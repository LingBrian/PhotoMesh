import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { MediaVersionSourceRecord } from '../src/db/repository.js';
import { MediaThumbnailError, MediaThumbnailService } from '../src/media/thumbnail-service.js';
import { ImageTransformError, type MediaThumbnailTransformer, type ThumbnailImage } from '../src/media/image-transformer.js';

const thumbnailBytes = Buffer.from('derived-webp');
const thumbnail: ThumbnailImage = { bytes: thumbnailBytes, mimeType: 'image/webp', width: 192, height: 96 };

function sourceFor(bytes: Buffer, overrides: Partial<MediaVersionSourceRecord> = {}): MediaVersionSourceRecord {
  return {
    libraryId: 'library', assetId: 'asset', sourceVersionId: null, kind: 'photo',
    filename: 'photo.jpg', sha256: digest(bytes), byteSize: bytes.byteLength,
    storageRef: 'objects/asset/original.blob', originalPath: null, availability: 'online', mimeType: null,
    ...overrides
  };
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function makeService(options: {
  source: MediaVersionSourceRecord;
  bytes?: Buffer;
  transformer?: MediaThumbnailTransformer;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  maxQueuedJobs?: number;
}): { service: MediaThumbnailService; openOriginal: ReturnType<typeof vi.fn>; transformer: MediaThumbnailTransformer } {
  const bytes = options.bytes ?? Buffer.from('source-bytes');
  const openOriginal = vi.fn(async () => Readable.from([bytes]));
  const transformer = options.transformer ?? { createThumbnail: vi.fn(async () => thumbnail) };
  const service = new MediaThumbnailService({
    getSource: () => options.source, openOriginal, transformer,
    ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.maxCacheBytes === undefined ? {} : { maxCacheBytes: options.maxCacheBytes }),
    ...(options.maxCacheEntries === undefined ? {} : { maxCacheEntries: options.maxCacheEntries }),
    ...(options.maxQueuedJobs === undefined ? {} : { maxQueuedJobs: options.maxQueuedJobs })
  });
  return { service, openOriginal, transformer };
}

