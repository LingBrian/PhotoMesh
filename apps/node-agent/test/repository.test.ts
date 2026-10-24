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

  it('migrates local media-version records with immutable output and idempotency constraints', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    db.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('asset-1', 'library-1', 'node-1', 'photo', '2026-10-24T00:00:00.000Z');
    db.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('file-1', 'asset-1', 'a'.repeat(64), 5, 'original', 'objects/asset-1/original.blob', '2026-10-24T00:00:00.000Z');
    db.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path, source_kind,
      source_node_id, path_ref, storage_class, availability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('location-1', 'file-1', 'node-1', 'source.jpg', null, 'upload', null,
        'objects/asset-1/original.blob', 'managed', 'online', '2026-10-24T00:00:00.000Z');

    const insert = db.prepare(`INSERT INTO media_versions (
      version_id, asset_id, library_id, source_version_id, source_sha256, transform_json, idempotency_scope,
      idempotency_key, request_fingerprint, status, storage_ref, output_sha256, mime_type, byte_size, width, height,
      error_code, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const staging = [
      'version-1', 'asset-1', 'library-1', null, 'a'.repeat(64),
      JSON.stringify({ crop: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 }, rotation: 90 }),
      'local-admin', '0123456789abcdef', 'b'.repeat(64), 'staging', 'derived/version-1/output.jpg',
      null, null, null, null, null, null, 'local-admin', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'
    ] as const;
    insert.run(...staging);
    expect(repository.getMediaVersionSource('library-1', 'asset-1', null)).toMatchObject({
      assetId: 'asset-1', sourceVersionId: null, sha256: 'a'.repeat(64), availability: 'online', mimeType: null
    });
    expect(repository.listStagingMediaVersions().map((version) => version.versionId)).toEqual(['version-1']);
    expect(repository.getMediaVersionByIdempotency('library-1', 'local-admin', '0123456789abcdef')?.versionId).toBe('version-1');
    expect(repository.getMediaVersionSource('library-1', 'asset-1', 'version-1')).toBeUndefined();
    expect(repository.markMediaVersionReady('version-1', {
      sha256: 'f'.repeat(64), mimeType: 'image/jpeg', byteSize: 12, width: 8, height: 4
    }, '2026-10-24T00:00:01.000Z')).toBe(true);
    expect(repository.markMediaVersionReady('version-1', {
      sha256: 'f'.repeat(64), mimeType: 'image/jpeg', byteSize: 12, width: 8, height: 4
    }, '2026-10-24T00:00:02.000Z')).toBe(false);
    expect(repository.getMediaVersion('library-1', 'asset-1', 'version-1')).toMatchObject({
      status: 'ready', outputSha256: 'f'.repeat(64), width: 8, height: 4
    });
    expect(repository.getMediaVersionSource('library-1', 'asset-1', 'version-1')).toMatchObject({
      sourceVersionId: 'version-1', sha256: 'f'.repeat(64), storageRef: 'derived/version-1/output.jpg',
      availability: 'online', mimeType: 'image/jpeg'
    });
    expect(repository.listStagingMediaVersions()).toHaveLength(0);
    expect(repository.listMediaVersions('library-1', 'asset-1')).toHaveLength(1);
    expect(() => db.prepare('UPDATE media_versions SET source_sha256 = ? WHERE version_id = ?').run('e'.repeat(64), 'version-1')).toThrow();
    expect(() => db.prepare('UPDATE media_versions SET output_sha256 = ? WHERE version_id = ?').run('e'.repeat(64), 'version-1')).toThrow();
    expect(() => db.prepare('DELETE FROM media_versions WHERE version_id = ?').run('version-1')).toThrow();
    expect(() => insert.run(
      'version-child', 'asset-1', 'library-1', 'version-1', 'e'.repeat(64), JSON.stringify({}), 'local-admin',
      'child-key-0123456789', 'f'.repeat(64), 'staging', 'derived/version-child/output.jpg', null, null, null, null, null,
      null, 'local-admin', 'now', 'now'
    )).toThrow();
    expect(db.prepare('SELECT status, output_sha256 FROM media_versions WHERE version_id = ?').get('version-1'))
      .toEqual({ status: 'ready', output_sha256: 'f'.repeat(64) });
    const duplicateKey = [...staging];
    duplicateKey[0] = 'version-duplicate';
    duplicateKey[10] = 'derived/version-duplicate/output.jpg';
    expect(() => insert.run(...duplicateKey)).toThrow();
    expect(() => insert.run(
      'version-2', 'asset-1', 'library-1', null, 'bad', JSON.stringify({}), 'local-admin', '0123456789abcdef',
      'c'.repeat(64), 'staging', 'derived/version-2/output.jpg', null, null, null, null, null, null,
      'local-admin', 'now', 'now'
    )).toThrow();
    expect(() => insert.run(
      'version-3', 'asset-1', 'library-1', null, 'a'.repeat(64), JSON.stringify({}), 'local-admin', 'fedcba9876543210',
      'd'.repeat(64), 'ready', 'derived/version-3/output.jpg', null, null, null, null, null, null,
      'local-admin', 'now', 'now'
    )).toThrow();
    expect(db.prepare('SELECT sha256, byte_size, storage_ref FROM asset_files WHERE file_id = ?').get('file-1'))
      .toEqual({ sha256: 'a'.repeat(64), byte_size: 5, storage_ref: 'objects/asset-1/original.blob' });
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
