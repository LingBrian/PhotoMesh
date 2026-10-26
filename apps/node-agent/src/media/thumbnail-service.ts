import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { MediaVersionSourceRecord } from '../db/repository.js';
import {
  ImageTransformError, maxThumbnailInputBytes, maxThumbnailOutputBytes, maxThumbnailPixels,
  thumbnailDimension, type MediaThumbnailTransformer, type ThumbnailImage
} from './image-transformer.js';

export const maxThumbnailCacheBytes = 8 * 1024 * 1024;
export const maxThumbnailCacheEntries = 128;
export const maxThumbnailQueuedJobs = 8;
export const thumbnailProfile = 'timeline-192' as const;
const thumbnailTransformerVersion = 'webp-192-v1';

export interface ThumbnailContent extends ThumbnailImage {
  sha256: string;
  byteSize: number;
}

export type MediaThumbnailErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'SOURCE_CHANGED' | 'SOURCE_OFFLINE' | 'TOO_LARGE'
  | 'UNSUPPORTED_MEDIA' | 'PROCESSING_FAILED' | 'QUEUE_FULL' | 'STORAGE_FAILED';

export class MediaThumbnailError extends Error {
  constructor(readonly code: MediaThumbnailErrorCode) {
    super(code);
    this.name = 'MediaThumbnailError';
  }
}

export interface MediaThumbnailServiceOptions {
  getSource(libraryId: string, assetId: string): MediaVersionSourceRecord | undefined | Promise<MediaVersionSourceRecord | undefined>;
  openOriginal(source: MediaVersionSourceRecord): Promise<Readable | undefined> | Readable | undefined;
  transformer: MediaThumbnailTransformer;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxPixels?: number;
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  maxQueuedJobs?: number;
}

type QueuedTask = () => void;

export class MediaThumbnailService {
  private readonly getSource: MediaThumbnailServiceOptions['getSource'];
  private readonly openOriginal: MediaThumbnailServiceOptions['openOriginal'];
  private readonly transformer: MediaThumbnailTransformer;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxPixels: number;
  private readonly maxCacheBytes: number;
  private readonly maxCacheEntries: number;
  private readonly maxQueuedJobs: number;
  private readonly cache = new Map<string, ThumbnailContent>();
  private readonly inFlight = new Map<string, Promise<ThumbnailContent>>();
  private cacheBytes = 0;
  private active = false;
  private readonly queue: QueuedTask[] = [];

  constructor(options: MediaThumbnailServiceOptions) {
    this.getSource = options.getSource;
    this.openOriginal = options.openOriginal;
    this.transformer = options.transformer;
    this.maxInputBytes = options.maxInputBytes ?? maxThumbnailInputBytes;
    this.maxOutputBytes = options.maxOutputBytes ?? maxThumbnailOutputBytes;
    this.maxPixels = options.maxPixels ?? maxThumbnailPixels;
    this.maxCacheBytes = options.maxCacheBytes ?? maxThumbnailCacheBytes;
    this.maxCacheEntries = options.maxCacheEntries ?? maxThumbnailCacheEntries;
    this.maxQueuedJobs = options.maxQueuedJobs ?? maxThumbnailQueuedJobs;
    if (!isPositiveInteger(this.maxInputBytes) || !isPositiveInteger(this.maxOutputBytes) ||
        !isPositiveInteger(this.maxPixels) || !isPositiveInteger(this.maxCacheBytes) ||
        !isPositiveInteger(this.maxCacheEntries) || !Number.isSafeInteger(this.maxQueuedJobs) || this.maxQueuedJobs < 0) {
      throw new RangeError('Thumbnail resource limits must be positive integers and queue size non-negative');
    }
  }

