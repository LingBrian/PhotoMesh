import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { FavoriteSyncRepository } from '../src/sync/favorite-sync-repository.js';
import type { EventEnvelope } from '../src/sync/event-envelope.js';

const peerId = '12D3KooWPM046LocalAuthor';
const now = '2026-10-28T00:00:00.000Z';
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function migrateTo0008(db: Database.Database): Promise<void> {
  await new SqliteRepository(db).migrate(migrations.slice(0, 8));
}

function insertMetadataEvent(db: Database.Database, eventId: string): void {
  db.prepare(`INSERT INTO sync_event_log
    (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
     causal_parents_json, payload_json, created_at, signature, envelope_json, state)
    VALUES (?, 'family', ?, 1, 1, 1, 'asset.indexed', '[]', '{}', ?, 'sig', '{}', 'ready')`).run(eventId, peerId, now);
}

describe('PM-046 asset favorite migration and global event IDs', () => {
  it('appends 0009, retains populated 0008 data/checksums, and adds the favorite event namespace', async () => {
    const db = new Database(':memory:');
    try {
      await migrateTo0008(db);
      insertMetadataEvent(db, uuid(1));
      const before = db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all();
      const repo = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repo.migrate();
      const latest = db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get();
      expect(latest).toEqual({ migration_id: '0009_asset_favorites' });
      expect(db.prepare(`SELECT migration_id, checksum FROM schema_migrations WHERE migration_id <> '0009_asset_favorites' ORDER BY migration_id`).all()).toEqual(before);
      expect(db.prepare('SELECT event_stream FROM sync_global_id_registry WHERE global_id = ?').get(uuid(1)))
        .toEqual({ event_stream: 'asset-metadata-v1' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sync_global_id_registry_0008'").get()).toBeUndefined();

      const favoriteId = uuid(2);
      db.prepare(`INSERT INTO favorite_sync_event_log
        (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
         causal_parents_json, payload_json, created_at, signature, envelope_json, state)
        VALUES (?, 'family', ?, 1, 1, 1, 'asset.favorite.added', '["${uuid(1)}"]', '{"assetId":"asset-1"}', ?, 'sig', '{}', 'ready')`)
        .run(favoriteId, peerId, now);
      expect(db.prepare('SELECT event_stream, operation_kind FROM sync_global_id_registry WHERE global_id = ?').get(favoriteId))
        .toEqual({ event_stream: 'asset-favorites-v1', operation_kind: null });
      expect(() => insertMetadataEvent(db, favoriteId)).toThrow(/global event ID collision/i);
      expect(db.prepare('SELECT event_stream FROM sync_global_id_registry WHERE global_id = ?').get(favoriteId))
        .toEqual({ event_stream: 'asset-favorites-v1' });
    } finally {
      db.close();
    }
  });

  it('protects operation-only idempotency keys against cross-stream reuse', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate();
      const operationId = uuid(3);
      db.prepare(`INSERT INTO favorite_operations
        (operation_id, principal_id, author_peer_id, library_id, asset_id, operation_type, request_fingerprint, result_json, created_at)
        VALUES (?, 'local-admin', ?, 'family', 'asset-1', 'favorite.add.noop', ?, '{"favorite":true}', ?)`)
        .run(operationId, peerId, 'a'.repeat(64), now);
      expect(db.prepare('SELECT event_stream, operation_kind FROM sync_global_id_registry WHERE global_id = ?').get(operationId))
        .toEqual({ event_stream: null, operation_kind: 'favorite-operation' });
      expect(() => db.prepare(`INSERT INTO tag_sync_event_log
        (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
         causal_parents_json, payload_json, created_at, signature, envelope_json, state)
        VALUES (?, 'family', ?, 1, 1, 1, 'asset.tag.added', '[]', '{}', ?, 'sig', '{}', 'ready')`)
        .run(operationId, peerId, now)).toThrow(/global event ID collision/i);
    } finally {
      db.close();
    }
  });

  it('leaves a populated 0008 database byte-for-byte query-equivalent when the 0009 backup fails', async () => {
    const db = new Database(':memory:');
    try {
      await migrateTo0008(db);
      insertMetadataEvent(db, uuid(4));
      const registryBefore = db.prepare('SELECT * FROM sync_global_id_registry ORDER BY global_id').all();
      const checksumsBefore = db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all();
      const backup = vi.fn(async () => { throw new Error('backup unavailable'); });
      const repository = new SqliteRepository(db, { backupBeforeMigration: backup });
      await expect(repository.migrate()).rejects.toThrow(/backup unavailable/);
      expect(backup).toHaveBeenCalledOnce();
      expect(db.prepare('SELECT * FROM sync_global_id_registry ORDER BY global_id').all()).toEqual(registryBefore);
      expect(db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all()).toEqual(checksumsBefore);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorite_sync_event_log'").get()).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_global_id_registry_0008'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('masks unknown and tombstoned assets for local favorite writes', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate();
      const repo = new FavoriteSyncRepository(db, () => now);
      const input = { operationId: uuid(50), principalId: 'local-admin', authorPeerId: peerId, libraryId: 'family', assetId: 'missing', favorite: true, requestFingerprint: 'b'.repeat(64), createdAt: now };
      expect(repo.setFavorite(input)).toBe('not_found');
      expect(repo.getFavorite('family', 'missing')).toBe(false);
      expect(db.prepare('SELECT count(*) n FROM favorite_operations').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('applies local OR-set add/remove and replays an identical operation idempotently', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate();
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-1','family',?,'photo',?)`).run(peerId,now);
      db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,'sig','{}','ready')`).run(uuid(70),peerId,JSON.stringify({assetId:'asset-1'}),now);
      const repo = new FavoriteSyncRepository(db, () => now);
      const input={operationId:uuid(71),principalId:'local-admin',authorPeerId:peerId,libraryId:'family',assetId:'asset-1',favorite:true,requestFingerprint:'c'.repeat(64),createdAt:now};
      expect(repo.setFavorite(input)).toEqual({status:'changed',favorite:true});
      const draft=repo.getUnsignedLocalDrafts(peerId)[0];
      repo.completeLocalDraft({...draft,signature:'A'.repeat(86)} as EventEnvelope);
      expect(repo.getFavorite('family','asset-1')).toBe(true);
      expect(new SqliteRepository(db).listGalleryAssets('family', undefined, 10).items.find(({ assetId }) => assetId === 'asset-1')?.favorite).toBe(true);
      expect(repo.setFavorite(input)).toEqual({status:'changed',favorite:true});
      expect(repo.setFavorite({...input,operationId:uuid(72),favorite:false,requestFingerprint:'d'.repeat(64)})).toEqual({status:'changed',favorite:false});
      const remove=repo.getUnsignedLocalDrafts(peerId)[0];
      repo.completeLocalDraft({...remove,signature:'B'.repeat(86)} as EventEnvelope);
      expect(repo.getFavorite('family','asset-1')).toBe(false);
      expect(new SqliteRepository(db).listGalleryAssets('family', undefined, 10).items.find(({ assetId }) => assetId === 'asset-1')?.favorite).toBe(false);
    } finally { db.close(); }
  });

  it('refuses cursor-only and rejected acknowledgements until a contiguous event is accepted', async () => {
    const db = new Database(':memory:');
    try {
      const sqlite = new SqliteRepository(db);
      await sqlite.migrate();
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-ack','family',?,'photo',?)`).run(peerId,now);
      db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,'sig','{}','ready')`).run(uuid(95),peerId,JSON.stringify({assetId:'asset-ack'}),now);
      const readerId = '12D3KooWPM046ReaderPeer';
      sqlite.trustPeer({ peerId: readerId, publicKey: 'reader-key', label: 'reader', trustState: 'trusted', createdAt: now, revokedAt: null });
      sqlite.grantLibraryRead(readerId, 'family', now);
      const repo = new FavoriteSyncRepository(db, () => now);
      const input={operationId:uuid(96),principalId:'local-admin',authorPeerId:peerId,libraryId:'family',assetId:'asset-ack',favorite:true,requestFingerprint:'1'.repeat(64),createdAt:now};
      expect(repo.setFavorite(input)).toEqual({status:'changed',favorite:true});
      const first={...repo.getUnsignedLocalDrafts(peerId)[0]!,signature:'D'.repeat(86)} as EventEnvelope;
      repo.completeLocalDraft(first);
      expect(repo.setFavorite({...input,operationId:uuid(97),favorite:false,requestFingerprint:'2'.repeat(64)})).toEqual({status:'changed',favorite:false});
      const second={...repo.getUnsignedLocalDrafts(peerId)[0]!,signature:'D'.repeat(86)} as EventEnvelope;
      repo.completeLocalDraft(second);
      const events=[first,second];
      expect(events.map((event)=>event.authorSequence)).toEqual([1,2]);
      repo.recordOfferedEvents(readerId,events);
      const cursor={libraryId:'family',authorPeerId:peerId,sequence:2};
      repo.acknowledgeCursors(readerId,[cursor]);
      expect(repo.getAcknowledgedCursors(readerId)).toEqual([]);
      repo.recordOfferResult(readerId,events[0]!.eventId,'unauthorized');
      repo.recordOfferResult(readerId,events[1]!.eventId,'applied');
      repo.acknowledgeCursors(readerId,[cursor]);
      expect(repo.getAcknowledgedCursors(readerId)).toEqual([]);
      expect(db.prepare('SELECT count(*) n FROM favorite_sync_outbox WHERE peer_id=?').get(readerId)).toEqual({n:2});
      repo.recordOfferResult(readerId,events[0]!.eventId,'applied');
      repo.acknowledgeCursors(readerId,[cursor]);
      expect(repo.getAcknowledgedCursors(readerId)).toEqual([cursor]);
      expect(db.prepare('SELECT count(*) n FROM favorite_sync_outbox WHERE peer_id=?').get(readerId)).toEqual({n:0});
    } finally { db.close(); }
  });

  it('hides favorites on tombstones and restores the OR-set projection', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate();
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-restore','family',?,'photo',?)`).run(peerId,now);
      db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,'sig','{}','ready')`).run(uuid(90),peerId,JSON.stringify({assetId:'asset-restore'}),now);
      const repo = new FavoriteSyncRepository(db, () => now);
      const input={operationId:uuid(91),principalId:'local-admin',authorPeerId:peerId,libraryId:'family',assetId:'asset-restore',favorite:true,requestFingerprint:'e'.repeat(64),createdAt:now};
      expect(repo.setFavorite(input)).toEqual({status:'changed',favorite:true});
      repo.completeLocalDraft({...repo.getUnsignedLocalDrafts(peerId)[0],signature:'C'.repeat(86)} as EventEnvelope);
      db.prepare(`INSERT INTO sync_asset_projection(library_id,asset_id,origin_node_id,kind,sha256,byte_length,metadata_json,tombstone_event_id,restored_by_event_id,last_event_id)
        VALUES('family','asset-restore',?,'photo',?,0,'{}',?,NULL,?)`).run(peerId,'0'.repeat(64),uuid(92),uuid(90));
      repo.rebuildFavoriteProjectionForAsset('family','asset-restore');
      expect(repo.getFavorite('family','asset-restore')).toBe(true);
      expect(new SqliteRepository(db).listGalleryAssets('family', undefined, 10).items.some(({ assetId }) => assetId === 'asset-restore')).toBe(false);
      expect(repo.setFavorite(input)).toEqual({status:'changed',favorite:true});
      expect(repo.setFavorite({...input,operationId:uuid(93),favorite:false,requestFingerprint:'f'.repeat(64)})).toBe('not_found');
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id=NULL, restored_by_event_id=? WHERE library_id='family' AND asset_id='asset-restore'").run(uuid(94));
      repo.rebuildFavoriteProjectionForAsset('family','asset-restore');
      expect(repo.getFavorite('family','asset-restore')).toBe(true);
      expect(new SqliteRepository(db).listGalleryAssets('family', undefined, 10).items.find(({ assetId }) => assetId === 'asset-restore')?.favorite).toBe(true);
    } finally { db.close(); }
  });
});
