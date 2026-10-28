import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { FavoriteSyncRepository } from '../src/sync/favorite-sync-repository.js';
import { makeUnsignedEvent, signEvent } from '../src/sync/event-envelope.js';
import { FavoriteSyncService, isFavoriteSyncExchangeRequest, type FavoriteSyncTransport } from '../src/sync/favorite-sync-service.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';

const databases: Database.Database[] = [];
let clockMs = Date.parse('2026-10-28T00:00:00.000Z');
const now = (): string => new Date(clockMs).toISOString();

async function createNode(name: string) {
  const database = new Database(':memory:');
  databases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (key) => secrets.get(`${name}:${key}`),
    set: (key, value) => { secrets.set(`${name}:${key}`, value); }
  });
  database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
    VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(identity.peerId, now());
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true }), () => clockMs);
  const syncRepository = new SyncRepository(database, now);
  const sync = new SyncService(syncRepository, identity, pairing, now, undefined, false, false, true);
  const favoriteRepository = new FavoriteSyncRepository(database, now);
  const favorites = new FavoriteSyncService(favoriteRepository, identity, pairing, () => sync.hello(), now);
  return { database, repository, identity, pairing, syncRepository, sync, favoriteRepository, favorites };
}

async function trustNodes(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>, grantFavoriteWrite = true) {
  a.repository.trustPeer({ peerId: b.identity.peerId, publicKey: Buffer.from(b.identity.publicKey).toString('base64'), label: 'B', trustState: 'trusted', createdAt: now(), revokedAt: null });
  b.repository.trustPeer({ peerId: a.identity.peerId, publicKey: Buffer.from(a.identity.publicKey).toString('base64'), label: 'A', trustState: 'trusted', createdAt: now(), revokedAt: null });
  a.repository.grantLibraryRead(b.identity.peerId, 'family', now());
  b.repository.grantLibraryRead(a.identity.peerId, 'family', now());
  if (grantFavoriteWrite) {
    a.favoriteRepository.grantFavoriteWriter('family', b.identity.peerId, a.identity.peerId, now());
    b.favoriteRepository.grantFavoriteWriter('family', a.identity.peerId, b.identity.peerId, now());
  }
  const existing = (node: Awaited<ReturnType<typeof createNode>>) => node.database.prepare(
    `SELECT last_event_id FROM sync_asset_projection WHERE library_id='family' AND asset_id='asset-1'`
  ).get() as { last_event_id: string } | undefined;
  const indexEvent = existing(a) || existing(b)
    ? a.syncRepository.getEventEnvelope((existing(a) ?? existing(b))!.last_event_id) ?? b.syncRepository.getEventEnvelope((existing(a) ?? existing(b))!.last_event_id)
    : await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
      assetId: 'asset-1', originNodeId: a.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 12
    } });
  if (!indexEvent) throw new Error('test asset index event was not created');
  for (const node of [a, b]) if (!existing(node)) node.syncRepository.appendLocalEvent(indexEvent);
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  clockMs = Date.parse('2026-10-28T00:00:00.000Z');
});

