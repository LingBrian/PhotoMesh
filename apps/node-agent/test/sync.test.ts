import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { SqliteRepository } from '../src/db/repository.js';
import { migrations } from '../src/db/migrations.js';
import { SyncRepository, SyncAuthorizationError, SyncProtocolConflictError } from '../src/sync/sync-repository.js';
import { isSyncExchangeRequest, negotiateProtocol, SyncService, type SyncHello } from '../src/sync/sync-service.js';
import { makeUnsignedEvent, signEvent } from '../src/sync/event-envelope.js';

const databases: Database.Database[] = [];

afterEach(() => databases.splice(0).forEach((database) => database.close()));

async function createNode() {
  const database = new Database(':memory:');
  databases.push(database);
  const pairingRepository = new SqliteRepository(database);
  await pairingRepository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(pairingRepository, {
    get: (name) => secrets.get(name), set: (name, value) => { secrets.set(name, value); }
  });
  const pairing = new PairingService(pairingRepository, identity.peerId, async () => ({ approved: true }));
  const syncRepository = new SyncRepository(database);
  const sync = new SyncService(syncRepository, identity, pairing);
  return { database, pairingRepository, identity, pairing, syncRepository, sync };
}

async function trustEachOther(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>, libraryId = 'family') {
  const now = '2026-10-21T00:00:00.000Z';
  a.pairingRepository.trustPeer({ peerId: b.identity.peerId, publicKey: Buffer.from(b.identity.publicKey).toString('base64'), label: 'B', trustState: 'trusted', createdAt: now, revokedAt: null });
  b.pairingRepository.trustPeer({ peerId: a.identity.peerId, publicKey: Buffer.from(a.identity.publicKey).toString('base64'), label: 'A', trustState: 'trusted', createdAt: now, revokedAt: null });
  a.pairingRepository.grantLibraryRead(b.identity.peerId, libraryId, now);
  b.pairingRepository.grantLibraryRead(a.identity.peerId, libraryId, now);
  a.syncRepository.setRemoteLibraries(b.identity.peerId, [libraryId]);
  b.syncRepository.setRemoteLibraries(a.identity.peerId, [libraryId]);
}

async function indexAsset(node: Awaited<ReturnType<typeof createNode>>, assetId = 'asset-1') {
  return node.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.indexed', payload: {
    assetId, originNodeId: node.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10
  } });
}

