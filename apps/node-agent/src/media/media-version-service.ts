import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { RepositoryConflictError, SqliteRepository, type CreateMediaVersionRecord, type MediaVersionRecord, type MediaVersionSourceRecord, type MediaVersionTransform, type MediaVersionStatus } from '../db/repository.js';
import { ImageTransformError, maxMediaVersionInputBytes, maxMediaVersionOutputBytes, maxMediaVersionPixels, type MediaImageTransformer, type SupportedImageMime, type TransformedImage } from './image-transformer.js';

export interface CreateMediaVersionRequest {
  sourceVersionId: string | null;
  sourceSha256: string;
  transform: MediaVersionTransform;
  idempotencyKey: string;
}

export interface MediaVersionFileSystem {
  openReadStream(path: string): Promise<Readable>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  flush(path: string): Promise<void>;
  publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'>;
  hashFile(path: string): Promise<{ byteLength: number; sha256: string }>;
  exists(path: string): Promise<boolean>;
}

export interface MediaVersionView {
  versionId: string;
  assetId: string;
  sourceVersionId: string | null;
  sourceSha256: string;
  outputSha256: string | null;
  mimeType: SupportedImageMime | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  transform: MediaVersionTransform;
  status: MediaVersionStatus;
  createdAt: string;
  errorCode: string | null;
}

export interface MediaVersionOperation {
  operationId: string;
  versionId: string;
  status: MediaVersionStatus;
}

export interface MediaVersionPage {
  original: {
    sourceVersionId: null;
    sha256: string;
    mimeType: SupportedImageMime | null;
    byteSize: number;
    filename: string;
    availability: MediaVersionSourceRecord['availability'];
  };
  items: MediaVersionView[];
}

export type MediaVersionErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'SOURCE_CHANGED' | 'SOURCE_OFFLINE' | 'IDEMPOTENCY_CONFLICT'
  | 'TOO_LARGE' | 'UNSUPPORTED_MEDIA' | 'PROCESSING_FAILED' | 'STORAGE_FAILED' | 'QUEUE_FULL'
  | 'VERSION_NOT_READY' | 'VERSION_FAILED' | 'VERSION_UNAVAILABLE' | 'STORAGE_CORRUPT';

export class MediaVersionError extends Error {
  constructor(readonly code: MediaVersionErrorCode) {
    super(code);
    this.name = 'MediaVersionError';
  }
}

export interface MediaVersionServiceOptions {
  repository: SqliteRepository;
  fileSystem: MediaVersionFileSystem;
  transformer: MediaImageTransformer;
  openOriginal: (media: MediaVersionSourceRecord) => Promise<Readable | undefined> | Readable | undefined;
  now?: () => string;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxPixels?: number;
  maxPendingVersions?: number;
  maxConcurrentPreflights?: number;
}

export class MediaVersionService {
  private readonly repository: SqliteRepository;
  private readonly fileSystem: MediaVersionFileSystem;
  private readonly transformer: MediaImageTransformer;
  private readonly openOriginal: MediaVersionServiceOptions['openOriginal'];
  private readonly now: () => string;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxPixels: number;
  private readonly maxPendingVersions: number;
  private readonly maxConcurrentPreflights: number;
  private pendingAdmissions = 0;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Set<string>();
  private readonly inFlightAdmissions = new Map<string, { fingerprint: string; promise: Promise<MediaVersionOperation> }>();
  private workerPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(options: MediaVersionServiceOptions) {
    this.repository = options.repository;
    this.fileSystem = options.fileSystem;
    this.transformer = options.transformer;
    this.openOriginal = options.openOriginal;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxInputBytes = options.maxInputBytes ?? maxMediaVersionInputBytes;
    this.maxOutputBytes = options.maxOutputBytes ?? maxMediaVersionOutputBytes;
    this.maxPixels = options.maxPixels ?? maxMediaVersionPixels;
    this.maxPendingVersions = options.maxPendingVersions ?? 16;
    this.maxConcurrentPreflights = options.maxConcurrentPreflights ?? 2;
    if (!Number.isSafeInteger(this.maxPendingVersions) || this.maxPendingVersions < 1 ||
        !Number.isSafeInteger(this.maxConcurrentPreflights) || this.maxConcurrentPreflights < 1) {
      throw new RangeError('Media-version queue limits must be positive integers');
    }
  }

