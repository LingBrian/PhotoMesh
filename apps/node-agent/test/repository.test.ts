import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationError, RepositoryConflictError, SqliteRepository } from '../src/db/repository.js';
import { migrations } from '../src/db/migrations.js';

describe('SQLite repository and migrations', () => {
  it('serves cursor pages in capture order and applies filename search before paging', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    for (const [id, date, filename] of [
      ['asset-a', '2026-05-01T00:00:00.000Z', 'May.jpg'],
      ['asset-b', '2026-05-03T00:00:00.000Z', 'Weekend.jpg'],
      ['asset-c', '2026-05-02T00:00:00.000Z', 'Weekend-2.jpg'],
      ['asset-d', '2026-05-02T00:00:00.000Z', 'Other.jpg']
    ]) {
      db.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'library', 'node-a', 'photo', date, date);
      db.prepare('INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`file-${id}`, id, 'a'.repeat(64), 10, 'original', `objects/${id}/original.blob`, date);
      db.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path, source_kind,
        source_node_id, path_ref, storage_class, availability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`location-${id}`, `file-${id}`, 'node-a', filename, `/camera/${filename}`, 'upload', 'phone-a', `objects/${id}/original.blob`, 'managed', 'online', date);
    }
    const first = repository.listGalleryAssets('library', undefined, 2);
    expect(first.items.map((asset) => asset.assetId)).toEqual(['asset-b', 'asset-d']);
    expect(first.nextCursor).toBeTruthy();
    const second = repository.listGalleryAssets('library', first.nextCursor!, 2);
    expect(second.items.map((asset) => asset.assetId)).toEqual(['asset-c', 'asset-a']);
    expect(second.nextCursor).toBeNull();
    expect(repository.listGalleryAssets('library', undefined, 1, 'Weekend').items.map((asset) => asset.filename)).toEqual(['Weekend.jpg']);
    expect(repository.listGalleryAssets('library', undefined, 5, '%').items).toEqual([]);
    for (const id of ['null-a', 'null-b', 'null-c']) {
      db.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(id, 'library', 'node-a', 'photo', '2026-05-04T00:00:00.000Z');
      db.prepare('INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`file-${id}`, id, 'a'.repeat(64), 10, 'original', `objects/${id}/original.blob`, '2026-05-04T00:00:00.000Z');
    }
    const nullPage = repository.listGalleryAssets('library', first.nextCursor!, 2);
    expect(nullPage.items.map((asset) => asset.assetId)).toEqual(['asset-c', 'asset-a']);
    expect(nullPage.nextCursor).toBeTruthy();
    const firstNullPage = repository.listGalleryAssets('library', nullPage.nextCursor!, 2);
    expect(firstNullPage.items.map((asset) => asset.assetId)).toEqual(['null-c', 'null-b']);
    expect(firstNullPage.nextCursor).toBeTruthy();
    const finalNullPage = repository.listGalleryAssets('library', firstNullPage.nextCursor!, 2);
    expect(finalNullPage.items.map((asset) => asset.assetId)).toEqual(['null-a']);
    expect(finalNullPage.nextCursor).toBeNull();
    db.close();
  });

  it('applies checksummed migrations and persists upload and core records', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);

    await repository.migrate(migrations);
    repository.createUploadSession({
      sessionId: 'session-1',
      idempotencyScope: 'device-1',
      idempotencyKey: '0123456789abcdef',
      requestFingerprint: 'a'.repeat(64),
      libraryId: 'library-1',
      filename: 'original.jpg',
      sourceKind: 'upload',
      sourcePath: 'camera/2026/original.jpg',
      sourceNodeId: 'node-1',
      kind: 'photo',
      totalBytes: 4,
      expectedSha256: 'b'.repeat(64),
      expiresAt: '2026-10-22T00:00:00.000Z',
      finalStorageRef: 'objects/session-1/original.blob',
      now: '2026-10-21T00:00:00.000Z'
    });
    repository.recordChunk({ sessionId: 'session-1', chunkIndex: 0, byteLength: 4, sha256: 'c'.repeat(64), stagingRef: 'session-1/0', acceptedOffset: 0, createdAt: '2026-10-21T00:00:00.000Z' }, 0, '2026-10-21T00:00:00.000Z');

    expect(repository.getUploadSession('session-1')?.offset).toBe(4);
    expect(repository.getUploadSessionByIdempotency('device-1', '0123456789abcdef')?.sessionId).toBe('session-1');
    expect(repository.getUploadSession('missing')).toBeUndefined();
    expect(repository.getUploadChunk('session-1', 99)).toBeUndefined();
    expect(repository.getUploadChunks('session-1')).toHaveLength(1);
    expect(repository.getLocationForSession('session-1')).toBeUndefined();
    expect(db.prepare("SELECT state FROM jobs WHERE job_id = 'session-1'").get()).toEqual({ state: 'running' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(
      expect.arrayContaining([
        { name: 'assets' }, { name: 'asset_files' }, { name: 'file_locations' },
        { name: 'jobs' }, { name: 'events' }, { name: 'upload_sessions' }, { name: 'upload_chunks' }
      ])
    );

    db.close();
  });

  it('rolls back invalid migration and refuses changed checksums', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate(migrations);

    await expect(repository.migrate([{ id: '0001_upload_foundation', sql: 'CREATE TABLE changed (id TEXT);' }]))
      .rejects.toBeInstanceOf(MigrationError);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='changed'").get()).toBeUndefined();

    db.close();
  });

  it('enforces foreign keys and non-negative bytes', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate(migrations);

    expect(() => db.prepare(`INSERT INTO asset_files
      (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
      VALUES ('f1', 'missing', '${'a'.repeat(64)}', 0, 'original', 'objects/x', 'now')`).run())
      .toThrow();
    expect(() => db.prepare(`INSERT INTO upload_sessions
      (session_id, idempotency_scope, idempotency_key, request_fingerprint, library_id, filename, source_kind,
       total_bytes, expected_sha256, state, offset_bytes, expires_at, created_at, updated_at)
      VALUES ('s', 'd', 'key', '${'a'.repeat(64)}', 'l', 'x', 'upload', -1, '${'b'.repeat(64)}', 'created', 0, 'later', 'now', 'now')`).run())
      .toThrow();

    db.close();
  });

  it('requires a backup callback before applying migrations to a non-empty database', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_data (value TEXT)');
    let backupCalls = 0;
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backupCalls += 1; } });
    await repository.migrate();
    expect(backupCalls).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").get()).toEqual({ name: 'assets' });
    db.close();
  });

  it('refuses to migrate a non-empty database without a backup callback', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_data (value TEXT)');
    const repository = new SqliteRepository(db);
    await expect(repository.migrate()).rejects.toThrow('database backup is required');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").get()).toBeUndefined();
    db.close();
  });

  it('stores each external source path independently and only changes its availability index', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    const base = {
      nodeId: 'node-1', libraryId: 'library-1', kind: 'photo' as const, filename: 'same.jpg',
      byteSize: 3, sha256: 'a'.repeat(64), now: '2026-10-21T00:00:00.000Z'
    };
    repository.recordExternalFile({ ...base, locationId: 'location-a', fileId: 'file-a', assetId: 'asset-a', originalPath: '/photos/a.jpg', storageRef: 'external:a' });
    repository.recordExternalFile({ ...base, locationId: 'location-b', fileId: 'file-b', assetId: 'asset-b', originalPath: '/photos/b.jpg', storageRef: 'external:b' });

    expect(repository.listExternalLocations('node-1')).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS count FROM assets').get()).toEqual({ count: 2 });
    repository.setExternalAvailability('location-a', 'missing');
    expect(repository.listExternalLocations('node-1')).toEqual(expect.arrayContaining([
      { locationId: 'location-a', originalPath: '/photos/a.jpg', availability: 'missing' },
      { locationId: 'location-b', originalPath: '/photos/b.jpg', availability: 'online' }
    ]));
    expect(db.prepare('SELECT count(*) AS count FROM asset_files').get()).toEqual({ count: 2 });

    db.close();
  });

  it('creates a new immutable file record when an external path changes content', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    const common = { nodeId: 'n', libraryId: 'l', kind: 'photo' as const, filename: 'a.jpg', originalPath: '/photos/a.jpg', now: 'now', byteSize: 1 };
    repository.recordExternalFile({ ...common, locationId: 'l1', fileId: 'f1', assetId: 'a1', sha256: 'a'.repeat(64), storageRef: 'ext:1' });
    repository.recordExternalFile({ ...common, locationId: 'l2', fileId: 'f2', assetId: 'a2', sha256: 'b'.repeat(64), storageRef: 'ext:2' });
    expect(repository.listExternalLocations('n')).toEqual(expect.arrayContaining([
      { locationId: 'l1', originalPath: '/photos/a.jpg', availability: 'missing' },
      { locationId: 'l2', originalPath: '/photos/a.jpg', availability: 'online' }
    ]));
    expect(db.prepare('SELECT count(*) AS count FROM asset_files').get()).toEqual({ count: 2 });
    db.close();
  });

  it('rolls back SQL errors, rejects duplicate/out-of-order migrations, and rejects unknown applied migrations', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await expect(repository.migrate([{ id: '0001_broken', sql: 'CREATE TABLE partial (id TEXT); INVALID SQL;' }]))
      .rejects.toBeInstanceOf(MigrationError);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial'").get()).toBeUndefined();
    await expect(repository.migrate([
      { id: '0002_later', sql: 'CREATE TABLE later (id TEXT);' },
      { id: '0001_earlier', sql: 'CREATE TABLE earlier (id TEXT);' }
    ])).rejects.toThrow('strictly increasing');
    await expect(repository.migrate([
      { id: '0001_duplicate', sql: 'CREATE TABLE duplicate (id TEXT);' },
      { id: '0001_duplicate', sql: 'CREATE TABLE duplicate_again (id TEXT);' }
    ])).rejects.toThrow('duplicate migration id');
    db.exec("INSERT INTO schema_migrations VALUES ('0009_future', 'checksum', 'now')");
    await expect(repository.migrate([])).rejects.toThrow('unknown migration');
    db.close();
  });

  it('keeps chunk offset transactions atomic on a repository conflict', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    repository.createUploadSession({
      sessionId: 'session-2', idempotencyScope: 'device', idempotencyKey: '0123456789abcdef',
      requestFingerprint: 'a'.repeat(64), libraryId: 'library', filename: 'file.jpg', sourceKind: 'upload',
      sourcePath: null, sourceNodeId: null, kind: 'photo', totalBytes: 3, expectedSha256: 'b'.repeat(64),
      expiresAt: '2026-10-22T00:00:00Z', finalStorageRef: 'objects/session-2/original.blob', now: '2026-10-21T00:00:00Z'
    });
    expect(() => repository.recordChunk({
      sessionId: 'session-2', chunkIndex: 0, byteLength: 3, sha256: 'c'.repeat(64),
      stagingRef: 'staging/session-2/chunk-0.bin', acceptedOffset: 0, createdAt: '2026-10-21T00:00:00Z'
    }, 2, '2026-10-21T00:00:00Z')).toThrow(RepositoryConflictError);
    expect(repository.getUploadSession('session-2')?.offset).toBe(0);
    expect(repository.getUploadChunks('session-2')).toHaveLength(0);
    db.close();
  });
});
