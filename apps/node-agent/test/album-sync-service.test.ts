import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { PairingService } from '../src/auth/pairing-service.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { AlbumSyncRepository } from '../src/sync/album-sync-repository.js';
import { makeUnsignedEvent, signEvent, signingBytes, verifyEvent, type EventEnvelope } from '../src/sync/event-envelope.js';
import { ALBUM_SYNC_CAPABILITY, AlbumSyncProtocolConflictError, AlbumSyncService, isAlbumSyncExchangeRequest, isAlbumSyncExchangeResponse, type AlbumSyncExchangeRequest, type AlbumSyncExchangeResponse } from '../src/sync/album-sync-service.js';
import type { SyncHello } from '../src/sync/sync-service.js';

const now = '2026-10-28T00:00:00.000Z';
const databases: Database.Database[] = [];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function createNode(name: string) {
  const database = new Database(':memory:'); databases.push(database);
  const repository = new SqliteRepository(database); await repository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (key) => secrets.get(`${name}:${key}`),
    set: (key, value) => { secrets.set(`${name}:${key}`, value); }
  }, now);
  const pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true }), () => Date.parse(now));
  const albumRepository = new AlbumSyncRepository(database, () => now);
  const hello = (): SyncHello => ({ nodeId: identity.peerId, protocolMin: 1, protocolMax: 1, schemaVersions: [1], capabilities: ['causal-cursors', ALBUM_SYNC_CAPABILITY] });
  const service = new AlbumSyncService(albumRepository, identity, pairing, hello, () => now);
  return { database, repository, identity, pairing, albumRepository, service, hello };
}

function trust(a: Awaited<ReturnType<typeof createNode>>, b: Awaited<ReturnType<typeof createNode>>, options: { read?: boolean; write?: boolean; delete?: boolean } = {}) {
  a.repository.trustPeer({ peerId: b.identity.peerId, publicKey: Buffer.from(b.identity.publicKey).toString('base64'), label: 'peer', trustState: 'trusted', createdAt: now, revokedAt: null });
  b.repository.trustPeer({ peerId: a.identity.peerId, publicKey: Buffer.from(a.identity.publicKey).toString('base64'), label: 'peer', trustState: 'trusted', createdAt: now, revokedAt: null });
  a.repository.grantLibraryRead(b.identity.peerId, 'family', now);
  b.repository.grantLibraryRead(a.identity.peerId, 'family', now);
  if (options.write) { a.albumRepository.setAlbumWriteGrant('family', b.identity.peerId, now); b.albumRepository.setAlbumWriteGrant('family', a.identity.peerId, now); }
  if (options.delete) { a.albumRepository.setAlbumDeleteGrant('family', b.identity.peerId, now); b.albumRepository.setAlbumDeleteGrant('family', a.identity.peerId, now); }
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

function validRequest(hello: SyncHello): AlbumSyncExchangeRequest { return { hello, grantedLibraryIds: ['family'], cursors: [], events: [] }; }
function validResponse(hello: SyncHello): AlbumSyncExchangeResponse { return { hello, agreedProtocol: 1, schemaVersion: 1, grantedLibraryIds: ['family'], cursors: [], events: [], results: [] }; }
function createEnvelope(authorPeerId: string, sequence: number, eventId: string, title = 'Album') {
  return makeUnsignedEvent({ eventId, libraryId: 'family', authorPeerId, authorSequence: sequence, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(sequence + 1000), title, createdAt: now }, createdAt: now });
}

