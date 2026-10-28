import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { LanPairingNode } from '../src/auth/lan-node.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { FavoriteSyncRepository } from '../src/sync/favorite-sync-repository.js';
import { FavoriteSyncService } from '../src/sync/favorite-sync-service.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';
import { verifyEvent } from '../src/sync/event-envelope.js';

const databases: Database.Database[] = [];
const lanNodes: LanPairingNode[] = [];
const now = '2026-10-28T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(lanNodes.splice(0).map((node) => node.stop()));
  databases.splice(0).forEach((database) => database.close());
});

async function createLanNode(name: string, supportsFavoriteSync = true) {
  const database = new Database(':memory:');
  databases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (key) => secrets.get(`${name}:${key}`),
    set: (key, value) => { secrets.set(`${name}:${key}`, value); }
  });
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true, libraryIds: [] }));
  const favoriteRepository = new FavoriteSyncRepository(database, () => now);
  const sync = new SyncService(new SyncRepository(database, () => now), identity, pairing, () => now, undefined, false, false, supportsFavoriteSync);
  const favorites = new FavoriteSyncService(favoriteRepository, identity, pairing, () => sync.hello(), () => now);
  const node = await LanPairingNode.start({ identity, pairing, listenAddresses: ['127.0.0.1'], listenPort: 0,
    syncService: sync, ...(supportsFavoriteSync ? { favoriteSyncService: favorites } : {}) });
  lanNodes.push(node);
  return { database, identity, repository, pairing, favoriteRepository, favorites, sync, node };
}

async function seedSharedAsset(host: Awaited<ReturnType<typeof createLanNode>>, client: Awaited<ReturnType<typeof createLanNode>>) {
  const event = await host.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
    assetId: 'asset-1', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
  } });
  const author = client.pairing.listPeers().find((peer) => peer.peerId === host.identity.peerId);
  if (!author || !(await verifyEvent(event, author.publicKey))) throw new Error('test metadata signature is not trusted by peer');
  client.sync.repository.appendLocalEvent(event);
  for (const node of [host, client]) node.database.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at)
    VALUES('asset-1','family',?,'photo',?)`).run(host.identity.peerId, now);
}

describe('LAN asset-favorites protocol transport', () => {
  it('negotiates the independent capability and syncs signed favorites over its dedicated stream', async () => {
    const host = await createLanNode('favorite-host');
    const client = await createLanNode('favorite-client');
    await client.node.pairWithInvite(host.node.createInvite(), 'LAN favorite client');
    host.repository.grantLibraryRead(client.identity.peerId, 'family', now);
    client.repository.grantLibraryRead(host.identity.peerId, 'family', now);
    client.favoriteRepository.grantFavoriteWriter('family', host.identity.peerId, client.identity.peerId, now);
    await seedSharedAsset(host, client);

    const operationId = randomUUID();
    await host.favorites.setAssetFavorite({ operationId, principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: 'a'.repeat(64) });
    await host.node.syncWithPeer(client.identity.peerId);
    expect(host.sync.peerSupportsCapability(client.identity.peerId, 'asset-favorites-v1')).toBe(true);
    expect(client.favoriteRepository.getFavorite('family', 'asset-1')).toBe(true);
    expect(host.favoriteRepository.getPeerSyncStatus(client.identity.peerId).pending).toBe(0);
  }, 30_000);

  it('keeps favorite events pending for an N-1 peer without dialing the favorite stream', async () => {
    const current = await createLanNode('favorite-current');
    const oldPeer = await createLanNode('favorite-old', false);
    await current.node.pairWithInvite(oldPeer.node.createInvite(), 'N-1 favorite peer');
    current.repository.grantLibraryRead(oldPeer.identity.peerId, 'family', now);
    oldPeer.repository.grantLibraryRead(current.identity.peerId, 'family', now);
    await seedSharedAsset(current, oldPeer);
    await current.favorites.setAssetFavorite({ operationId: randomUUID(), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: 'b'.repeat(64) });

    await current.node.syncWithPeer(oldPeer.identity.peerId);
    expect(current.sync.peerSupportsCapability(oldPeer.identity.peerId, 'asset-favorites-v1')).toBe(false);
    expect(oldPeer.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);
    expect(current.favoriteRepository.getPeerSyncStatus(oldPeer.identity.peerId).pending).toBe(1);
    expect(current.favoriteRepository.getPeerSyncStatus(oldPeer.identity.peerId).lastError).toBe('peer_missing_asset_favorites_v1');
  }, 30_000);
});
