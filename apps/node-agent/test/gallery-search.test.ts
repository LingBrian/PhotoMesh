import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { makeUnsignedEvent } from '../src/sync/event-envelope.js';

const now = '2026-10-29T00:00:00.000Z';
const peerId = '12D3KooWPM048SearchPeer';
let projectionSequence = 0;

function insertLocalAsset(
  db: Database.Database,
  input: { assetId: string; libraryId?: string; capturedAt?: string | null; filename: string; path: string }
): void {
  const libraryId = input.libraryId ?? 'library-a';
  db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,capture_ts,created_at)
    VALUES(?,?,?,'photo',?,?)`).run(input.assetId, libraryId, peerId, input.capturedAt ?? null, now);
  const fileId = `file-${input.assetId}`;
  db.prepare(`INSERT INTO asset_files(file_id,asset_id,sha256,byte_size,media_role,storage_ref,created_at)
    VALUES(?,?,?,1,'original',?,?)`).run(fileId, input.assetId, 'a'.repeat(64), `objects/${input.assetId}`, now);
  db.prepare(`INSERT INTO file_locations(location_id,file_id,node_id,original_filename,original_path,source_kind,source_node_id,
    path_ref,storage_class,availability,created_at) VALUES(?,?,?,?,?,'import',NULL,?,'external','online',?)`)
    .run(`loc-${input.assetId}`, fileId, peerId, input.filename, input.path, `objects/${input.assetId}`, now);
}

function insertProjection(db: Database.Database, input: {
  assetId: string; libraryId?: string; filename: string; path: string; capturedAt?: string | null; tombstoneEventId?: string | null;
}): void {
  const libraryId = input.libraryId ?? 'library-a';
  const eventId = `00000000-0000-4000-8000-${String(++projectionSequence).padStart(12, '0')}`;
  const envelope = makeUnsignedEvent({
    eventId, libraryId, authorPeerId: '12D3KooWPM048Remote', authorSequence: projectionSequence,
    causalParents: [], eventType: 'asset.indexed', payload: {
      assetId: input.assetId, originNodeId: '12D3KooWPM048Remote', kind: 'photo', sha256: 'b'.repeat(64), byteLength: 1
    }, createdAt: now
  });
  db.prepare(`INSERT INTO sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,
    event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,'ready')`)
    .run(eventId, libraryId, envelope.authorPeerId, envelope.authorSequence, envelope.protocolVersion, envelope.schemaVersion,
      envelope.eventType, JSON.stringify(envelope.causalParents), JSON.stringify(envelope.payload), envelope.createdAt, JSON.stringify(envelope));
  db.prepare(`INSERT INTO sync_asset_projection(library_id,asset_id,origin_node_id,kind,sha256,byte_length,metadata_json,
    tombstone_event_id,last_event_id) VALUES(?,?,'12D3KooWPM048Remote','photo',?,1,?,?,?)`)
    .run(libraryId, input.assetId, 'b'.repeat(64), JSON.stringify({
      filename: input.filename, sourcePath: input.path, ...(input.capturedAt ? { capturedAt: input.capturedAt } : {})
    }), input.tombstoneEventId ?? null, eventId);
}

describe('PM-048 gallery search index and cursor', () => {
  it('appends 0011, backfills FTS5, and maintains local/projection content and tombstones', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations.slice(0, 10));
      insertLocalAsset(db, { assetId: 'local-one', capturedAt: '2026-05-02T08:00:00.000Z', filename: 'Alpha Photo.JPG', path: '/private/Trips/Alpha Photo.JPG' });
      insertProjection(db, { assetId: 'remote-one', filename: 'Remote Photo.JPG', path: '/remote/Trips/Remote Photo.JPG' });
      insertLocalAsset(db, { assetId: 'shared-asset', filename: 'Shared Local Name.jpg', path: '/local/Shared Local Name.jpg' });
      insertProjection(db, { assetId: 'shared-asset', filename: 'Projection Must Stay Hidden.jpg', path: '/remote/Projection Must Stay Hidden.jpg' });
      const before = db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all();

      await repository.migrate(migrations);

      expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get())
        .toEqual({ migration_id: '0011_gallery_search_index' });
      expect(db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all())
        .toEqual([...before, { migration_id: '0011_gallery_search_index', checksum: expect.any(String) }]);
      expect(searchIds(db, '"photo"', 'library-a')).toEqual(['local-one', 'remote-one']);
      expect(searchIds(db, '"shared"', 'library-a')).toEqual(['shared-asset']);
      expect(searchIds(db, '"projection"', 'library-a')).toEqual([]);

      insertLocalAsset(db, { assetId: 'local-after', filename: 'Fresh Archive.JPG', path: '/new/Fresh Archive.JPG' });
      expect(searchIds(db, '"fresh"', 'library-a')).toEqual(['local-after']);
      insertLocalAsset(db, { assetId: 'file-mutation', filename: 'FileChangingTerm.jpg', path: '/mutable/FileChangingTerm.jpg' });
      expect(searchIds(db, '"filechangingterm"', 'library-a')).toEqual(['file-mutation']);
      db.prepare("DELETE FROM file_locations WHERE location_id='loc-file-mutation'").run();
      expect(searchIds(db, '"filechangingterm"', 'library-a')).toEqual([]);
      db.prepare("DELETE FROM asset_files WHERE file_id='file-file-mutation'").run();

      db.prepare("UPDATE file_locations SET original_filename='Renamed Export.JPG', original_path='/moved/Renamed Export.JPG' WHERE location_id='loc-local-one'").run();
      expect(searchIds(db, '"alpha"', 'library-a')).toEqual([]);
      expect(searchIds(db, '"renamed"', 'library-a')).toContain('local-one');
      db.prepare('UPDATE asset_files SET sha256=?,byte_size=77 WHERE file_id=?').run('c'.repeat(64), 'file-local-one');
      db.prepare("UPDATE assets SET capture_ts='2026-05-03T00:00:00.000Z' WHERE asset_id='local-one'").run();
      const changedLocal = repository.listGalleryAssets('library-a', undefined, 10, { q: 'renamed' }).items[0];
      expect(changedLocal).toMatchObject({ assetId: 'local-one', sha256: 'c'.repeat(64), byteSize: 77, capturedAt: '2026-05-03T00:00:00.000Z' });

      db.prepare(`UPDATE sync_asset_projection SET metadata_json=json_set(metadata_json,'$.filename','Revised Projection.jpg','$.sourcePath','/archive/Revised Projection.jpg')
        WHERE library_id='library-a' AND asset_id='remote-one'`).run();
      expect(searchIds(db, '"photo"', 'library-a')).not.toContain('remote-one');
      expect(searchIds(db, '"revised"', 'library-a')).toContain('remote-one');
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id='tombstone-1' WHERE library_id='library-a' AND asset_id='remote-one'").run();
      expect(searchIds(db, '"revised"', 'library-a')).not.toContain('remote-one');
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id=NULL WHERE library_id='library-a' AND asset_id='remote-one'").run();
      expect(searchIds(db, '"revised"', 'library-a')).toContain('remote-one');

      db.prepare(`INSERT INTO file_locations(location_id,file_id,node_id,original_filename,original_path,source_kind,source_node_id,
        path_ref,storage_class,availability,created_at) VALUES('z-location','file-shared-asset',?,'Zebra Marker Unique.jpg','/zebra/Zebra Marker Unique.jpg',
        'import',NULL,'objects/zebra','external','online',?)`).run(peerId, now);
      db.prepare(`INSERT INTO file_locations(location_id,file_id,node_id,original_filename,original_path,source_kind,source_node_id,
        path_ref,storage_class,availability,created_at) VALUES('a-location','file-shared-asset',?,'Alpha CandidateUnique.jpg','/alpha/Alpha CandidateUnique.jpg',
        'import',NULL,'objects/alpha','external','online',?)`).run(peerId, now);
      expect(searchIds(db, '"candidateunique"', 'library-a')).toEqual(['shared-asset']);
      expect(searchIds(db, '"zebramarker"', 'library-a')).toEqual([]);
      db.prepare("UPDATE file_locations SET availability='offline' WHERE location_id='z-location'").run();
      expect(searchIds(db, '"candidateunique"', 'library-a')).toEqual(['shared-asset']);

      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id='shared-tombstone' WHERE library_id='library-a' AND asset_id='shared-asset'").run();
      expect(searchIds(db, '"candidateunique"', 'library-a')).toEqual([]);
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id=NULL WHERE library_id='library-a' AND asset_id='shared-asset'").run();
      expect(searchIds(db, '"candidateunique"', 'library-a')).toEqual(['shared-asset']);
      expect(searchIds(db, '"projection"', 'library-a')).not.toContain('shared-asset');
    } finally {
      db.close();
    }
  });

  it('uses literal case-insensitive substring search, half-open UTC dates, and scoped stable keyset cursors', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db);
      await repository.migrate(migrations);
      insertLocalAsset(db, { assetId: 'asset-a', capturedAt: '2026-05-01T23:59:59.999Z', filename: 'Summer-Photo.jpg', path: '/Trips/Summer-Photo.jpg' });
      insertLocalAsset(db, { assetId: 'asset-b', capturedAt: '2026-05-02T03:00:00+03:00', filename: 'Photo "Quote".jpg', path: '/Trips/Photo "Quote".jpg' });
      insertLocalAsset(db, { assetId: 'asset-c', capturedAt: '2026-05-02T12:00:00.000Z', filename: 'Other.JPG', path: '/Trips/PHOTO-Other.JPG' });
      insertLocalAsset(db, { assetId: 'asset-null', capturedAt: null, filename: 'No-Date.jpg', path: '/Trips/Photo-No-Date.jpg' });
      insertLocalAsset(db, { assetId: 'asset-invalid', capturedAt: 'not-a-date', filename: 'Photo Invalid Date.jpg', path: '/Trips/Photo-Invalid-Date.jpg' });
      insertLocalAsset(db, { assetId: 'asset-unicode', capturedAt: null, filename: '山猫旅行📷ab.jpg', path: '/Trips/山猫旅行📷ab.jpg' });
      insertLocalAsset(db, { assetId: 'asset-accent', capturedAt: null, filename: 'Café au lait.jpg', path: '/Trips/Café au lait.jpg' });
      insertLocalAsset(db, { assetId: 'asset-percent', capturedAt: null, filename: 'Percent p%h.jpg', path: '/Trips/Percent p%h.jpg' });
      insertLocalAsset(db, { assetId: 'asset-underscore', capturedAt: null, filename: 'Under p_h.jpg', path: '/Trips/Under p_h.jpg' });
      insertProjection(db, { assetId: 'asset-remote', filename: 'Remote Photo.jpg', path: '/remote/Photo archive.jpg', capturedAt: '2026-05-02T13:00:00.000Z' });

      const allMatches = repository.listGalleryAssets('library-a', undefined, 10, { q: 'PHOTO' });
      expect(allMatches.items.map((asset) => asset.assetId)).toEqual(['asset-remote', 'asset-c', 'asset-b', 'asset-a', 'asset-null', 'asset-invalid']);
      expect(allMatches.items.find((asset) => asset.assetId === 'asset-b')?.capturedAt).toBe('2026-05-02T00:00:00.000Z');
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: '"Quote"' }).items.map((asset) => asset.assetId))
        .toEqual(['asset-b']);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { q: 'ph' })).toThrow(/query/i);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: 'p%h' }).items.map((asset) => asset.assetId)).toEqual(['asset-percent']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: 'p_h' }).items.map((asset) => asset.assetId)).toEqual(['asset-underscore']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: 'asset-r' }).items.map((asset) => asset.assetId)).toEqual(['asset-remote']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: '12D3KooWPM048Remote' }).items.map((asset) => asset.assetId)).toEqual(['asset-remote']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: '猫旅行' }).items.map((asset) => asset.assetId)).toEqual(['asset-unicode']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: '📷ab' }).items.map((asset) => asset.assetId)).toEqual(['asset-unicode']);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { q: '📷a' })).toThrow(/query/i);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { q: 'cafe' }).items).toEqual([]);

      const datePage = repository.listGalleryAssets('library-a', undefined, 10, { dateFrom: '2026-05-02', dateTo: '2026-05-03' });
      expect(datePage.items.map((asset) => asset.assetId)).toEqual(['asset-remote', 'asset-c', 'asset-b']);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { dateFrom: '2026-05-03' }).items).toEqual([]);
      expect(repository.listGalleryAssets('library-a', undefined, 10, { dateTo: '2026-05-02' }).items.map((asset) => asset.assetId)).toEqual(['asset-a']);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { dateFrom: '2026-05-02', dateTo: '2026-05-02' })).toThrow(/date range/i);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { dateFrom: '2026-02-30' })).toThrow(/date/i);

      const first = repository.listGalleryAssets('library-a', undefined, 2, { q: 'photo' });
      expect(first.nextCursor).toBeTruthy();
      const second = repository.listGalleryAssets('library-a', first.nextCursor!, 2, { q: 'photo' });
      expect(second.items.map((asset) => asset.assetId)).toEqual(['asset-b', 'asset-a']);
      const third = repository.listGalleryAssets('library-a', second.nextCursor!, 2, { q: 'photo' });
      expect(third.items.map((asset) => asset.assetId)).toEqual(['asset-null', 'asset-invalid']);
      expect(third.nextCursor).toBeNull();
      const cursorPayload = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
      const extraCursorField = Buffer.from(JSON.stringify({ ...cursorPayload, unexpected: true }), 'utf8').toString('base64url');
      expect(() => repository.listGalleryAssets('library-a', extraCursorField, 2, { q: 'photo' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-a', 'e30=', 2, { q: 'photo' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-b', first.nextCursor!, 2, { q: 'photo' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-a', first.nextCursor!, 2, { q: 'remote' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-a', first.nextCursor!, 2, { q: 'photo', dateFrom: '2026-05-01' })).toThrow(/cursor/i);
    } finally {
      db.close();
    }
  });

  it('uses FTS and capture-date indexes and keeps the search migration atomic', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations.slice(0, 10));
      await repository.migrate(migrations);
      const ftsPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT c.asset_id FROM gallery_search_content c
        WHERE c.library_id=? AND c.rowid IN (SELECT rowid FROM gallery_search_fts WHERE gallery_search_fts MATCH ?)
        ORDER BY c.captured_at DESC,c.asset_id COLLATE BINARY DESC LIMIT ?`).all('library-a', '"photo"', 51) as Array<{ detail: string }>;
      expect(ftsPlan.some((row) => row.detail.includes('VIRTUAL TABLE INDEX'))).toBe(true);
      const datePlan = db.prepare(`EXPLAIN QUERY PLAN SELECT asset_id FROM gallery_search_content
        WHERE library_id=? AND captured_at>=? AND captured_at<? ORDER BY captured_at DESC,asset_id DESC LIMIT 10`)
        .all('library-a', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z') as Array<{ detail: string }>;
      expect(datePlan.some((row) => row.detail.includes('gallery_search_content_capture_idx'))).toBe(true);
      db.prepare("INSERT INTO gallery_search_fts(gallery_search_fts,rank) VALUES('integrity-check',1)").run();
    } finally {
      db.close();
    }

    const collisionDb = new Database(':memory:');
    try {
      const base = new SqliteRepository(collisionDb);
      await base.migrate(migrations.slice(0, 10));
      collisionDb.exec("CREATE VIRTUAL TABLE gallery_search_fts USING fts5(filename,source_path,asset_id,origin_node_id,tokenize='trigram')");
      const repository = new SqliteRepository(collisionDb, { backupBeforeMigration: async () => undefined });
      await expect(repository.migrate(migrations)).rejects.toThrow(/gallery_search_fts|failed applying migration/i);
      expect(collisionDb.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 10 });
      expect(collisionDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gallery_search_content'").get()).toBeUndefined();
    } finally {
      collisionDb.close();
    }
  });

  it('rejects an old binary after the search-index migration is applied', async () => {
    const db = new Database(':memory:');
    try {
      const current = new SqliteRepository(db);
      await current.migrate(migrations);
      const oldBinary = new SqliteRepository(db);
      await expect(oldBinary.migrate(migrations.slice(0, 10))).rejects.toThrow(/unknown migration 0011_gallery_search_index/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 11 });
    } finally {
      db.close();
    }
  });

  it('fails the search migration before changing an existing database when backup fails', async () => {
    const db = new Database(':memory:');
    try {
      const base = new SqliteRepository(db);
      await base.migrate(migrations.slice(0, 10));
      insertLocalAsset(db, { assetId: 'before-search', filename: 'Before.jpg', path: '/before/Before.jpg' });
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { throw new Error('backup unavailable'); } });
      await expect(repository.migrate(migrations)).rejects.toThrow(/backup unavailable/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 10 });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gallery_search_content'").get()).toBeUndefined();
      expect(db.prepare('SELECT asset_id FROM assets WHERE asset_id=?').get('before-search')).toEqual({ asset_id: 'before-search' });
    } finally {
      db.close();
    }
  });
});

function searchIds(db: Database.Database, ftsQuery: string, libraryId: string): string[] {
  return (db.prepare(`SELECT c.asset_id FROM gallery_search_fts f
    JOIN gallery_search_content c ON c.rowid=f.rowid
    WHERE gallery_search_fts MATCH ? AND c.library_id=? ORDER BY c.asset_id`).all(ftsQuery, libraryId) as Array<{ asset_id: string }>)
    .map((row) => row.asset_id);
}
