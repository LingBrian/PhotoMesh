import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { LanPairingNode } from '../src/auth/lan-node.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { RatingSyncRepository } from '../src/sync/rating-sync-repository.js';
import { RatingSyncService } from '../src/sync/rating-sync-service.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';

const databases: Database.Database[] = [];
const lanNodes: LanPairingNode[] = [];
const now = '2026-10-29T00:00:00.000Z';

async function createLanNode(name: string, supportsRatingSync = true) {
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
  const syncRepository = new SyncRepository(database, () => now);
  const sync = new SyncService(syncRepository, identity, pairing, () => now, undefined, false, false, false, supportsRatingSync);
  const ratingRepository = new RatingSyncRepository(database, () => now);
  const ratingSync = supportsRatingSync
    ? new RatingSyncService(ratingRepository, identity, pairing, () => sync.hello(), () => now)
    : undefined;
  const node = await LanPairingNode.start({
    identity, pairing, listenAddresses: ['127.0.0.1'], listenPort: 0, syncService: sync,
    ...(ratingSync ? { ratingSyncService: ratingSync } : {})
  });
  lanNodes.push(node);
  return { database, repository, identity, pairing, syncRepository, sync, ratingRepository, ratingSync, node };
}

async function seedSharedAsset(host: Awaited<ReturnType<typeof createLanNode>>, client: Awaited<ReturnType<typeof createLanNode>>) {
  const event = await host.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
    assetId: 'asset-1', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
  } });
  client.syncRepository.appendLocalEvent(event);
  for (const node of [host, client]) {
    node.database.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at)
      VALUES('asset-1','family',?,'photo',?)`).run(host.identity.peerId, now);
  }
}

afterEach(async () => {
  await Promise.all(lanNodes.splice(0).map((node) => node.stop()));
  databases.splice(0).forEach((database) => database.close());
});

describe('LAN asset-ratings protocol transport', () => {
  it('negotiates rating capability and transfers a signed rating over its dedicated stream', async () => {
    const host = await createLanNode('rating-lan-host');
    const client = await createLanNode('rating-lan-client');
    await client.node.pairWithInvite(host.node.createInvite(), 'LAN rating client');
    host.repository.grantLibraryRead(client.identity.peerId, 'family', now);
    client.repository.grantLibraryRead(host.identity.peerId, 'family', now);
    client.ratingRepository.grantRatingWriter('family', host.identity.peerId, client.identity.peerId, now);
    await seedSharedAsset(host, client);

    const result = await host.ratingSync!.setAssetRating({
      operationId: randomUUID(), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1',
      rating: 4, requestFingerprint: 'a'.repeat(64)
    });
    expect(result).toMatchObject({ rating: 4 });

    await host.node.syncWithPeer(client.identity.peerId);
    expect(host.sync.peerSupportsCapability(client.identity.peerId, 'asset-ratings-v1')).toBe(true);
    expect(client.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: 4, conflict: false, ratingCandidates: [4] });
    expect(host.ratingRepository.getPeerSyncStatus(client.identity.peerId).pending).toBe(0);
  }, 30_000);

  it('leaves rating outbox pending and does not dial the rating stream for an N-1 peer', async () => {
    const current = await createLanNode('rating-lan-current');
    const oldPeer = await createLanNode('rating-lan-old', false);
    await current.node.pairWithInvite(oldPeer.node.createInvite(), 'N-1 rating peer');
    current.repository.grantLibraryRead(oldPeer.identity.peerId, 'family', now);
    oldPeer.repository.grantLibraryRead(current.identity.peerId, 'family', now);
    oldPeer.ratingRepository.grantRatingWriter('family', current.identity.peerId, oldPeer.identity.peerId, now);
    await seedSharedAsset(current, oldPeer);

    const result = await current.ratingSync!.setAssetRating({
      operationId: randomUUID(), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1',
      rating: 5, requestFingerprint: 'b'.repeat(64)
    });
    expect(result).toMatchObject({ rating: 5 });

    await current.node.syncWithPeer(oldPeer.identity.peerId);
    expect(current.sync.peerSupportsCapability(oldPeer.identity.peerId, 'asset-ratings-v1')).toBe(false);
    expect(oldPeer.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: null, conflict: false, ratingCandidates: [] });
    expect(current.ratingRepository.getPeerSyncStatus(oldPeer.identity.peerId)).toMatchObject({
      pending: 1, lastError: 'peer_missing_asset_ratings_v1'
    });
  }, 30_000);
});