describe('MediaThumbnailService', () => {
  it('verifies source bytes, returns only a WebP derivative, and reuses the bounded cache', async () => {
    const bytes = Buffer.from('source-bytes');
    const { service, openOriginal, transformer } = makeService({ source: sourceFor(bytes), bytes });
    const first = await service.getThumbnail('library', 'asset', 'timeline-192');
    const second = await service.getThumbnail('library', 'asset', 'timeline-192');

    expect(first).toMatchObject({ mimeType: 'image/webp', byteSize: thumbnailBytes.byteLength, width: 192, height: 96 });
    expect(first.sha256).toBe(digest(thumbnailBytes));
    expect(first.bytes).toEqual(thumbnailBytes);
    expect(second).toBe(first);
    expect(openOriginal).toHaveBeenCalledTimes(1);
    expect(transformer.createThumbnail).toHaveBeenCalledTimes(1);
  });

  it('serves an exact-source cached derivative while offline but fails closed on a cache miss', async () => {
    const bytes = Buffer.from('source-bytes');
    const source = sourceFor(bytes);
    const getSource = vi.fn(() => source);
    const openOriginal = vi.fn(async () => Readable.from([bytes]));
    const transformer: MediaThumbnailTransformer = { createThumbnail: vi.fn(async () => thumbnail) };
    const service = new MediaThumbnailService({ getSource, openOriginal, transformer });
    await service.getThumbnail('library', 'asset', 'timeline-192');
    getSource.mockImplementation(() => ({ ...source, availability: 'offline' }));

    await expect(service.getThumbnail('library', 'asset', 'timeline-192')).resolves.toMatchObject({ sha256: digest(thumbnailBytes) });
    await expect(service.getThumbnail('library', 'other-asset', 'timeline-192')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(openOriginal).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached derivatives when the current original SHA changes', async () => {
    const firstBytes = Buffer.from('source-one');
    const secondBytes = Buffer.from('source-two');
    let currentSource = sourceFor(firstBytes);
    const transformer: MediaThumbnailTransformer = { createThumbnail: vi.fn(async () => thumbnail) };
    const openOriginal = vi.fn(async () => Readable.from([currentSource.sha256 === digest(firstBytes) ? firstBytes : secondBytes]));
    const service = new MediaThumbnailService({
      getSource: () => currentSource, openOriginal, transformer
    });
    await service.getThumbnail('library', 'asset', 'timeline-192');
    currentSource = sourceFor(secondBytes);
    await service.getThumbnail('library', 'asset', 'timeline-192');
    expect(openOriginal).toHaveBeenCalledTimes(2);
    expect(transformer.createThumbnail).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-photo, wrong library, and offline cache miss without opening originals', async () => {
    const bytes = Buffer.from('source-bytes');
    const openOriginal = vi.fn(async () => Readable.from([bytes]));
    const source = sourceFor(bytes);
    const service = new MediaThumbnailService({
      getSource: (libraryId, assetId) => libraryId === source.libraryId && assetId === source.assetId
        ? { ...source, kind: 'video', availability: 'offline' } : undefined,
      openOriginal,
      transformer: { createThumbnail: vi.fn(async () => thumbnail) }
    });
    await expect(service.getThumbnail('other-library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(openOriginal).not.toHaveBeenCalled();
  });

  it('checks source metadata size before opening and hard-bounds actual streamed bytes', async () => {
    const bytes = Buffer.from('12345');
    const tooLarge = makeService({ source: sourceFor(bytes), bytes, maxInputBytes: 4 });
    await expect(tooLarge.service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(tooLarge.openOriginal).not.toHaveBeenCalled();

    const lyingSource = sourceFor(bytes, { byteSize: 1 });
    const actual = makeService({ source: lyingSource, bytes, maxInputBytes: 8 });
    await expect(actual.service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(actual.transformer.createThumbnail).not.toHaveBeenCalled();
  });

  it('rejects source hash mismatch, invalid profile, and oversized derivative', async () => {
    const bytes = Buffer.from('source-bytes');
    const hashMismatch = makeService({ source: sourceFor(bytes, { sha256: 'f'.repeat(64) }), bytes });
    await expect(hashMismatch.service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    const normal = makeService({ source: sourceFor(bytes), bytes });
    await expect(normal.service.getThumbnail('library', 'asset', 'original' as 'timeline-192')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const oversizedTransformer: MediaThumbnailTransformer = {
      createThumbnail: vi.fn(async () => ({ ...thumbnail, bytes: Buffer.alloc(5) }))
    };
    const oversized = makeService({ source: sourceFor(bytes), bytes, transformer: oversizedTransformer, maxOutputBytes: 4 });
    await expect(oversized.service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects invalid identifiers, service limits, missing sources, and corrupt source metadata', async () => {
    const bytes = Buffer.from('source-bytes');
    const source = sourceFor(bytes);
    const transformer: MediaThumbnailTransformer = { createThumbnail: vi.fn(async () => thumbnail) };
    const openOriginal = async () => Readable.from([bytes]);
    expect(() => new MediaThumbnailService({
      getSource: () => source, openOriginal, transformer, maxCacheBytes: 0
    })).toThrow(RangeError);

    const validService = new MediaThumbnailService({ getSource: () => source, openOriginal, transformer });
    await expect(validService.getThumbnail('../library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const missing = new MediaThumbnailService({ getSource: () => undefined, openOriginal, transformer });
    await expect(missing.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const failedLookup = new MediaThumbnailService({ getSource: () => { throw new Error('db failure'); }, openOriginal, transformer });
    await expect(failedLookup.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const invalidHash = new MediaThumbnailService({ getSource: () => ({ ...source, sha256: 'bad' }), openOriginal, transformer });
    await expect(invalidHash.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const invalidSize = new MediaThumbnailService({ getSource: () => ({ ...source, byteSize: 0 }), openOriginal, transformer });
    await expect(invalidSize.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('fails closed for offline or unavailable originals and destroys over-limit streams', async () => {
    const bytes = Buffer.from('source-bytes');
    const transformer: MediaThumbnailTransformer = { createThumbnail: vi.fn(async () => thumbnail) };
    const offlineSource = sourceFor(bytes, { availability: 'offline' });
    const offlineOpen = vi.fn(async () => Readable.from([bytes]));
    const offline = new MediaThumbnailService({ getSource: () => offlineSource, openOriginal: offlineOpen, transformer });
    await expect(offline.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'SOURCE_OFFLINE' });
    expect(offlineOpen).not.toHaveBeenCalled();

    const missingStream = new MediaThumbnailService({ getSource: () => sourceFor(bytes), openOriginal: async () => undefined, transformer });
    await expect(missingStream.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'SOURCE_OFFLINE' });
    const failedStream = new MediaThumbnailService({ getSource: () => sourceFor(bytes), openOriginal: async () => { throw new Error('offline'); }, transformer });
    await expect(failedStream.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'SOURCE_OFFLINE' });

    const tooManyBytes = Buffer.from('12345');
    const sourceWithLyingSize = sourceFor(tooManyBytes, { byteSize: 4 });
    let overflowStream: Readable | undefined;
    const overflow = new MediaThumbnailService({
      getSource: () => sourceWithLyingSize,
      openOriginal: async () => {
        overflowStream = new Readable({ read() { this.push(tooManyBytes); this.push(null); } });
        return overflowStream;
      },
      transformer, maxInputBytes: 4
    });
    await expect(overflow.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(overflowStream?.destroyed).toBe(true);
    expect(transformer.createThumbnail).not.toHaveBeenCalled();
  });

  it('maps transformer errors and validates generated image shape and MIME', async () => {
    const bytes = Buffer.from('source-bytes');
    for (const [failure, code] of [
      [new ImageTransformError('TOO_LARGE'), 'TOO_LARGE'],
      [new ImageTransformError('UNSUPPORTED_MEDIA'), 'UNSUPPORTED_MEDIA'],
      [new ImageTransformError('PROCESSING_FAILED'), 'PROCESSING_FAILED'],
      [new Error('native failure'), 'PROCESSING_FAILED']
    ] as const) {
      const service = makeService({ source: sourceFor(bytes), bytes, transformer: {
        createThumbnail: vi.fn(async () => { throw failure; })
      } }).service;
      await expect(service.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code });
    }

    const wrongMime = makeService({ source: sourceFor(bytes), bytes, transformer: {
      createThumbnail: vi.fn(async () => ({ ...thumbnail, mimeType: 'image/png' as 'image/webp' }))
    } }).service;
    await expect(wrongMime.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    const badDimensions = makeService({ source: sourceFor(bytes), bytes, transformer: {
      createThumbnail: vi.fn(async () => ({ ...thumbnail, width: 0 }))
    } }).service;
    await expect(badDimensions.getThumbnail('library', 'asset', 'timeline-192')).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
  });

  it('does not cache entries larger than the configured memory budget', async () => {
    const bytes = Buffer.from('source-bytes');
    const { service, openOriginal } = makeService({ source: sourceFor(bytes), bytes, maxCacheBytes: 3 });
    await service.getThumbnail('library', 'asset', 'timeline-192');
    await service.getThumbnail('library', 'asset', 'timeline-192');
    expect(openOriginal).toHaveBeenCalledTimes(2);
  });

  it('runs accepted queued jobs serially and releases the next task', async () => {
    const bytes = Buffer.from('source-bytes');
    const sources = new Map([['one', sourceFor(bytes, { assetId: 'one' })], ['two', sourceFor(bytes, { assetId: 'two' })]]);
    const releases: Array<(value: ThumbnailImage) => void> = [];
    const transformer: MediaThumbnailTransformer = {
      createThumbnail: vi.fn(() => new Promise<ThumbnailImage>((resolve) => { releases.push(resolve); }))
    };
    const getSource = vi.fn((_libraryId: string, assetId: string) => sources.get(assetId));
    const service = new MediaThumbnailService({
      getSource,
      openOriginal: async () => Readable.from([bytes]), transformer, maxQueuedJobs: 1
    });
    const first = service.getThumbnail('library', 'one', 'timeline-192');
    await vi.waitFor(() => expect(transformer.createThumbnail).toHaveBeenCalledTimes(1));
    const second = service.getThumbnail('library', 'two', 'timeline-192');
    await vi.waitFor(() => expect(getSource).toHaveBeenCalledTimes(3));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transformer.createThumbnail).toHaveBeenCalledTimes(1);
    releases[0]?.(thumbnail);
    await vi.waitFor(() => expect(transformer.createThumbnail).toHaveBeenCalledTimes(2));
    releases[1]?.(thumbnail);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('evicts least-recently-used cache entries at the configured count bound', async () => {
    const bytes = Buffer.from('source-bytes');
    const sources = new Map([['one', sourceFor(bytes, { assetId: 'one' })], ['two', sourceFor(bytes, { assetId: 'two' })]]);
    const transformer: MediaThumbnailTransformer = { createThumbnail: vi.fn(async () => thumbnail) };
    const openOriginal = vi.fn(async () => Readable.from([bytes]));
    const service = new MediaThumbnailService({
      getSource: (_libraryId, assetId) => sources.get(assetId), openOriginal, transformer, maxCacheEntries: 1
    });
    await service.getThumbnail('library', 'one', 'timeline-192');
    await service.getThumbnail('library', 'two', 'timeline-192');
    await service.getThumbnail('library', 'one', 'timeline-192');
    expect(openOriginal).toHaveBeenCalledTimes(3);
  });

  it('bounds queued work and reports queue saturation', async () => {
    const bytes = Buffer.from('source-bytes');
    let release: ((value: ThumbnailImage) => void) | undefined;
    const transformer: MediaThumbnailTransformer = {
      createThumbnail: vi.fn(() => new Promise<ThumbnailImage>((resolve) => { release = resolve; }))
    };
    const firstSource = sourceFor(bytes);
    const secondSource = sourceFor(bytes, { assetId: 'other-asset' });
    const service = new MediaThumbnailService({
      getSource: (_libraryId, assetId) => assetId === 'asset' ? firstSource : assetId === 'other-asset' ? secondSource : undefined,
      openOriginal: async () => Readable.from([bytes]), transformer, maxQueuedJobs: 0
    });
    const first = service.getThumbnail('library', 'asset', 'timeline-192');
    await vi.waitFor(() => expect(transformer.createThumbnail).toHaveBeenCalledTimes(1));
    await expect(service.getThumbnail('library', 'other-asset', 'timeline-192')).rejects.toBeInstanceOf(MediaThumbnailError);
    await expect(service.getThumbnail('library', 'other-asset', 'timeline-192')).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    release?.(thumbnail);
    await expect(first).resolves.toMatchObject({ mimeType: 'image/webp' });
  });
});
