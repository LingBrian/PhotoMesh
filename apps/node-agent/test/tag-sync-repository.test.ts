import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditRepository } from '../src/audit/audit-repository.js';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { makeUnsignedEvent, signEvent, type EventEnvelope } from '../src/sync/event-envelope.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { TagSyncRepository, type TagEventDraftFactory } from '../src/sync/tag-sync-repository.js';

const databases: Database.Database[] = [];
const now = '2026-10-27T00:00:00.000Z';

function seedLocalAsset(db: Database.Database, libraryId = 'family', assetId = 'asset-1'): void {
  db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
    VALUES (?, ?, 'node-local', 'photo', NULL, ?)`).run(assetId, libraryId, now);
}

async function createIdentity(repository: SqliteRepository, secretName = 'identity') {
  const secrets = new Map<string, string>();
  return loadOrCreateLocalIdentity(repository, {
    get: (name) => secrets.get(`${secretName}:${name}`),
    set: (name, value) => { secrets.set(`${secretName}:${name}`, value); }
  });
}

async function seedIndexedAsset(db: Database.Database, identity: Awaited<ReturnType<typeof createIdentity>>, libraryId = 'family', assetId = 'asset-1') {
  const metadata = new SyncRepository(db, () => now);
  const indexed = await signEvent(makeUnsignedEvent({
    libraryId, authorPeerId: identity.peerId, authorSequence: 1, causalParents: [], eventType: 'asset.indexed', createdAt: now,
    payload: { assetId, originNodeId: identity.peerId, kind: 'photo', sha256: 'd'.repeat(64), byteLength: 20 }
  }), identity);
  metadata.appendLocalEvent(indexed);
  return indexed;
}

function draftFactory(libraryId: string, authorPeerId: string, createdAt = now): TagEventDraftFactory {
  return ({ context, eventType, payload }) => makeUnsignedEvent({
    libraryId, authorPeerId, authorSequence: context.authorSequence, causalParents: context.causalParents,
    eventType, payload, createdAt
  });
}

async function signPending(tags: TagSyncRepository, peerId: string, identity: Awaited<ReturnType<typeof createIdentity>>): Promise<void> {
  for (const draft of tags.getUnsignedLocalDrafts(peerId)) await tags.completeLocalDraft(await signEvent(draft, identity));
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('tag sync migration and local OR-Set persistence', () => {
  it('adds migration 0006 and seeds existing PM-041 tags without deleting them', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    let backups = 0;
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backups += 1; } });
    await repository.migrate(migrations.slice(0, 5));
    seedLocalAsset(db);
    db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('family', 'asset-1', 'legacy', now);

    await repository.migrate(migrations);
    const tags = new TagSyncRepository(db);
    expect(migrations.map(({ id }) => id)).toContain('0006_asset_tag_sync');
    expect(backups).toBe(1);
    expect(db.prepare('SELECT tag FROM asset_tags WHERE library_id = ? AND asset_id = ?').all('family', 'asset-1'))
      .toEqual([{ tag: 'legacy' }]);
    expect(db.prepare('SELECT library_id, asset_id, tag, state FROM asset_tag_legacy_seeds').all())
      .toEqual([{ library_id: 'family', asset_id: 'asset-1', tag: 'legacy', state: 'pending' }]);
    expect(tags.getAssetTags('family', 'asset-1')).toEqual(['legacy']);
  });

  it('atomically records a signed add/remove and keeps duplicate operations idempotent', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);

    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'Summer', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('added');
    expect(tags.getAssetTags('family', 'asset-1')).toEqual(['Summer']);
    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'Summer', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('already_present');
    expect(tags.getUnsignedLocalDrafts(identity.peerId)).toHaveLength(1);
    await signPending(tags, identity.peerId, identity);

    expect(tags.removeLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'Summer', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('removed');
    expect(tags.getAssetTags('family', 'asset-1')).toEqual([]);
    const removeDraft = tags.getUnsignedLocalDrafts(identity.peerId)[0]!;
    expect(removeDraft.eventType).toBe('asset.tag.removed');
    expect(removeDraft.payload).toMatchObject({ assetId: 'asset-1', tag: 'Summer', observedAddEventIds: [expect.any(String)] });
    await tags.completeLocalDraft(await signEvent(removeDraft, identity));
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_event_log WHERE state = ?').get('ready'))
      .toEqual({ count: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM asset_tag_remove_observations').get())
      .toEqual({ count: 1 });
  });

  it('database guards bind OR-set materialized rows to matching operation payloads', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);
    const factory = draftFactory('family', identity.peerId);
    tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'bound', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: factory });
    await signPending(tags, identity.peerId, identity);
    tags.removeLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'bound', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: factory });
    const remove = tags.getUnsignedLocalDrafts(identity.peerId)[0]!;
    await tags.completeLocalDraft(await signEvent(remove, identity));
    const ids = db.prepare('SELECT event_id, event_type FROM tag_sync_event_log ORDER BY author_sequence')
      .all() as Array<{ event_id: string; event_type: string }>;
    const addId = ids.find((event) => event.event_type === 'asset.tag.added')!.event_id;
    const removeId = ids.find((event) => event.event_type === 'asset.tag.removed')!.event_id;

    expect(() => db.prepare(`INSERT INTO asset_tag_adds (library_id, asset_id, tag, add_event_id)
      VALUES ('family', 'different-asset', 'bound', ?)` ).run(addId)).toThrow('asset_tag_add_event_mismatch');
    expect(() => db.prepare(`INSERT INTO asset_tag_remove_observations
      (library_id, asset_id, tag, add_event_id, remove_event_id) VALUES ('family', 'asset-1', 'wrong-tag', ?, ?)` )
      .run(addId, removeId)).toThrow('asset_tag_remove_event_mismatch');

    tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'other', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: factory });
    await signPending(tags, identity.peerId, identity);
    const otherAddId = (db.prepare(`SELECT event_id FROM tag_sync_event_log WHERE event_type = 'asset.tag.added'
      AND json_extract(payload_json, '$.tag') = 'other'`).get() as { event_id: string }).event_id;
    const fakeAddId = '550e8400-e29b-41d4-a716-446655440045';
    db.prepare(`INSERT INTO tag_sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, 'family', ?, 4, 1, 1, 'asset.tag.added', '[]', ?, ?, 'invalid-for-trigger-test', '{}', 'ready')`)
      .run(fakeAddId, identity.peerId, JSON.stringify({ assetId: 'asset-1', tag: 'unbound' }), now);
    expect(() => db.prepare(`INSERT INTO asset_tag_adds (library_id, asset_id, tag, add_event_id)
      VALUES ('family', 'asset-1', 'unbound', ?)` ).run(fakeAddId)).toThrow('asset_tag_add_event_mismatch');
    const fakeRemoveId = '550e8400-e29b-41d4-a716-446655440044';
    db.prepare(`INSERT INTO tag_sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, 'family', ?, 5, 1, 1, 'asset.tag.removed', '[]', ?, ?, 'invalid-for-trigger-test', '{}', 'ready')`)
      .run(fakeRemoveId, identity.peerId, JSON.stringify({ assetId: 'asset-1', tag: 'other', observedAddEventIds: [otherAddId] }), now);
    expect(() => db.prepare(`INSERT INTO asset_tag_remove_observations
      (library_id, asset_id, tag, add_event_id, remove_event_id) VALUES ('family', 'asset-1', 'other', ?, ?)`)
      .run(otherAddId, fakeRemoveId)).toThrow('asset_tag_remove_event_mismatch');
  });

  it('requires an indexed metadata head before creating a local add event', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate(migrations);
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    const tags = new TagSyncRepository(db);
    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'not-yet-indexed', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('not_found');
    expect(tags.getUnsignedLocalDrafts(identity.peerId)).toEqual([]);
  });

  it('includes the current asset metadata head in local add causality', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate(migrations);
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    const metadata = new SyncRepository(db, () => now);
    const indexed = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', createdAt: now,
      payload: { assetId: 'asset-1', originNodeId: identity.peerId, kind: 'photo', sha256: 'd'.repeat(64), byteLength: 20 }
    }), identity);
    metadata.appendLocalEvent(indexed);

    const tags = new TagSyncRepository(db, () => now);
    tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'replicated-after-index', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) });
    const draft = tags.getUnsignedLocalDrafts(identity.peerId)[0]!;
    expect(draft.causalParents).toEqual([indexed.eventId]);
  });

  it('bootstraps each legacy row once and recovers its pending signature', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
    await repository.migrate(migrations.slice(0, 5));
    seedLocalAsset(db);
    db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('family', 'asset-1', 'old-tag', now);
    await repository.migrate(migrations);
    const identity = await createIdentity(repository);
    const tags = new TagSyncRepository(db);

    expect(tags.reconcileLegacyTagSeeds({ authorPeerId: identity.peerId, createdAt: now,
      draftFactory: draftFactory('family', identity.peerId) })).toBe(0);
    await seedIndexedAsset(db, identity);
    expect(tags.reconcileLegacyTagSeeds({ authorPeerId: identity.peerId, createdAt: now,
      draftFactory: draftFactory('family', identity.peerId) })).toBe(1);
    expect(tags.reconcileLegacyTagSeeds({ authorPeerId: identity.peerId, createdAt: now,
      draftFactory: draftFactory('family', identity.peerId) })).toBe(0);
    expect(tags.getUnsignedLocalDrafts(identity.peerId)).toHaveLength(1);
    expect(db.prepare('SELECT state, seed_event_id FROM asset_tag_legacy_seeds').get())
      .toMatchObject({ state: 'queued', seed_event_id: expect.any(String) });

    await signPending(tags, identity.peerId, identity);
    expect(db.prepare('SELECT state FROM asset_tag_legacy_seeds').get()).toEqual({ state: 'complete' });
    expect(tags.getAssetTags('family', 'asset-1')).toEqual(['old-tag']);
  });

  it('enforces 64 active tags per writer but allows a merged view above 64', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);
    const factory = draftFactory('family', identity.peerId);

    for (let index = 0; index < 64; index += 1) {
      expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: `writer-tag-${index}`,
        authorPeerId: identity.peerId, createdAt: now, draftFactory: factory })).toBe('added');
      await signPending(tags, identity.peerId, identity);
    }
    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'writer-tag-overflow',
      authorPeerId: identity.peerId, createdAt: now, draftFactory: factory })).toBe('limit_reached');

    for (let index = 0; index < 65; index += 1) {
      db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
        .run('family', 'asset-1', `remote-tag-${index}`, now);
    }
    expect(tags.getAssetTags('family', 'asset-1')).toHaveLength(129);
  });

  it('requires trusted peers for explicit tag-write, denies by default, and preserves author slots after revocation', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    const identity = await createIdentity(repository);
    const tags = new TagSyncRepository(db);
    const addTrustedPeer = (peerId: string): void => {
      db.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
        VALUES (?, 'key', ?, 'trusted', ?, NULL)`).run(peerId, peerId, now);
    };

    addTrustedPeer('tag-writer-1');
    expect(tags.isTagWriterAllowed('family', 'tag-writer-1')).toBe(false);
    expect(tags.grantTagWriter('family', 'tag-writer-1', identity.peerId, now)).toBe(true);
    expect(tags.isTagWriterAllowed('family', 'tag-writer-1')).toBe(true);
    expect(tags.listTagWriters('family')).toContain('tag-writer-1');
    expect(repository.revokePeer('tag-writer-1', now)).toBe(true);
    expect(tags.isTagWriterAllowed('family', 'tag-writer-1')).toBe(false);
    expect(tags.listTagWriters('family')).not.toContain('tag-writer-1');
    expect(tags.revokeTagWriter('family', 'tag-writer-1', now)).toBe(true);
    expect(tags.isTagWriterAllowed('family', 'tag-writer-1')).toBe(false);

    for (let index = 2; index <= 64; index += 1) {
      const peerId = `tag-writer-${index}`;
      addTrustedPeer(peerId);
      if (index <= 63) tags.grantTagWriter('family', peerId, identity.peerId, now);
      else expect(() => tags.grantTagWriter('family', peerId, identity.peerId, now)).toThrow('tag author limit reached');
    }
    expect(tags.revokeTagWriter('family', 'tag-writer-2', now)).toBe(true);
    expect(() => tags.grantTagWriter('family', 'tag-writer-64', identity.peerId, now)).toThrow('tag author limit reached');
  });

  it('keeps offered tag events pending until a cursor acknowledges a locally known head', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);
    db.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
      VALUES ('sync-peer', 'key', 'Sync peer', 'trusted', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO library_grants (peer_id, library_id, permission, created_at) VALUES ('sync-peer', 'family', 'read', ?)`)
      .run(now);
    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'share', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('added');
    const draft = tags.getUnsignedLocalDrafts(identity.peerId)[0]!;
    const event = await signEvent(draft, identity);
    tags.completeLocalDraft(event);

    expect(tags.eventsMissingForPeer('sync-peer', tags.getAcknowledgedCursors('sync-peer'))).toEqual([event]);
    tags.recordOfferedEvents('sync-peer', [event]);
    tags.acknowledgeCursors('sync-peer', [{ libraryId: 'family', authorPeerId: 'untrusted-author', sequence: 99 }]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get('sync-peer')).toEqual({ count: 1 });
    expect(tags.eventsMissingForPeer('sync-peer', tags.getAcknowledgedCursors('sync-peer'))).toEqual([event]);

    tags.acknowledgeCursors('sync-peer', [{ libraryId: 'family', authorPeerId: identity.peerId, sequence: 99 }]);
    expect(tags.eventsMissingForPeer('sync-peer', tags.getAcknowledgedCursors('sync-peer'))).toEqual([]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get('sync-peer')).toEqual({ count: 0 });
  });

  it('retains offered events when a peer library grant is revoked before cursor acknowledgement', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);
    db.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
      VALUES ('revoked-cursor-peer', 'key', 'Revoked cursor peer', 'trusted', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO library_grants (peer_id, library_id, permission, created_at)
      VALUES ('revoked-cursor-peer', 'family', 'read', ?)`).run(now);
    tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag: 'keep-until-authorized-ack',
      authorPeerId: identity.peerId, createdAt: now, draftFactory: draftFactory('family', identity.peerId) });
    await signPending(tags, identity.peerId, identity);
    const [event] = tags.eventsMissingForPeer('revoked-cursor-peer', []);
    tags.recordOfferedEvents('revoked-cursor-peer', [event!]);

    db.prepare(`DELETE FROM library_grants WHERE peer_id = ? AND library_id = ?`).run('revoked-cursor-peer', 'family');
    tags.acknowledgeCursors('revoked-cursor-peer', [{ libraryId: 'family', authorPeerId: identity.peerId, sequence: 1 }]);

    expect(tags.getAcknowledgedCursors('revoked-cursor-peer')).toEqual([]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get('revoked-cursor-peer'))
      .toEqual({ count: 1 });
  });

  it('does not trust a peer cursor past the contiguous events actually offered', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const tags = new TagSyncRepository(db);
    db.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
      VALUES ('cursor-peer', 'key', 'Cursor peer', 'trusted', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO library_grants (peer_id, library_id, permission, created_at) VALUES ('cursor-peer', 'family', 'read', ?)`).run(now);
    for (const tag of ['first', 'second']) {
      tags.addLocalTag({ libraryId: 'family', assetId: 'asset-1', tag, authorPeerId: identity.peerId,
        createdAt: now, draftFactory: draftFactory('family', identity.peerId) });
      await signPending(tags, identity.peerId, identity);
    }
    const events = tags.eventsMissingForPeer('cursor-peer', []);
    expect(events).toHaveLength(2);
    tags.recordOfferedEvents('cursor-peer', [events[1]!]);
    tags.acknowledgeCursors('cursor-peer', [{ libraryId: 'family', authorPeerId: identity.peerId, sequence: 2 }]);
    expect(tags.getAcknowledgedCursors('cursor-peer')).toEqual([]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get('cursor-peer'))
      .toEqual({ count: 2 });

    tags.recordOfferedEvents('cursor-peer', [events[0]!]);
    tags.acknowledgeCursors('cursor-peer', [{ libraryId: 'family', authorPeerId: identity.peerId, sequence: 2 }]);
    expect(tags.getAcknowledgedCursors('cursor-peer')).toMatchObject([{ sequence: 2 }]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get('cursor-peer'))
      .toEqual({ count: 0 });
  });

  it('does not mutate tags for a tombstoned or unknown local asset', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    const identity = await createIdentity(repository);
    const tags = new TagSyncRepository(db);
    db.prepare(`INSERT INTO sync_event_log (event_id, library_id, author_peer_id, author_sequence, protocol_version,
      schema_version, event_type, causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES ('indexed-event', 'family', ?, 1, 1, 1, 'asset.indexed', '[]', '{}', ?, 'sig', '{}', 'ready')`)
      .run(identity.peerId, now);
    db.prepare(`INSERT INTO sync_asset_projection (library_id, asset_id, origin_node_id, kind, sha256, byte_length,
      metadata_json, tombstone_event_id, restored_by_event_id, last_event_id)
      VALUES ('family', 'tombstoned-asset', ?, 'photo', ?, 4, '{}', 'tombstone-event', NULL, 'indexed-event')`)
      .run(identity.peerId, 'a'.repeat(64));

    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'tombstoned-asset', tag: 'hidden', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('not_found');
    expect(tags.addLocalTag({ libraryId: 'family', assetId: 'missing', tag: 'unknown', authorPeerId: identity.peerId,
      createdAt: now, draftFactory: draftFactory('family', identity.peerId) })).toBe('not_found');
  });

  it('records tag applied and unchanged outcomes and rolls back the event draft on audit failure', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db);
    const identity = await createIdentity(repository);
    await seedIndexedAsset(db, identity);
    const audit = new AuditRepository(db);
    const tags = new TagSyncRepository(db, () => now, audit);
    const factory = draftFactory('family', identity.peerId);
    const base = { libraryId: 'family', assetId: 'asset-1', tag: 'Private tag', authorPeerId: identity.peerId, createdAt: now, draftFactory: factory };

    expect(tags.addLocalTag({ ...base, requestId: 'tag-add' })).toBe('added');
    expect(tags.addLocalTag({ ...base, requestId: 'tag-add-noop' })).toBe('already_present');
    tags.completeLocalDraft({ ...tags.getUnsignedLocalDrafts(identity.peerId)[0]!, signature: 'A'.repeat(86) } as EventEnvelope);
    expect(tags.removeLocalTag({ ...base, requestId: 'tag-remove' })).toBe('removed');
    tags.completeLocalDraft({ ...tags.getUnsignedLocalDrafts(identity.peerId)[0]!, signature: 'B'.repeat(86) } as EventEnvelope);
    expect(tags.removeLocalTag({ ...base, requestId: 'tag-remove-noop' })).toBe('unchanged');

    db.exec(`CREATE TRIGGER fail_metadata_audit BEFORE INSERT ON metadata_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit insert rejected'); END`);
    expect(() => tags.addLocalTag({ ...base, tag: 'Blocked tag', requestId: 'tag-failed' })).toThrow('audit insert rejected');
    expect(tags.getAssetTags('family', 'asset-1')).toEqual([]);
    expect(db.prepare('SELECT count(*) AS count FROM tag_sync_event_log').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM metadata_audit_events').get()).toEqual({ count: 4 });
  });
});