  async createVersion(libraryId: string, assetId: string, input: CreateMediaVersionRequest, principalId: string): Promise<MediaVersionOperation> {
    const normalized = validateRequest(libraryId, assetId, input, principalId);
    const fingerprint = hashJson({ libraryId, assetId, sourceVersionId: normalized.sourceVersionId,
      sourceSha256: normalized.sourceSha256, transform: normalized.transform });
    const prior = this.repository.getMediaVersionByIdempotency(libraryId, principalId, normalized.idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new MediaVersionError('IDEMPOTENCY_CONFLICT');
      if (prior.status === 'staging') this.enqueue(prior.versionId);
      return operationFor(prior);
    }

    const idempotencyIdentity = JSON.stringify([libraryId, principalId, normalized.idempotencyKey]);
    const inFlight = this.inFlightAdmissions.get(idempotencyIdentity);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new MediaVersionError('IDEMPOTENCY_CONFLICT');
      return inFlight.promise;
    }

    const source = this.repository.getMediaVersionSource(libraryId, assetId, normalized.sourceVersionId);
    if (!source) {
      if (normalized.sourceVersionId !== null) {
        const parent = this.repository.getMediaVersion(libraryId, assetId, normalized.sourceVersionId);
        if (!parent) throw new MediaVersionError('NOT_FOUND');
        throw new MediaVersionError(parent.status === 'failed' ? 'VERSION_FAILED' : 'VERSION_NOT_READY');
      }
      throw new MediaVersionError('NOT_FOUND');
    }
    if (!['online', 'cached'].includes(source.availability)) throw new MediaVersionError('SOURCE_OFFLINE');
    if (source.sha256 !== normalized.sourceSha256) throw new MediaVersionError('SOURCE_CHANGED');
    this.reserveAdmission();
    const promise = this.createVersionFromSource(libraryId, assetId, normalized, fingerprint, source, principalId);
    const admission = { fingerprint, promise };
    this.inFlightAdmissions.set(idempotencyIdentity, admission);
    try {
      return await promise;
    } finally {
      if (this.inFlightAdmissions.get(idempotencyIdentity) === admission) {
        this.inFlightAdmissions.delete(idempotencyIdentity);
      }
    }
  }

  private async createVersionFromSource(
    libraryId: string, assetId: string, normalized: CreateMediaVersionRequest, fingerprint: string,
    source: MediaVersionSourceRecord, principalId: string
  ): Promise<MediaVersionOperation> {
    try {
      const bytes = await this.readSource(source);
      if (digest(bytes) !== source.sha256) throw new MediaVersionError('SOURCE_CHANGED');
      const probe = await this.inspect(bytes);
      this.assertImageProbe(probe, source.mimeType);
      const sourceMime = mimeForFormat(probe.format);
      if (!sourceMime) throw new MediaVersionError('UNSUPPORTED_MEDIA');

      const versionId = randomUUID();
      const record: CreateMediaVersionRecord = {
        versionId, assetId, libraryId, sourceVersionId: normalized.sourceVersionId,
        sourceSha256: normalized.sourceSha256, transform: normalized.transform, idempotencyScope: principalId,
        idempotencyKey: normalized.idempotencyKey, requestFingerprint: fingerprint,
        storageRef: `derived/${versionId}/output.${extensionForMime(sourceMime)}`,
        createdBy: principalId, createdAt: this.now()
      };
      try {
        this.repository.createMediaVersion(record);
      } catch (error) {
        const raced = this.repository.getMediaVersionByIdempotency(libraryId, principalId, normalized.idempotencyKey);
        if (raced) {
          if (raced.requestFingerprint !== fingerprint) throw new MediaVersionError('IDEMPOTENCY_CONFLICT');
          if (raced.status === 'staging') this.enqueue(raced.versionId);
          return operationFor(raced);
        }
        if (error instanceof RepositoryConflictError) throw new MediaVersionError('IDEMPOTENCY_CONFLICT');
        throw new MediaVersionError('STORAGE_FAILED');
      }
      this.enqueue(versionId);
      return { operationId: versionId, versionId, status: 'staging' };
    } finally {
      this.pendingAdmissions--;
    }
  }

  private reserveAdmission(): void {
    const pending = this.repository.countStagingMediaVersions() + this.pendingAdmissions;
    if (this.pendingAdmissions >= this.maxConcurrentPreflights || pending >= this.maxPendingVersions) {
      throw new MediaVersionError('QUEUE_FULL');
    }
    this.pendingAdmissions++;
  }

  listVersions(libraryId: string, assetId: string): MediaVersionPage {
    const original = this.repository.getMediaVersionSource(libraryId, assetId, null);
    if (!original) throw new MediaVersionError('NOT_FOUND');
    return {
      original: {
        sourceVersionId: null, sha256: original.sha256, mimeType: original.mimeType,
        byteSize: original.byteSize, filename: original.filename, availability: original.availability
      },
      items: this.repository.listMediaVersions(libraryId, assetId).map(toView)
    };
  }

  getVersion(libraryId: string, assetId: string, versionId: string): MediaVersionView | undefined {
    const version = this.repository.getMediaVersion(libraryId, assetId, versionId);
    return version ? toView(version) : undefined;
  }

  async readVersionContent(libraryId: string, assetId: string, versionId: string): Promise<{
    bytes: Buffer; mimeType: SupportedImageMime; sha256: string; byteSize: number;
  }> {
    const version = this.repository.getMediaVersion(libraryId, assetId, versionId);
    if (!version) throw new MediaVersionError('NOT_FOUND');
    if (version.status === 'failed') throw new MediaVersionError('VERSION_FAILED');
    if (version.status !== 'ready') throw new MediaVersionError('VERSION_NOT_READY');
    if (!version.outputSha256 || !version.mimeType || version.byteSize === null || version.byteSize > this.maxOutputBytes) {
      throw new MediaVersionError('VERSION_UNAVAILABLE');
    }
    try {
      const stream = await this.fileSystem.openReadStream(version.storageRef);
      const bytes = await readStreamBounded(stream, this.maxOutputBytes, 'VERSION_UNAVAILABLE');
      if (bytes.byteLength !== version.byteSize || digest(bytes) !== version.outputSha256) {
        throw new MediaVersionError('VERSION_UNAVAILABLE');
      }
      return { bytes, mimeType: version.mimeType, sha256: version.outputSha256, byteSize: version.byteSize };
    } catch (error) {
      if (error instanceof MediaVersionError) throw error;
      throw new MediaVersionError('VERSION_UNAVAILABLE');
    }
  }

  async resumePending(): Promise<void> {
    for (const version of this.repository.listStagingMediaVersions()) this.enqueue(version.versionId);
  }

  async waitForIdle(): Promise<void> {
    while (this.workerPromise) await this.workerPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.workerPromise;
  }

  private enqueue(versionId: string): void {
    if (this.stopping || this.queued.has(versionId) || this.active.has(versionId)) return;
    this.queue.push(versionId);
    this.queued.add(versionId);
    this.startWorker();
  }

  private startWorker(): void {
    if (this.workerPromise || this.stopping) return;
    this.workerPromise = this.pump().finally(() => {
      this.workerPromise = undefined;
      if (this.queue.length && !this.stopping) this.startWorker();
    });
  }

  private async pump(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      const versionId = this.queue.shift();
      if (!versionId) continue;
      this.queued.delete(versionId);
      this.active.add(versionId);
      try { await this.processVersion(versionId); }
      finally { this.active.delete(versionId); }
    }
  }

  private async processVersion(versionId: string): Promise<void> {
    const version = this.repository.getMediaVersionById(versionId);
    if (!version || version.status !== 'staging') return;
    let published = false;
    try {
      const source = this.repository.getMediaVersionSource(version.libraryId, version.assetId, version.sourceVersionId);
      if (!source || !['online', 'cached'].includes(source.availability)) throw new MediaVersionError('SOURCE_OFFLINE');
      if (source.sha256 !== version.sourceSha256) throw new MediaVersionError('SOURCE_CHANGED');
      const input = await this.readSource(source);
      if (digest(input) !== version.sourceSha256) throw new MediaVersionError('SOURCE_CHANGED');
      const probe = await this.inspect(input);
      this.assertImageProbe(probe, source.mimeType);
      const inputMime = mimeForFormat(probe.format);
      if (!inputMime) throw new MediaVersionError('UNSUPPORTED_MEDIA');
      const output = await this.transformer.transform(input, version.transform);
      this.assertOutput(output, inputMime);
      const outputSha256 = digest(output.bytes);

      try {
        if (await this.fileSystem.exists(version.storageRef)) {
          const existing = await this.fileSystem.hashFile(version.storageRef);
          if (existing.sha256 !== outputSha256 || existing.byteLength !== output.bytes.byteLength) {
            throw new MediaVersionError('STORAGE_CORRUPT');
          }
          published = true;
        } else {
          const temporaryRef = `staging/media-versions/${version.versionId}-${randomUUID()}.part`;
          await this.fileSystem.writeExclusive(temporaryRef, output.bytes);
          await this.fileSystem.flush(temporaryRef);
          await this.fileSystem.publishNoReplace(temporaryRef, version.storageRef);
          const committed = await this.fileSystem.hashFile(version.storageRef);
          if (committed.sha256 !== outputSha256 || committed.byteLength !== output.bytes.byteLength) {
            throw new MediaVersionError('STORAGE_CORRUPT');
          }
          published = true;
        }
      } catch (error) {
        if (error instanceof MediaVersionError) throw error;
        throw new MediaVersionError('STORAGE_FAILED');
      }
      const updated = this.repository.markMediaVersionReady(version.versionId, {
        sha256: outputSha256, mimeType: output.mimeType, byteSize: output.bytes.byteLength,
        width: output.width, height: output.height
      }, this.now());
      if (!updated) {
        const current = this.repository.getMediaVersionById(version.versionId);
        if (current?.status !== 'ready' || current.outputSha256 !== outputSha256) throw new MediaVersionError('STORAGE_FAILED');
      }
    } catch (error) {
      if (published) return;
      const safeCode = versionErrorCode(error);
      if (safeCode === 'SOURCE_OFFLINE' || safeCode === 'STORAGE_FAILED') return;
      try { this.repository.markMediaVersionFailed(version.versionId, safeCode.toLowerCase(), this.now()); } catch { /* Preserve staging for restart recovery. */ }
    }
  }

  private async readSource(source: MediaVersionSourceRecord): Promise<Buffer> {
    if (source.byteSize > this.maxInputBytes) throw new MediaVersionError('TOO_LARGE');
    let stream: Readable | undefined;
    try {
      stream = source.sourceVersionId === null
        ? await this.openOriginal(source)
        : await this.fileSystem.openReadStream(source.storageRef);
    } catch {
      throw new MediaVersionError('SOURCE_OFFLINE');
    }
    if (!stream) throw new MediaVersionError('SOURCE_OFFLINE');
    const chunks: Buffer[] = [];
    let byteLength = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        byteLength += chunk.byteLength;
        if (byteLength > this.maxInputBytes) throw new MediaVersionError('TOO_LARGE');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof MediaVersionError) throw error;
      throw new MediaVersionError('SOURCE_OFFLINE');
    }
    return Buffer.concat(chunks, byteLength);
  }

  private async inspect(bytes: Buffer) {
    try { return await this.transformer.inspect(bytes); }
    catch (error) { throw mapTransformError(error); }
  }

  private assertImageProbe(probe: { format: string; width: number; height: number; pages: number }, expectedMime: string | null): void {
    if (!['jpeg', 'png', 'webp'].includes(probe.format) || probe.pages > 1) throw new MediaVersionError('UNSUPPORTED_MEDIA');
    if (!Number.isSafeInteger(probe.width) || !Number.isSafeInteger(probe.height) || probe.width < 1 || probe.height < 1 ||
      probe.width * probe.height > this.maxPixels) throw new MediaVersionError('TOO_LARGE');
    const mime = mimeForFormat(probe.format);
    if (!mime || expectedMime && mime !== expectedMime) throw new MediaVersionError('UNSUPPORTED_MEDIA');
  }

  private assertOutput(output: TransformedImage, expectedMime: SupportedImageMime): void {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(output.mimeType) || output.mimeType !== expectedMime) {
      throw new MediaVersionError('PROCESSING_FAILED');
    }
    if (output.bytes.byteLength < 1 || output.bytes.byteLength > this.maxOutputBytes) throw new MediaVersionError('TOO_LARGE');
    if (!Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || output.width < 1 || output.height < 1 ||
      output.width * output.height > this.maxPixels) throw new MediaVersionError('PROCESSING_FAILED');
  }
}

