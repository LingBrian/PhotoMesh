import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AuditRepository } from '../src/audit/audit-repository.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { RatingSyncRepository } from '../src/sync/rating-sync-repository.js';
import { makeUnsignedEvent, type EventEnvelope } from '../src/sync/event-envelope.js';

const authorPeerId = '12D3KooWPM047RatingAuthor';
const now = '2026-10-29T00:00:00.000Z';
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function migrateTo0009(db: Database.Database): Promise<void> {
  await new SqliteRepository(db).migrate(migrations.slice(0, 9));
}

function insertIndexEvent(db: Database.Database, eventId: string, assetId: string): void {
  db.prepare(`INSERT INTO sync_event_log
    (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
    VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,'sig','{}','ready')`)
    .run(eventId, authorPeerId, JSON.stringify({ assetId, originNodeId: authorPeerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 }), now);
}

describe('PM-047 rating register persistence', () => {
  it('appends 0010 without changing prior migration checksums and fences rating event IDs', async () => {
    const db = new Database(':memory:');
    try {
      await migrateTo0009(db);
      insertIndexEvent(db, uuid(1), 'asset-1');
      const previous = db.prepare('SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id').all();
      await new SqliteRepository(db, { backupBeforeMigration: async () => undefined }).migrate(migrations.slice(0, 10));
      expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get())
        .toEqual({ migration_id: '0010_asset_ratings' });
      expect(db.prepare(`SELECT migration_id,checksum FROM schema_migrations WHERE migration_id <> '0010_asset_ratings' ORDER BY migration_id`).all()).toEqual(previous);
      const ratingId = uuid(2);
      db.prepare(`INSERT INTO rating_sync_event_log
        (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
        VALUES(?,'family',?,1,1,1,'asset.rating.set','["${uuid(1)}"]','{"assetId":"asset-1","rating":4,"observedRatingEventIds":[]}',?,'sig','{}','ready')`)
        .run(ratingId, authorPeerId, now);
      expect(db.prepare('SELECT event_stream,operation_kind FROM sync_global_id_registry WHERE global_id=?').get(ratingId))
        .toEqual({ event_stream: 'asset-ratings-v1', operation_kind: null });
      expect(() => db.prepare(`INSERT INTO favorite_sync_event_log
        (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
        VALUES(?,'family',?,1,1,1,'asset.favorite.added','[]','{}',?,'sig','{}','ready')`).run(ratingId, authorPeerId, now))
        .toThrow(/global event ID collision/i);
    } finally { db.close(); }
  });

  it('keeps stable single values, explicit null clears, and idempotency results', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations);
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-1','family',?,'photo',?)`).run(authorPeerId, now);
      insertIndexEvent(db, uuid(10), 'asset-1');
      const repo = new RatingSyncRepository(db, () => now);
      const request = { operationId: uuid(11), principalId: 'local-admin', authorPeerId, libraryId: 'family', assetId: 'asset-1', rating: 4,
        requestFingerprint: '1'.repeat(64), createdAt: now };
      expect(repo.setRating(request)).toMatchObject({ status: 'changed', rating: 4, conflict: false, ratingCandidates: [4] });
      const first = { ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'A'.repeat(86) } as EventEnvelope;
      repo.completeLocalDraft(first);
      expect(repo.setRating({ ...request, operationId: uuid(12), rating: 2, requestFingerprint: '2'.repeat(64) }))
        .toMatchObject({ status: 'changed', rating: 2, conflict: false, ratingCandidates: [2] });
      const second = { ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'B'.repeat(86) } as EventEnvelope;
      repo.completeLocalDraft(second);
      const beforeNoop = db.prepare('SELECT count(*) n FROM rating_sync_event_log').get();
      expect(repo.setRating({ ...request, operationId: uuid(13), rating: 2, requestFingerprint: '3'.repeat(64) }))
        .toMatchObject({ status: 'unchanged', rating: 2, conflict: false, ratingCandidates: [2] });
      expect(db.prepare('SELECT count(*) n FROM rating_sync_event_log').get()).toEqual(beforeNoop);
      expect(repo.setRating(request)).toMatchObject({ status: 'changed', rating: 4 });
      expect(() => repo.setRating({ ...request, rating: 3, requestFingerprint: '4'.repeat(64) })).toThrow(/different request/i);

      expect(repo.setRating({ ...request, operationId: uuid(14), rating: null, requestFingerprint: '5'.repeat(64) }))
        .toMatchObject({ status: 'changed', rating: null, conflict: false, ratingCandidates: [null] });
      const clear = { ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'C'.repeat(86) } as EventEnvelope;
      repo.completeLocalDraft(clear);
      expect(repo.getRating('family', 'asset-1')).toEqual({ rating: null, conflict: false, ratingCandidates: [null] });
      expect(repo.getRating('family', 'unknown')).toEqual({ rating: null, conflict: false, ratingCandidates: [] });
    } finally { db.close(); }
  });

  it('requires contiguous accepted-at evidence before a cursor ACK and clears rejection acceptance', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations);
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-ack','family',?,'photo',?)`).run(authorPeerId, now);
      insertIndexEvent(db, uuid(30), 'asset-ack');
      const remotePeerId = '12D3KooWPM047RatingRemote';
      db.prepare(`INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at) VALUES(?,'a2V5','remote','trusted',?)`).run(remotePeerId, now);
      db.prepare("INSERT INTO library_grants(peer_id,library_id,permission,created_at) VALUES(?,'family','read',?)").run(remotePeerId, now);
      const repo = new RatingSyncRepository(db, () => now);
      repo.setRating({ operationId: uuid(31), principalId: 'local-admin', authorPeerId, libraryId: 'family', assetId: 'asset-ack',
        rating: 3, requestFingerprint: 'c'.repeat(64), createdAt: now });
      const event = { ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'E'.repeat(86) } as EventEnvelope;
      repo.completeLocalDraft(event);
      const cursor = repo.getCursors(['family']);
      repo.recordOfferedEvents(remotePeerId, [event]);

      repo.recordOfferResult(remotePeerId, event.eventId, 'unauthorized');
      repo.acknowledgeCursors(remotePeerId, cursor);
      expect(repo.getAcknowledgedCursors(remotePeerId)).toEqual([]);
      expect(db.prepare('SELECT accepted_at FROM rating_sync_outbox WHERE peer_id=? AND event_id=?').get(remotePeerId, event.eventId))
        .toEqual({ accepted_at: null });

      repo.recordOfferResult(remotePeerId, event.eventId, 'pending');
      repo.acknowledgeCursors(remotePeerId, cursor);
      expect(repo.getAcknowledgedCursors(remotePeerId)).toEqual([{ libraryId: 'family', authorPeerId, sequence: 1 }]);
      expect(db.prepare('SELECT count(*) n FROM rating_sync_outbox WHERE peer_id=?').get(remotePeerId)).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('durably freezes a signer stream when a causal parent is known but belongs to another asset', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations);
      const remotePeerId = '12D3KooWPM047RatingRemote';
      db.prepare(`INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at) VALUES(?,'a2V5','remote','trusted',?)`).run(remotePeerId, now);
      db.prepare("INSERT INTO library_grants(peer_id,library_id,permission,created_at) VALUES(?,'family','read',?)").run(remotePeerId, now);
      const parentId = uuid(40);
      insertIndexEvent(db, parentId, 'other-asset');
      const repo = new RatingSyncRepository(db, () => now);
      repo.grantRatingWriter('family', remotePeerId, authorPeerId, now);
      repo.setRemoteLibraries(remotePeerId, ['family']);
      const event = { ...makeUnsignedEvent({ eventId: uuid(41), libraryId: 'family', authorPeerId: remotePeerId, authorSequence: 1,
        causalParents: [parentId], eventType: 'asset.rating.set',
        payload: { assetId: 'asset-1', rating: 4, observedRatingEventIds: [] }, createdAt: now }), signature: 'F'.repeat(86) } as EventEnvelope;

      expect(repo.ingest(remotePeerId, event)).toMatchObject({ status: 'conflict' });
      expect(db.prepare('SELECT state,accepted_at FROM rating_sync_inbox WHERE event_id=?').get(event.eventId))
        .toEqual({ state: 'conflict', accepted_at: null });
      expect(db.prepare('SELECT error_code FROM rating_sync_conflicts WHERE library_id=? AND author_peer_id=?')
        .get('family', remotePeerId)).toEqual({ error_code: 'invalid_causal_parent' });
    } finally { db.close(); }
  });

  it('masks tombstoned assets and rebuilds retained rating history after restore', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations);
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-restore','family',?,'photo',?)`).run(authorPeerId, now);
      insertIndexEvent(db, uuid(20), 'asset-restore');
      const repo = new RatingSyncRepository(db, () => now);
      repo.setRating({ operationId: uuid(21), principalId: 'local-admin', authorPeerId, libraryId: 'family', assetId: 'asset-restore', rating: 5,
        requestFingerprint: 'a'.repeat(64), createdAt: now });
      repo.completeLocalDraft({ ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'D'.repeat(86) } as EventEnvelope);
      db.prepare(`INSERT INTO sync_asset_projection(library_id,asset_id,origin_node_id,kind,sha256,byte_length,metadata_json,tombstone_event_id,restored_by_event_id,last_event_id)
        VALUES('family','asset-restore',?,'photo',?,0,'{}',?,NULL,?)`).run(authorPeerId, '0'.repeat(64), uuid(22), uuid(20));
      repo.rebuildRatingProjectionForAsset('family', 'asset-restore');
      expect(repo.setRating({ operationId: uuid(23), principalId: 'local-admin', authorPeerId, libraryId: 'family', assetId: 'asset-restore', rating: 3,
        requestFingerprint: 'b'.repeat(64), createdAt: now })).toBe('not_found');
      expect(repo.getRating('family', 'asset-restore')).toEqual({ rating: null, conflict: false, ratingCandidates: [] });
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id=NULL,restored_by_event_id=? WHERE library_id='family' AND asset_id='asset-restore'").run(uuid(24));
      repo.rebuildRatingProjectionForAsset('family', 'asset-restore');
      expect(repo.getRating('family', 'asset-restore')).toEqual({ rating: 5, conflict: false, ratingCandidates: [5] });
    } finally { db.close(); }
  });

  it('atomically audits rating applied, unchanged, replayed, and rejected writes', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate();
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-audit','family',?,'photo',?)`).run(authorPeerId, now);
      insertIndexEvent(db, uuid(80), 'asset-audit');
      const audit = new AuditRepository(db);
      const repo = new RatingSyncRepository(db, () => now, audit);
      const input = {
        operationId: uuid(81), principalId: 'local-admin', authorPeerId, libraryId: 'family', assetId: 'asset-audit',
        rating: 4, requestFingerprint: 'a'.repeat(64), createdAt: now, requestId: 'rating-applied'
      };
      expect(repo.setRating(input)).toMatchObject({ status: 'changed', rating: 4 });
      expect(repo.setRating({ ...input, requestId: 'rating-replay' })).toMatchObject({ status: 'changed', rating: 4 });
      expect(repo.setRating({ ...input, operationId: uuid(82), requestFingerprint: 'b'.repeat(64), requestId: 'rating-unchanged' }))
        .toMatchObject({ status: 'unchanged', rating: 4 });
      repo.completeLocalDraft({ ...repo.getUnsignedLocalDrafts(authorPeerId)[0]!, signature: 'A'.repeat(86) } as EventEnvelope);
      db.exec(`CREATE TRIGGER fail_metadata_audit BEFORE INSERT ON metadata_audit_events
        BEGIN SELECT RAISE(ABORT, 'audit insert rejected'); END`);
      expect(() => repo.setRating({ ...input, operationId: uuid(83), rating: 2, requestFingerprint: 'c'.repeat(64), requestId: 'rating-failed' }))
        .toThrow('audit insert rejected');
      expect(repo.getRating('family', 'asset-audit')).toMatchObject({ rating: 4, conflict: false });
      expect(db.prepare('SELECT count(*) AS count FROM rating_operations').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM rating_sync_event_log').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT action,outcome,request_id FROM metadata_audit_events ORDER BY audit_id').all()).toEqual([
        { action: 'asset.rating.set', outcome: 'applied', request_id: 'rating-applied' },
        { action: 'asset.rating.set', outcome: 'replayed', request_id: 'rating-replay' },
        { action: 'asset.rating.set', outcome: 'unchanged', request_id: 'rating-unchanged' }
      ]);
    } finally { db.close(); }
  });
});