describe('P2P signed event synchronization', () => {
  it('assigns author sequence and causal parents without consulting wall-clock order', async () => {
    const node = await createNode();
    const first = await indexAsset(node);
    const second = await node.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'second' } }, createdAt: '1990-01-01T00:00:00.000Z' });
    expect(first.authorSequence).toBe(1);
    expect(second.authorSequence).toBe(2);
    expect(second.causalParents).toEqual([first.eventId]);
    expect(second.createdAt).toBe('1990-01-01T00:00:00.000Z');
  });

  it('reconciles legacy local assets into signed index events idempotently without origin paths', async () => {
    const node = await createNode();
    node.database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
      VALUES ('legacy-asset', 'family', 'legacy-node', 'photo', NULL, '2025-01-01T00:00:00.000Z')`).run();
    node.database.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
      VALUES ('legacy-file', 'legacy-asset', ?, 9, 'original', 'external:/legacy.jpg', '2025-01-01T00:00:00.000Z')`).run('c'.repeat(64));
    expect(await node.sync.reconcileLocalAssets()).toBe(1);
    expect(await node.sync.reconcileLocalAssets()).toBe(0);
    const projection = node.syncRepository.getProjection('family', 'legacy-asset');
    expect(projection).toMatchObject({ originNodeId: node.identity.peerId, sha256: 'c'.repeat(64), byteLength: 9 });
    const stored = node.database.prepare("SELECT payload_json, state FROM sync_event_log WHERE event_type = 'asset.indexed'").get() as { payload_json: string; state: string };
    expect(JSON.parse(stored.payload_json)).not.toHaveProperty('path');
    expect(stored.state).toBe('ready');
  });

  it('waits for missing causal parents and applies buffered out-of-order events after their parent arrives', async () => {
    const host = await createNode();
    const receiver = await createNode();
    await trustEachOther(host, receiver);
    const index = await indexAsset(host);
    const metadata = await host.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'ready' } } });
    expect(receiver.syncRepository.ingest(host.identity.peerId, metadata).status).toBe('pending');
    expect(receiver.syncRepository.getProjection('family', 'asset-1')).toBeUndefined();
    expect(receiver.syncRepository.ingest(host.identity.peerId, index).appliedEventIds).toEqual([index.eventId, metadata.eventId]);
    expect(receiver.syncRepository.getProjection('family', 'asset-1')?.metadata.caption).toBe('ready');
  });

  it('deduplicates repeated delivery and rejects ungranted libraries before storing them', async () => {
    const host = await createNode();
    const receiver = await createNode();
    const untrustedAuthor = await createNode();
    await trustEachOther(host, receiver);
    const event = await indexAsset(host);
    expect(receiver.syncRepository.ingest(host.identity.peerId, event).status).toBe('applied');
    expect(receiver.syncRepository.ingest(host.identity.peerId, event).status).toBe('duplicate');
    expect(receiver.pairing.readLibraryIndex(host.identity.peerId, 'family')).toContainEqual({
      assetId: 'asset-1', libraryId: 'family', originNodeId: host.identity.peerId,
      kind: 'photo', sha256: 'a'.repeat(64), availability: 'missing'
    });
    const denied = await host.sync.createLocalEvent({ libraryId: 'private', eventType: 'asset.indexed', payload: {
      assetId: 'private-asset', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'b'.repeat(64), byteLength: 4
    } });
    expect(() => receiver.syncRepository.ingest(host.identity.peerId, denied)).toThrow(SyncAuthorizationError);
    expect(receiver.syncRepository.getProjection('private', 'private-asset')).toBeUndefined();
    const forgedRelay = await indexAsset(untrustedAuthor, 'relay-asset');
    expect(() => receiver.syncRepository.ingest(host.identity.peerId, forgedRelay)).toThrow(SyncAuthorizationError);
    expect(receiver.syncRepository.getProjection('family', 'relay-asset')).toBeUndefined();
  });

  it('retains an unknown signed schema event without applying it or advancing the author cursor', async () => {
    const host = await createNode();
    const receiver = await createNode();
    await trustEachOther(host, receiver);
    const indexed = makeUnsignedEvent({
      libraryId: 'family', authorPeerId: host.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', createdAt: '2026-10-21T00:00:00.000Z',
      payload: { assetId: 'future-asset', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'd'.repeat(64), byteLength: 12 }
    });
    const future = await signEvent({ ...indexed, schemaVersion: 2, eventType: 'asset.indexed.v2' }, host.identity);

    expect(receiver.syncRepository.ingest(host.identity.peerId, future)).toMatchObject({ status: 'unsupported', appliedEventIds: [] });
    expect(receiver.database.prepare('SELECT state, error_code FROM sync_inbox WHERE event_id = ?').get(future.eventId))
      .toEqual({ state: 'unsupported', error_code: 'unsupported_event_version' });
    expect(receiver.syncRepository.getProjection('family', 'future-asset')).toBeUndefined();
    expect(receiver.syncRepository.getCursors(['family'])).toEqual([]);
  });

  it('does not let an ahead-of-log cursor delete unacknowledged outbox events', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    await indexAsset(a);
    const second = await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'not yet acked' } } });
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId)).toEqual({ count: 2 });
    a.syncRepository.acknowledgeCursors(b.identity.peerId, [{ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 }]);
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([{ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 }]);
    expect(a.database.prepare('SELECT event_id FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId)).toEqual({ event_id: second.eventId });
    a.syncRepository.acknowledgeCursors(b.identity.peerId, [{ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 9000 }]);
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([{ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 2 }]);
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId)).toEqual({ count: 0 });
  });

  it('rejects malformed cursors before acknowledging incoming requests', async () => {
    const sender = await createNode();
    const receiver = await createNode();
    await trustEachOther(sender, receiver);
    await indexAsset(receiver, 'request-cursor-asset');

    await expect(receiver.sync.handleExchange(sender.identity.peerId, {
      hello: sender.sync.hello(), grantedLibraryIds: ['family'],
      cursors: [{ libraryId: 'family', authorPeerId: receiver.identity.peerId, sequence: -1 }], events: []
    })).rejects.toThrow('invalid sync batch');
    expect(receiver.syncRepository.getAcknowledgedCursors(sender.identity.peerId)).toEqual([]);
    expect(receiver.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(sender.identity.peerId))
      .toEqual({ count: 1 });
  });

  it('does not persist remote grants or acknowledgements from a batch with an invalid signature', async () => {
    const sender = await createNode();
    const receiver = await createNode();
    await trustEachOther(sender, receiver);
    await indexAsset(receiver, 'receiver-outbox-asset');
    const firstValidEvent = await indexAsset(sender, 'valid-request-before-invalid');
    const signed = await sender.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated',
      payload: { assetId: 'valid-request-before-invalid', fields: { caption: 'must not apply' } } });
    const changed = { ...signed, payload: { ...(signed.payload as Record<string, string | number>), fields: { caption: 'tampered' } } };

    await expect(receiver.sync.handleExchange(sender.identity.peerId, {
      hello: sender.sync.hello(), grantedLibraryIds: ['family', 'untrusted-extra'],
      cursors: [{ libraryId: 'family', authorPeerId: receiver.identity.peerId, sequence: 1 }], events: [firstValidEvent, changed]
    })).rejects.toThrow('event signature or author identity is invalid');

    expect(receiver.syncRepository.getRemoteLibraries(sender.identity.peerId)).toEqual(['family']);
    expect(receiver.syncRepository.getAcknowledgedCursors(sender.identity.peerId)).toEqual([]);
    expect(receiver.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(sender.identity.peerId))
      .toEqual({ count: 1 });
    expect(receiver.syncRepository.getProjection('family', 'valid-request-before-invalid')).toBeUndefined();
  });

  it('rejects a payload changed after signing before it reaches the projection', async () => {
    const host = await createNode();
    const receiver = await createNode();
    await trustEachOther(host, receiver);
    const signed = await indexAsset(host);
    const changed = { ...signed, payload: { ...(signed.payload as Record<string, string | number>), byteLength: 11 } };
    await expect(receiver.sync.handleExchange(host.identity.peerId, {
      hello: host.sync.hello(), grantedLibraryIds: ['family'], cursors: [], events: [changed]
    })).rejects.toThrow('event signature or author identity is invalid');
    expect(receiver.syncRepository.getProjection('family', 'asset-1')).toBeUndefined();
  });

  it('quarantines a different signed event that reuses an author sequence', async () => {
    const host = await createNode();
    const receiver = await createNode();
    await trustEachOther(host, receiver);
    const original = await indexAsset(host);
    receiver.syncRepository.ingest(host.identity.peerId, original);
    const conflicting = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: host.identity.peerId, authorSequence: original.authorSequence,
      causalParents: [], eventType: 'asset.indexed', createdAt: '2026-10-21T00:00:00.000Z',
      payload: { assetId: 'different-asset', originNodeId: host.identity.peerId, kind: 'photo', sha256: 'b'.repeat(64), byteLength: 20 }
    }), host.identity);
    expect(() => receiver.syncRepository.ingest(host.identity.peerId, conflicting)).toThrow('author_sequence_conflict');
    expect(receiver.database.prepare('SELECT error_code FROM sync_rejected_events WHERE event_id = ?').get(conflicting.eventId))
      .toEqual({ error_code: 'author_sequence_conflict' });
  });

  it('retains concurrent metadata values as a conflict and chooses a deterministic display value independent of timestamps', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const initial = await indexAsset(a);
    expect(b.syncRepository.ingest(a.identity.peerId, initial).status).toBe('applied');
    const fromA = await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'Alpha' } }, createdAt: '2030-01-01T00:00:00.000Z' });
    const fromB = await b.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'Beta' } }, createdAt: '2000-01-01T00:00:00.000Z' });
    a.syncRepository.ingest(b.identity.peerId, fromB);
    b.syncRepository.ingest(a.identity.peerId, fromA);
    const stateA = a.syncRepository.getProjection('family', 'asset-1');
    const stateB = b.syncRepository.getProjection('family', 'asset-1');
    const expected = [a.identity.peerId, b.identity.peerId].sort().at(-1) === a.identity.peerId ? 'Alpha' : 'Beta';
    expect(stateA?.metadata.caption).toBe(expected);
    expect(stateB?.metadata.caption).toBe(expected);
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_conflicts WHERE resolved_by_event_id IS NULL').get()).toEqual({ count: 1 });
    expect(b.database.prepare('SELECT count(*) AS count FROM sync_conflicts WHERE resolved_by_event_id IS NULL').get()).toEqual({ count: 1 });
  });

  it('keeps tombstones as metadata, wins concurrent updates, and requires an explicit causally linked restore', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const initial = await indexAsset(a);
    b.syncRepository.ingest(a.identity.peerId, initial);
    const tombstone = await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.tombstoned', payload: { assetId: 'asset-1', reason: 'user removed from album' } });
    const concurrentEdit = await b.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { caption: 'late edit' } } });
    const concurrentTombstone = await b.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.tombstoned', payload: { assetId: 'asset-1', reason: 'removed on NAS' } });
    a.syncRepository.ingest(b.identity.peerId, concurrentEdit);
    a.syncRepository.ingest(b.identity.peerId, concurrentTombstone);
    b.syncRepository.ingest(a.identity.peerId, tombstone);
    expect(a.syncRepository.getProjection('family', 'asset-1')?.tombstoned).toBe(true);
    expect(b.syncRepository.getProjection('family', 'asset-1')?.tombstoned).toBe(true);
    const restored = await a.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.restored', payload: { assetId: 'asset-1', tombstoneEventId: tombstone.eventId } });
    expect(restored.causalParents).toContain(tombstone.eventId);
    expect(restored.causalParents).toContain(concurrentTombstone.eventId);
    b.syncRepository.ingest(a.identity.peerId, restored);
    expect(b.syncRepository.getProjection('family', 'asset-1')?.tombstoned).toBe(true);
    const restoreSecond = await b.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.restored', payload: { assetId: 'asset-1', tombstoneEventId: concurrentTombstone.eventId } });
    a.syncRepository.ingest(b.identity.peerId, restoreSecond);
    expect(a.syncRepository.getProjection('family', 'asset-1')?.tombstoned).toBe(false);
    expect(b.syncRepository.getProjection('family', 'asset-1')?.sha256).toBe('a'.repeat(64));
  });

  it('negotiates a common N-1 version and refuses disjoint protocol or schema ranges', () => {
    const current: SyncHello = { nodeId: 'current-node-123', protocolMin: 1, protocolMax: 2, schemaVersions: [1, 2], capabilities: ['asset.indexed', 'asset.restored'] };
    const previous: SyncHello = { nodeId: 'previous-node-123', protocolMin: 1, protocolMax: 1, schemaVersions: [1], capabilities: ['asset.indexed'] };
    expect(negotiateProtocol(current, previous)).toEqual({ protocol: 1, schemaVersion: 1, capabilities: ['asset.indexed'] });
    expect(() => negotiateProtocol({ ...current, protocolMin: 3, protocolMax: 3 }, previous)).toThrow(SyncProtocolConflictError);
    expect(() => negotiateProtocol(current, { ...previous, schemaVersions: [9] })).toThrow(SyncProtocolConflictError);
    expect(() => negotiateProtocol(current, { ...previous, schemaVersions: [] })).toThrow('invalid protocol hello');
    expect(() => negotiateProtocol({ ...current, protocolMin: 0 }, previous)).toThrow('invalid protocol hello');
  });

  it('validates hello, grants, cursors, and bounded event batches before exchange', async () => {
    const node = await createNode();
    const hello = node.sync.hello();
    const valid = { hello, grantedLibraryIds: ['family'], cursors: [], events: [] };
    expect(isSyncExchangeRequest(valid)).toBe(true);
    expect(isSyncExchangeRequest(null)).toBe(false);
    expect(isSyncExchangeRequest({ ...valid, hello: { ...hello, protocolMax: 0 } })).toBe(false);
    expect(isSyncExchangeRequest({ ...valid, cursors: [{ libraryId: 'family', authorPeerId: 'peer-valid-12345', sequence: -1 }] })).toBe(false);
    expect(isSyncExchangeRequest({ ...valid, events: Array.from({ length: 65 }, () => ({})) })).toBe(false);
    await expect(node.sync.syncWithPeer('untrusted-peer-123', { exchange: async () => { throw new Error('must not connect'); } }))
      .rejects.toBeInstanceOf(SyncAuthorizationError);
  });

  it('syncs both authorized directions with independent cursors and durable outbox acknowledgements', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const eventA = await indexAsset(a, 'from-a');
    const eventB = await indexAsset(b, 'from-b');
    const transport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => b.sync.handleExchange(a.identity.peerId, request) };
    const result = await a.sync.syncWithPeer(b.identity.peerId, transport);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(1);
    expect(a.syncRepository.getProjection('family', 'from-b')?.lastEventId).toBe(eventB.eventId);
    expect(b.syncRepository.getProjection('family', 'from-a')?.lastEventId).toBe(eventA.eventId);
  });

  it('does not persist grants or acknowledgements from a response with an invalid signature', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    await indexAsset(a, 'client-outbox-asset');
    await indexAsset(b, 'valid-response-before-invalid');
    await b.sync.createLocalEvent({ libraryId: 'family', eventType: 'asset.metadata.updated',
      payload: { assetId: 'valid-response-before-invalid', fields: { caption: 'must not apply' } } });
    const malformedResponseTransport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      const response = await b.sync.handleExchange(a.identity.peerId, request);
      expect(response.events).toHaveLength(2);
      const changed = { ...response.events[1]!, payload: { ...(response.events[1]!.payload as Record<string, string | number>), fields: { caption: 'tampered' } } };
      return { ...response, grantedLibraryIds: ['family', 'untrusted-extra'], events: [response.events[0]!, changed] };
    } };

    await expect(a.sync.syncWithPeer(b.identity.peerId, malformedResponseTransport, 1))
      .rejects.toThrow('event signature or author identity is invalid');
    expect(a.syncRepository.getRemoteLibraries(b.identity.peerId)).toEqual(['family']);
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([]);
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId))
      .toEqual({ count: 1 });
    expect(a.syncRepository.getProjection('family', 'valid-response-before-invalid')).toBeUndefined();
  });

  it('retries a persisted event after the peer commits it but the acknowledgement is lost', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const event = await indexAsset(a, 'ack-lost-asset');

    const lostAckTransport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      await b.sync.handleExchange(a.identity.peerId, request);
      throw new Error('ack lost after peer committed event');
    } };
    await expect(a.sync.syncWithPeer(b.identity.peerId, lostAckTransport)).rejects.toThrow('ack lost after peer committed event');
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([]);
    expect(b.syncRepository.getProjection('family', 'ack-lost-asset')?.lastEventId).toBe(event.eventId);

    const resentEventIds: string[] = [];
    const retryStatuses: string[] = [];
    const retryTransport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      resentEventIds.push(...request.events.map((item) => item.eventId));
      const response = await b.sync.handleExchange(a.identity.peerId, request);
      retryStatuses.push(...response.results.map((result) => result.status));
      return response;
    } };
    const result = await a.sync.syncWithPeer(b.identity.peerId, retryTransport);

    expect(result.sent).toBe(1);
    expect(resentEventIds).toEqual([event.eventId]);
    expect(retryStatuses).toEqual(['duplicate']);
    expect(b.syncRepository.getProjection('family', 'ack-lost-asset')?.lastEventId).toBe(event.eventId);
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([
      { libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 }
    ]);
    expect(a.database.prepare('SELECT 1 FROM sync_outbox WHERE peer_id = ? AND event_id = ?')
      .get(b.identity.peerId, event.eventId)).toBeUndefined();
  });

  it('rejects malformed response cursors before acknowledging durable outbox events', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    await indexAsset(a, 'malformed-cursor-asset');

    const malformedResponseTransport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      const response = await b.sync.handleExchange(a.identity.peerId, request);
      return { ...response, cursors: [{ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: -1 }] };
    } };

    await expect(a.sync.syncWithPeer(b.identity.peerId, malformedResponseTransport, 1)).rejects.toThrow('invalid sync response');
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([]);
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId)).toEqual({ count: 1 });
    expect(b.syncRepository.getProjection('family', 'malformed-cursor-asset')).toBeDefined();
  });

  it('rejects oversized response cursor arrays before acknowledging durable outbox events', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    await indexAsset(a, 'oversized-cursor-asset');
    const cursor = { libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 };
    const oversizedResponseTransport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      const response = await b.sync.handleExchange(a.identity.peerId, request);
      return { ...response, cursors: Array.from({ length: 4097 }, () => cursor) };
    } };

    await expect(a.sync.syncWithPeer(b.identity.peerId, oversizedResponseTransport, 1)).rejects.toThrow('invalid sync response');
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([]);
    expect(a.database.prepare('SELECT count(*) AS count FROM sync_outbox WHERE peer_id = ?').get(b.identity.peerId)).toEqual({ count: 1 });
  });

  it('retries an offered event until a durable acknowledgement cursor is returned', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const event = await indexAsset(a, 'stale-ack-asset');
    let calls = 0;
    const transport = { exchange: async (_peerId: string, request: Parameters<SyncService['handleExchange']>[1]) => {
      calls += 1;
      const response = await b.sync.handleExchange(a.identity.peerId, request);
      return calls === 1 ? { ...response, cursors: [] } : response;
    } };

    const result = await a.sync.syncWithPeer(b.identity.peerId, transport);

    expect(calls).toBe(2);
    expect(result.rounds).toBe(2);
    expect(result.sent).toBe(2);
    expect(b.syncRepository.getProjection('family', 'stale-ack-asset')?.lastEventId).toBe(event.eventId);
    expect(a.syncRepository.getAcknowledgedCursors(b.identity.peerId)).toEqual([
      { libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 }
    ]);
    expect(a.database.prepare('SELECT 1 FROM sync_outbox WHERE peer_id = ? AND event_id = ?')
      .get(b.identity.peerId, event.eventId)).toBeUndefined();
  });

  it('rejects a peer that reports a different negotiated protocol than its hello', async () => {
    const a = await createNode();
    const b = await createNode();
    await trustEachOther(a, b);
    const transport = { exchange: async () => ({
      hello: b.sync.hello(), agreedProtocol: 2, schemaVersion: 1, grantedLibraryIds: [], cursors: [], events: [], results: []
    }) };
    await expect(a.sync.syncWithPeer(b.identity.peerId, transport)).rejects.toThrow('inconsistent protocol negotiation');
  });

  it('rejects an exchange hello whose node identity differs from the authenticated peer', async () => {
    const host = await createNode();
    const remote = await createNode();
    await trustEachOther(host, remote);

    await expect(host.sync.handleExchange(remote.identity.peerId, {
      hello: { ...remote.sync.hello(), nodeId: 'impersonated-node-123' },
      grantedLibraryIds: ['family'], cursors: [], events: []
    })).rejects.toThrow('hello identity does not match authenticated peer');
  });

  it('rejects a sync response hello whose node identity differs from the requested peer', async () => {
    const local = await createNode();
    const remote = await createNode();
    await trustEachOther(local, remote);
    const transport = { exchange: async () => ({
      hello: { ...remote.sync.hello(), nodeId: 'impersonated-node-123' },
      agreedProtocol: 1, schemaVersion: 1, grantedLibraryIds: ['family'], cursors: [], events: [], results: []
    }) };

    await expect(local.sync.syncWithPeer(remote.identity.peerId, transport))
      .rejects.toThrow('hello identity does not match authenticated peer');
  });
});
