import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { LanPairingNode } from '../src/auth/lan-node.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { AlbumSyncRepository } from '../src/sync/album-sync-repository.js';
import { AlbumSyncService } from '../src/sync/album-sync-service.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';

const databases: Database.Database[] = [];
const lanNodes: LanPairingNode[] = [];
const now = '2026-10-28T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(lanNodes.splice(0).map((node) => node.stop()));
  databases.splice(0).forEach((database) => database.close());
});

async function createLanNode(name: string, supportsAlbumSync = true) {
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
  const albumSyncRepository = new AlbumSyncRepository(database, () => now);
  const sync = new SyncService(new SyncRepository(database), identity, pairing, () => now, undefined, false, supportsAlbumSync);
  const albumSync = new AlbumSyncService(albumSyncRepository, identity, pairing, () => sync.hello(), () => now);
  repository.setAlbumOperationEventDrafter((input) => { albumSync.reserveLocalOperation(input); });
  repository.setAlbumLifecycleEventDrafter((input) => { albumSync.reserveLocalLifecycleOperation(input); });
  const node = await LanPairingNode.start({ identity, pairing, listenAddresses: ['127.0.0.1'], listenPort: 0,
    syncService: sync, ...(supportsAlbumSync ? { albumSyncService: albumSync } : {}) });
  lanNodes.push(node);
  return { database, identity, repository, pairing, albumSyncRepository, albumSync, sync, node };
}

async function seedSharedAsset(host: Awaited<ReturnType<typeof createLanNode>>, client: Awaited<ReturnType<typeof createLanNode>>) {
  const event = await host.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
    assetId: 'asset-1', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
  } });
  client.sync.repository.appendLocalEvent(event);
  for (const node of [host, client]) {
    node.database.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-1','family',?,'photo',?)`)
      .run(host.identity.peerId, now);
  }
}

describe('LAN virtual-album protocol transport', () => {
  it('negotiates the independent capability and syncs album create/member events over its own protocol', async () => {
    const host = await createLanNode('album-host');
    const client = await createLanNode('album-client');
    await client.node.pairWithInvite(host.node.createInvite(), 'LAN album client');
    host.repository.grantLibraryRead(client.identity.peerId, 'family', now);
    client.repository.grantLibraryRead(host.identity.peerId, 'family', now);
    client.albumSyncRepository.setAlbumWriteGrant('family', host.identity.peerId, now);
    client.albumSyncRepository.setAlbumDeleteGrant('family', host.identity.peerId, now);
    host.albumSyncRepository.setAlbumDeleteGrant('family', client.identity.peerId, now);
    await seedSharedAsset(host, client);

    const operationId = randomUUID();
    const album = host.repository.createAlbum({
      operationId, principalId: 'local-admin', authorPeerId: host.identity.peerId, libraryId: 'family',
      requestFingerprint: '1'.repeat(64), createdAt: now, title: 'LAN trip'
    });
    expect(album && album !== 'writer_limit').toBe(true);
    if (!album || album === 'writer_limit') throw new Error('album create failed');
    await host.albumSync.signPendingLocalEvents();
    const added = host.repository.addAlbumMember({
      operationId: randomUUID(), principalId: 'local-admin', authorPeerId: host.identity.peerId, libraryId: 'family',
      requestFingerprint: '2'.repeat(64), createdAt: now, albumId: album.albumId, assetId: 'asset-1'
    });
    expect(added.status).toBe('added');
    await host.albumSync.signPendingLocalEvents();

    await client.node.syncWithPeer(host.identity.peerId);
    expect(client.sync.peerSupportsCapability(host.identity.peerId, 'virtual-albums-v1')).toBe(true);
    expect(client.repository.listAlbumMembers('family', album.albumId, undefined, 10)).toEqual({ items: [{ assetId: 'asset-1' }], nextCursor: null });
    expect(client.database.prepare('SELECT count(*) AS count FROM album_sync_outbox WHERE peer_id = ?').get(client.identity.peerId)).toEqual({ count: 0 });
    expect(client.albumSyncRepository.getCursors(['family']).some((cursor) => cursor.authorPeerId === host.identity.peerId && cursor.sequence === 2)).toBe(true);

    const deleted = host.repository.deleteAlbum({ operationId: randomUUID(), principalId: 'local-admin', authorPeerId: host.identity.peerId,
      libraryId: 'family', albumId: album.albumId, scope: 'global', requestFingerprint: '4'.repeat(64), createdAt: now });
    expect(deleted).toBe('deleted');
    await host.albumSync.signPendingLocalEvents();
    await client.node.syncWithPeer(host.identity.peerId);
    expect(client.repository.listAlbums('family', undefined, 10)?.items).toEqual([]);
    expect(client.repository.listDeletedAlbums('family', 'all', undefined, 10)?.items[0]?.scopes).toEqual(['global']);

    const restored = client.repository.restoreAlbum({ operationId: randomUUID(), principalId: 'local-admin', authorPeerId: client.identity.peerId,
      libraryId: 'family', albumId: album.albumId, scope: 'global', requestFingerprint: '5'.repeat(64), createdAt: now });
    expect(restored).toBe('restored');
    await client.albumSync.signPendingLocalEvents();
    await host.node.syncWithPeer(client.identity.peerId);
    expect(host.repository.listAlbums('family', undefined, 10)?.items).toHaveLength(1);
    expect(client.repository.listAlbums('family', undefined, 10)?.items).toHaveLength(1);
  }, 30_000);

  it('does not dial the album protocol for an N-1 peer and leaves the event pending for upgrade', async () => {
    const oldPeer = await createLanNode('album-old-peer', false);
    const current = await createLanNode('album-current');
    await current.node.pairWithInvite(oldPeer.node.createInvite(), 'Current album peer');
    current.repository.grantLibraryRead(oldPeer.identity.peerId, 'family', now);
    oldPeer.repository.grantLibraryRead(current.identity.peerId, 'family', now);

    current.database.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('album-seed','family',?,'photo',?)`)
      .run(current.identity.peerId, now);
    const created = current.repository.createAlbum({
      operationId: randomUUID(), principalId: 'local-admin', authorPeerId: current.identity.peerId, libraryId: 'family',
      requestFingerprint: '3'.repeat(64), createdAt: now, title: 'Pending'
    });
    expect(created && created !== 'writer_limit').toBe(true);
    await current.albumSync.signPendingLocalEvents();
    await current.node.syncWithPeer(oldPeer.identity.peerId);
    expect(current.sync.peerSupportsCapability(oldPeer.identity.peerId, 'virtual-albums-v1')).toBe(false);
    expect(current.albumSyncRepository.getPeerSyncStatus(oldPeer.identity.peerId)).toEqual({ pending: 1, lastError: 'peer_missing_virtual_albums_v1' });
    expect(oldPeer.database.prepare('SELECT count(*) AS count FROM album_sync_event_log').get()).toEqual({ count: 0 });
  }, 30_000);
});
