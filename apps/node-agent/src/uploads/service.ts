import { createHash, randomUUID } from 'node:crypto';
import type { AssetKind, CreateUploadSessionRecord, SourceKind, UploadChunkRecord, UploadRepository, UploadSessionRecord } from '../db/repository.js';
import { RepositoryConflictError } from '../db/repository.js';
import type { FileDigest, UploadFileSystem } from './file-system.js';

export interface CreateUploadRequest {
  libraryId: string;
  filename: string;
  originalPath?: string;
  sourceKind: SourceKind;
  sourceNodeId?: string;
  kind?: AssetKind;
  totalBytes: number;
  sha256: string;
}

export interface UploadSessionResponse {
  sessionId: string;
  offset: number;
  expiresAt: string;
  state: UploadSessionRecord['state'];
}

export interface UploadCompleteResponse {
  sessionId: string;
  assetId: string;
  fileId: string;
  sha256: string;
  byteLength: number;
  storageRef: string;
}

export type UploadErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'OFFSET_CONFLICT'
  | 'CHUNK_CONFLICT' | 'CHECKSUM_MISMATCH' | 'CAPACITY_EXHAUSTED' | 'STORAGE_IO'
  | 'TOO_LARGE' | 'SESSION_EXPIRED' | 'SESSION_FAILED' | 'INCOMPLETE_UPLOAD';

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UploadError';
  }
}

export interface UploadServiceOptions {
  repository: UploadRepository;
  fileSystem: UploadFileSystem;
  nodeId: string;
  now?: () => string;
  maxFileBytes?: number;
  maxChunkBytes?: number;
  sessionTtlMs?: number;
}