async function readStreamBounded(stream: Readable, maxBytes: number, overflowCode: 'TOO_LARGE' | 'VERSION_UNAVAILABLE' = 'TOO_LARGE'): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) throw new MediaVersionError(overflowCode);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof MediaVersionError) throw error;
    throw new MediaVersionError(overflowCode === 'TOO_LARGE' ? 'SOURCE_OFFLINE' : 'VERSION_UNAVAILABLE');
  }
  return Buffer.concat(chunks, byteLength);
}

function validateRequest(libraryId: string, assetId: string, input: CreateMediaVersionRequest, principalId: string): CreateMediaVersionRequest {
  if (!libraryId || libraryId.length > 128 || !assetId || assetId.length > 128 || !principalId || principalId.length > 128 ||
    !input || typeof input !== 'object' || !/^[0-9a-f]{64}$/.test(input.sourceSha256) ||
    !(input.sourceVersionId === null || typeof input.sourceVersionId === 'string' && input.sourceVersionId.length > 0 && input.sourceVersionId.length <= 128) ||
    !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey) || !input.transform || typeof input.transform !== 'object') {
    throw new MediaVersionError('INVALID_REQUEST');
  }
  const { crop, rotation } = input.transform;
  if (!crop || !Number.isSafeInteger(crop.x) || !Number.isSafeInteger(crop.y) ||
    !Number.isSafeInteger(crop.width) || !Number.isSafeInteger(crop.height) ||
    crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
    crop.x + crop.width > 1_000_000 || crop.y + crop.height > 1_000_000 ||
    ![0, 90, 180, 270].includes(rotation) ||
    crop.x === 0 && crop.y === 0 && crop.width === 1_000_000 && crop.height === 1_000_000 && rotation === 0) {
    throw new MediaVersionError('INVALID_REQUEST');
  }
  return {
    sourceVersionId: input.sourceVersionId, sourceSha256: input.sourceSha256,
    transform: { crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, rotation },
    idempotencyKey: input.idempotencyKey
  };
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function operationFor(version: MediaVersionRecord): MediaVersionOperation {
  return { operationId: version.versionId, versionId: version.versionId, status: version.status };
}

