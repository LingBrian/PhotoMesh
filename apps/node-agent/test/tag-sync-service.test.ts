import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { SyncService } from '../src/sync/sync-service.js';
import { TagSyncRepository } from '../src/sync/tag-sync-repository.js';
import { makeUnsignedEvent, parseEventEnvelope, signEvent, verifyEvent } from '../src/sync/event-envelope.js';
import { isTagSyncExchangeRequest, TagSyncService } from '../src/sync/tag-sync-service.js';

const databases: Database.Database[] = [];
const now = '2026-10-27T00:00:00.000Z';

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
    VALUES ('asset-1', 'family', ?, 'photo', NULL, ?)`).run(identity.peerId, now);
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true }), () => Date.parse(now));
  const syncRepository = new SyncRepository(database, () => now);
  const tagRepository = new TagSyncRepository(database, () => now);
  const sync = new SyncService(syncRepository, identity, pairing, () => now, (event) => {
    const payload = event.payload;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        ['asset.indexed', 'asset.tombstoned', 'asset.restored'].includes(event.eventType) &&
        typeof payload.assetId === 'string') {
      tagRepository.rebuildAssetTagProjection(event.libraryId, payload.assetId);
    }
    tagRepository.reconcilePendingEvents(event.libraryId);
  }, true);
  const tagSync = new TagSyncService(tagRepository, identity, pairing, () => sync.hello(), () => now);
  return { database, identity, pairing, repository, sync, syncRepository, tagRepository, tagSync };
}

async function ensureSharedAssetIndex(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>): Promise<void> {
  const head = (node: Awaited<ReturnType<typeof createNode>>) => node.database.prepare(`SELECT last_event_id FROM sync_asset_projection
    WHERE library_id = 'family' AND asset_id = 'asset-1'`).get() as { last_event_id: string } | undefined;
  const existingHead = head(a) ?? head(b);
  const event = existingHead
    ? (a.syncRepository.getEventEnvelope(existingHead.last_event_id) ?? b.syncRepository.getEventEnvelope(existingHead.last_event_id))
    : await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
      assetId: 'asset-1', originNodeId: a.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
    } });
  if (!event) throw new Error('shared test asset index event was not persisted');
  for (const node of [a, b]) {
    const current = head(node);
    if (current && current.last_event_id !== event.eventId) throw new Error('test nodes have conflicting asset index events');
    if (!current) node.syncRepository.appendLocalEvent(event);
  }
}

async function trustNodes(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>,
  grantWriter = true, seedAssetIndex = true): Promise<void> {
  a.repository.trustPeer({ peerId: b.identity.peerId, publicKey: Buffer.from(b.identity.publicKey).toString('base64'),
    label: 'B', trustState: 'trusted', createdAt: now, revokedAt: null });
  b.repository.trustPeer({ peerId: a.identity.peerId, publicKey: Buffer.from(a.identity.publicKey).toString('base64'),
    label: 'A', trustState: 'trusted', createdAt: now, revokedAt: null });
  a.repository.grantLibraryRead(b.identity.peerId, 'family', now);
  b.repository.grantLibraryRead(a.identity.peerId, 'family', now);
  if (grantWriter) {
    a.tagRepository.grantTagWriter('family', b.identity.peerId, a.identity.peerId, now);
    b.tagRepository.grantTagWriter('family', a.identity.peerId, b.identity.peerId, now);
  }
  if (seedAssetIndex) await ensureSharedAssetIndex(a, b);
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('dedicated asset-tags/1.0.0 service', () => {
  it('validates bounded requests and requires the negotiated tag capability', async () => {
    const node = await createNode('validator');
    const hello = node.sync.hello();
    const valid = { hello, grantedLibraryIds: ['family'], cursors: [], events: [] };
    expect(isTagSyncExchangeRequest(valid)).toBe(true);
    expect(isTagSyncExchangeRequest(null)).toBe(false);
    expect(isTagSyncExchangeRequest({ ...valid, cursors: [{ libraryId: 'family', authorPeerId: 'peer-123456789', sequence: -1 }] })).toBe(false);
    expect(isTagSyncExchangeRequest({ ...valid, events: Array.from({ length: 65 }, () => ({})) })).toBe(false);

    const remote = await createNode('old-peer');
    await trustNodes(node, remote);
    const oldHello = { ...remote.sync.hello(), capabilities: remote.sync.hello().capabilities.filter((capability) => capability !== 'asset-tags-v1') };
    await expect(node.tagSync.handleExchange(remote.identity.peerId, {
      hello: oldHello, grantedLibraryIds: ['family'], cursors: [], events: []
    })).rejects.toThrow('no common asset tag sync capability');
  });

  it('retries legacy tag seeds once a metadata head appears during a later exchange', async () => {
    const author = await createNode('late-legacy-seed-author');
    const peer = await createNode('late-legacy-seed-peer');
    await trustNodes(author, peer, true, false);
    author.database.prepare(`INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES ('family', 'asset-1', 'legacy', ?)`)
      .run(now);
    author.database.prepare(`INSERT INTO asset_tag_legacy_seeds (library_id, asset_id, tag, created_at, state, seed_event_id)
      VALUES ('family', 'asset-1', 'legacy', ?, 'pending', NULL)`).run(now);
    await author.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
      assetId: 'asset-1', originNodeId: author.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24
    } });

    const response = await author.tagSync.handleExchange(peer.identity.peerId, {
      hello: peer.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: []
    });
    expect(response.events).toHaveLength(1);
    expect(response.events[0]).toMatchObject({ eventType: 'asset.tag.added', payload: { assetId: 'asset-1', tag: 'legacy' } });
    expect(author.database.prepare('SELECT state FROM asset_tag_legacy_seeds').get()).toEqual({ state: 'complete' });
  });

  it('rejects a payload whose signature no longer verifies before inbox ingestion', async () => {
    const author = await createNode('tampered-author');
    const receiver = await createNode('tampered-receiver');
    await trustNodes(author, receiver);
    expect(await author.tagSync.addAssetTag('family', 'asset-1', 'original')).toBe('added');
    const row = author.database.prepare('SELECT envelope_json FROM tag_sync_event_log WHERE author_peer_id = ?')
      .get(author.identity.peerId) as { envelope_json: string };
    const signed = parseEventEnvelope(JSON.parse(row.envelope_json));
    const tampered = { ...signed, payload: { assetId: 'asset-1', tag: 'forged' } };

    await expect(receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [tampered]
    })).rejects.toThrow('tag event signature or author identity is invalid');
    expect(receiver.tagRepository.getAssetTags('family', 'asset-1')).toEqual([]);
    expect(receiver.database.prepare('SELECT count(*) AS count FROM tag_sync_inbox').get()).toEqual({ count: 0 });
  });

  it('does not let an unverified peer cursor hide or acknowledge unoffered local events', async () => {
    const sender = await createNode('cursor-sender');
    const peer = await createNode('cursor-peer');
    await trustNodes(sender, peer);
    expect(await sender.tagSync.addAssetTag('family', 'asset-1', 'must-remain-pending')).toBe('added');
    const stored = sender.database.prepare(`SELECT event_id FROM tag_sync_event_log WHERE event_type = 'asset.tag.added'`)
      .get() as { event_id: string };

    const response = await sender.tagSync.handleExchange(peer.identity.peerId, {
      hello: peer.sync.hello(), grantedLibraryIds: ['family'],
      cursors: [{ libraryId: 'family', authorPeerId: sender.identity.peerId, sequence: 99 }], events: []
    });
    expect(response.events.map((event) => event.eventId)).toEqual([stored.event_id]);
    expect(sender.tagRepository.getAcknowledgedCursors(peer.identity.peerId)).toEqual([]);
    expect(sender.database.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get(peer.identity.peerId))
      .toEqual({ count: 1 });
  });

  it('blocks a locally authored tag event until the peer applies its asset index', async () => {
    const author = await createNode('local-index-author');
    const receiver = await createNode('local-index-receiver');
    await trustNodes(author, receiver, true, false);
    author.database.prepare(`INSERT INTO asset_files
      (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
      VALUES ('file-asset-1', 'asset-1', ?, 24, 'original', 'storage-asset-1', ?)` ).run('f'.repeat(64), now);
    await author.sync.reconcileLocalAssets();
    const indexRow = author.database.prepare(`SELECT envelope_json FROM sync_event_log WHERE event_type = 'asset.indexed'`)
      .get() as { envelope_json: string };
    const index = parseEventEnvelope(JSON.parse(indexRow.envelope_json));
    expect(await author.tagSync.addAssetTag('family', 'asset-1', 'causal-local-tag')).toBe('added');
    const row = author.database.prepare(`SELECT envelope_json FROM tag_sync_event_log WHERE event_type = 'asset.tag.added'`)
      .get() as { envelope_json: string };
    const tagEvent = parseEventEnvelope(JSON.parse(row.envelope_json));
    expect(tagEvent.causalParents).toContain(index.eventId);

    const deferred = await receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [tagEvent]
    });
    expect(deferred.results).toEqual([{ eventId: tagEvent.eventId, status: 'pending' }]);
    expect(receiver.tagRepository.getAssetTags('family', 'asset-1')).toEqual([]);

    await receiver.sync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [index]
    });
    expect(receiver.tagRepository.getAssetTags('family', 'asset-1')).toEqual(['causal-local-tag']);
  });

  it('replays a tag operation after its indexed-asset causal dependency is applied', async () => {
    const author = await createNode('deferred-author');
    const prerequisite = await createNode('deferred-prerequisite');
    const receiver = await createNode('deferred-receiver');
    await trustNodes(author, receiver, true, false);
    await trustNodes(prerequisite, receiver, true, false);
    const prerequisiteEventId = '550e8400-e29b-41d4-a716-446655440010';
    const indexEventId = '550e8400-e29b-41d4-a716-446655440011';
    const prerequisiteEvent = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: prerequisite.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', createdAt: now, eventId: prerequisiteEventId,
      payload: { assetId: 'prerequisite-asset', originNodeId: prerequisite.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 24 }
    }), prerequisite.identity);
    const indexEvent = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [prerequisiteEventId],
      eventType: 'asset.indexed', createdAt: now, eventId: indexEventId,
      payload: { assetId: 'future-asset', originNodeId: author.identity.peerId, kind: 'photo', sha256: 'b'.repeat(64), byteLength: 24 }
    }), author.identity);
    const tagEvent = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [indexEventId],
      eventType: 'asset.tag.added', createdAt: now,
      payload: { assetId: 'future-asset', tag: 'queued-before-index' }
    }), author.identity);

    const pendingIndex = await receiver.sync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [indexEvent]
    });
    expect(pendingIndex.results).toEqual([{ eventId: indexEventId, status: 'pending' }]);
    const deferred = await receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [tagEvent]
    });
    expect(deferred.results).toEqual([{ eventId: tagEvent.eventId, status: 'pending' }]);
    expect(receiver.database.prepare('SELECT error_code FROM tag_sync_inbox WHERE event_id = ?').get(tagEvent.eventId))
      .toEqual({ error_code: null });
    expect(receiver.tagRepository.getAssetTags('family', 'future-asset')).toEqual([]);

    await receiver.sync.handleExchange(prerequisite.identity.peerId, {
      hello: prerequisite.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [prerequisiteEvent]
    });
    expect(receiver.tagRepository.getAssetTags('family', 'future-asset')).toEqual(['queued-before-index']);
    expect(receiver.database.prepare('SELECT state FROM tag_sync_inbox WHERE event_id = ?').get(tagEvent.eventId))
      .toEqual({ state: 'applied' });
  });

  it('rebuilds active tag projection when a tombstoned asset is restored', async () => {
    const author = await createNode('restore-author');
    const receiver = await createNode('restore-receiver');
    await trustNodes(author, receiver, true, false);
    const indexId = '550e8400-e29b-41d4-a716-446655440021';
    const tombstoneId = '550e8400-e29b-41d4-a716-446655440022';
    const index = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', createdAt: now, eventId: indexId,
      payload: { assetId: 'asset-1', originNodeId: author.identity.peerId, kind: 'photo', sha256: 'c'.repeat(64), byteLength: 12 }
    }), author.identity);
    const tombstone = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 2, causalParents: [indexId],
      eventType: 'asset.tombstoned', createdAt: now, eventId: tombstoneId,
      payload: { assetId: 'asset-1', reason: 'user_request' }
    }), author.identity);
    await receiver.sync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [index, tombstone]
    });
    const add = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [tombstoneId],
      eventType: 'asset.tag.added', createdAt: now, payload: { assetId: 'asset-1', tag: 'while-hidden' }
    }), author.identity);
    await receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [add]
    });
    expect(receiver.tagRepository.getAssetTags('family', 'asset-1')).toEqual([]);

    const restore = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 3, causalParents: [tombstoneId],
      eventType: 'asset.restored', createdAt: now,
      payload: { assetId: 'asset-1', tombstoneEventId: tombstoneId }
    }), author.identity);
    await receiver.sync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [restore]
    });
    expect(receiver.tagRepository.getAssetTags('family', 'asset-1')).toEqual(['while-hidden']);
  });

  it('rejects causal parents from a different library', async () => {
    const author = await createNode('cross-library-author');
    const receiver = await createNode('cross-library-receiver');
    await trustNodes(author, receiver);
    const foreignIndex = await signEvent(makeUnsignedEvent({
      libraryId: 'other-library', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', createdAt: now, eventId: '550e8400-e29b-41d4-a716-446655440031',
      payload: { assetId: 'other-asset', originNodeId: author.identity.peerId, kind: 'photo', sha256: 'e'.repeat(64), byteLength: 24 }
    }), author.identity);
    await receiver.sync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['other-library'], cursors: [], events: [foreignIndex]
    });
    const tag = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [foreignIndex.eventId],
      eventType: 'asset.tag.added', createdAt: now, payload: { assetId: 'asset-1', tag: 'cross-library' }
    }), author.identity);
    const response = await receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [tag]
    });
    expect(response.results).toEqual([{ eventId: tag.eventId, status: 'conflict' }]);
    expect(receiver.database.prepare('SELECT error_code FROM tag_sync_inbox WHERE event_id = ?').get(tag.eventId))
      .toEqual({ error_code: 'cross_library_causal_parent' });
  });

  it('quarantines tag operations with no indexed-asset causal dependency', async () => {
    const author = await createNode('unknown-author');
    const receiver = await createNode('unknown-receiver');
    await trustNodes(author, receiver);
    const event = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.tag.added', createdAt: now, payload: { assetId: 'asset-1', tag: 'orphan' }
    }), author.identity);
    const response = await receiver.tagSync.handleExchange(author.identity.peerId, {
      hello: author.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [event]
    });
    expect(response.results).toEqual([{ eventId: event.eventId, status: 'conflict' }]);
    expect(receiver.database.prepare('SELECT error_code FROM tag_sync_inbox WHERE event_id = ?').get(event.eventId))
      .toEqual({ error_code: 'unknown_asset_dependency' });
  });

  it('exchanges signed tag events with independent cursors and retains denied writes', async () => {
    const a = await createNode('a');
    const b = await createNode('b');
    await trustNodes(a, b);
    expect(await a.tagSync.addAssetTag('family', 'asset-1', 'shared')).toBe('added');
    expect(await b.tagSync.addAssetTag('family', 'asset-1', 'local-only')).toBe('added');
    const firstStored = a.database.prepare('SELECT envelope_json FROM tag_sync_event_log WHERE author_peer_id = ?')
      .get(a.identity.peerId) as { envelope_json: string };
    const firstEvent = parseEventEnvelope(JSON.parse(firstStored.envelope_json));
    const trustedA = b.pairing.listPeers().find((peer) => peer.peerId === a.identity.peerId)!;
    expect(await verifyEvent(firstEvent, trustedA.publicKey)).toBe(true);

    const transport = { exchangeTags: async (_peerId: string, request: Parameters<TagSyncService['handleExchange']>[1]) =>
      b.tagSync.handleExchange(a.identity.peerId, request) };
    const synced = await a.tagSync.syncWithPeer(b.identity.peerId, transport);
    expect(synced.sent).toBe(1);
    expect(synced.received).toBe(1);
    expect(a.tagRepository.getAssetTags('family', 'asset-1').sort()).toEqual(['local-only', 'shared']);
    expect(b.tagRepository.getAssetTags('family', 'asset-1').sort()).toEqual(['local-only', 'shared']);
    expect(a.database.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get(b.identity.peerId))
      .toEqual({ count: 0 });

    const deniedA = await createNode('denied-a');
    const deniedB = await createNode('denied-b');
    await trustNodes(deniedA, deniedB, false);
    expect(await deniedA.tagSync.addAssetTag('family', 'asset-1', 'permission')).toBe('added');
    const deniedTransport = { exchangeTags: async (_peerId: string, request: Parameters<TagSyncService['handleExchange']>[1]) =>
      deniedB.tagSync.handleExchange(deniedA.identity.peerId, request) };
    await deniedA.tagSync.syncWithPeer(deniedB.identity.peerId, deniedTransport);
    expect(deniedB.tagRepository.getAssetTags('family', 'asset-1')).toEqual([]);
    expect(deniedA.database.prepare('SELECT last_error FROM tag_sync_outbox WHERE peer_id = ?').get(deniedB.identity.peerId))
      .toEqual({ last_error: 'tag_write_denied' });
  });
});