export class UploadService {
  private readonly repository: UploadRepository;
  private readonly fileSystem: UploadFileSystem;
  private readonly nodeId: string;
  private readonly now: () => string;
  private readonly maxFileBytes: number;
  private readonly maxChunkBytes: number;
  private readonly sessionTtlMs: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: UploadServiceOptions) {
    this.repository = options.repository;
    this.fileSystem = options.fileSystem;
    this.nodeId = options.nodeId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxFileBytes = options.maxFileBytes ?? 100 * 1024 * 1024 * 1024;
    this.maxChunkBytes = options.maxChunkBytes ?? 8 * 1024 * 1024;
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  }

  async createSession(idempotencyKey: string, input: CreateUploadRequest, idempotencyScope = 'local'): Promise<UploadSessionResponse> {
    validateCreateRequest(idempotencyKey, input, this.maxFileBytes);
    const canonical = {
      libraryId: input.libraryId,
      filename: input.filename,
      originalPath: input.originalPath ?? null,
      sourceKind: input.sourceKind,
      sourceNodeId: input.sourceNodeId ?? null,
      kind: input.kind ?? 'photo',
      totalBytes: input.totalBytes,
      sha256: input.sha256
    };
    const requestFingerprint = digestJson(canonical);
    const prior = this.repository.getUploadSessionByIdempotency(idempotencyScope, idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) throw new UploadError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request');
      return toSessionResponse(prior);
    }

    const sessionId = randomUUID();
    const now = this.now();
    const record: CreateUploadSessionRecord = {
      sessionId,
      idempotencyScope,
      idempotencyKey,
      requestFingerprint,
      libraryId: canonical.libraryId,
      filename: canonical.filename,
      sourceKind: canonical.sourceKind,
      sourcePath: canonical.originalPath,
      sourceNodeId: canonical.sourceNodeId,
      kind: canonical.kind,
      totalBytes: canonical.totalBytes,
      expectedSha256: canonical.sha256,
      expiresAt: new Date(Date.parse(now) + this.sessionTtlMs).toISOString(),
      finalStorageRef: `objects/${sessionId}/original.blob`,
      now
    };
    try {
      this.repository.createUploadSession(record);
    } catch (error) {
      const raced = this.repository.getUploadSessionByIdempotency(idempotencyScope, idempotencyKey);
      if (raced && raced.requestFingerprint === requestFingerprint) return toSessionResponse(raced);
      if (raced) throw new UploadError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request', { cause: error });
      throw error;
    }
    return this.getSession(sessionId);
  }

  getSession(sessionId: string): UploadSessionResponse {
    return toSessionResponse(this.requireSession(sessionId));
  }

  async putChunk(sessionId: string, chunkIndex: number, offset: number, bytes: Uint8Array, expectedSha256: string): Promise<UploadSessionResponse> {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(offset) || offset < 0 || !isSha256(expectedSha256)) {
      throw new UploadError('INVALID_REQUEST', 'Chunk index, offset, or checksum is invalid');
    }
    if (bytes.byteLength > this.maxChunkBytes) throw new UploadError('TOO_LARGE', 'Chunk exceeds the configured size limit');
    if (digestBytes(bytes) !== expectedSha256) throw new UploadError('CHECKSUM_MISMATCH', 'Chunk checksum does not match its content');

    return this.withSessionLock(sessionId, async () => {
      const session = this.requireWritableSession(sessionId);
      this.assertNotExpired(session);
      const previous = this.repository.getUploadChunk(sessionId, chunkIndex);
      if (previous) {
        if (previous.sha256 !== expectedSha256 || previous.byteLength !== bytes.byteLength) {
          throw new UploadError('CHUNK_CONFLICT', 'Chunk index already contains different bytes');
        }
        const stagingRef = previous.stagingRef;
        const temporaryRef = `staging/${sessionId}/repair-${chunkIndex}-${randomUUID()}.tmp`;
        try {
          if (await this.fileSystem.exists(stagingRef)) {
            const stagedDigest = await this.fileSystem.hashFile(stagingRef);
            if (stagedDigest.byteLength === bytes.byteLength && stagedDigest.sha256 === expectedSha256) return toSessionResponse(session);
            await this.fileSystem.remove(stagingRef);
          }
          await this.fileSystem.writeExclusive(temporaryRef, bytes);
          await this.fileSystem.flush(temporaryRef);
          const published = await this.fileSystem.publishNoReplace(temporaryRef, stagingRef);
          if (published === 'exists') {
            await this.fileSystem.remove(temporaryRef);
            assertDigestMatches(await this.fileSystem.hashFile(stagingRef), bytes.byteLength, expectedSha256, 'staged chunk repair conflict');
          }
        } catch (error) {
          try {
            await this.fileSystem.remove(temporaryRef);
          } catch {
            // The temporary path is generated and confined to this session's staging directory.
          }
          throw mapStorageError(error);
        }
        return toSessionResponse(session);
      }
      if (offset !== session.offset) throw new UploadError('OFFSET_CONFLICT', 'Chunk offset does not match the durable upload offset');
      if (chunkIndex !== this.repository.getUploadChunks(sessionId).length) throw new UploadError('OFFSET_CONFLICT', 'Chunks must be accepted in sequence');
      if (bytes.byteLength === 0 || offset + bytes.byteLength > session.totalBytes) throw new UploadError('INVALID_REQUEST', 'Chunk length is invalid for this upload');

      const stagingRef = `staging/${sessionId}/chunk-${chunkIndex}.bin`;
      const temporaryRef = `staging/${sessionId}/chunk-${chunkIndex}-${randomUUID()}.tmp`;
      try {
        if (await this.fileSystem.exists(stagingRef)) {
          const stagedDigest = await this.fileSystem.hashFile(stagingRef);
          assertDigestMatches(stagedDigest, bytes.byteLength, expectedSha256, 'staged chunk differs from retry');
        } else {
          await this.fileSystem.writeExclusive(temporaryRef, bytes);
          await this.fileSystem.flush(temporaryRef);
          const published = await this.fileSystem.publishNoReplace(temporaryRef, stagingRef);
          if (published === 'exists') {
            await this.fileSystem.remove(temporaryRef);
            const stagedDigest = await this.fileSystem.hashFile(stagingRef);
            assertDigestMatches(stagedDigest, bytes.byteLength, expectedSha256, 'concurrent chunk differs');
          }
        }

        const now = this.now();
        const record: UploadChunkRecord = {
          sessionId, chunkIndex, byteLength: bytes.byteLength, sha256: expectedSha256,
          stagingRef, acceptedOffset: offset, createdAt: now
        };
        try {
          this.repository.recordChunk(record, offset, now);
        } catch (error) {
          const raced = this.repository.getUploadChunk(sessionId, chunkIndex);
          if (raced?.sha256 === expectedSha256 && raced.byteLength === bytes.byteLength) return this.getSession(sessionId);
          if (error instanceof RepositoryConflictError) throw new UploadError('OFFSET_CONFLICT', 'Upload offset changed concurrently', { cause: error });
          throw error;
        }
      } catch (error) {
        try {
          await this.fileSystem.remove(temporaryRef);
        } catch {
          // The temporary path is generated and confined to this session's staging directory.
        }
        throw mapStorageError(error);
      }
      return this.getSession(sessionId);
    });
  }

  async complete(sessionId: string): Promise<UploadCompleteResponse> {
    return this.withSessionLock(sessionId, () => this.completeLocked(sessionId));
  }

  async recoverAndComplete(sessionId: string): Promise<UploadCompleteResponse> {
    return this.complete(sessionId);
  }

  private async completeLocked(sessionId: string): Promise<UploadCompleteResponse> {
    let session = this.requireSession(sessionId);
    if (session.state === 'completed' && session.assetId && session.fileId) {
      await this.cleanupStaging(sessionId);
      return toCompleteResponse(session);
    }
    if (session.state === 'failed') throw new UploadError('SESSION_FAILED', 'Upload session is failed');
    this.assertNotExpired(session);
    if (session.offset !== session.totalBytes) throw new UploadError('INCOMPLETE_UPLOAD', 'Not all declared bytes have been accepted');
    const chunks = this.repository.getUploadChunks(sessionId);
    if (!areChunksContiguous(chunks, session.totalBytes)) throw new UploadError('INCOMPLETE_UPLOAD', 'Upload chunk manifest is incomplete');
    this.repository.markVerifying(sessionId, this.now());
    session = this.requireSession(sessionId);

    try {
      let digest: FileDigest;
      if (await this.fileSystem.exists(session.finalStorageRef)) {
        digest = await this.fileSystem.hashFile(session.finalStorageRef);
      } else {
        const temporaryRef = `staging/${sessionId}/assembled.tmp`;
        if (await this.fileSystem.exists(temporaryRef)) await this.fileSystem.remove(temporaryRef);
        digest = await this.fileSystem.assembleAndHash(chunks.map((chunk) => chunk.stagingRef), temporaryRef);
        if (digest.byteLength !== session.totalBytes || digest.sha256 !== session.expectedSha256) {
          this.repository.markFailed(sessionId, this.now());
          throw new UploadError('CHECKSUM_MISMATCH', 'Complete file checksum does not match the declared content');
        }
        await this.fileSystem.flush(temporaryRef);
        const published = await this.fileSystem.publishNoReplace(temporaryRef, session.finalStorageRef);
        if (published === 'exists') digest = await this.fileSystem.hashFile(session.finalStorageRef);
      }
      if (digest.byteLength !== session.totalBytes || digest.sha256 !== session.expectedSha256) {
        this.repository.markFailed(sessionId, this.now());
        throw new UploadError('CHECKSUM_MISMATCH', 'Published object checksum does not match the declared content');
      }
      this.repository.finalizeUpload(sessionId, randomUUID(), randomUUID(), randomUUID(), this.nodeId, this.now());
      const completed = this.requireSession(sessionId);
      await this.cleanupStaging(sessionId);
      return toCompleteResponse(completed);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw mapStorageError(error);
    }
  }

  private requireSession(sessionId: string): UploadSessionRecord {
    const session = this.repository.getUploadSession(sessionId);
    if (!session) throw new UploadError('NOT_FOUND', 'Upload session does not exist');
    return session;
  }

  private requireWritableSession(sessionId: string): UploadSessionRecord {
    const session = this.requireSession(sessionId);
    if (session.state === 'completed') throw new UploadError('SESSION_FAILED', 'Upload session is already completed');
    if (session.state === 'failed') throw new UploadError('SESSION_FAILED', 'Upload session is failed');
    return session;
  }

  private assertNotExpired(session: UploadSessionRecord): void {
    if (Date.parse(session.expiresAt) <= Date.parse(this.now())) throw new UploadError('SESSION_EXPIRED', 'Upload session has expired');
  }

  private async cleanupStaging(sessionId: string): Promise<void> {
    try {
      await this.fileSystem.removeTree(`staging/${sessionId}`);
    } catch {
      // Successful objects and metadata are durable; failed staging cleanup can be retried on completion replay.
    }
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    this.locks.set(sessionId, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }
}