function toView(version: MediaVersionRecord): MediaVersionView {
  return {
    versionId: version.versionId, assetId: version.assetId, sourceVersionId: version.sourceVersionId,
    sourceSha256: version.sourceSha256, outputSha256: version.outputSha256, mimeType: version.mimeType,
    byteSize: version.byteSize, width: version.width, height: version.height, transform: version.transform,
    status: version.status, createdAt: version.createdAt, errorCode: version.errorCode
  };
}

function extensionForMime(mimeType: SupportedImageMime): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function mimeForFormat(format: string): SupportedImageMime | undefined {
  switch (format) {
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    default: return undefined;
  }
}

function versionErrorCode(error: unknown): MediaVersionErrorCode {
  if (error instanceof MediaVersionError) return error.code;
  if (error instanceof ImageTransformError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    if (error.code === 'TOO_LARGE' || error.code === 'UNSUPPORTED_MEDIA' || error.code === 'PROCESSING_FAILED') return error.code;
  }
  return 'PROCESSING_FAILED';
}

function mapTransformError(error: unknown): MediaVersionError {
  const code = versionErrorCode(error);
  return new MediaVersionError(code === 'TOO_LARGE' || code === 'UNSUPPORTED_MEDIA' ? code : 'PROCESSING_FAILED');
}