describe('AlbumSyncService', () => {
  it('enforces exchange limits for event count, byte size, cursors, and libraries', async () => {
    const node = await createNode('limits'); const request = validRequest(node.hello()); const response = validResponse(node.hello());
    expect(isAlbumSyncExchangeRequest({ ...request, events: Array.from({ length: 64 }, () => ({})) })).toBe(true);
    expect(isAlbumSyncExchangeRequest({ ...request, events: Array.from({ length: 65 }, () => ({})) })).toBe(false);
    expect(isAlbumSyncExchangeResponse({ ...response, events: Array.from({ length: 64 }, () => ({})), results: Array.from({ length: 64 }, (_, i) => ({ eventId: String(i), status: 'pending' })) })).toBe(true);
    expect(isAlbumSyncExchangeResponse({ ...response, results: Array.from({ length: 65 }, (_, i) => ({ eventId: String(i), status: 'pending' })) })).toBe(false);
    const cursor = { libraryId: 'l', authorPeerId: node.identity.peerId, sequence: 0 };
    expect(isAlbumSyncExchangeRequest({ ...request, cursors: Array.from({ length: 16_384 }, () => cursor) })).toBe(true);
    expect(isAlbumSyncExchangeRequest({ ...request, cursors: Array.from({ length: 16_385 }, () => cursor) })).toBe(false);
    expect(isAlbumSyncExchangeRequest({ ...request, grantedLibraryIds: Array.from({ length: 256 }, (_, i) => `library-${i}`) })).toBe(true);
    expect(isAlbumSyncExchangeRequest({ ...request, grantedLibraryIds: Array.from({ length: 257 }, (_, i) => `library-${i}`) })).toBe(false);
    expect(isAlbumSyncExchangeRequest({ ...request, note: 'x'.repeat(16 * 1024 * 1024) })).toBe(false);
    expect(isAlbumSyncExchangeResponse({ ...response, note: 'x'.repeat(16 * 1024 * 1024) })).toBe(false);
  });

  it('requires trusted authenticated identity and virtual-album capability negotiation', async () => {
    const a = await createNode('negotiation-a'); const b = await createNode('negotiation-b'); trust(a, b);
    const noCapability = { ...b.hello(), capabilities: b.hello().capabilities.filter((cap) => cap !== ALBUM_SYNC_CAPABILITY) };
    await expect(a.service.handleExchange(b.identity.peerId, validRequest(noCapability))).rejects.toThrow('no common virtual album sync capability');
    await expect(a.service.handleExchange(b.identity.peerId, { ...validRequest(b.hello()), hello: { ...b.hello(), nodeId: a.identity.peerId } })).rejects.toThrow('hello identity does not match authenticated peer');
    const outsider = await createNode('negotiation-outsider');
    await expect(a.service.handleExchange(outsider.identity.peerId, validRequest(outsider.hello()))).rejects.toThrow('relay is not a trusted peer');

    const response: AlbumSyncExchangeResponse = { ...validResponse(b.hello()), hello: { ...b.hello(), nodeId: a.identity.peerId } };
    const transport = { exchangeAlbums: async () => response };
    await expect(a.service.syncWithPeer(b.identity.peerId, transport)).rejects.toThrow('hello identity does not match authenticated peer');
  });

  it('checks signed author identity and signature before ingestion', async () => {
    const author = await createNode('signed-author'); const receiver = await createNode('signed-receiver'); trust(author, receiver, { write: true });
    const signed = await signEvent(createEnvelope(author.identity.peerId, 1, uuid(1)), author.identity);
    expect(await verifyEvent(signed, Buffer.from(author.identity.publicKey).toString('base64'))).toBe(true);
    const tampered = { ...signed, payload: { albumId: uuid(1001), title: 'tampered', createdAt: now } } as EventEnvelope;
    const exchange = (event: EventEnvelope) => receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [event] });
    await expect(exchange(tampered)).rejects.toThrow('album event signature or author identity is invalid');
    expect(receiver.database.prepare('SELECT count(*) AS n FROM album_sync_inbox').get()).toEqual({ n: 0 });
    const untrusted = await createNode('untrusted-author');
    const untrustedEvent = await signEvent(createEnvelope(untrusted.identity.peerId, 1, uuid(2)), untrusted.identity);
    await expect(exchange(untrustedEvent)).rejects.toThrow('album event signature or author identity is invalid');
  });

  it('applies independent write and delete grants', async () => {
    const author = await createNode('grant-author'); const receiver = await createNode('grant-receiver'); trust(author, receiver, { write: true });
    const create = await signEvent(createEnvelope(author.identity.peerId, 1, uuid(10)), author.identity);
    const accepted = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [create] });
    expect(accepted.results, JSON.stringify(receiver.database.prepare('SELECT state,error_code FROM album_sync_inbox WHERE event_id=?').get(create.eventId))).toEqual([{ eventId: create.eventId, status: 'applied' }]);
    const delUnsigned = makeUnsignedEvent({ eventId: uuid(11), libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 2, causalParents: [create.eventId], eventType: 'album.deleted', payload: { albumId: uuid(1001) }, createdAt: now });
    const del = await signEvent(delUnsigned, author.identity);
    const denied = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [del] });
    expect(denied.results).toEqual([{ eventId: del.eventId, status: 'unauthorized' }]);
    receiver.albumRepository.setAlbumDeleteGrant('family', author.identity.peerId, now);
    const allowed = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [del] });
    expect(allowed.results).toEqual([{ eventId: del.eventId, status: 'applied' }]);

    const readOnlyAuthor = await createNode('read-only-author'); const readOnlyReceiver = await createNode('read-only-receiver'); trust(readOnlyAuthor, readOnlyReceiver);
    const noWrite = await signEvent(createEnvelope(readOnlyAuthor.identity.peerId, 1, uuid(12)), readOnlyAuthor.identity);
    const writeDenied = await readOnlyReceiver.service.handleExchange(readOnlyAuthor.identity.peerId, { ...validRequest(readOnlyAuthor.hello()), events: [noWrite] });
    expect(writeDenied.results).toEqual([{ eventId: noWrite.eventId, status: 'unauthorized' }]);
  });

  it('syncs both directions to eventual convergence and clears offered events only after cursor ACK', async () => {
    const a = await createNode('roundtrip-a'); const b = await createNode('roundtrip-b'); trust(a, b, { write: true });
    const transport = { exchangeAlbums: async (_peerId: string, request: AlbumSyncExchangeRequest) => b.service.handleExchange(a.identity.peerId, request) };
    const draftA = a.service.reserveLocalOperation({ operationId: uuid(20), authorPeerId: a.identity.peerId, libraryId: 'family', albumId: uuid(1020), assetId: null, operationType: 'album.created', title: 'A', createdAt: now });
    const draftB = b.service.reserveLocalOperation({ operationId: uuid(21), authorPeerId: b.identity.peerId, libraryId: 'family', albumId: uuid(1021), assetId: null, operationType: 'album.created', title: 'B', createdAt: now });
    expect(draftA.authorSequence).toBe(1); expect(draftB.authorSequence).toBe(1);
    const synced = await a.service.syncWithPeer(b.identity.peerId, transport);
    expect(synced.sent).toBeGreaterThan(0); expect(synced.received).toBeGreaterThan(0);
    expect(a.database.prepare('SELECT state,error_code FROM album_sync_inbox').all()).toHaveLength(1);
    expect(b.database.prepare('SELECT state,error_code FROM album_sync_inbox').all()).toHaveLength(1);
    expect(a.albumRepository.getAcknowledgedCursors(b.identity.peerId)).toContainEqual({ libraryId: 'family', authorPeerId: a.identity.peerId, sequence: 1 });
    expect(a.database.prepare('SELECT count(*) AS n FROM album_sync_outbox WHERE peer_id=?').get(b.identity.peerId)).toEqual({ n: 0 });
  });

  it('does not ACK or advance cursors for pending, untrusted, or invalidly signed events', async () => {
    const author = await createNode('ack-author'); const receiver = await createNode('ack-receiver'); trust(author, receiver, { write: true });
    // Sequence 2 depends on a missing parent, so it remains pending and cannot advance its author cursor.
    const pending = await signEvent(makeUnsignedEvent({ eventId: uuid(30), libraryId: 'family', authorPeerId: author.identity.peerId, authorSequence: 2, causalParents: [uuid(29)], eventType: 'album.created', payload: { albumId: uuid(1030), title: 'Pending', createdAt: now }, createdAt: now }), author.identity);
    const pendingResponse = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [pending] });
    expect(pendingResponse.results).toEqual([{ eventId: pending.eventId, status: 'pending' }]);
    expect(receiver.albumRepository.getCursors(['family'])).not.toContainEqual({ libraryId: 'family', authorPeerId: author.identity.peerId, sequence: 2 });
    expect(receiver.albumRepository.getAcknowledgedCursors(author.identity.peerId)).toEqual([]);
    const tampered = { ...pending, payload: { albumId: uuid(1030), title: 'Forged', createdAt: now } } as EventEnvelope;
    await expect(receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [tampered] })).rejects.toBeInstanceOf(AlbumSyncProtocolConflictError);
    expect(receiver.albumRepository.getCursors(['family'])).not.toContainEqual({ libraryId: 'family', authorPeerId: author.identity.peerId, sequence: 2 });
    const outsider = await createNode('ack-outsider');
    const signedUntrusted = await signEvent(createEnvelope(outsider.identity.peerId, 1, uuid(31)), outsider.identity);
    await expect(receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [signedUntrusted] })).rejects.toThrow('album event signature or author identity is invalid');
    expect(receiver.albumRepository.getAcknowledgedCursors(author.identity.peerId)).toEqual([]);
  });

  it('applies already-accepted durable events after later author trust revocation', async () => {
    const author = await createNode('revoked-pending-author'); const receiver = await createNode('revoked-pending-receiver'); trust(author, receiver, { write: true });
    const first = await signEvent(createEnvelope(author.identity.peerId, 1, uuid(45), 'First'), author.identity);
    const firstResponse = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [first] });
    expect(firstResponse.results).toEqual([{ eventId: first.eventId, status: 'applied' }]);
    const parentId = uuid(46);
    const laterUnsigned = makeUnsignedEvent({ eventId: uuid(47), libraryId: 'family', authorPeerId: author.identity.peerId,
      authorSequence: 2, causalParents: [parentId], eventType: 'album.created',
      payload: { albumId: uuid(1047), title: 'Pending after revoke', createdAt: now }, createdAt: now });
    const later = await signEvent(laterUnsigned, author.identity);
    const pending = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [later] });
    expect(pending.results).toEqual([{ eventId: later.eventId, status: 'pending' }]);
    expect(receiver.repository.revokePeer(author.identity.peerId, now)).toBe(true);
    await expect(receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [later] }))
      .rejects.toThrow('relay is not a trusted peer');
    receiver.database.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?, 'family', ?, 1, 1, 1, 'asset.indexed', '[]', ?, ?, ?, '{}', 'ready')`)
      .run(parentId, receiver.identity.peerId, JSON.stringify({ assetId: 'dependency' }), now, 'a'.repeat(86));
    receiver.albumRepository.reconcilePendingEvents('family');
    expect(receiver.database.prepare('SELECT state,error_code FROM album_sync_inbox WHERE event_id=?').get(later.eventId)).toEqual({ state: 'applied', error_code: null });
    expect(receiver.database.prepare('SELECT count(*) AS n FROM album_sync_event_log WHERE event_id=?').get(later.eventId)).toEqual({ n: 1 });
    expect(receiver.albumRepository.getCursors(['family'])).toContainEqual({ libraryId: 'family', authorPeerId: author.identity.peerId, sequence: 2 });
  });

  it('records malformed signed envelopes as protocol conflicts and blocks later events by that author', async () => {
    const author = await createNode('invalid-envelope-author'); const receiver = await createNode('invalid-envelope-receiver'); trust(author, receiver, { write: true });
    const malformed = { ...createEnvelope(author.identity.peerId, 1, uuid(40)), payload: { albumId: 'not-a-uuid', title: 'bad', createdAt: now } };
    const signature = await author.identity.privateKey.sign(signingBytes(malformed));
    const bad = { ...malformed, signature: Buffer.from(signature).toString('base64url') } as unknown as EventEnvelope;
    await expect(receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [bad] })).rejects.toThrow('signed album event envelope is invalid');
    expect(receiver.database.prepare('SELECT error_code FROM album_sync_conflicts WHERE event_id=?').get(bad.eventId)).toEqual({ error_code: 'invalid_event_envelope' });
    const later = await signEvent(createEnvelope(author.identity.peerId, 2, uuid(41), 'Later'), author.identity);
    const response = await receiver.service.handleExchange(author.identity.peerId, { ...validRequest(author.hello()), events: [later] });
    expect(response.results).toEqual([{ eventId: later.eventId, status: 'conflict' }]);
    expect(receiver.database.prepare('SELECT COUNT(*) AS n FROM album_sync_conflicts WHERE author_peer_id=?').get(author.identity.peerId)).toEqual({ n: 1 });
    expect(receiver.albumRepository.getCursors(['family'])).toEqual([]);
  });

});
