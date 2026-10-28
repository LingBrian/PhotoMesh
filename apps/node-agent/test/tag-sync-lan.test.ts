import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { LanPairingNode } from '../src/auth/lan-node.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService, type SyncHello } from '../src/sync/sync-service.js';
import { TagSyncRepository } from '../src/sync/tag-sync-repository.js';
import { TagSyncService } from '../src/sync/tag-sync-service.js';

const databases: Database.Database[] = [];
const lanNodes: LanPairingNode[] = [];
const now = '2026-10-27T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(lanNodes.splice(0).map((node) => node.stop()));
  databases.splice(0).forEach((database) => database.close());
});

class NMinusOneSyncService extends SyncService {
  override hello(): SyncHello {
    const hello = super.hello();
    return { ...hello, capabilities: hello.capabilities.filter((capability) => capability !== 'asset-tags-v1') };
  }
}

async function createLanNode(name: string, grantLibrary = false, nMinusOne = false, withTagSync = true) {
  const database = new Database(':memory:');
  databases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (key) => secrets.get(`${name}:${key}`),
    set: (key, value) => { secrets.set(`${name}:${key}`, value); }
  });
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true, libraryIds: grantLibrary ? ['family'] : [] }));
  const syncRepository = new SyncRepository(database);
  const sync = nMinusOne
    ? new NMinusOneSyncService(syncRepository, identity, pairing, () => now)
    : new SyncService(syncRepository, identity, pairing, () => now, undefined, withTagSync);
  const tagRepository = new TagSyncRepository(database, () => now);
  const tagSync = new TagSyncService(tagRepository, identity, pairing, () => sync.hello(), () => now);
  const node = await LanPairingNode.start({ identity, pairing, listenAddresses: ['127.0.0.1'], listenPort: 0,
    syncService: sync, ...(withTagSync ? { tagSyncService: tagSync } : {}) });
  lanNodes.push(node);
  return { database, identity, repository, pairing, syncRepository, sync, tagRepository, tagSync, node };
}

async function seedSharedAsset(host: Awaited<ReturnType<typeof createLanNode>>, client: Awaited<ReturnType<typeof createLanNode>>): Promise<void> {
  const event = await host.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
    assetId: 'asset-1', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
  } });
  client.syncRepository.appendLocalEvent(event);
}

describe('LAN asset-tags protocol transport', () => {
  it('dials the dedicated protocol only after v1 capability negotiation and syncs tags', async () => {
    const host = await createLanNode('host', true);
    const client = await createLanNode('client');
    const invite = host.node.createInvite();
    await client.node.pairWithInvite(invite, 'LAN client');

    client.repository.grantLibraryRead(host.identity.peerId, 'family', now);
    host.repository.grantLibraryRead(client.identity.peerId, 'family', now);
    host.tagRepository.grantTagWriter('family', client.identity.peerId, host.identity.peerId, now);
    client.tagRepository.grantTagWriter('family', host.identity.peerId, client.identity.peerId, now);
    host.database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
      VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(host.identity.peerId, now);
    client.database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
      VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(host.identity.peerId, now);
    await seedSharedAsset(host, client);

    expect(await client.tagSync.addAssetTag('family', 'asset-1', 'LAN')).toBe('added');
    await client.node.syncWithPeer(host.identity.peerId);
    expect(host.tagRepository.getAssetTags('family', 'asset-1')).toEqual(['LAN']);
    expect(client.sync.peerSupportsCapability(host.identity.peerId, 'asset-tags-v1')).toBe(true);
    expect(client.database.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get(host.identity.peerId))
      .toEqual({ count: 0 });
  }, 30_000);

  it('keeps tag events pending and skips the protocol for an N-1 peer', async () => {
    const oldHost = await createLanNode('old-host', true, true, false);
    const client = await createLanNode('current-client');
    const invite = oldHost.node.createInvite();
    await client.node.pairWithInvite(invite, 'Current client');

    client.repository.grantLibraryRead(oldHost.identity.peerId, 'family', now);
    oldHost.repository.grantLibraryRead(client.identity.peerId, 'family', now);
    client.database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
      VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(client.identity.peerId, now);
    oldHost.database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
      VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(oldHost.identity.peerId, now);
    await seedSharedAsset(oldHost, client);

    expect(await client.tagSync.addAssetTag('family', 'asset-1', 'pending-for-upgrade')).toBe('added');
    await client.node.syncWithPeer(oldHost.identity.peerId);
    expect(client.sync.peerSupportsCapability(oldHost.identity.peerId, 'asset-tags-v1')).toBe(false);
    expect(client.tagRepository.getPeerSyncStatus(oldHost.identity.peerId)).toEqual({ pending: 1, lastError: 'peer_missing_asset_tags_v1' });
    expect(oldHost.tagRepository.getAssetTags('family', 'asset-1')).toEqual([]);
  }, 30_000);
});
