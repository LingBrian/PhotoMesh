import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { RatingSyncRepository } from '../src/sync/rating-sync-repository.js';
import { RatingSyncService, isRatingSyncExchangeRequest, type RatingSyncTransport } from '../src/sync/rating-sync-service.js';
import { makeUnsignedEvent, signEvent } from '../src/sync/event-envelope.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';

const databases: Database.Database[] = [];
let clockMs = Date.parse('2026-10-29T00:00:00.000Z');
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
  database.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,capture_ts,created_at)
    VALUES('asset-1','family',?,'photo',NULL,?)`).run(identity.peerId, now());
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true }), () => clockMs);
  const syncRepository = new SyncRepository(database, now);
  const sync = new SyncService(syncRepository, identity, pairing, now, undefined, false, false, false, true);
  const ratingRepository = new RatingSyncRepository(database, now);
  const ratings = new RatingSyncService(ratingRepository, identity, pairing, () => sync.hello(), now);
  return { database, repository, identity, pairing, syncRepository, sync, ratingRepository, ratings };
}

async function trustNodes(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>, grantRatingWrite = true) {
  a.repository.trustPeer({ peerId: b.identity.peerId, publicKey: Buffer.from(b.identity.publicKey).toString('base64'), label: 'B', trustState: 'trusted', createdAt: now(), revokedAt: null });
  b.repository.trustPeer({ peerId: a.identity.peerId, publicKey: Buffer.from(a.identity.publicKey).toString('base64'), label: 'A', trustState: 'trusted', createdAt: now(), revokedAt: null });
  a.repository.grantLibraryRead(b.identity.peerId, 'family', now());
  b.repository.grantLibraryRead(a.identity.peerId, 'family', now());
  if (grantRatingWrite) {
    a.ratingRepository.grantRatingWriter('family', b.identity.peerId, a.identity.peerId, now());
    b.ratingRepository.grantRatingWriter('family', a.identity.peerId, b.identity.peerId, now());
  }
  const getIndex = (node: Awaited<ReturnType<typeof createNode>>) => node.database.prepare(
    `SELECT last_event_id FROM sync_asset_projection WHERE library_id='family' AND asset_id='asset-1'`
  ).get() as { last_event_id: string } | undefined;
  const existing = getIndex(a) ?? getIndex(b);
  const event = existing
    ? a.syncRepository.getEventEnvelope(existing.last_event_id) ?? b.syncRepository.getEventEnvelope(existing.last_event_id)
    : await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
      assetId: 'asset-1', originNodeId: a.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 12
    } });
  if (!event) throw new Error('rating test asset index event was not created');
  for (const node of [a, b]) if (!getIndex(node)) node.syncRepository.appendLocalEvent(event);
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  clockMs = Date.parse('2026-10-29T00:00:00.000Z');
});

describe('library-scoped asset rating sync', () => {
  it('validates bounded requests and requires the negotiated rating capability', async () => {
    const a = await createNode('rating-validator-a');
    const b = await createNode('rating-validator-b');
    await trustNodes(a, b);
    const hello = a.sync.hello();
    const request = { hello: b.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [] };
    expect(isRatingSyncExchangeRequest(request)).toBe(true);
    expect(isRatingSyncExchangeRequest({ ...request, cursors: [{ libraryId: 'family', authorPeerId: 'peer-123456789', sequence: -1 }] })).toBe(false);
    expect(isRatingSyncExchangeRequest({ ...request, events: Array.from({ length: 65 }, () => ({})) })).toBe(false);
    const oldHello = { ...b.sync.hello(), capabilities: b.sync.hello().capabilities.filter((capability) => capability !== 'asset-ratings-v1') };
    await expect(a.ratings.handleExchange(b.identity.peerId, { ...request, hello: oldHello })).rejects.toThrow(/no common asset rating sync capability/i);
    expect(hello.capabilities).toContain('asset-ratings-v1');
  });

  it('preserves concurrent values as visible conflicts and resolves only observed candidates', async () => {
    const a = await createNode('rating-orset-a');
    const b = await createNode('rating-orset-b');
    await trustNodes(a, b);
    const toB: RatingSyncTransport = { exchangeRatings: async (_peerId, request) => b.ratings.handleExchange(a.identity.peerId, request) };
    const toA: RatingSyncTransport = { exchangeRatings: async (_peerId, request) => a.ratings.handleExchange(b.identity.peerId, request) };

    await a.ratings.setAssetRating({ operationId: '00000000-0000-4000-8000-000000000401', principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', rating: 3, requestFingerprint: 'a'.repeat(64) });
    await b.ratings.setAssetRating({ operationId: '00000000-0000-4000-8000-000000000402', principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', rating: 5, requestFingerprint: 'b'.repeat(64) });
    await a.ratings.syncWithPeer(b.identity.peerId, toB);
    expect(b.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: null, conflict: true, ratingCandidates: [3, 5] });
    await b.ratings.syncWithPeer(a.identity.peerId, toA);
    expect(a.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: null, conflict: true, ratingCandidates: [3, 5] });

    await a.ratings.setAssetRating({ operationId: '00000000-0000-4000-8000-000000000403', principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', rating: 4, requestFingerprint: 'c'.repeat(64) });
    await a.ratings.syncWithPeer(b.identity.peerId, toB);
    expect(a.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: 4, conflict: false, ratingCandidates: [4] });
    expect(b.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: 4, conflict: false, ratingCandidates: [4] });
  });

  it('denies remote writes by default and retries after a separate rating-write grant', async () => {
    const a = await createNode('rating-acl-a');
    const b = await createNode('rating-acl-b');
    await trustNodes(a, b, false);
    const transport: RatingSyncTransport = { exchangeRatings: async (_peerId, request) => b.ratings.handleExchange(a.identity.peerId, request) };
    await a.ratings.setAssetRating({ operationId: '00000000-0000-4000-8000-000000000411', principalId: 'local-admin', libraryId: 'family', assetId: 'asset-1', rating: 2, requestFingerprint: 'd'.repeat(64) });
    await a.ratings.syncWithPeer(b.identity.peerId, transport);
    expect(b.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: null, conflict: false, ratingCandidates: [] });
    expect(a.ratingRepository.getPeerSyncStatus(b.identity.peerId).lastError).toBe('rating_write_denied');

    b.ratingRepository.grantRatingWriter('family', a.identity.peerId, b.identity.peerId, now());
    clockMs += 11_000;
    await a.ratings.syncWithPeer(b.identity.peerId, transport);
    expect(b.ratingRepository.getRating('family', 'asset-1')).toEqual({ rating: 2, conflict: false, ratingCandidates: [2] });
    expect(a.ratingRepository.getPeerSyncStatus(b.identity.peerId).pending).toBe(0);
  });

  it('requires author read access and applies accepted pending events after write revocation', async () => {
    const a = await createNode('rating-revoke-a');
    const b = await createNode('rating-revoke-b');
    await trustNodes(a, b, false);
    b.database.prepare('DELETE FROM library_grants WHERE peer_id=? AND library_id=?').run(a.identity.peerId, 'family');
    expect(() => b.ratingRepository.grantRatingWriter('family', a.identity.peerId, b.identity.peerId, now())).toThrow(/library read grant/i);
    b.repository.grantLibraryRead(a.identity.peerId, 'family', now());
    b.ratingRepository.grantRatingWriter('family', a.identity.peerId, b.identity.peerId, now());
    b.ratingRepository.setRemoteLibraries(a.identity.peerId, ['family']);
    b.database.prepare('DELETE FROM library_grants WHERE peer_id=? AND library_id=?').run(a.identity.peerId, 'family');
    const denied = await signEvent(makeUnsignedEvent({
      eventId: '00000000-0000-4000-8000-000000000421', libraryId: 'family', authorPeerId: a.identity.peerId,
      authorSequence: 1, causalParents: ['00000000-0000-4000-8000-000000000422'], eventType: 'asset.rating.set',
      payload: { assetId: 'asset-later', rating: 5, observedRatingEventIds: [] }, createdAt: now()
    }), a.identity);
    const deniedResponse = await b.ratings.handleExchange(a.identity.peerId, { hello: a.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [denied] });
    expect(deniedResponse.results).toEqual([{ eventId: denied.eventId, status: 'unauthorized' }]);
    expect(b.database.prepare('SELECT count(*) n FROM rating_sync_inbox').get()).toEqual({ n: 0 });

    b.repository.grantLibraryRead(a.identity.peerId, 'family', now());
    const parentId = '00000000-0000-4000-8000-000000000422';
    const pendingEvent = await signEvent(makeUnsignedEvent({
      eventId: '00000000-0000-4000-8000-000000000423', libraryId: 'family', authorPeerId: a.identity.peerId,
      authorSequence: 1, causalParents: [parentId], eventType: 'asset.rating.set',
      payload: { assetId: 'asset-later', rating: 5, observedRatingEventIds: [] }, createdAt: now()
    }), a.identity);
    const response = await b.ratings.handleExchange(a.identity.peerId, { hello: a.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [pendingEvent] });
    expect(response.results).toEqual([{ eventId: pendingEvent.eventId, status: 'pending' }]);
    b.ratingRepository.revokeRatingWriter('family', a.identity.peerId, now());
    const rootContext = b.syncRepository.getLocalEventContext('family', b.identity.peerId);
    const root = await signEvent(makeUnsignedEvent({
      eventId: parentId, libraryId: 'family', authorPeerId: b.identity.peerId, authorSequence: rootContext.authorSequence,
      causalParents: rootContext.causalParents, eventType: 'asset.indexed',
      payload: { assetId: 'asset-later', originNodeId: b.identity.peerId, kind: 'photo', sha256: 'c'.repeat(64), byteLength: 10 }, createdAt: now()
    }), b.identity);
    b.syncRepository.appendLocalEvent(root);
    b.ratingRepository.reconcilePendingEvents();
    expect(b.ratingRepository.getRating('family', 'asset-later')).toEqual({ rating: 5, conflict: false, ratingCandidates: [5] });
  });
});