  async getThumbnail(libraryId: string, assetId: string, profile: string = thumbnailProfile): Promise<ThumbnailContent> {
    if (!isSafeIdentifier(libraryId) || !isSafeIdentifier(assetId) || profile !== thumbnailProfile) {
      throw new MediaThumbnailError('INVALID_REQUEST');
    }
    const source = await this.resolveSource(libraryId, assetId);
    this.assertSourceMetadata(source, libraryId, assetId);
    const key = makeCacheKey(source, profile);
    const cached = this.readCache(key);
    if (cached) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.enqueue(() => this.generate(source, key, profile));
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private async resolveSource(libraryId: string, assetId: string): Promise<MediaVersionSourceRecord> {
    try {
      const source = await this.getSource(libraryId, assetId);
      if (!source || source.libraryId !== libraryId || source.assetId !== assetId || source.kind !== 'photo') {
        throw new MediaThumbnailError('NOT_FOUND');
      }
      return source;
    } catch (error) {
      if (error instanceof MediaThumbnailError) throw error;
      throw new MediaThumbnailError('STORAGE_FAILED');
    }
  }

  private assertSourceMetadata(source: MediaVersionSourceRecord, libraryId: string, assetId: string): void {
    if (!isSafeIdentifier(libraryId) || !isSafeIdentifier(assetId) || !/^[0-9a-f]{64}$/.test(source.sha256) ||
        !Number.isSafeInteger(source.byteSize) || source.byteSize < 1) {
      throw new MediaThumbnailError('STORAGE_FAILED');
    }
    if (source.byteSize > this.maxInputBytes) throw new MediaThumbnailError('TOO_LARGE');
  }

  private readCache(key: string): ThumbnailContent | undefined {
    const value = this.cache.get(key);
    if (!value) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  private writeCache(key: string, value: ThumbnailContent): void {
    if (value.byteSize > this.maxCacheBytes) return;
    const prior = this.cache.get(key);
    if (prior) {
      this.cacheBytes -= prior.byteSize;
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    this.cacheBytes += value.byteSize;
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.entries().next().value as [string, ThumbnailContent] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].byteSize;
    }
  }

  private enqueue(task: () => Promise<ThumbnailContent>): Promise<ThumbnailContent> {
    if (!this.active) {
      this.active = true;
      return Promise.resolve().then(task).finally(() => this.releaseNext());
    }
    if (this.queue.length >= this.maxQueuedJobs) return Promise.reject(new MediaThumbnailError('QUEUE_FULL'));
    return new Promise<ThumbnailContent>((resolve, reject) => {
      this.queue.push(() => {
        void Promise.resolve().then(task).then(resolve, reject).finally(() => this.releaseNext());
      });
    });
  }

  private releaseNext(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active = false;
  }

  private async generate(source: MediaVersionSourceRecord, key: string, profile: string): Promise<ThumbnailContent> {
    const current = await this.resolveSource(source.libraryId, source.assetId);
    this.assertSourceMetadata(current, source.libraryId, source.assetId);
    if (current.sha256 !== source.sha256 || current.byteSize !== source.byteSize) throw new MediaThumbnailError('SOURCE_CHANGED');
    const cached = this.readCache(key);
    if (cached) return cached;
    if (!['online', 'cached'].includes(current.availability)) throw new MediaThumbnailError('SOURCE_OFFLINE');

    let stream: Readable | undefined;
    try { stream = await this.openOriginal(current); }
    catch { throw new MediaThumbnailError('SOURCE_OFFLINE'); }
    if (!stream) throw new MediaThumbnailError('SOURCE_OFFLINE');
    const sourceBytes = await readBoundedSource(stream, this.maxInputBytes);
    if (sourceBytes.byteLength !== current.byteSize || sourceBytes.sha256 !== current.sha256) {
      throw new MediaThumbnailError('SOURCE_CHANGED');
    }

    let image: ThumbnailImage;
    try { image = await this.transformer.createThumbnail(sourceBytes.bytes); }
    catch (error) { throw mapTransformError(error); }
    if (image.mimeType !== 'image/webp') throw new MediaThumbnailError('PROCESSING_FAILED');
    if (!Buffer.isBuffer(image.bytes) || image.bytes.byteLength < 1 || image.bytes.byteLength > this.maxOutputBytes) {
      throw new MediaThumbnailError('TOO_LARGE');
    }
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 ||
        image.width > thumbnailDimension || image.height > thumbnailDimension || image.width * image.height > this.maxPixels) {
      throw new MediaThumbnailError('PROCESSING_FAILED');
    }
    const content: ThumbnailContent = {
      ...image,
      sha256: createHash('sha256').update(image.bytes).digest('hex'),
      byteSize: image.bytes.byteLength
    };
    this.writeCache(makeCacheKey(current, profile), content);
    return content;
  }
}

async function readBoundedSource(stream: Readable, maxBytes: number): Promise<{ bytes: Buffer; byteLength: number; sha256: string }> {
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        stream.destroy();
        throw new MediaThumbnailError('TOO_LARGE');
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof MediaThumbnailError) throw error;
    throw new MediaThumbnailError('SOURCE_OFFLINE');
  }
  return { bytes: Buffer.concat(chunks, byteLength), byteLength, sha256: hash.digest('hex') };
}

function makeCacheKey(source: MediaVersionSourceRecord, profile: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source.libraryId, source.assetId, source.sha256, profile, thumbnailTransformerVersion]))
    .digest('hex');
}

function mapTransformError(error: unknown): MediaThumbnailError {
  if (error instanceof ImageTransformError) {
    if (error.code === 'TOO_LARGE') return new MediaThumbnailError('TOO_LARGE');
    if (error.code === 'UNSUPPORTED_MEDIA') return new MediaThumbnailError('UNSUPPORTED_MEDIA');
  }
  return new MediaThumbnailError('PROCESSING_FAILED');
}

function isSafeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\\/\0]/.test(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
