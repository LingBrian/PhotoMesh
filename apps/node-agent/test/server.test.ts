import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createNodeAgentServer, type MediaVersionServerControl, type NodeAgentServerOptions, type PairingServerControl } from '../src/server.js';
import { MediaThumbnailService } from '../src/media/thumbnail-service.js';
import type { MediaThumbnailTransformer } from '../src/media/image-transformer.js';
import { RepositoryConflictError, type MediaVersionSourceRecord } from '../src/db/repository.js';

const servers: ReturnType<typeof createNodeAgentServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function request(path: string, options: NodeAgentServerOptions = {}, init?: RequestInit) {
  const server = createNodeAgentServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP address');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('node-agent health endpoint', () => {
  it('returns the health contract on loopback', async () => {
    const response = await request('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: [] });
  });

  it('advertises tag-sync capability independently from tag API availability', async () => {
    const response = await request('/v1/health', { assetTags: { addAssetTag: () => 'added', removeAssetTag: () => 'removed' }, tagSync: true });
    expect((await response.json() as { capabilities: string[] }).capabilities).toEqual(['assetTags', 'tagSync']);
  });

  it('advertises virtual albums only when the album service is configured', async () => {
    const unavailable = await request('/v1/health');
    expect((await unavailable.json() as { capabilities: string[] }).capabilities).not.toContain('virtualAlbums');
    const available = await request('/v1/health', { albums: {
      listAlbums: () => ({ items: [], nextCursor: null }), createAlbum: () => undefined,
      listMembers: () => undefined, addMember: () => ({ status: 'not_found' }), removeMember: () => ({ status: 'not_found' })
    } });
    expect((await available.json() as { capabilities: string[] }).capabilities).toContain('virtualAlbums');
  });

  it('protects component diagnostics and omits internal error details', async () => {
    const sensitivePath = 'D:\\\\Users\\\\private\\\\photos';
    const checkDatabase = vi.fn(() => { throw new Error(sensitivePath); });
    const options: NodeAgentServerOptions = {
      authorizePairingAdmin: (token) => token === 'admin-token',
      diagnostics: {
        checkDatabase,
        checkStorage: () => undefined,
        apiCapabilities: () => ['rest'],
        storageCapabilities: () => ['managedFiles'],
        identityCapabilities: () => []
      }
    };

    const denied = await request('/v1/diagnostics', options);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(await denied.json()).toMatchObject({ error: 'forbidden' });
    expect(checkDatabase).not.toHaveBeenCalled();

    const response = await request('/v1/diagnostics', options, {
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      status: 'unavailable',
      readiness: 'not_ready',
      components: {
        api: { status: 'ok', capabilities: ['rest'] },
        database: { status: 'unavailable', capabilities: ['sqlite'] },
        storage: { status: 'ok', capabilities: ['managedFiles'] },
        identity: { status: 'unavailable', capabilities: [] }
      }
    });
    expect(JSON.stringify(body)).not.toContain(sensitivePath);
    expect(checkDatabase).toHaveBeenCalledOnce();
  });

  it('returns a structured 404 for unknown paths', async () => {
    const response = await request('/private');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('authorized thumbnail endpoint', () => {
  it('checks library ACL before invoking thumbnail service and returns bounded private WebP bytes', async () => {
    const bytes = Buffer.from('derived-webp');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const authorizeLibraryRead = vi.fn((token: string | undefined, libraryId: string) =>
      token === 'reader' && libraryId === 'library' ? 'reader-1' : undefined);
    const readThumbnail = vi.fn(async () => ({
      bytes, sha256, byteSize: bytes.byteLength, width: 192, height: 96, mimeType: 'image/webp' as const
    }));
    const options = { authorizeLibraryRead, thumbnails: { readThumbnail } } as NodeAgentServerOptions;
    const path = '/v1/libraries/library/assets/asset/thumbnail?profile=timeline-192';

    const denied = await request(path, options);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: 'not_found' });
    expect(readThumbnail).not.toHaveBeenCalled();

    const unauthorizedLibrary = await request('/v1/libraries/other-library/assets/asset/thumbnail?profile=timeline-192', options, {
      headers: { authorization: 'Bearer reader' }
    });
    expect(unauthorizedLibrary.status).toBe(404);
    expect(readThumbnail).not.toHaveBeenCalled();

    const response = await request(path, options, { headers: { authorization: 'Bearer reader' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('etag')).toBe(`"${sha256}"`);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(authorizeLibraryRead).toHaveBeenCalledWith('reader', 'library');
    expect(readThumbnail).toHaveBeenCalledWith('library', 'asset', 'timeline-192');

    const cacheHitResponse = await request(path, options, { headers: { authorization: 'Bearer reader' } });
    expect(cacheHitResponse.status).toBe(200);
    expect((await cacheHitResponse.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    expect(readThumbnail).toHaveBeenCalledTimes(2);
    expect(authorizeLibraryRead).toHaveBeenCalledTimes(6);

    const invalidProfile = await request('/v1/libraries/library/assets/asset/thumbnail?profile=original', options, {
      headers: { authorization: 'Bearer reader' }
    });
    expect(invalidProfile.status).toBe(400);
    expect(readThumbnail).toHaveBeenCalledTimes(2);
  });

  it('keeps a warm derived cache inaccessible after ACL revocation', async () => {
    const originalBytes = Buffer.from('private-original-bytes');
    const derivedBytes = Buffer.from('derived-webp-only');
    const source: MediaVersionSourceRecord = {
      libraryId: 'library', assetId: 'asset', sourceVersionId: null, kind: 'photo', filename: 'private.jpg',
      sha256: createHash('sha256').update(originalBytes).digest('hex'), byteSize: originalBytes.byteLength,
      storageRef: 'objects/asset/original.blob', originalPath: null, availability: 'online', mimeType: null
    };
    const getSource = vi.fn(() => source);
    const openOriginal = vi.fn(async () => Readable.from([originalBytes]));
    const transformer: MediaThumbnailTransformer = {
      createThumbnail: vi.fn(async () => ({ bytes: derivedBytes, mimeType: 'image/webp' as const, width: 1, height: 1 }))
    };
    const thumbnailService = new MediaThumbnailService({ getSource, openOriginal, transformer });
    let allowed = true;
    const options: NodeAgentServerOptions = {
      authorizeLibraryRead: (_token, libraryId) => allowed && libraryId === 'library' ? 'reader' : undefined,
      thumbnails: { readThumbnail: (libraryId, assetId, profile) => thumbnailService.getThumbnail(libraryId, assetId, profile) }
    };
    const path = '/v1/libraries/library/assets/asset/thumbnail?profile=timeline-192';
    const headers = { authorization: 'Bearer reader' };

    const first = await request(path, options, { headers });
    expect(first.status).toBe(200);
    const firstBody = Buffer.from(await first.arrayBuffer());
    expect(firstBody).toEqual(derivedBytes);
    expect(firstBody).not.toEqual(originalBytes);
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(openOriginal).toHaveBeenCalledTimes(1);

    allowed = false;
    const revoked = await request(path, options, { headers });
    expect(revoked.status).toBe(404);
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(openOriginal).toHaveBeenCalledTimes(1);

    allowed = true;
    const cached = await request(path, options, { headers });
    expect(cached.status).toBe(200);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(derivedBytes);
    expect(getSource).toHaveBeenCalledTimes(3);
    expect(openOriginal).toHaveBeenCalledTimes(1);
  });

  it('advertises the optional thumbnail capability only when configured', async () => {
    const response = await request('/v1/health', {
      thumbnails: { readThumbnail: async () => ({ bytes: Buffer.from('x'), sha256: 'c'.repeat(64), byteSize: 1, width: 1, height: 1, mimeType: 'image/webp' }) }
    } as NodeAgentServerOptions);
    expect((await response.json() as { capabilities: string[] }).capabilities).toContain('thumbnails');
  });

  it('maps queue saturation to a bounded retry response without exposing internal details', async () => {
    const response = await request('/v1/libraries/library/assets/asset/thumbnail', {
      authorizeLibraryRead: (token, libraryId) => token === 'reader' && libraryId === 'library' ? 'reader' : undefined,
      thumbnails: {
        readThumbnail: async () => { throw Object.assign(new Error('private file path'), { code: 'QUEUE_FULL' }); }
      }
    }, { headers: { authorization: 'Bearer reader' } });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    const body = await response.text();
    expect(body).toContain('queue_full');
    expect(body).not.toContain('private file path');
  });
});

describe('pairing and library authorization endpoints', () => {
  it('requires fresh library authorization for timeline, original reads, and recycle-bin results', async () => {
    const readOriginal = vi.fn(() => ({ libraryId: 'library', filename: 'original.jpg', sha256: 'a'.repeat(64), byteSize: 3, availability: 'online', storageRef: 'objects/a/original.blob', originalPath: null }));
    const openOriginal = vi.fn(async () => Readable.from([Buffer.from('raw')]));
    const options: NodeAgentServerOptions = {
      authorizeLibraryList: (token) => token === 'admin',
      authorizeLibraryRead: (token, libraryId) => token === 'admin' && libraryId === 'library' ? 'local-admin' : undefined,
      gallery: {
        listLibraries: () => [{ libraryId: 'library', title: 'library' }],
        listAssets: () => ({ items: [{ assetId: 'asset' }], nextCursor: null }),
        getOriginal: async () => readOriginal(),
        openOriginal,
        listTombstones: () => [{ assetId: 'deleted', libraryId: 'library', eventId: 'evt' }],
        restoreTombstone: async () => ({ status: 'restored', restoreEventId: 'restore-event' })
      }
    };
    const noAuth = await request('/v1/libraries', options);
    expect(noAuth.status).toBe(403);
    const denied = await request('/v1/assets/asset/original', options);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('raw');
    expect(readOriginal).toHaveBeenCalledTimes(1);
    expect(openOriginal).not.toHaveBeenCalled();
    const authorizedPage = await request('/v1/assets?libraryId=library&limit=1', options, { headers: { authorization: 'Bearer admin' } });
    expect(await authorizedPage.json()).toEqual({ items: [{ assetId: 'asset' }], nextCursor: null });
    const authorizedOriginal = await request('/v1/assets/asset/original', options, { headers: { authorization: 'Bearer admin' } });
    expect(authorizedOriginal.status).toBe(200);
    expect(authorizedOriginal.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
    expect(await authorizedOriginal.text()).toBe('raw');
    expect(openOriginal).toHaveBeenCalledWith(expect.objectContaining({ storageRef: 'objects/a/original.blob' }));
    const recycle = await request('/v1/recycle-bin?libraryId=library', options, { headers: { authorization: 'Bearer admin' } });
    expect(recycle.status).toBe(200);
    expect(await recycle.json()).toMatchObject({ items: [{ assetId: 'deleted' }] });
  });

  it('restores only authorized active tombstones and requires a valid causal parent identifier', async () => {
    const eventId = '550e8400-e29b-41d4-a716-446655440001';
    const restoreTombstone = vi.fn(async (): Promise<{ status: 'restored'; restoreEventId: string } | 'not_found' | 'inactive' | 'conflict'> => ({ status: 'restored', restoreEventId: '550e8400-e29b-41d4-a716-446655440099' }));
    const options: NodeAgentServerOptions = {
      authorizePairingAdmin: (token) => token === 'admin',
      authorizeLibraryRead: (token, libraryId) => token === 'admin' && libraryId === 'library' ? 'local-admin' : undefined,
      gallery: {
        listLibraries: () => [], listAssets: () => ({ items: [], nextCursor: null }),
        getOriginal: async () => undefined, openOriginal: () => undefined, listTombstones: () => [], restoreTombstone
      }
    };
    const body = JSON.stringify({ libraryId: 'library', eventId });
    const unauthenticated = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    expect(unauthenticated.status).toBe(403);
    expect(restoreTombstone).not.toHaveBeenCalled();

    const wrongLibrary = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ libraryId: 'other-library', eventId })
    });
    expect(wrongLibrary.status).toBe(403);
    expect(restoreTombstone).not.toHaveBeenCalled();

    const malformed = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ libraryId: 'library', eventId: 'not-an-event-id' })
    });
    expect(malformed.status).toBe(400);
    expect(restoreTombstone).not.toHaveBeenCalled();

    const restored = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ status: 'restored', tombstoneEventId: eventId, restoreEventId: '550e8400-e29b-41d4-a716-446655440099' });
    expect(restoreTombstone).toHaveBeenCalledWith('library', eventId);

    const retried = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ status: 'restored', tombstoneEventId: eventId, restoreEventId: '550e8400-e29b-41d4-a716-446655440099' });
    expect(restoreTombstone).toHaveBeenCalledTimes(2);

    restoreTombstone.mockResolvedValue('inactive');
    const alreadyRestored = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body
    });
    expect(alreadyRestored.status).toBe(409);
    expect(await alreadyRestored.json()).toMatchObject({ error: 'tombstone_not_active' });

    restoreTombstone.mockResolvedValue('conflict');
    const causalConflict = await request('/v1/recycle-bin/restore', options, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body
    });
    expect(causalConflict.status).toBe(409);
    expect(await causalConflict.json()).toMatchObject({ error: 'causal_context_conflict' });
  });

  it('gates version APIs on current Node admin credentials and validates create requests', async () => {
    const listVersions = vi.fn(() => ({ original: {
      sourceVersionId: null, sha256: 'a'.repeat(64), mimeType: 'image/jpeg' as const,
      byteSize: 10, filename: 'photo.jpg', availability: 'online' as const
    }, items: [] }));
    const createVersion = vi.fn<MediaVersionServerControl['createVersion']>(async () => ({
      operationId: '550e8400-e29b-41d4-a716-446655440000',
      versionId: '550e8400-e29b-41d4-a716-446655440000', status: 'staging'
    }));
    const options: NodeAgentServerOptions = {
      mediaVersions: mediaVersionControl({ listVersions, createVersion }),
      authorizePairingAdmin: (token) => token === 'admin-secret',
      authorizeLibraryRead: (token, libraryId) => token === 'admin-secret' && libraryId === 'library' ? 'local-admin' : undefined
    };
    const health = await request('/v1/health', options);
    expect(await health.json()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: ['mediaVersions'] });

    const denied = await request('/v1/libraries/library/assets/asset/versions', options);
    expect(denied.status).toBe(403);
    expect(listVersions).not.toHaveBeenCalled();
    const wrongLibrary = await request('/v1/libraries/private-library/assets/asset/versions', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(wrongLibrary.status).toBe(403);
    const encodedSeparator = await request('/v1/libraries/library%2Fprivate/assets/asset/versions', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(encodedSeparator.status).toBe(400);

    const authorized = await request('/v1/libraries/library/assets/asset/versions', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ original: { sourceVersionId: null }, items: [] });

    const wrongContentType = await request('/v1/libraries/library/assets/asset/versions', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret' }, body: '{}'
    });
    expect(wrongContentType.status).toBe(415);
    const malformedJson = await request('/v1/libraries/library/assets/asset/versions', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: '{'
    });
    expect(malformedJson.status).toBe(400);
    const oversizedBody = await request('/v1/libraries/library/assets/asset/versions', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024 + 1)
    });
    expect(oversizedBody.status).toBe(413);

    const badBody = await request('/v1/libraries/library/assets/asset/versions', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVersionId: null, sourceSha256: 'a'.repeat(64), idempotencyKey: 'save-key-0123456789',
        transform: { crop: { x: 900_000, y: 0, width: 200_000, height: 1_000_000 }, rotation: 0 }
      })
    });
    expect(badBody.status).toBe(400);
    expect(createVersion).not.toHaveBeenCalled();

    const created = await request('/v1/libraries/library/assets/asset/versions', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVersionId: null, sourceSha256: 'a'.repeat(64), idempotencyKey: 'save-key-0123456789',
        transform: { crop: { x: 0, y: 0, width: 500_000, height: 1_000_000 }, rotation: 90 }
      })
    });
    expect(created.status).toBe(202);
    expect(createVersion).toHaveBeenCalledWith('library', 'asset', expect.objectContaining({ sourceVersionId: null }), 'local-admin');

    const offlineOptions: NodeAgentServerOptions = {
      ...options,
      mediaVersions: mediaVersionControl({ createVersion: async () => { throw { code: 'SOURCE_OFFLINE' }; } })
    };
    const offline = await request('/v1/libraries/library/assets/asset/versions', offlineOptions, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVersionId: null, sourceSha256: 'a'.repeat(64), idempotencyKey: 'offline-save-key-012345',
        transform: { crop: { x: 0, y: 0, width: 500_000, height: 1_000_000 }, rotation: 90 }
      })
    });
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ error: 'source_offline' });

    const storageOptions: NodeAgentServerOptions = {
      ...options,
      mediaVersions: mediaVersionControl({ createVersion: async () => { throw { code: 'STORAGE_FAILED' }; } })
    };
    const storageFailure = await request('/v1/libraries/library/assets/asset/versions', storageOptions, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVersionId: null, sourceSha256: 'a'.repeat(64), idempotencyKey: 'storage-failure-012345',
        transform: { crop: { x: 0, y: 0, width: 500_000, height: 1_000_000 }, rotation: 90 }
      })
    });
    expect(storageFailure.status).toBe(503);
    expect(await storageFailure.json()).toMatchObject({ error: 'storage_failed' });

    const queueOptions: NodeAgentServerOptions = {
      ...options,
      mediaVersions: mediaVersionControl({ createVersion: async () => { throw { code: 'QUEUE_FULL' }; } })
    };
    const queueFull = await request('/v1/libraries/library/assets/asset/versions', queueOptions, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVersionId: null, sourceSha256: 'a'.repeat(64), idempotencyKey: 'queue-full-save-key-0123',
        transform: { crop: { x: 0, y: 0, width: 500_000, height: 1_000_000 }, rotation: 90 }
      })
    });
    expect(queueFull.status).toBe(503);
    expect(await queueFull.json()).toMatchObject({ error: 'queue_full' });
  });

  it('streams only ready derived-version bytes after fresh authorization', async () => {
    const versionId = '550e8400-e29b-41d4-a716-446655440000';
    const readVersionContent = vi.fn(async () => ({
      bytes: Buffer.from('derived-bytes'), mimeType: 'image/jpeg' as const, sha256: 'b'.repeat(64), byteSize: 13
    }));
    const options: NodeAgentServerOptions = {
      mediaVersions: mediaVersionControl({ readVersionContent }),
      authorizePairingAdmin: (token) => token === 'admin-secret',
      authorizeLibraryRead: (token, libraryId) => token === 'admin-secret' && libraryId === 'library' ? 'local-admin' : undefined
    };
    const prefix = `/v1/libraries/library/assets/asset/versions/${versionId}`;
    const denied = await request(`${prefix}/content`, options);
    expect(denied.status).toBe(403);
    expect(readVersionContent).not.toHaveBeenCalled();

    const metadata = await request(prefix, options, { headers: { authorization: 'Bearer admin-secret' } });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ versionId, status: 'ready' });

    const content = await request(`${prefix}/content`, options, { headers: { authorization: 'Bearer admin-secret' } });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/jpeg');
    expect(content.headers.get('etag')).toBe(`"${'b'.repeat(64)}"`);
    expect(content.headers.get('cache-control')).toBe('no-store');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await content.text()).toBe('derived-bytes');

    const missingOptions: NodeAgentServerOptions = {
      ...options, mediaVersions: mediaVersionControl({ getVersion: () => undefined })
    };
    const missing = await request(prefix, missingOptions, { headers: { authorization: 'Bearer admin-secret' } });
    expect(missing.status).toBe(404);
    const baseVersion = mediaVersionControl().getVersion('library', 'asset', versionId)!;
    const stagingOptions: NodeAgentServerOptions = {
      ...options, mediaVersions: mediaVersionControl({ getVersion: () => ({ ...baseVersion, status: 'staging' }) })
    };
    const staging = await request(`${prefix}/content`, stagingOptions, { headers: { authorization: 'Bearer admin-secret' } });
    expect(staging.status).toBe(409);
    expect(await staging.json()).toMatchObject({ error: 'version_not_ready' });
    const failedOptions: NodeAgentServerOptions = {
      ...options, mediaVersions: mediaVersionControl({ getVersion: () => ({ ...baseVersion, status: 'failed', errorCode: 'processing_failed' }) })
    };
    const failed = await request(`${prefix}/content`, failedOptions, { headers: { authorization: 'Bearer admin-secret' } });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: 'version_failed' });

    const notReadyOptions: NodeAgentServerOptions = {
      ...options,
      mediaVersions: mediaVersionControl({ readVersionContent: async () => { throw { code: 'VERSION_NOT_READY' }; } })
    };
    const notReady = await request(`${prefix}/content`, notReadyOptions, { headers: { authorization: 'Bearer admin-secret' } });
    expect(notReady.status).toBe(409);
    expect(await notReady.text()).not.toContain('original');

    const unavailableOptions: NodeAgentServerOptions = {
      ...options,
      mediaVersions: mediaVersionControl({ readVersionContent: async () => { throw { code: 'VERSION_UNAVAILABLE' }; } })
    };
    const unavailable = await request(`${prefix}/content`, unavailableOptions, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: 'version_unavailable' });
  });

  it('fails closed when media-version capability is unavailable', async () => {
    const options: NodeAgentServerOptions = {
      authorizePairingAdmin: (token) => token === 'admin-secret',
      authorizeLibraryRead: (token, libraryId) => token === 'admin-secret' && libraryId === 'library' ? 'local-admin' : undefined
    };
    const response = await request('/v1/libraries/library/assets/asset/versions', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'capability_unavailable' });
  });

  it('adds CORS only for loopback web and platform-specific Tauri origins by default', async () => {
    const allowed = await request('/v1/health', {}, { headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const linuxTauri = await request('/v1/libraries', {}, { method: 'OPTIONS', headers: { origin: 'tauri://localhost' } });
    expect(linuxTauri.status).toBe(204);
    expect(linuxTauri.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const httpsTauri = await request('/v1/health', {}, { headers: { origin: 'https://tauri.localhost' } });
    expect(httpsTauri.headers.get('access-control-allow-origin')).toBe('https://tauri.localhost');

    const windowsTauri = await request('/v1/libraries', {}, { method: 'OPTIONS', headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(windowsTauri.status).toBe(204);
    expect(windowsTauri.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    expect(windowsTauri.headers.get('access-control-allow-headers')).toContain('Authorization');
    const nonDefaultTauriPort = await request('/v1/health', {}, { headers: { origin: 'http://tauri.localhost:5173' } });
    expect(nonDefaultTauriPort.headers.get('access-control-allow-origin')).toBeNull();

    const spoofedTauri = await request('/v1/health', {}, { headers: { origin: 'http://tauri.localhost.evil.example' } });
    expect(spoofedTauri.headers.get('access-control-allow-origin')).toBeNull();
    const denied = await request('/v1/health', {}, { headers: { origin: 'https://attacker.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a configured remote Web origin exactly, while rejecting other origins', async () => {
    const allowedOrigin = 'https://gallery.example.com';
    const preflight = await request('/v1/recycle-bin/restore', { allowedWebOrigins: [allowedOrigin] }, {
      method: 'OPTIONS', headers: { origin: allowedOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const denied = await request('/v1/health', { allowedWebOrigins: [allowedOrigin] }, { headers: { origin: 'https://gallery.example.com.evil' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(() => createNodeAgentServer({ allowedWebOrigins: ['https://gallery.example.com/gallery'] })).toThrow(/PHOTOMESH_WEB_ORIGINS/);
    expect(() => createNodeAgentServer({ allowedWebOrigins: ['http://gallery.example.com'] })).toThrow(/PHOTOMESH_WEB_ORIGINS/);
  });

  it('denies library index reads without a trusted principal and a persisted library grant', async () => {
    const readIndex = vi.fn((peerId: string) => peerId === 'trusted-peer' ? [] : undefined);
    const control = pairingControl({ readLibraryIndex: readIndex });
    const options: NodeAgentServerOptions = {
      pairingControl: control,
      authorizeLibraryRead: (token) => token === 'trusted-token' ? 'trusted-peer' : undefined
    };
    const denied = await request('/v1/assets?libraryId=private-library', options);
    expect(denied.status).toBe(403);
    expect(readIndex).not.toHaveBeenCalled();

    const authorized = await request('/v1/assets?libraryId=private-library', options, {
      headers: { authorization: 'Bearer trusted-token' }
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ items: [], nextCursor: null });
    expect(readIndex).toHaveBeenCalledWith('trusted-peer', 'private-library');
  });

  it('requires the local administrator token to create an invite or change trust', async () => {
    const control = pairingControl();
    const options: NodeAgentServerOptions = { pairingControl: control, authorizePairingAdmin: (token) => token === 'admin-secret' };
    const denied = await request('/v1/pairing/invitations', options, { method: 'POST' });
    expect(denied.status).toBe(403);
    const created = await request('/v1/pairing/invitations', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret' }
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ protocol: 'photomesh-pairing', version: 1 });
  });

  it('requires local administration to redeem a scanned invite and delegates the Noise join', async () => {
    const pairWithInvite = vi.fn(async () => ({ hostPeerId: 'host-peer-123456' }));
    const control = pairingControl({ pairWithInvite });
    const options: NodeAgentServerOptions = { pairingControl: control, authorizePairingAdmin: (token) => token === 'admin-secret' };
    const body = { invite: { protocol: 'photomesh-pairing', version: 1 }, label: 'Laptop' };
    const denied = await request('/v1/pairing/join', options, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(denied.status).toBe(403);
    expect(pairWithInvite).not.toHaveBeenCalled();

    const joined = await request('/v1/pairing/join', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ hostPeerId: 'host-peer-123456' });
    expect(pairWithInvite).toHaveBeenCalledWith(body.invite, 'Laptop', undefined);
  });

  it('protects tag-writer grants and exposes per-peer tag sync status to local admins', async () => {
    const grantTagWrite = vi.fn(() => true);
    const revokeTagWrite = vi.fn(() => true);
    const options: NodeAgentServerOptions = {
      pairingControl: pairingControl({
        grantTagWrite, revokeTagWrite, listTagWriters: () => ['peer-writer'],
        getTagSyncStatus: () => ({ pending: 2, lastError: 'peer_missing_asset_tags_v1' })
      }),
      authorizePairingAdmin: (token) => token === 'admin-secret'
    };
    const denied = await request('/v1/pairing/peers/peer-writer/libraries/family/tag-write', options, { method: 'PUT' });
    expect(denied.status).toBe(403);
    expect(grantTagWrite).not.toHaveBeenCalled();

    const granted = await request('/v1/pairing/peers/peer-writer/libraries/family/tag-write', options, {
      method: 'PUT', headers: { authorization: 'Bearer admin-secret', 'x-request-id': 'tag-grant-request' }
    });
    expect(granted.status).toBe(204);
    expect(granted.headers.get('x-request-id')).toBe('tag-grant-request');
    expect(grantTagWrite).toHaveBeenCalledWith('peer-writer', 'family');

    const writers = await request('/v1/pairing/libraries/family/tag-writers', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(writers.status).toBe(200);
    expect(await writers.json()).toEqual({ writers: ['peer-writer'] });
    const status = await request('/v1/pairing/peers/peer-writer/tag-sync-status', options, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    expect(await status.json()).toEqual({ pending: 2, lastError: 'peer_missing_asset_tags_v1' });

    const revoked = await request('/v1/pairing/peers/peer-writer/libraries/family/tag-write', options, {
      method: 'DELETE', headers: { authorization: 'Bearer admin-secret' }
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ status: 'revoked', replicatedEventsRemain: true });
    expect(revokeTagWrite).toHaveBeenCalledWith('peer-writer', 'family');
  });

  it('validates local approval payloads and bounds library pagination', async () => {
    const options: NodeAgentServerOptions = {
      pairingControl: pairingControl({ readLibraryIndex: () => [] }), authorizePairingAdmin: (token) => token === 'admin-secret',
      authorizeLibraryRead: () => 'trusted-peer'
    };
    const badPage = await request('/v1/assets?libraryId=album&limit=500', options);
    expect(badPage.status).toBe(400);
    const badApproval = await request('/v1/pairing/peers/peer/approval', options, {
      method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ approved: 'yes' })
    });
    expect(badApproval.status).toBe(400);
  });
});

describe('virtual albums HTTP API', () => {
  const albumRecord = { albumId: 'album-1', libraryId: 'family', title: 'Family', createdByPeerId: 'node-local', createdAt: '2026-10-28T00:00:00.000Z' };
  const operationKey = '123e4567-e89b-42d3-a456-426614174000';

  function albumOptions(overrides: Partial<NonNullable<NodeAgentServerOptions['albums']>> = {}): NodeAgentServerOptions {
    const albums: NonNullable<NodeAgentServerOptions['albums']> = {
      listAlbums: vi.fn(() => ({ items: [], nextCursor: null })),
      createAlbum: vi.fn(() => albumRecord),
      listMembers: vi.fn(() => ({ items: [{ assetId: 'asset-1' }], nextCursor: null })),
      addMember: vi.fn(() => ({ status: 'added' as const })),
      removeMember: vi.fn(() => ({ status: 'removed' as const, observedAddIds: ['add-1'] })),
      ...overrides
    };
    return {
      authorizePairingAdmin: (token) => token === 'admin-secret',
      authorizeLibraryRead: (token, libraryId) => token === 'admin-secret' && libraryId !== 'denied' ? 'local-admin' : undefined,
      gallery: {
        listLibraries: () => [{ libraryId: 'family', title: 'family' }],
        listAssets: () => ({ items: [], nextCursor: null }), getOriginal: async () => undefined,
        openOriginal: () => undefined, listTombstones: () => [], restoreTombstone: async () => 'not_found'
      } as NonNullable<NodeAgentServerOptions['gallery']>,
      albums
    };
  }

  const adminHeaders = { authorization: 'Bearer admin-secret' };

  it('authenticates admin first, validates library scope/existence, and masks resource failures as 404', async () => {
    const listAlbums = vi.fn(() => ({ items: [], nextCursor: null }));
    const authorizeLibraryRead = vi.fn((token: string | undefined, libraryId: string) =>
      token === 'admin-secret' && libraryId !== 'denied' ? 'local-admin' : undefined);
    const options = albumOptions({ listAlbums });
    options.authorizeLibraryRead = authorizeLibraryRead;

    const unauthenticated = await request('/v1/libraries/family/albums', options);
    expect(unauthenticated.status).toBe(403);
    expect(authorizeLibraryRead).not.toHaveBeenCalled();
    expect(unauthenticated.headers.get('cache-control')).toBe('private, no-store');

    const deniedScope = await request('/v1/libraries/denied/albums', options, { headers: adminHeaders });
    const unknownLibrary = await request('/v1/libraries/unknown/albums', options, { headers: adminHeaders });
    expect(deniedScope.status).toBe(404);
    expect(unknownLibrary.status).toBe(404);
    expect(await deniedScope.json()).toMatchObject({ error: 'not_found' });
    expect(await unknownLibrary.json()).toMatchObject({ error: 'not_found' });

    const emptyList = await request('/v1/libraries/family/albums', options, { headers: adminHeaders });
    expect(emptyList.status).toBe(200);
    expect(await emptyList.json()).toEqual({ items: [], nextCursor: null });
    expect(listAlbums).toHaveBeenCalledOnce();
    expect(emptyList.headers.get('cache-control')).toBe('private, no-store');
    expect(emptyList.headers.get('x-request-id')).toBeTruthy();
  });

  it('validates keyset query parameters and hides missing/cross-library albums and assets', async () => {
    const listAlbums = vi.fn(() => ({ items: [], nextCursor: null }));
    const listMembers = vi.fn(() => undefined);
    const options = albumOptions({ listAlbums, listMembers });
    for (const query of ['?limit=0', '?limit=201', '?limit=1&limit=2', '?unknown=x', '?cursor=not-a-cursor']) {
      const response = await request(`/v1/libraries/family/albums${query}`, options, { headers: adminHeaders });
      expect(response.status, query).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    const missingAlbum = await request('/v1/libraries/family/albums/missing/members', options, { headers: adminHeaders });
    expect(missingAlbum.status).toBe(404);
    expect(await missingAlbum.json()).toMatchObject({ error: 'not_found' });
    expect(listMembers).toHaveBeenCalledOnce();
    expect(listAlbums).not.toHaveBeenCalled();
  });

  it('projects provider results through strict public DTO allowlists', async () => {
    const options = albumOptions({
      listAlbums: () => ({ items: [{ ...albumRecord, sourcePath: 'D:\\private\\photo.jpg' }], nextCursor: null, totalCount: 99 } as never),
      createAlbum: () => ({ ...albumRecord, storageRef: 'objects/private' }),
      listMembers: () => ({ items: [{ assetId: 'asset-1', sourcePath: 'D:\\private\\photo.jpg', exif: { gps: 'private' } }], nextCursor: null, totalCount: 1 } as never)
    });
    const list = await request('/v1/libraries/family/albums', options, { headers: adminHeaders });
    expect(await list.json()).toEqual({ items: [albumRecord], nextCursor: null });
    const created = await request('/v1/libraries/family/albums', options, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json', 'idempotency-key': operationKey },
      body: JSON.stringify({ title: 'Family' })
    });
    expect(await created.json()).toEqual(albumRecord);
    const members = await request('/v1/libraries/family/albums/album-1/members', options, { headers: adminHeaders });
    expect(await members.json()).toEqual({ items: [{ assetId: 'asset-1' }], nextCursor: null });
  });

  it('normalizes title, requires a UUID idempotency key, and keeps mutation responses private', async () => {
    const createAlbum = vi.fn(() => albumRecord);
    const options = albumOptions({ createAlbum });
    const missingKey = await request('/v1/libraries/family/albums', options, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Family' })
    });
    expect(missingKey.status).toBe(400);

    const invalidTitle = await request('/v1/libraries/family/albums', options, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json', 'idempotency-key': operationKey }, body: JSON.stringify({ title: '\u00a0\u3000' })
    });
    expect(invalidTitle.status).toBe(400);

    const response = await request('/v1/libraries/family/albums', options, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json', 'idempotency-key': operationKey.toUpperCase() },
      body: JSON.stringify({ title: '\u2000 Family trip \u00a0' })
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(albumRecord);
    expect(createAlbum).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Family trip', operationId: operationKey, principalId: 'local-admin', libraryId: 'family'
    }));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('requires operation keys for membership writes and maps idempotency/writer conflicts', async () => {
    const addMember = vi.fn(() => ({ status: 'added' as const }));
    const removeMember = vi.fn(() => ({ status: 'removed' as const, observedAddIds: ['add-1'] }));
    const options = albumOptions({ addMember, removeMember });
    const missingKey = await request('/v1/libraries/family/albums/album-1/members/asset-1', options, {
      method: 'PUT', headers: adminHeaders
    });
    expect(missingKey.status).toBe(400);
    const added = await request('/v1/libraries/family/albums/album-1/members/asset-1', options, {
      method: 'PUT', headers: { ...adminHeaders, 'idempotency-key': operationKey }
    });
    expect(added.status).toBe(204);
    expect(added.headers.get('cache-control')).toBe('private, no-store');
    expect(addMember).toHaveBeenCalledWith(expect.objectContaining({ operationId: operationKey, principalId: 'local-admin' }));
    const removed = await request('/v1/libraries/family/albums/album-1/members/asset-1', options, {
      method: 'DELETE', headers: { ...adminHeaders, 'idempotency-key': '223e4567-e89b-42d3-a456-426614174000' }
    });
    expect(removed.status).toBe(204);
    expect(removeMember).toHaveBeenCalledOnce();

    const conflict = await request('/v1/libraries/family/albums/album-1/members/asset-1', albumOptions({
      addMember: () => { throw new RepositoryConflictError('idempotency conflict'); }
    }), { method: 'PUT', headers: { ...adminHeaders, 'idempotency-key': operationKey } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'idempotency_conflict' });
    const writerLimit = await request('/v1/libraries/family/albums/album-1/members/asset-1', albumOptions({
      addMember: () => ({ status: 'writer_limit' as const })
    }), { method: 'PUT', headers: { ...adminHeaders, 'idempotency-key': '323e4567-e89b-42d3-a456-426614174000' } });
    expect(writerLimit.status).toBe(409);
    expect(await writerLimit.json()).toMatchObject({ error: 'writer_limit_reached' });
  });
});

function pairingControl(overrides: Partial<PairingServerControl> = {}): PairingServerControl {
  return {
    createInvite: () => ({ protocol: 'photomesh-pairing', version: 1, hostPeerId: 'host-peer-123456', addresses: [], inviteId: 'e8b66476-4102-47ce-b246-81a391c48cc2', secret: 'a'.repeat(43), expiresAt: '2026-10-21T00:02:00.000Z' }),
    pairWithInvite: async () => ({ hostPeerId: 'host-peer-123456' }),
    listPeers: () => [], listPending: () => [], decide: () => false, revokePeer: async () => false,
    grantLibraryRead: () => undefined, readLibraryIndex: () => undefined, listDiscoveredPeers: () => [],
    dialManualIp: async () => ({ peerId: 'peer', addresses: [] }), ...overrides
  };
}

function mediaVersionControl(overrides: Partial<MediaVersionServerControl> = {}): MediaVersionServerControl {
  const versionId = '550e8400-e29b-41d4-a716-446655440000';
  return {
    listVersions: () => ({ original: {
      sourceVersionId: null, sha256: 'a'.repeat(64), mimeType: 'image/jpeg', byteSize: 10,
      filename: 'photo.jpg', availability: 'online'
    }, items: [] }),
    createVersion: async () => ({ operationId: versionId, versionId, status: 'staging' }),
    getVersion: () => ({
      versionId, assetId: 'asset', sourceVersionId: null, sourceSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64), mimeType: 'image/jpeg', byteSize: 13, width: 2, height: 3,
      transform: { crop: { x: 0, y: 0, width: 500_000, height: 1_000_000 }, rotation: 90 },
      status: 'ready', createdAt: '2026-10-24T00:00:00.000Z', errorCode: null
    }),
    readVersionContent: async () => ({
      bytes: Buffer.from('derived-bytes'), mimeType: 'image/jpeg', sha256: 'b'.repeat(64), byteSize: 13
    }),
    ...overrides
  };
}
