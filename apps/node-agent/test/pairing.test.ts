import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../src/db/repository.js';
import { migrations } from '../src/db/migrations.js';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { SystemSecretStore, type SecretStore } from '../src/auth/key-store.js';
import { PairingRejectedError, PairingService } from '../src/auth/pairing-service.js';
import { PairingApprovalQueue } from '../src/auth/pairing-approval-queue.js';
import { LanPairingNode } from '../src/auth/lan-node.js';

const lanNodes: LanPairingNode[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  await Promise.all(lanNodes.splice(0).map((node) => node.stop()));
  databases.splice(0).forEach((database) => database.close());
});

async function createRepository(): Promise<SqliteRepository> {
  const database = new Database(':memory:');
  databases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate(migrations);
  return repository;
}

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  get(name: string): string | undefined { return this.values.get(name); }
  set(name: string, value: string): void { this.values.set(name, value); }
}

async function createNode(approve: (peer: { peerId: string; publicKey: string; proposedLabel: string }) => Promise<{ approved: boolean; label?: string; libraryIds?: string[] }> = async () => ({ approved: true })) {
  const repository = await createRepository();
  const secretStore = new MemorySecretStore();
  const identity = await loadOrCreateLocalIdentity(repository, secretStore, '2026-10-21T00:00:00.000Z');
  const pairing = new PairingService(repository, identity.peerId, approve, Date.now);
  const node = await LanPairingNode.start({ identity, pairing, listenAddresses: ['127.0.0.1'], listenPort: 0 });
  lanNodes.push(node);
  return { repository, secretStore, identity, pairing, node };
}

