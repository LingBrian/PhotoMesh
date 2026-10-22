import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/db/repository.js';
import { UploadError, UploadService, type CreateUploadRequest } from '../src/uploads/service.js';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { makeUnsignedEvent, signEvent } from '../src/sync/event-envelope.js';
import { VirtualFileSystem } from './support/virtual-file-system.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = new TextEncoder().encode('immutable-original');
const chunkSize = 6;

async function fixture(capacityBytes = Infinity, serviceOptions: { maxFileBytes?: number; maxChunkBytes?: number; sessionTtlMs?: number } = {}) {
  const db = new Database(':memory:');
  const repositoryFaults = { failFinalize: false, failRecordChunk: false };
  const repository = new SqliteRepository(db, {
    beforeRecordChunk: () => {
      if (repositoryFaults.failRecordChunk) {
        repositoryFaults.failRecordChunk = false;
        throw new Error('injected chunk metadata failure');
      }
    },
    beforeFinalize: () => {
      if (repositoryFaults.failFinalize) {
        repositoryFaults.failFinalize = false;
        throw new Error('injected metadata failure');
      }
    }
  });
  await repository.migrate();
  const fileSystem = new VirtualFileSystem({ capacityBytes });
  fileSystem.seed('/source/2026/original.jpg', sourceBytes);
  const service = new UploadService({ repository, fileSystem, nodeId: 'node-local', now: () => '2026-10-21T00:00:00.000Z', ...serviceOptions });
  return {
    db, repository, fileSystem, service,
    failFinalize: () => { repositoryFaults.failFinalize = true; },
    failRecordChunk: () => { repositoryFaults.failRecordChunk = true; }
  };
}

const request = {
  libraryId: 'library-1', filename: 'original.jpg', originalPath: '/source/2026/original.jpg',
  sourceKind: 'import' as const, sourceNodeId: 'phone-1', totalBytes: sourceBytes.byteLength,
  sha256: sha256(sourceBytes)
};

