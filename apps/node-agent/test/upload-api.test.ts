import { createHash } from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/db/repository.js';
import { createNodeAgentServer } from '../src/server.js';
import { UploadService } from '../src/uploads/service.js';
import { VirtualFileSystem } from './support/virtual-file-system.js';

const bytes = new TextEncoder().encode('api-original-bytes');
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const servers: ReturnType<typeof createNodeAgentServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

async function createFixture(authorize = true, options: { capacityBytes?: number; maxChunkBytes?: number; sessionTtlMs?: number; maxRequestBytes?: number } = {}) {
  const db = new Database(':memory:');
  const repository = new SqliteRepository(db);
  await repository.migrate();
  const fileSystem = new VirtualFileSystem(options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes });
  const service = new UploadService({ repository, fileSystem, nodeId: 'node-api', now: () => '2026-10-21T00:00:00.000Z', ...options });
  const server = createNodeAgentServer({
    uploadService: service,
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    authorizeUpload: ({ token }) => authorize && token === 'valid-token' ? { principalId: 'device-1' } : undefined
  });
  servers.push(server);
  return { db, repository, fileSystem, server };
}

async function listen(server: ReturnType<typeof createNodeAgentServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('upload HTTP API', () => {
  it('denies upload access when no authorizer is configured', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    const service = new UploadService({ repository, fileSystem: new VirtualFileSystem(), nodeId: 'node-api' });
    const server = createNodeAgentServer({ uploadService: service });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': '0123456789abcdef' },
      body: JSON.stringify({ libraryId: 'lib', filename: 'x.jpg', sourceKind: 'upload', totalBytes: 0, sha256: hash(new Uint8Array()) })
    });
    expect(response.status).toBe(403);
    db.close();
  });

  it('authorizes, accepts chunks, and only returns completion after commit', async () => {
    const { db, repository, fileSystem, server } = await createFixture();
    const baseUrl = await listen(server);
    const headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json', 'Idempotency-Key': '0123456789abcdef' };
    const create = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST', headers,
      body: JSON.stringify({
        libraryId: 'library-api', filename: 'camera.jpg', originalPath: 'DCIM/2026/camera.jpg',
        sourceKind: 'import', sourceNodeId: 'phone-1', totalBytes: bytes.byteLength, sha256: hash(bytes)
      })
    });
    expect(create.status).toBe(201);
    const session = await create.json() as { sessionId: string; state: string };
    expect(session.state).toBe('created');

    const chunk = await fetch(`${baseUrl}/v1/uploads/${session.sessionId}/chunks/0`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer valid-token', 'content-type': 'application/octet-stream',
        'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(bytes)
      },
      body: bytes
    });
    expect(chunk.status).toBe(200);
    expect(await chunk.json()).toMatchObject({ state: 'uploading', offset: bytes.byteLength });

    const complete = await fetch(`${baseUrl}/v1/uploads/${session.sessionId}/complete`, {
      method: 'POST', headers: { authorization: 'Bearer valid-token' }
    });
    expect(complete.status).toBe(200);
    const result = await complete.json() as { storageRef: string; sha256: string };
    expect(result.sha256).toBe(hash(bytes));
    expect(fileSystem.read(result.storageRef)).toEqual(bytes);
    expect(repository.getUploadSession(session.sessionId)?.state).toBe('completed');
    db.close();
  });

  it('maps malformed, unauthorized, missing, and conflicting HTTP requests', async () => {
    const { db, server } = await createFixture();
    const baseUrl = await listen(server);
    const body = {
      libraryId: 'library-api', filename: 'camera.jpg', sourceKind: 'upload',
      totalBytes: bytes.byteLength, sha256: hash(bytes)
    };
    const malformed = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST', headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' }, body: '{'
    });
    expect(malformed.status).toBe(400);
    const missingKey = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST', headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(missingKey.status).toBe(400);
    const create = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST', headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json', 'Idempotency-Key': 'abcdef0123456789' },
      body: JSON.stringify(body)
    });
    const session = await create.json() as { sessionId: string };
    const changedReplay = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST', headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json', 'Idempotency-Key': 'abcdef0123456789' },
      body: JSON.stringify({ ...body, libraryId: 'different-library' })
    });
    expect(changedReplay.status).toBe(409);
    const sessionUrl = `${baseUrl}/v1/uploads/${session.sessionId}`;
    expect((await fetch(sessionUrl)).status).toBe(403);
    expect((await fetch(`${sessionUrl}/chunks/0`, { method: 'PUT', body: bytes })).status).toBe(403);
    expect((await fetch(`${sessionUrl}/complete`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${baseUrl}/v1/uploads/missing-session`, { headers: { authorization: 'Bearer valid-token' } })).status).toBe(404);
    expect((await fetch(sessionUrl, { headers: { authorization: 'Bearer valid-token' } })).status).toBe(200);

    const invalidOffset = await fetch(`${sessionUrl}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': 'bad', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(invalidOffset.status).toBe(400);
    const badChunkHash = await fetch(`${sessionUrl}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': 'f'.repeat(64) }, body: bytes
    });
    expect(badChunkHash.status).toBe(422);
    const badOffset = await fetch(`${sessionUrl}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '1', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(badOffset.status).toBe(409);
    const incomplete = await fetch(`${sessionUrl}/complete`, { method: 'POST', headers: { authorization: 'Bearer valid-token' } });
    expect(incomplete.status).toBe(409);
    const accepted = await fetch(`${sessionUrl}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(accepted.status).toBe(200);
    const conflictingChunk = new TextEncoder().encode('different-bytes');
    const chunkConflict = await fetch(`${sessionUrl}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(conflictingChunk) }, body: conflictingChunk
    });
    expect(chunkConflict.status).toBe(409);
    expect((await fetch(`${baseUrl}/v1/uploads/${session.sessionId}/other`)).status).toBe(404);
    db.close();
  });

  it('maps capacity, chunk limits, and expiry to stable HTTP statuses', async () => {
    const payload = { libraryId: 'l', filename: 'f', sourceKind: 'upload', totalBytes: bytes.byteLength, sha256: hash(bytes) };
    const auth = (key: string) => ({ authorization: 'Bearer valid-token', 'content-type': 'application/json', 'Idempotency-Key': key });

    const limited = await createFixture(true, { maxChunkBytes: 2 });
    const limitedBase = await listen(limited.server);
    const limitedCreate = await fetch(`${limitedBase}/v1/uploads`, { method: 'POST', headers: auth('0123456789abcdef'), body: JSON.stringify(payload) });
    const limitedSession = await limitedCreate.json() as { sessionId: string };
    const tooLarge = await fetch(`${limitedBase}/v1/uploads/${limitedSession.sessionId}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(tooLarge.status).toBe(413);
    limited.db.close();

    const full = await createFixture(true, { capacityBytes: 0 });
    const fullBase = await listen(full.server);
    const fullCreate = await fetch(`${fullBase}/v1/uploads`, { method: 'POST', headers: auth('abcdef0123456789'), body: JSON.stringify(payload) });
    const fullSession = await fullCreate.json() as { sessionId: string };
    const noCapacity = await fetch(`${fullBase}/v1/uploads/${fullSession.sessionId}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(noCapacity.status).toBe(507);
    full.db.close();

    const expired = await createFixture(true, { sessionTtlMs: 0 });
    const expiredBase = await listen(expired.server);
    const expiredCreate = await fetch(`${expiredBase}/v1/uploads`, { method: 'POST', headers: auth('fedcba9876543210'), body: JSON.stringify(payload) });
    const expiredSession = await expiredCreate.json() as { sessionId: string };
    const expiredWrite = await fetch(`${expiredBase}/v1/uploads/${expiredSession.sessionId}/chunks/0`, {
      method: 'PUT', headers: { authorization: 'Bearer valid-token', 'Upload-Offset': '0', 'Upload-Chunk-SHA256': hash(bytes) }, body: bytes
    });
    expect(expiredWrite.status).toBe(410);
    expired.db.close();
  });
});