function validateCreateRequest(key: string, input: CreateUploadRequest, maxFileBytes: number): void {
  if (key.length < 16 || key.length > 256 || !/^[\x21-\x7e]+$/.test(key)) throw new UploadError('INVALID_REQUEST', 'Idempotency key must contain 16-256 visible ASCII characters');
  if (!input.libraryId || input.libraryId.includes('\0') || !input.filename || input.filename.includes('\0')) throw new UploadError('INVALID_REQUEST', 'Library ID and original filename are required');
  if (input.originalPath?.includes('\0') || input.sourceNodeId?.includes('\0')) throw new UploadError('INVALID_REQUEST', 'Source metadata contains invalid characters');
  if (!['upload', 'import'].includes(input.sourceKind) || (input.kind && !['photo', 'video', 'live_photo'].includes(input.kind))) throw new UploadError('INVALID_REQUEST', 'Source kind or asset kind is invalid');
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0) throw new UploadError('INVALID_REQUEST', 'Total byte length must be a non-negative safe integer');
  if (input.totalBytes > maxFileBytes) throw new UploadError('TOO_LARGE', 'File exceeds the configured size limit');
  if (!isSha256(input.sha256)) throw new UploadError('INVALID_REQUEST', 'File checksum must be lowercase SHA-256 hex');
}

