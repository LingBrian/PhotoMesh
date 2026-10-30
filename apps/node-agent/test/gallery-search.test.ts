import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository, StaleGalleryCursorError } from '../src/db/repository.js';
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

      await repository.migrate(migrations.slice(0, 11));

      expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get())
        .toEqual({ migration_id: '0011_gallery_search_index' });
      expect(db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all())
        .toEqual([...before, { migration_id: '0011_gallery_search_index', checksum: expect.any(String) }]);
      expect(searchIds(db, '"photo"', 'library-a')).toEqual(['local-one', 'remote-one']);
      expect(searchIds(db, '"shared"', 'library-a')).toEqual(['shared-asset']);
      expect(searchIds(db, '"projection"', 'library-a')).toEqual([]);
      await repository.migrate(migrations);

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
      expect(cursorPayload.version).toBe(3);
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

  it('combines PM-049 kind, source, availability, q, and date filters with scoped v2 cursors', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations);
      insertLocalAsset(db, { assetId: 'asset-photo-import-online', capturedAt: '2026-10-29T00:00:00.000Z', filename: 'Trip Alpha.jpg', path: '/trip/Trip Alpha.jpg' });
      insertLocalAsset(db, { assetId: 'asset-video-upload-cached', capturedAt: '2026-10-28T00:00:00.000Z', filename: 'Trip Bravo.jpg', path: '/trip/Trip Bravo.jpg' });
      db.prepare("UPDATE assets SET kind='video' WHERE asset_id='asset-video-upload-cached'").run();
      db.prepare("UPDATE file_locations SET source_kind='upload',availability='cached' WHERE location_id='loc-asset-video-upload-cached'").run();
      insertLocalAsset(db, { assetId: 'asset-video-import-offline', capturedAt: '2026-10-27T00:00:00.000Z', filename: 'Trip Charlie.jpg', path: '/trip/Trip Charlie.jpg' });
      db.prepare("UPDATE assets SET kind='video' WHERE asset_id='asset-video-import-offline'").run();
      db.prepare("UPDATE file_locations SET availability='offline' WHERE location_id='loc-asset-video-import-offline'").run();
      insertLocalAsset(db, { assetId: 'asset-live-upload-online', capturedAt: '2026-10-26T00:00:00.000Z', filename: 'Trip Delta.jpg', path: '/trip/Trip Delta.jpg' });
      db.prepare("UPDATE assets SET kind='live_photo' WHERE asset_id='asset-live-upload-online'").run();
      db.prepare("UPDATE file_locations SET source_kind='upload' WHERE location_id='loc-asset-live-upload-online'").run();
      insertProjection(db, { assetId: 'asset-remote-video-upload', capturedAt: '2026-10-25T00:00:00.000Z', filename: 'Trip Echo.jpg', path: '/trip/Trip Echo.jpg' });
      db.prepare("UPDATE sync_asset_projection SET kind='video',metadata_json=json_set(metadata_json,'$.sourceKind','upload') WHERE asset_id='asset-remote-video-upload'").run();
      insertLocalAsset(db, { assetId: 'asset-other-library', libraryId: 'library-b', capturedAt: '2026-10-28T00:00:00.000Z', filename: 'Trip Secret.jpg', path: '/trip/Trip Secret.jpg' });
      db.prepare("UPDATE assets SET kind='video' WHERE asset_id='asset-other-library'").run();

      const ids = (filters: Parameters<typeof repository.listGalleryAssets>[3]) =>
        repository.listGalleryAssets('library-a', undefined, 20, filters).items.map((asset) => asset.assetId);
      expect(ids({ kind: 'video' })).toEqual(['asset-video-upload-cached', 'asset-video-import-offline', 'asset-remote-video-upload']);
      expect(ids({ sourceKind: 'upload' })).toEqual(['asset-video-upload-cached', 'asset-live-upload-online', 'asset-remote-video-upload']);
      expect(ids({ availability: 'missing' })).toEqual(['asset-remote-video-upload']);
      expect(ids({ kind: 'video', sourceKind: 'upload', availability: 'cached' })).toEqual(['asset-video-upload-cached']);
      expect(ids({ kind: 'video', sourceKind: 'upload', availability: 'missing' })).toEqual(['asset-remote-video-upload']);
      expect(ids({ q: 'Trip', dateFrom: '2026-10-25', dateTo: '2026-10-29', kind: 'video', sourceKind: 'upload' }))
        .toEqual(['asset-video-upload-cached', 'asset-remote-video-upload']);

      const first = repository.listGalleryAssets('library-a', undefined, 1, { kind: 'video', sourceKind: 'upload' });
      const firstPayload = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as { version: number };
      expect(firstPayload.version).toBe(3);
      expect(first.items.map((asset) => asset.assetId)).toEqual(['asset-video-upload-cached']);
      const second = repository.listGalleryAssets('library-a', first.nextCursor!, 1, { kind: 'video', sourceKind: 'upload' });
      expect(second.items.map((asset) => asset.assetId)).toEqual(['asset-remote-video-upload']);
      expect(() => repository.listGalleryAssets('library-a', first.nextCursor!, 1, { kind: 'video', sourceKind: 'import' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-a', first.nextCursor!, 1, { kind: 'video', sourceKind: 'upload', availability: 'missing' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-b', first.nextCursor!, 1, { kind: 'video', sourceKind: 'upload' })).toThrow(/cursor/i);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { kind: 'audio' as never })).toThrow(/kind/i);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { sourceKind: 'camera' as never })).toThrow(/source/i);
      expect(() => repository.listGalleryAssets('library-a', undefined, 10, { availability: 'present' as never })).toThrow(/availability/i);
    } finally {
      db.close();
    }
  });

  it('appends 0012 filter indexes transactionally and preserves the 0011 checksum', async () => {
    const db = new Database(':memory:');
    let backupCalls = 0;
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backupCalls += 1; } });
      await repository.migrate(migrations.slice(0, 11));
      const previous = db.prepare("SELECT checksum FROM schema_migrations WHERE migration_id='0011_gallery_search_index'").get();
      await repository.migrate(migrations.slice(0, 12));
      expect(backupCalls).toBe(1);
      expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get())
        .toEqual({ migration_id: '0012_gallery_filter_indexes' });
      expect(db.prepare("SELECT checksum FROM schema_migrations WHERE migration_id='0011_gallery_search_index'").get())
        .toEqual(previous);
      expect(db.prepare(`SELECT migration_id,checksum FROM schema_migrations WHERE migration_id='0012_gallery_filter_indexes'`).get())
        .toEqual({ migration_id: '0012_gallery_filter_indexes', checksum: expect.any(String) });
      for (const index of [
        'gallery_search_content_kind_capture_idx', 'gallery_search_content_source_kind_capture_idx',
        'gallery_search_content_availability_capture_idx'
      ]) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)).toBeDefined();
      }
    } finally {
      db.close();
    }

    const backupDb = new Database(':memory:');
    try {
      const base = new SqliteRepository(backupDb);
      await base.migrate(migrations.slice(0, 11));
      const refusing = new SqliteRepository(backupDb, { backupBeforeMigration: async () => { throw new Error('backup unavailable'); } });
      await expect(refusing.migrate(migrations)).rejects.toThrow(/backup unavailable/);
      expect(backupDb.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 11 });
      expect(backupDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='gallery_search_content_kind_capture_idx'").get()).toBeUndefined();
    } finally {
      backupDb.close();
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
      const filterIndexes = [
        ['kind', 'gallery_search_content_kind_capture_idx'],
        ['source_kind', 'gallery_search_content_source_kind_capture_idx'],
        ['availability', 'gallery_search_content_availability_capture_idx']
      ] as const;
      for (const [column, indexName] of filterIndexes) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT asset_id FROM gallery_search_content
          WHERE library_id=? AND ${column}=? ORDER BY captured_at DESC,asset_id COLLATE BINARY DESC LIMIT 10`)
          .all('library-a', column === 'kind' ? 'photo' : column === 'source_kind' ? 'import' : 'online') as Array<{ detail: string }>;
        expect(plan.some((row) => row.detail.includes(indexName))).toBe(true);
      }
      const combinedPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT asset_id FROM gallery_search_content
        WHERE library_id=? AND kind=? AND source_kind=? AND availability=? AND captured_at>=? AND captured_at<?
        ORDER BY captured_at DESC,asset_id COLLATE BINARY DESC LIMIT 10`)
        .all('library-a', 'photo', 'import', 'online', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z') as Array<{ detail: string }>;
      expect(combinedPlan.some((row) => row.detail.includes('gallery_search_content_kind_capture_idx') ||
        row.detail.includes('gallery_search_content_source_kind_capture_idx') || row.detail.includes('gallery_search_content_availability_capture_idx') ||
        row.detail.includes('gallery_search_content_capture_idx'))).toBe(true);
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
      const pm048Binary = new SqliteRepository(db);
      await expect(pm048Binary.migrate(migrations.slice(0, 11))).rejects.toThrow(/unknown migration 0012_gallery_filter_indexes/i);
      const oldBinary = new SqliteRepository(db);
      await expect(oldBinary.migrate(migrations.slice(0, 10))).rejects.toThrow(/unknown migration 0011_gallery_search_index/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 14 });
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

  it('reports duplicate candidates without merging sources or including tombstones', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations);
      insertLocalAsset(db, { assetId: 'local-duplicate', filename: 'Local copy.jpg', path: '/photos/local-copy.jpg' });
      db.prepare('UPDATE asset_files SET sha256=?, byte_size=? WHERE asset_id=?').run('c'.repeat(64), 7, 'local-duplicate');
      insertProjection(db, { assetId: 'remote-duplicate', filename: 'Remote copy.jpg', path: '/remote/remote-copy.jpg' });
      db.prepare('UPDATE sync_asset_projection SET sha256=?, byte_length=? WHERE asset_id=?').run('c'.repeat(64), 7, 'remote-duplicate');
      insertLocalAsset(db, { assetId: 'unique-asset', filename: 'Unique.jpg', path: '/photos/unique.jpg' });
      const groups = repository.listDuplicateCandidateGroups('library-a', 10);
      expect(groups).toEqual([{
        sha256: 'c'.repeat(64), byteSize: 7, truncated: false,
        assets: expect.arrayContaining([
          expect.objectContaining({ assetId: 'local-duplicate', sourcePath: '/photos/local-copy.jpg', availability: 'online' }),
          expect.objectContaining({ assetId: 'remote-duplicate', sourcePath: '/remote/remote-copy.jpg', availability: 'missing' })
        ])
      }]);
      expect(groups[0]?.assets).toHaveLength(2);
      db.prepare("UPDATE sync_asset_projection SET tombstone_event_id='tombstone-duplicate' WHERE asset_id='remote-duplicate'").run();
      expect(repository.listDuplicateCandidateGroups('library-a', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('limits duplicate candidate groups and members deterministically', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations);
      for (let index = 0; index < 35; index += 1) {
        insertLocalAsset(db, { assetId: `many-${String(index).padStart(2, '0')}`, filename: `many-${index}.jpg`, path: `/many/${index}.jpg` });
        db.prepare('UPDATE asset_files SET sha256=?, byte_size=? WHERE asset_id=?').run('d'.repeat(64), 9, `many-${String(index).padStart(2, '0')}`);
      }
      const groups = repository.listDuplicateCandidateGroups('library-a', 1);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ sha256: 'd'.repeat(64), byteSize: 9, truncated: true });
      expect(groups[0]?.assets).toHaveLength(32);
      expect(groups[0]?.assets[0]?.assetId).toBe('many-34');
    } finally {
      db.close();
    }
  });

  it('pages through equal instants, floating wall times, and unknown dates without duplicates', async () => {
    const db = new Database(':memory:');
    try {
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
      await repository.migrate(migrations);
      const instant = '2024-05-06T07:08:09.000Z';
      for (const assetId of ['instant-a', 'instant-b', 'instant-c', 'instant-d', 'instant-e']) {
        insertLocalAsset(db, { assetId, capturedAt: instant, filename: `${assetId}.jpg`, path: `/photos/${assetId}.jpg` });
        db.prepare(`UPDATE assets SET capture_local_time=?,capture_offset_minutes=120,capture_source='exif_offset',capture_confidence='high'
          WHERE asset_id=?`).run('2024-05-06T09:08:09.000', assetId);
      }
      for (const assetId of ['floating-a', 'floating-b', 'floating-c']) {
        insertLocalAsset(db, { assetId, filename: `${assetId}.jpg`, path: `/photos/${assetId}.jpg` });
        db.prepare(`UPDATE assets SET capture_local_time=?,capture_source='exif_floating',capture_confidence='medium'
          WHERE asset_id=?`).run('2024-05-06T09:08:09.000', assetId);
      }
      for (const assetId of ['unknown-a', 'unknown-b']) {
        insertLocalAsset(db, { assetId, filename: `${assetId}.jpg`, path: `/photos/${assetId}.jpg` });
      }

      const collected: string[] = [];
      const pages: Array<{ assetId: string; capturedAt: string | null; captureLocalTime: string | null; captureSource: string; captureConfidence: string }> = [];
      let cursor: string | undefined;
      let loops = 0;
      do {
        const page = repository.listGalleryAssets('library-a', cursor, 2);
        pages.push(...page.items);
        collected.push(...page.items.map((asset) => asset.assetId));
        cursor = page.nextCursor ?? undefined;
        loops += 1;
        if (loops > 10) throw new Error('cursor did not terminate');
      } while (cursor);

      expect(collected).toEqual([
        'instant-e', 'instant-d', 'instant-c', 'instant-b', 'instant-a',
        'floating-c', 'floating-b', 'floating-a', 'unknown-b', 'unknown-a'
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect(pages[0]).toMatchObject({ capturedAt: instant, captureLocalTime: '2024-05-06T09:08:09.000', captureSource: 'exif_offset', captureConfidence: 'high' });
      expect(pages[5]).toMatchObject({ capturedAt: null, captureLocalTime: '2024-05-06T09:08:09.000', captureSource: 'exif_floating', captureConfidence: 'medium' });
      expect(pages.at(-1)).toMatchObject({ captureSource: 'unknown', captureConfidence: 'unknown' });

      const first = repository.listGalleryAssets('library-a', undefined, 2);
      const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(decoded).toMatchObject({ version: 3, sortRank: 0, sortKey: instant });

      const legacyFilterHash = createHash('sha256').update(JSON.stringify({ q: '', dateFrom: null, dateTo: null })).digest('hex');
      const oldCursor = Buffer.from(JSON.stringify({
        version: 1, libraryId: 'library-a', filterHash: legacyFilterHash,
        sort: 'capture-desc-asset-binary-desc-v1', capturedAt: instant, assetId: 'instant-e'
      }), 'utf8').toString('base64url');
      expect(repository.listGalleryAssets('library-a', oldCursor, 2).items.map((asset) => asset.assetId))
        .toEqual(['instant-d', 'instant-c']);
      const oldNullCursor = Buffer.from(JSON.stringify({
        version: 1, libraryId: 'library-a', filterHash: legacyFilterHash,
        sort: 'capture-desc-asset-binary-desc-v1', capturedAt: null, assetId: 'unknown-b'
      }), 'utf8').toString('base64url');
      expect(() => repository.listGalleryAssets('library-a', oldNullCursor, 2)).toThrow(StaleGalleryCursorError);
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