describe('local node identity and LAN pairing', () => {
  it('uses only the configured native keyring backend and fails closed when it is unavailable', () => {
    const entries = new Map<string, string>();
    const store = new SystemSecretStore((service, name) => ({
      getPassword: () => entries.get(`${service}:${name}`) ?? null,
      setPassword: (value) => { entries.set(`${service}:${name}`, value); }
    }));
    store.set('identity', 'secret-in-test-keyring');
    expect(store.get('identity')).toBe('secret-in-test-keyring');
    expect(store.get('missing')).toBeUndefined();
    const unavailable = new SystemSecretStore(() => { throw new Error('platform details must not leak'); });
    expect(() => unavailable.get('identity')).toThrow('platform secure storage is unavailable');
    expect(() => unavailable.set('identity', 'value')).toThrow('platform secure storage is unavailable');
  });

  it('keeps the Ed25519 private key only in the injected secure store and detects identity mismatch', async () => {
    const repository = await createRepository();
    const firstStore = new MemorySecretStore();
    const first = await loadOrCreateLocalIdentity(repository, firstStore, '2026-10-21T00:00:00.000Z');
    const privateSecret = [...firstStore.values.values()][0]!;
    expect(privateSecret).toBeTruthy();
    expect(JSON.stringify(repository.getLocalIdentity())).not.toContain(privateSecret);
    expect(first.publicKey).toBeInstanceOf(Uint8Array);

    const second = await loadOrCreateLocalIdentity(repository, firstStore, '2026-10-21T00:00:01.000Z');
    expect(second.peerId).toBe(first.peerId);
    const missingSecretStore = new MemorySecretStore();
    await expect(loadOrCreateLocalIdentity(repository, missingSecretStore)).rejects.toThrow('secret is missing');
    expect(missingSecretStore.values.size).toBe(0);
  });

  it('creates a short-lived invite, requires host approval, trusts both identities, and rejects replay', async () => {
    const hostApproval = vi.fn(async () => ({ approved: true, label: 'NAS', libraryIds: ['library-a', '', 'x'.repeat(129), 'library-a'] }));
    const host = await createNode(hostApproval);
    const joining = await createNode();
    const invite = host.node.createInvite();

    expect(invite.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const inviteTimeLeft = Date.parse(invite.expiresAt) - Date.now();
    expect(inviteTimeLeft).toBeGreaterThanOrEqual(119_000);
    expect(inviteTimeLeft).toBeLessThanOrEqual(120_000);
    expect(invite.addresses.some((address) => address.includes(`/p2p/${host.identity.peerId}`))).toBe(true);
    const paired = await joining.node.pairWithInvite(invite, 'Laptop');
    expect(paired.hostPeerId).toBe(host.identity.peerId);
    expect(hostApproval).toHaveBeenCalledWith(expect.objectContaining({ peerId: joining.identity.peerId, proposedLabel: 'Laptop' }));
    expect(host.repository.getTrustedPeer(joining.identity.peerId)?.trustState).toBe('trusted');
    expect(joining.repository.getTrustedPeer(host.identity.peerId)?.trustState).toBe('trusted');
    expect(host.repository.canReadLibrary(joining.identity.peerId, 'library-a')).toBe(true);
    expect(host.repository.canReadLibrary(joining.identity.peerId, 'library-b')).toBe(false);
    expect(joining.node.listDiscoveredPeers()).toBeInstanceOf(Array);

    await expect(joining.node.pairWithInvite(invite, 'Laptop')).rejects.toBeInstanceOf(PairingRejectedError);
    expect(hostApproval).toHaveBeenCalledTimes(1);
  });

  it('denies library index reads before a grant, permits scoped reads, and rejects access after revocation', async () => {
    const host = await createNode(async () => ({ approved: true, libraryIds: ['private-library'] }));
    const joining = await createNode();
    const unauthorized = await createNode();
    const invite = host.node.createInvite();
    await joining.node.pairWithInvite(invite, 'Trusted device');

    const addr = invite.addresses[0]!;
    const hostPort = Number(addr.split('/tcp/')[1]?.split('/')[0]);
    await unauthorized.node.dialManualIp('127.0.0.1', hostPort, host.identity.peerId);
    await expect(unauthorized.node.getLibraryIndex(host.identity.peerId, 'private-library')).rejects.toThrow('library access denied');
    expect(await joining.node.getLibraryIndex(host.identity.peerId, 'private-library')).toEqual([]);
    await expect(joining.node.getLibraryIndex(host.identity.peerId, 'other-library')).rejects.toThrow('library access denied');

    expect(await host.node.revokePeer(joining.identity.peerId)).toBe(true);
    expect(host.repository.canReadLibrary(joining.identity.peerId, 'private-library')).toBe(false);
    await expect(joining.node.getLibraryIndex(host.identity.peerId, 'private-library')).rejects.toThrow();
    expect(host.repository.getTrustedPeer(joining.identity.peerId)?.trustState).toBe('revoked');
    await expect(joining.node.pairWithInvite(host.node.createInvite(), 'Same key')).rejects.toBeInstanceOf(PairingRejectedError);
    await expect(host.node.dialManualIp('8.8.8.8', 9000, joining.identity.peerId)).rejects.toThrow('private LAN IP');
    await expect(host.node.dialManualIp('192.168.1.8', 0, joining.identity.peerId)).rejects.toThrow('invalid manual peer address');
  });

  it('rejects non-private listener and manual IP addresses before opening sockets', async () => {
    const repository = await createRepository();
    const identity = await loadOrCreateLocalIdentity(repository, new MemorySecretStore());
    const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: false }));
    await expect(LanPairingNode.start({ identity, pairing, listenAddresses: ['0.0.0.0'] })).rejects.toThrow('explicit private');
    await expect(LanPairingNode.start({ identity, pairing, listenAddresses: ['8.8.8.8'] })).rejects.toThrow('explicit private');
    await expect(LanPairingNode.start({ identity, pairing, listenAddresses: [] })).rejects.toThrow('explicit private');
  });

  it('atomically consumes a pairing code once and expires it without approving the peer', async () => {
    const repository = await createRepository();
    const hostStore = new MemorySecretStore();
    const hostIdentity = await loadOrCreateLocalIdentity(repository, hostStore, '2026-10-21T00:00:00.000Z');
    let now = Date.parse('2026-10-21T00:00:00.000Z');
    const pairing = new PairingService(repository, hostIdentity.peerId, async () => ({ approved: false }), () => now);
    const invite = pairing.createInvite([]);
    const joiner = await loadOrCreateLocalIdentity(await createRepository(), new MemorySecretStore());
    const identity = { peerId: joiner.peerId, publicKey: joiner.publicKey };
    await expect(pairing.acceptInvite({ inviteId: invite.inviteId, secret: invite.secret, proposedLabel: 'node', authenticatedRemote: identity }))
      .rejects.toThrow('declined');
    await expect(pairing.acceptInvite({ inviteId: invite.inviteId, secret: invite.secret, proposedLabel: 'node', authenticatedRemote: identity }))
      .rejects.toBeInstanceOf(PairingRejectedError);
    const expired = pairing.createInvite([]);
    now += 120_001;
    await expect(pairing.acceptInvite({ inviteId: expired.inviteId, secret: expired.secret, proposedLabel: 'node', authenticatedRemote: identity }))
      .rejects.toBeInstanceOf(PairingRejectedError);
  });

  it('allows only one concurrent redemption of the same invitation', async () => {
    const repository = await createRepository();
    const hostIdentity = await loadOrCreateLocalIdentity(repository, new MemorySecretStore());
    let approvalCount = 0;
    let releaseApproval!: () => void;
    let approvalStarted!: () => void;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const pairing = new PairingService(repository, hostIdentity.peerId, async () => {
      approvalCount += 1;
      approvalStarted();
      await approvalGate;
      return { approved: true };
    });
    const joinerRepository = await createRepository();
    const joiner = await loadOrCreateLocalIdentity(joinerRepository, new MemorySecretStore());
    const invite = pairing.createInvite([]);
    const redemption = {
      inviteId: invite.inviteId, secret: invite.secret, proposedLabel: 'joining node',
      authenticatedRemote: { peerId: joiner.peerId, publicKey: joiner.publicKey }
    };

    const first = pairing.acceptInvite(redemption);
    await started;
    await expect(pairing.acceptInvite(redemption)).rejects.toBeInstanceOf(PairingRejectedError);
    releaseApproval();
    await expect(first).resolves.toMatchObject({ peerId: joiner.peerId, trustState: 'trusted' });
    expect(approvalCount).toBe(1);
  });

  it('requires administrator approval and times out or rejects duplicate pending approvals', async () => {
    let now = Date.parse('2026-10-21T00:00:00.000Z');
    const queue = new PairingApprovalQueue(100_000, () => now);
    const request = queue.request({ peerId: 'peer-1234567890', publicKey: 'public', proposedLabel: 'device' });
    expect(queue.list()).toHaveLength(1);
    await expect(queue.request({ peerId: 'peer-1234567890', publicKey: 'public', proposedLabel: 'device' })).resolves.toEqual({ approved: false });
    expect(queue.decide('peer-1234567890', { approved: true, libraryIds: ['one', 'one'] })).toBe(true);
    await expect(request).resolves.toEqual({ approved: true, libraryIds: ['one'] });
    expect(queue.decide('peer-1234567890', { approved: true })).toBe(false);
    vi.useFakeTimers();
    const timeoutRequest = queue.request({ peerId: 'peer-timeout-123', publicKey: 'public', proposedLabel: 'device' });
    vi.advanceTimersByTime(100_001);
    await expect(timeoutRequest).resolves.toEqual({ approved: false });
    vi.useRealTimers();
    now += 1;
  });
});
