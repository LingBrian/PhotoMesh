import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createNodeAgentServer, type MediaVersionServerControl, type NodeAgentServerOptions, type PairingServerControl } from '../src/server.js';

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

  it('returns a structured 404 for unknown paths', async () => {
    const response = await request('/private');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
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
        listTombstones: () => [{ assetId: 'deleted', libraryId: 'library', eventId: 'evt' }]
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

  it('adds CORS only for local web and Tauri origins', async () => {
    const allowed = await request('/v1/health', {}, { headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const preflight = await request('/v1/libraries', {}, { method: 'OPTIONS', headers: { origin: 'tauri://localhost' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const denied = await request('/v1/health', {}, { headers: { origin: 'https://attacker.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
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