describe('library-scoped favorite sync service', () => {
  it('bounds wire requests and rejects a peer without the negotiated favorite capability', async () => {
    const a = await createNode('validator-a');
    const b = await createNode('validator-b');
    await trustNodes(a, b);
    const hello = a.sync.hello();
    const request = { hello: b.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [] };
    expect(isFavoriteSyncExchangeRequest(request)).toBe(true);
    expect(isFavoriteSyncExchangeRequest({ ...request, cursors: [{ libraryId: 'family', authorPeerId: 'peer-123456789', sequence: -1 }] })).toBe(false);
    expect(isFavoriteSyncExchangeRequest({ ...request, events: Array.from({ length: 65 }, () => ({})) })).toBe(false);
    const oldHello = { ...b.sync.hello(), capabilities: b.sync.hello().capabilities.filter((capability) => capability !== 'asset-favorites-v1') };
    await expect(a.favorites.handleExchange(b.identity.peerId, { ...request, hello: oldHello })).rejects.toThrow(/no common asset favorite sync capability/i);
    expect(hello.capabilities).toContain('asset-favorites-v1');
  });

  it('preserves concurrent unseen adds and converges an observed remove through two nodes', async () => {
    const a = await createNode('orset-a');
    const b = await createNode('orset-b');
    await trustNodes(a, b);
    const toB: FavoriteSyncTransport = { exchangeFavorites: async (_peerId, request) => b.favorites.handleExchange(a.identity.peerId, request) };
    const toA: FavoriteSyncTransport = { exchangeFavorites: async (_peerId, request) => a.favorites.handleExchange(b.identity.peerId, request) };
    const op = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

    await a.favorites.setAssetFavorite({ operationId: op(1), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: 'a'.repeat(64) });
    await b.favorites.setAssetFavorite({ operationId: op(2), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: 'b'.repeat(64) });
    await a.favorites.setAssetFavorite({ operationId: op(3), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: false, requestFingerprint: 'c'.repeat(64) });
    expect(a.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);

    await a.favorites.syncWithPeer(b.identity.peerId, toB);
    expect(b.favoriteRepository.getFavorite('family', 'asset-1')).toBe(true);
    await b.favorites.syncWithPeer(a.identity.peerId, toA);
    expect(a.favoriteRepository.getFavorite('family', 'asset-1')).toBe(true);

    await b.favorites.setAssetFavorite({ operationId: op(4), principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: false, requestFingerprint: 'd'.repeat(64) });
    await b.favorites.syncWithPeer(a.identity.peerId, toA);
    expect(a.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);
    expect(b.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);
  });

  it('denies event delivery by default, then retries after explicit favorite-write grant', async () => {
    const a = await createNode('acl-a');
    const b = await createNode('acl-b');
    await trustNodes(a, b, false);
    const transport: FavoriteSyncTransport = { exchangeFavorites: async (_peerId, request) => b.favorites.handleExchange(a.identity.peerId, request) };
    const operationId = '00000000-0000-4000-8000-000000000101';
    await a.favorites.setAssetFavorite({ operationId, principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: 'e'.repeat(64) });
    await a.favorites.syncWithPeer(b.identity.peerId, transport);
    expect(b.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);
    expect(a.favoriteRepository.getPeerSyncStatus(b.identity.peerId).lastError).toBe('favorite_write_denied');

    b.favoriteRepository.grantFavoriteWriter('family', a.identity.peerId, b.identity.peerId, now());
    clockMs += 11_000;
    await a.favorites.syncWithPeer(b.identity.peerId, transport);
    expect(b.favoriteRepository.getFavorite('family', 'asset-1')).toBe(true);
    expect(a.favoriteRepository.getPeerSyncStatus(b.identity.peerId).pending).toBe(0);
  });

  it('requires a separate local read grant for the signed author', async () => {
    const a = await createNode('author-read-a');
    const b = await createNode('author-read-b');
    await trustNodes(a, b, false);
    b.database.prepare('DELETE FROM library_grants WHERE peer_id=? AND library_id=?').run(a.identity.peerId, 'family');
    expect(() => b.favoriteRepository.grantFavoriteWriter('family', a.identity.peerId, b.identity.peerId, now())).toThrow(/library read grant/i);
    b.repository.grantLibraryRead(a.identity.peerId, 'family', now());
    b.favoriteRepository.grantFavoriteWriter('family', a.identity.peerId, b.identity.peerId, now());
    b.database.prepare('DELETE FROM library_grants WHERE peer_id=? AND library_id=?').run(a.identity.peerId, 'family');
    b.favoriteRepository.setRemoteLibraries(a.identity.peerId, ['family']);
    expect(b.favoriteRepository.recordProtocolConflict(a.identity.peerId, {
      eventId: '00000000-0000-4000-8000-000000000202', libraryId: 'family', authorPeerId: a.identity.peerId, authorSequence: 1
    }, 'invalid_event_envelope')).toBe(false);
    expect(b.database.prepare('SELECT count(*) n FROM favorite_sync_conflicts').get()).toEqual({ n: 0 });

    const transport: FavoriteSyncTransport = { exchangeFavorites: async (_peerId, request) => b.favorites.handleExchange(a.identity.peerId, request) };
    await a.favorites.setAssetFavorite({ operationId: '00000000-0000-4000-8000-000000000201', principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', favorite: true, requestFingerprint: '2'.repeat(64) });
    await a.favorites.syncWithPeer(b.identity.peerId, transport);
    expect(b.favoriteRepository.getFavorite('family', 'asset-1')).toBe(false);
    expect(a.favoriteRepository.getPeerSyncStatus(b.identity.peerId).lastError).toBe('favorite_write_denied');
  });

  it('applies already-accepted pending events after favorite-write revocation', async () => {
    const a = await createNode('revoked-pending-a');
    const b = await createNode('revoked-pending-b');
    await trustNodes(a, b);
    const rootId = '00000000-0000-4000-8000-000000000301';
    const event = await signEvent(makeUnsignedEvent({
      eventId: '00000000-0000-4000-8000-000000000302', libraryId: 'family', authorPeerId: a.identity.peerId,
      authorSequence: 1, causalParents: [rootId], eventType: 'asset.favorite.added', payload: { assetId: 'asset-later' }, createdAt: now()
    }), a.identity);
    const response = await b.favorites.handleExchange(a.identity.peerId, {
      hello: a.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [event]
    });
    expect(response.results).toEqual([{ eventId: event.eventId, status: 'pending' }]);
    b.favoriteRepository.revokeFavoriteWriter('family', a.identity.peerId, now());

    const rootContext = b.syncRepository.getLocalEventContext('family', b.identity.peerId);
    const root = await signEvent(makeUnsignedEvent({
      eventId: rootId, libraryId: 'family', authorPeerId: b.identity.peerId,
      authorSequence: rootContext.authorSequence, causalParents: rootContext.causalParents,
      eventType: 'asset.indexed', payload: { assetId: 'asset-later', originNodeId: b.identity.peerId, kind: 'photo', sha256: 'b'.repeat(64), byteLength: 10 }, createdAt: now()
    }), b.identity);
    b.syncRepository.appendLocalEvent(root);
    b.favoriteRepository.reconcilePendingEvents();
    expect(b.favoriteRepository.getFavorite('family', 'asset-later')).toBe(true);
  });
});
