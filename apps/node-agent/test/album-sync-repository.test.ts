import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { AlbumSyncRepository, AlbumSyncConflictError } from '../src/sync/album-sync-repository.js';
import { makeUnsignedEvent, type EventEnvelope } from '../src/sync/event-envelope.js';

const now = '2026-11-01T00:00:00.000Z';
const local = '12D3KooWPM045LocalAuthor';
const remote = '12D3KooWPM045RemoteAuthor';
const relay = '12D3KooWPM045RelayPeer';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sig = 'a'.repeat(86);
const dbs: Database.Database[] = [];

async function setup() {
  const db = new Database(':memory:'); dbs.push(db);
  await new SqliteRepository(db).migrate(migrations);
  for (const p of [local, remote, relay]) db.prepare("INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at) VALUES(?,?,?,'trusted',?)").run(p, 'AQ==', p, now);
  db.prepare('INSERT INTO sync_remote_library_grants(peer_id,library_id,observed_at) VALUES(?,?,?)').run(relay, 'family', now);
  db.prepare('INSERT INTO library_album_write_grants(peer_id,library_id,granted_at) VALUES(?,?,?)').run(remote, 'family', now);
  return { db, repo: new AlbumSyncRepository(db, () => now) };
}
async function setupLegacy() {
  const db = new Database(':memory:'); dbs.push(db);
  const old = new SqliteRepository(db); await old.migrate(migrations.slice(0, 7));
  insertAsset(db);
  const album = old.createAlbum({ operationId: uuid(72), principalId: 'admin', authorPeerId: local, libraryId: 'family', requestFingerprint: '1'.repeat(64), createdAt: now, title: 'Legacy' });
  if (!album || album === 'writer_limit') throw new Error('legacy album setup failed');
  expect(old.addAlbumMember({ operationId: uuid(71), principalId: 'admin', authorPeerId: local, libraryId: 'family', requestFingerprint: '2'.repeat(64), createdAt: now, albumId: album.albumId, assetId: 'asset-1' }).status).toBe('added');
  expect(old.addAlbumMember({ operationId: uuid(73), principalId: 'admin', authorPeerId: local, libraryId: 'family', requestFingerprint: '3'.repeat(64), createdAt: now, albumId: album.albumId, assetId: 'asset-1' }).status).toBe('already_present');
  await new SqliteRepository(db, { backupBeforeMigration: async () => undefined }).migrate();
  return { db, repo: new AlbumSyncRepository(db, () => now), albumId: album.albumId };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function event(input: Parameters<typeof makeUnsignedEvent>[0]): EventEnvelope { return { ...makeUnsignedEvent(input), signature: sig }; }
function insertAsset(db: Database.Database, asset = 'asset-1', eventId = uuid(10)) {
  db.prepare("INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES(?,'family',?,'photo',?)").run(asset, local, now);
  db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
    VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,?,'{}','ready')`).run(eventId, local, JSON.stringify({ assetId: asset }), now, sig);
}
const draftFactory = (operationId: string) => (x: Parameters<Parameters<AlbumSyncRepository['reserveLocalDraft']>[0]['draftFactory']>[0]) => makeUnsignedEvent({
  eventId: operationId, libraryId: x.libraryId, authorPeerId: x.authorPeerId, authorSequence: x.context.authorSequence,
  causalParents: x.context.causalParents, eventType: x.eventType as 'album.member.added', payload: x.payload, createdAt: x.createdAt
});

describe('AlbumSyncRepository', () => {
  it('maps local operation type and finds asset.indexed parent without projection', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    db.prepare("INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,'family','A',?,?)").run(uuid(20), local, now);
    const create = event({ eventId: uuid(21), libraryId: 'family', authorPeerId: local, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(20), title: 'A', createdAt: now }, createdAt: now });
    db.prepare("INSERT INTO album_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,?,?,?,1,1,?,?,?,?,?,?, 'ready')").run(create.eventId, 'family', local, 1, create.eventType, '[]', JSON.stringify(create.payload), now, sig, JSON.stringify(create));
    db.prepare("INSERT INTO album_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready) VALUES('family',?,1,?,1)").run(local, create.eventId);
    const draft = repo.reserveLocalDraft({ operationId: uuid(22), authorPeerId: local, libraryId: 'family', albumId: uuid(20), assetId: 'asset-1', operationType: 'member.added', createdAt: now, draftFactory: draftFactory(uuid(22)) });
    expect(draft.eventType).toBe('album.member.added'); expect(draft.causalParents).toEqual([uuid(10), uuid(21)].sort());
  });
  it('fails closed without indexed event parent and reserves nothing', async () => {
    const { db, repo } = await setup();
    db.prepare("INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-1','family',?,'photo',?)").run(local, now);
    db.prepare("INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,'family','A',?,?)").run(uuid(20), local, now);
    expect(() => repo.reserveLocalDraft({ operationId: uuid(22), authorPeerId: local, libraryId: 'family', albumId: uuid(20), assetId: 'asset-1', operationType: 'member.added', createdAt: now, draftFactory: draftFactory(uuid(22)) })).toThrow(AlbumSyncConflictError);
    expect(db.prepare('SELECT count(*) n FROM album_sync_event_log').get()).toEqual({ n: 0 });
  });
  it('applies remote create/add/remove and retains observed remove targets', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    const create = event({ eventId: uuid(30), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(31), title: 'Shared', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, create).status).toBe('applied');
    const add = event({ eventId: uuid(32), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [uuid(30), uuid(10)].sort(), eventType: 'album.member.added', payload: { albumId: uuid(31), assetId: 'asset-1' }, createdAt: now });
    expect(repo.ingest(relay, add).status).toBe('applied');
    const remove = event({ eventId: uuid(33), libraryId: 'family', authorPeerId: remote, authorSequence: 3, causalParents: [uuid(32)], eventType: 'album.member.removed', payload: { albumId: uuid(31), assetId: 'asset-1', observedAddEventIds: [uuid(32)] }, createdAt: now });
    expect(repo.ingest(relay, remove).status).toBe('applied');
    expect(db.prepare('SELECT count(*) n FROM album_membership_remove_targets').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM album_memberships').get()).toEqual({ n: 0 });
  });
  it('retains tombstoned-asset add history then rebuilds projection on restore', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    db.prepare("INSERT INTO sync_asset_projection(library_id,asset_id,origin_node_id,kind,sha256,byte_length,metadata_json,tombstone_event_id,restored_by_event_id,last_event_id) VALUES('family','asset-1',?,'photo',?,0,'{}',?,?,?)").run(local, '0'.repeat(64), uuid(10), null, uuid(10));
    const create = event({ eventId: uuid(50), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(51), title: 'Tomb', createdAt: now }, createdAt: now }); repo.ingest(relay, create);
    const add = event({ eventId: uuid(52), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [uuid(50), uuid(10)].sort(), eventType: 'album.member.added', payload: { albumId: uuid(51), assetId: 'asset-1' }, createdAt: now });
    expect(repo.ingest(relay, add).status).toBe('applied'); expect(db.prepare('SELECT count(*) n FROM album_operations WHERE operation_id=?').get(uuid(52))).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM album_memberships WHERE add_operation_id=?').get(uuid(52))).toEqual({ n: 0 });
    db.prepare('UPDATE sync_asset_projection SET tombstone_event_id=NULL,restored_by_event_id=? WHERE library_id=? AND asset_id=?').run(uuid(53), 'family', 'asset-1');
    repo.rebuildMembershipsForAsset('family', 'asset-1'); expect(db.prepare('SELECT count(*) n FROM album_memberships WHERE add_operation_id=?').get(uuid(52))).toEqual({ n: 1 });
  });
  it('applies delete and restore using independent lifecycle grant', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    const create = event({ eventId: uuid(60), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(61), title: 'Life', createdAt: now }, createdAt: now }); repo.ingest(relay, create);
    repo.setAlbumDeleteGrant('family', remote, now);
    const del = event({ eventId: uuid(62), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [uuid(60)], eventType: 'album.deleted', payload: { albumId: uuid(61) }, createdAt: now });
    expect(repo.ingest(relay, del).status).toBe('applied');
    const restore = event({ eventId: uuid(63), libraryId: 'family', authorPeerId: remote, authorSequence: 3, causalParents: [uuid(62)], eventType: 'album.restored', payload: { albumId: uuid(61), observedDeleteEventIds: [uuid(62)] }, createdAt: now });
    expect(repo.ingest(relay, restore).status).toBe('applied'); expect(db.prepare('SELECT count(*) n FROM album_global_restore_targets').get()).toEqual({ n: 1 });
  });
  it('reserves lifecycle delete and restore drafts with their required causal parents', async () => {
    const { db, repo } = await setup();
    insertAsset(db);
    const albumId = uuid(61);
    db.prepare("INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,'family','Life',?,?)")
      .run(albumId, local, now);
    const create = event({ eventId: uuid(60), libraryId: 'family', authorPeerId: local, authorSequence: 1,
      causalParents: [], eventType: 'album.created', payload: { albumId, title: 'Life', createdAt: now }, createdAt: now });
    db.prepare(`INSERT INTO album_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,?,?,?,1,1,?,?,?,?,?,?,'ready')`)
      .run(create.eventId, 'family', local, 1, create.eventType, '[]', JSON.stringify(create.payload), now, sig, JSON.stringify(create));
    db.prepare("INSERT INTO album_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready) VALUES('family',?,1,?,1)")
      .run(local, create.eventId);

    const deleteId = uuid(62);
    db.prepare(`INSERT INTO album_lifecycle_operations(operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,
      request_fingerprint,observed_delete_event_ids_json,result_json,created_at) VALUES(?,?,?,'family',?,'album.deleted',?,'[]','{"status":"deleted"}',?)`)
      .run(deleteId, local, local, albumId, '1'.repeat(64), now);
    db.prepare("INSERT INTO album_global_delete_tokens(delete_event_id,library_id,album_id,author_peer_id,created_at) VALUES(?,'family',?,?,?)")
      .run(deleteId, albumId, local, now);
    const deleteDraft = repo.reserveLocalLifecycleDraft({ operationId: deleteId, authorPeerId: local, libraryId: 'family', albumId,
      operationType: 'album.deleted', createdAt: now, draftFactory: (x) => makeUnsignedEvent({
        eventId: deleteId, libraryId: x.libraryId, authorPeerId: x.authorPeerId, authorSequence: x.context.authorSequence,
        causalParents: x.context.causalParents, eventType: x.eventType as 'album.deleted', payload: x.payload, createdAt: x.createdAt
      }) });
    expect(deleteDraft).toMatchObject({ eventId: deleteId, authorSequence: 2, eventType: 'album.deleted', causalParents: [create.eventId], payload: { albumId } });
    repo.completeLocalDraft({ ...deleteDraft, signature: sig });

    const restoreId = uuid(63);
    db.prepare(`INSERT INTO album_lifecycle_operations(operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,
      request_fingerprint,observed_delete_event_ids_json,result_json,created_at) VALUES(?,?,?,'family',?,'album.restored',?,?,?,?)`)
      .run(restoreId, local, local, albumId, '2'.repeat(64), JSON.stringify([deleteId]), '{"status":"restored"}', now);
    db.prepare("INSERT INTO album_global_restore_targets(restore_operation_id,observed_delete_event_id,library_id,album_id) VALUES(?,?,'family',?)")
      .run(restoreId, deleteId, albumId);
    const restoreDraft = repo.reserveLocalLifecycleDraft({ operationId: restoreId, authorPeerId: local, libraryId: 'family', albumId,
      operationType: 'album.restored', createdAt: now, observedDeleteIds: [deleteId], draftFactory: (x) => makeUnsignedEvent({
        eventId: restoreId, libraryId: x.libraryId, authorPeerId: x.authorPeerId, authorSequence: x.context.authorSequence,
        causalParents: x.context.causalParents, eventType: x.eventType as 'album.restored', payload: x.payload, createdAt: x.createdAt
      }) });
    expect(restoreDraft).toMatchObject({ eventId: restoreId, authorSequence: 3, eventType: 'album.restored',
      causalParents: [deleteId], payload: { albumId, observedDeleteEventIds: [deleteId] } });
    expect(restoreDraft.causalParents).not.toContain(create.eventId);
  });

  it('exposes trusted library and album grant state for service orchestration', async () => {
    const { db, repo } = await setup();
    db.prepare("INSERT INTO library_grants(peer_id,library_id,permission,created_at) VALUES(?,'family','read',?)").run(relay, now);
    repo.setRemoteLibraries(relay, ['family', 'family']); repo.setAlbumDeleteGrant('family', remote, now);
    expect(repo.listGrantedLibraries(relay)).toEqual(['family']); expect(repo.getRemoteLibraries(relay)).toEqual(['family']);
    expect(repo.listAlbumSyncGrants('family')).toContainEqual({ peerId: remote, writeGranted: true, writeRevokedAt: null, deleteGranted: true, deleteRevokedAt: null });
    repo.revokeAlbumWriteGrant('family', remote, now);
    expect(repo.listAlbumSyncGrants('family').find(g => g.peerId === remote)?.writeGranted).toBe(false);
    expect(db.prepare('SELECT count(*) n FROM sync_remote_library_grants WHERE peer_id=?').get(relay)).toEqual({ n: 1 });
  });
  it('bootstraps operations in dependency order, skips no-op keys, and is restart-idempotent', async () => {
    const { db, repo, albumId } = await setupLegacy();
    expect(repo.reconcileLegacyOperations(local)).toBe(2); const first = repo.getUnsignedLocalDrafts(local);
    expect(first.map(e => e.eventId)).toEqual([uuid(72), uuid(71)]); expect(first.map(e => e.authorSequence)).toEqual([1, 2]);
    const restarted = new AlbumSyncRepository(db, () => now); expect(restarted.reconcileLegacyOperations(local)).toBe(0); expect(restarted.getUnsignedLocalDrafts(local).map(e => e.eventId)).toEqual([uuid(72), uuid(71)]);
    expect(db.prepare('SELECT count(*) n FROM album_sync_event_log WHERE event_id=?').get(uuid(73))).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM album_sync_event_log WHERE json_extract(payload_json,'$.albumId')=?").get(albumId)).toEqual({ n: 2 });
  });
  it('permanently blocks a first-author stream after a cross-stream global ID collision', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    const collision = event({ eventId: uuid(10), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [],
      eventType: 'album.created', payload: { albumId: uuid(201), title: 'Collision', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, collision).status).toBe('conflict');
    expect(db.prepare('SELECT error_code FROM album_sync_conflicts WHERE event_id=?').get(uuid(10))).toEqual({ error_code: 'global_event_id_collision' });
    const later = event({ eventId: uuid(202), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [],
      eventType: 'album.created', payload: { albumId: uuid(203), title: 'Blocked', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, later).status).toBe('conflict');
    expect(repo.getCursors(['family'])).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM album_sync_conflicts WHERE author_peer_id=?').get(remote)).toEqual({ n: 1 });
  });

  it('permanently conflicts an event that references a known causal parent from another library', async () => {
    const { db, repo } = await setup();
    const foreignParent = uuid(120);
    db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state)
      VALUES(?, 'other', ?, 1, 1, 1, 'asset.indexed', '[]', '{}', ?, ?, '{}', 'ready')`)
      .run(foreignParent, local, now, sig);
    const invalid = event({ eventId: uuid(121), libraryId: 'family', authorPeerId: remote, authorSequence: 1,
      causalParents: [foreignParent], eventType: 'album.created',
      payload: { albumId: uuid(122), title: 'Wrong library parent', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, invalid).status).toBe('conflict');
    expect(db.prepare('SELECT state,error_code FROM album_sync_inbox WHERE event_id=?').get(invalid.eventId))
      .toEqual({ state: 'conflict', error_code: 'invalid_causal_parent' });
    const later = event({ eventId: uuid(123), libraryId: 'family', authorPeerId: remote, authorSequence: 2,
      causalParents: [], eventType: 'album.created', payload: { albumId: uuid(124), title: 'Blocked', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, later).status).toBe('conflict');
    expect(db.prepare('SELECT state FROM album_sync_inbox WHERE event_id=?').get(later.eventId)).toBeUndefined();
  });

  it('honors exponential outbox retry deadlines instead of re-offering on every poll', async () => {
    const { db } = await setup(); let current = now; const repo = new AlbumSyncRepository(db, () => current);
    db.prepare("INSERT INTO library_grants(peer_id,library_id,permission,created_at) VALUES(?,'family','read',?)").run(relay, now);
    const outgoing = event({ eventId: uuid(125), libraryId: 'family', authorPeerId: local, authorSequence: 1,
      causalParents: [], eventType: 'album.created', payload: { albumId: uuid(126), title: 'Retry', createdAt: now }, createdAt: now });
    db.prepare(`INSERT INTO album_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?, 'family', ?, 1, 1, 1, ?, '[]', ?, ?, ?, ?, 'ready')`)
      .run(outgoing.eventId, local, outgoing.eventType, JSON.stringify(outgoing.payload), now, outgoing.signature, JSON.stringify(outgoing));
    db.prepare('INSERT INTO album_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready) VALUES(?,?,?,?,1)')
      .run('family', local, 1, outgoing.eventId);
    expect(repo.eventsMissingForPeer(relay, [])).toHaveLength(1);
    repo.recordOfferedEvents(relay, [outgoing]);
    expect(repo.eventsMissingForPeer(relay, [])).toHaveLength(0);
    current = '2026-11-01T00:00:10.000Z';
    expect(repo.eventsMissingForPeer(relay, []).map((value) => value.eventId)).toEqual([outgoing.eventId]);
    repo.recordOfferedEvents(relay, [outgoing]);
    repo.recordOfferFailure(relay, [outgoing.eventId], 'transport_error');
    current = '2026-11-01T00:00:29.999Z';
    expect(repo.eventsMissingForPeer(relay, [])).toHaveLength(0);
    current = '2026-11-01T00:00:30.000Z';
    expect(repo.eventsMissingForPeer(relay, []).map((value) => value.eventId)).toEqual([outgoing.eventId]);
  });

  it('retains concurrent delete tokens created by different authors', async () => {
    const { db, repo } = await setup(); insertAsset(db); const second = '12D3KooWPM045SecondAuthor';
    db.prepare("INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at) VALUES(?,?,?,'trusted',?)").run(second, 'AQ==', second, now);
    repo.setAlbumDeleteGrant('family', remote, now); repo.setAlbumDeleteGrant('family', second, now);
    const create = event({ eventId: uuid(80), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(81), title: 'Concurrent', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, create).status).toBe('applied');
    const delA = event({ eventId: uuid(82), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [uuid(80)], eventType: 'album.deleted', payload: { albumId: uuid(81) }, createdAt: now });
    const delB = event({ eventId: uuid(83), libraryId: 'family', authorPeerId: second, authorSequence: 1, causalParents: [uuid(80)], eventType: 'album.deleted', payload: { albumId: uuid(81) }, createdAt: now });
    expect(repo.ingest(relay, delA).status).toBe('applied'); expect(repo.ingest(relay, delB).status).toBe('applied');
    expect(db.prepare('SELECT count(*) n FROM album_global_delete_tokens').get()).toEqual({ n: 2 });
  });
  it('rolls back partial operation history through an apply savepoint', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    const create = event({ eventId: uuid(100), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(101), title: 'Savepoint', createdAt: now }, createdAt: now }); repo.ingest(relay, create);
    const add = event({ eventId: uuid(102), libraryId: 'family', authorPeerId: remote, authorSequence: 2, causalParents: [uuid(100), uuid(10)].sort(), eventType: 'album.member.added', payload: { albumId: uuid(101), assetId: 'asset-1' }, createdAt: now }); repo.ingest(relay, add);
    const duplicate = event({ eventId: uuid(103), libraryId: 'family', authorPeerId: remote, authorSequence: 3, causalParents: [uuid(100), uuid(10)].sort(), eventType: 'album.member.added', payload: { albumId: uuid(101), assetId: 'asset-1' }, createdAt: now });
    expect(repo.ingest(relay, duplicate).status).toBe('conflict');
    expect(db.prepare('SELECT count(*) n FROM album_operations WHERE operation_id=?').get(uuid(103))).toEqual({ n: 0 });
    expect(db.prepare('SELECT event_stream,operation_kind FROM sync_global_id_registry WHERE global_id=?').get(uuid(103))).toEqual({ event_stream: 'virtual-albums-v1', operation_kind: null });
    expect(db.prepare('SELECT state FROM album_sync_inbox WHERE event_id=?').get(uuid(103))).toEqual({ state: 'conflict' });
  });
  it('persists sequence conflicts and preserves unsupported/conflict duplicate status', async () => {
    const { db, repo } = await setup(); insertAsset(db);
    const created = event({ eventId: uuid(90), libraryId: 'family', authorPeerId: remote, authorSequence: 1, causalParents: [], eventType: 'album.created', payload: { albumId: uuid(91), title: 'Conflict', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, created).status).toBe('applied');
    const unknown = { ...created, eventId: uuid(92), authorSequence: 2, eventType: 'album.future', payload: { arbitrary: true }, causalParents: [uuid(90)] } as EventEnvelope;
    expect(repo.ingest(relay, unknown).status).toBe('unsupported'); expect(repo.ingest(relay, unknown).status).toBe('unsupported');
    const clash = { ...unknown, eventId: uuid(93) }; expect(repo.ingest(relay, clash).status).toBe('conflict');
    expect(repo.ingest(relay, unknown).status).toBe('conflict'); expect(db.prepare("SELECT state FROM album_sync_inbox WHERE event_id=?").get(uuid(92))).toEqual({ state: 'conflict' });
    const later = event({ eventId: uuid(94), libraryId: 'family', authorPeerId: remote, authorSequence: 3, causalParents: [uuid(90)], eventType: 'album.created', payload: { albumId: uuid(95), title: 'Blocked', createdAt: now }, createdAt: now });
    expect(repo.ingest(relay, later).status).toBe('conflict');
    expect(db.prepare("SELECT state FROM album_sync_inbox WHERE event_id=?").get(uuid(94))).toBeUndefined();
    expect(db.prepare('SELECT error_code,author_sequence FROM album_sync_conflicts WHERE event_id=?').get(uuid(93)))
      .toEqual({ error_code: 'author_sequence_conflict', author_sequence: 2 });
    expect(db.prepare('SELECT error_code FROM album_sync_conflicts WHERE event_id=?').get(uuid(94))).toBeUndefined();
    expect(db.prepare('SELECT ready FROM album_sync_author_heads WHERE library_id=? AND author_peer_id=?').get('family', remote)).toEqual({ ready: 0 });
  });
});
