import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeAgentServer, type NodeAgentServerOptions, type PairingServerControl } from '../src/server.js';

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
    expect(await response.json()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0 });
  });

  it('returns a structured 404 for unknown paths', async () => {
    const response = await request('/private');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('pairing and library authorization endpoints', () => {
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