describe('immutable resumable upload pipeline', () => {
  it('commits an unsigned sync draft atomically with upload metadata and recovers its signature on retry', async () => {
    const { db, repository, fileSystem } = await fixture();
    const secrets = new Map<string, string>();
    const identity = await loadOrCreateLocalIdentity(repository, {
      get: (name) => secrets.get(name), set: (name, value) => { secrets.set(name, value); }
    });
    const syncRepository = new SyncRepository(db);
    let interrupted = true;
    const service = new UploadService({
      repository, fileSystem, nodeId: identity.peerId,
      createEventDraft: (session, assetId) => (context) => makeUnsignedEvent({
        libraryId: session.libraryId, authorPeerId: identity.peerId, authorSequence: context.authorSequence,
        causalParents: context.causalParents, eventType: 'asset.indexed', createdAt: '2026-10-21T00:00:00.000Z',
        payload: { assetId, originNodeId: identity.peerId, kind: session.kind, sha256: session.expectedSha256, byteLength: session.totalBytes }
      }),
      signPendingEvents: async () => {
        if (interrupted) { interrupted = false; throw new Error('injected signing interruption'); }
        for (const draft of syncRepository.getUnsignedLocalDrafts(identity.peerId)) {
          syncRepository.completeLocalDraft(await signEvent(draft, identity));
        }
      }
    });
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    await expect(service.complete(session.sessionId)).rejects.toThrow('injected signing interruption');
    expect(repository.getUploadSession(session.sessionId)?.state).toBe('completed');
    expect(db.prepare("SELECT state FROM sync_event_log WHERE event_type = 'asset.indexed'").get()).toEqual({ state: 'signing' });
    const completed = await service.complete(session.sessionId);
    expect(completed.assetId).toBeTruthy();
    expect(db.prepare("SELECT state, signature FROM sync_event_log WHERE event_type = 'asset.indexed'").get())
      .toMatchObject({ state: 'ready', signature: expect.any(String) });
    expect(syncRepository.getProjection(request.libraryId, completed.assetId)?.sha256).toBe(request.sha256);
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    db.close();
  });

  it('rolls back asset, location, and event rows together if event reservation fails', async () => {
    const { db, repository, fileSystem } = await fixture();
    const service = new UploadService({
      repository, fileSystem, nodeId: 'node-local',
      createEventDraft: () => () => { throw new Error('injected event reservation failure'); }
    });
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    await expect(service.complete(session.sessionId)).rejects.toThrow('injected event reservation failure');
    expect(db.prepare('SELECT count(*) AS count FROM assets').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM file_locations').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM sync_event_log').get()).toEqual({ count: 0 });
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    db.close();
  });

  it('commits only after complete SHA-256 verification and preserves source metadata and bytes', async () => {
    const { db, repository, fileSystem, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    for (let offset = 0, index = 0; offset < sourceBytes.byteLength; index += 1) {
      const chunk = sourceBytes.slice(offset, offset + chunkSize);
      await service.putChunk(session.sessionId, index, offset, chunk, sha256(chunk));
      offset += chunk.byteLength;
    }

    expect(repository.getUploadSession(session.sessionId)?.state).toBe('uploading');
    const result = await service.complete(session.sessionId);
    expect(result.sha256).toBe(request.sha256);
    expect(repository.getUploadSession(session.sessionId)?.state).toBe('completed');
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    expect(repository.getLocationForSession(session.sessionId)).toMatchObject({
      originalFilename: 'original.jpg', originalPath: '/source/2026/original.jpg', sourceNodeId: 'phone-1'
    });
    expect(fileSystem.read(result.storageRef)).toEqual(sourceBytes);
    expect(await fileSystem.exists(`staging/${session.sessionId}/chunk-0.bin`)).toBe(false);

    db.close();
  });

  it('returns the same session for a repeated key and rejects a changed request', async () => {
    const { db, service } = await fixture();
    const first = await service.createSession('0123456789abcdef', request);
    const duplicate = await service.createSession('0123456789abcdef', request);
    expect(duplicate.sessionId).toBe(first.sessionId);
    await expect(service.createSession('0123456789abcdef', { ...request, filename: 'different.jpg' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    db.close();
  });

  it('makes identical chunks idempotent, rejects conflicting bytes, and serializes concurrent retries', async () => {
    const { db, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);
    const hash = sha256(chunk);

    await Promise.all([
      service.putChunk(session.sessionId, 0, 0, chunk, hash),
      service.putChunk(session.sessionId, 0, 0, chunk, hash)
    ]);
    await expect(service.putChunk(session.sessionId, 0, 0, new TextEncoder().encode('wrong!'), sha256(new TextEncoder().encode('wrong!'))))
      .rejects.toMatchObject({ code: 'CHUNK_CONFLICT' });
    expect(service.getSession(session.sessionId).offset).toBe(chunkSize);
    db.close();
  });

  it('keeps the accepted offset on capacity failure and never reports completion', async () => {
    const { db, repository, fileSystem, service } = await fixture(0);
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);

    await expect(service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk)))
      .rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(0);
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    await expect(service.complete(session.sessionId)).rejects.toBeInstanceOf(UploadError);
    expect(repository.getUploadSession(session.sessionId)?.state).not.toBe('completed');
    db.close();
  });

  it('does not complete when the full-file checksum differs', async () => {
    const { db, repository, service } = await fixture();
    const badRequest = { ...request, sha256: '0'.repeat(64) };
    const session = await service.createSession('0123456789abcdef', badRequest);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));

    await expect(service.complete(session.sessionId)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(repository.getUploadSession(session.sessionId)?.state).not.toBe('completed');
    await expect(service.complete(session.sessionId)).rejects.toMatchObject({ code: 'SESSION_FAILED' });
    db.close();
  });

  it('recovers a crash after atomic publication but before metadata commit', async () => {
    const { db, repository, fileSystem, service, failFinalize } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    failFinalize();

    await expect(service.complete(session.sessionId)).rejects.toThrow('injected metadata failure');
    expect(repository.getUploadSession(session.sessionId)?.state).not.toBe('completed');
    const result = await service.recoverAndComplete(session.sessionId);
    expect(repository.getUploadSession(session.sessionId)?.state).toBe('completed');
    expect(fileSystem.read(result.storageRef)).toEqual(sourceBytes);
    db.close();
  });

  it('rejects wrong chunk hash and leaves the session offset unchanged', async () => {
    const { db, repository, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);
    await expect(service.putChunk(session.sessionId, 0, 0, chunk, 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(0);
    db.close();
  });

  it('retries after a crash during no-replace chunk publication', async () => {
    const { db, repository, fileSystem, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);
    fileSystem.failNext('publishNoReplace', 'EIO');
    await expect(service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk))).rejects.toMatchObject({ code: 'STORAGE_IO' });
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(0);

    await service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk));
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(chunkSize);
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    db.close();
  });

  it('reconciles a durable staged chunk when the SQLite chunk transaction rolls back', async () => {
    const { db, repository, fileSystem, service, failRecordChunk } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);
    failRecordChunk();

    await expect(service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk))).rejects.toMatchObject({ code: 'STORAGE_IO' });
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(0);
    expect(await fileSystem.exists(`staging/${session.sessionId}/chunk-0.bin`)).toBe(true);

    await service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk));
    expect(repository.getUploadSession(session.sessionId)?.offset).toBe(chunkSize);
    expect(fileSystem.read('/source/2026/original.jpg')).toEqual(sourceBytes);
    db.close();
  });

  it('returns an already completed result idempotently', async () => {
    const { db, fileSystem, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    fileSystem.failNext('removeTree', 'EIO');
    const first = await service.complete(session.sessionId);
    const repeated = await service.complete(session.sessionId);
    expect(repeated).toEqual(first);
    expect(await fileSystem.exists(`staging/${session.sessionId}/chunk-0.bin`)).toBe(false);
    db.close();
  });

  it('repairs a missing or corrupt accepted staging chunk on an identical retry', async () => {
    const { db, fileSystem, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, chunkSize);
    await service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk));
    fileSystem.seed(`staging/${session.sessionId}/chunk-0.bin`, new TextEncoder().encode('corrupt'));
    await service.putChunk(session.sessionId, 0, 0, chunk, sha256(chunk));
    expect(await fileSystem.hashFile(`staging/${session.sessionId}/chunk-0.bin`)).toEqual({ byteLength: chunkSize, sha256: sha256(chunk) });
    db.close();
  });

  it('rejects invalid request metadata and configured size limits', async () => {
    const { db, repository, fileSystem, service } = await fixture();
    const invalidRequests: Array<[string, CreateUploadRequest]> = [
      ['0123456789abcdef', { ...request, libraryId: '' }],
      ['0123456789abcdef', { ...request, filename: 'bad\0name.jpg' }],
      ['0123456789abcdef', { ...request, originalPath: 'bad\0path' }],
      ['0123456789abcdef', { ...request, sourceKind: 'other' as never }],
      ['0123456789abcdef', { ...request, kind: 'raw' as never }],
      ['0123456789abcdef', { ...request, totalBytes: -1 }],
      ['0123456789abcdef', { ...request, sha256: 'ABC' }],
      ['short', request],
      ['x'.repeat(257), request],
      ['0123456789abcde\u0000', request]
    ];
    for (const [key, invalid] of invalidRequests) {
      await expect(service.createSession(key, invalid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    const limited = new UploadService({ repository, fileSystem, nodeId: 'node-limited', maxFileBytes: 1 });
    await expect(limited.createSession('0123456789abcdef', request)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    db.close();
  });

  it('rejects invalid, missing, expired, incomplete, and out-of-order chunk operations', async () => {
    const { db, repository, fileSystem, service } = await fixture(Infinity, { maxChunkBytes: 4 });
    expect(() => service.getSession('missing-session')).toThrow(UploadError);
    const session = await service.createSession('0123456789abcdef', request);
    const chunk = sourceBytes.slice(0, 3);
    const oversized = sourceBytes.slice(0, 5);
    await expect(service.putChunk(session.sessionId, 0, 0, oversized, sha256(oversized)))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(service.putChunk(session.sessionId, 1, 0, chunk, sha256(chunk)))
      .rejects.toMatchObject({ code: 'OFFSET_CONFLICT' });
    await expect(service.putChunk(session.sessionId, 0, 1, chunk, sha256(chunk)))
      .rejects.toMatchObject({ code: 'OFFSET_CONFLICT' });
    await expect(service.putChunk(session.sessionId, 0, 0, new Uint8Array(), sha256(new Uint8Array())))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.complete(session.sessionId)).rejects.toMatchObject({ code: 'INCOMPLETE_UPLOAD' });

    const expiredService = new UploadService({ repository, fileSystem, nodeId: 'node-local', sessionTtlMs: 0, now: () => '2026-10-21T00:00:00.000Z' });
    const expired = await expiredService.createSession('abcdef0123456789', request);
    await expect(expiredService.putChunk(expired.sessionId, 0, 0, chunk, sha256(chunk)))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(service.putChunk('absent-session', 0, 0, chunk, sha256(chunk)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    db.close();
  });

  it('replaces a stale assembly temporary file and supports empty originals', async () => {
    const { db, fileSystem, service } = await fixture();
    const empty = new Uint8Array();
    const session = await service.createSession('0123456789abcdef', {
      libraryId: 'library-empty', filename: 'empty.bin', sourceKind: 'upload', totalBytes: 0, sha256: sha256(empty)
    });
    fileSystem.seed(`staging/${session.sessionId}/assembled.tmp`, new TextEncoder().encode('stale'));
    const result = await service.complete(session.sessionId);
    expect(result.byteLength).toBe(0);
    expect(fileSystem.read(result.storageRef)).toEqual(empty);
    db.close();
  });

  it('refuses a pre-existing object with different bytes and marks the session failed', async () => {
    const { db, repository, fileSystem, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    const conflictingObject = new TextEncoder().encode('other-object');
    fileSystem.seed(`objects/${session.sessionId}/original.blob`, conflictingObject);

    await expect(service.complete(session.sessionId)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(repository.getUploadSession(session.sessionId)?.state).toBe('failed');
    expect(fileSystem.read(`objects/${session.sessionId}/original.blob`)).toEqual(conflictingObject);
    db.close();
  });

  it('does not complete if the persisted chunk manifest is inconsistent', async () => {
    const { db, repository, service } = await fixture();
    const session = await service.createSession('0123456789abcdef', request);
    await service.putChunk(session.sessionId, 0, 0, sourceBytes, sha256(sourceBytes));
    db.prepare('UPDATE upload_chunks SET accepted_offset = 1 WHERE session_id = ? AND chunk_index = 0').run(session.sessionId);
    await expect(service.complete(session.sessionId)).rejects.toMatchObject({ code: 'INCOMPLETE_UPLOAD' });
    expect(repository.getUploadSession(session.sessionId)?.state).not.toBe('completed');
    db.close();
  });
});