function areChunksContiguous(chunks: readonly UploadChunkRecord[], totalBytes: number): boolean {
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.chunkIndex !== index || chunk.acceptedOffset !== offset) return false;
    offset += chunk.byteLength;
  }
  return offset === totalBytes;
}

function assertDigestMatches(digest: FileDigest, byteLength: number, sha256: string, message: string): void {
  if (digest.byteLength !== byteLength || digest.sha256 !== sha256) throw new UploadError('CHUNK_CONFLICT', message);
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function toSessionResponse(session: UploadSessionRecord): UploadSessionResponse {
  return { sessionId: session.sessionId, offset: session.offset, expiresAt: session.expiresAt, state: session.state };
}

function toCompleteResponse(session: UploadSessionRecord): UploadCompleteResponse {
  if (!session.assetId || !session.fileId) throw new UploadError('STORAGE_IO', 'Completed upload is missing committed metadata');
  return {
    sessionId: session.sessionId,
    assetId: session.assetId,
    fileId: session.fileId,
    sha256: session.expectedSha256,
    byteLength: session.totalBytes,
    storageRef: session.finalStorageRef
  };
}

function mapStorageError(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'ENOSPC') return new UploadError('CAPACITY_EXHAUSTED', 'Managed storage has insufficient capacity', { cause: error });
  if (code === 'EIO' || code === 'ENOENT' || code === 'EEXIST' || code === 'EPERM') return new UploadError('STORAGE_IO', 'Managed storage operation failed', { cause: error });
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new UploadError('STORAGE_IO', `Upload persistence operation failed${detail}`, { cause: error });
}
