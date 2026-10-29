import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { assertQuickCheckResults, MigrationError, RepositoryConflictError, SqliteRepository, verifySqliteIntegrity } from '../src/db/repository.js';
import { migrations } from '../src/db/migrations.js';
import { AlbumSyncRepository } from '../src/sync/album-sync-repository.js';
import { makeUnsignedEvent, type AlbumSyncEventType, type EventEnvelope, type JsonValue } from '../src/sync/event-envelope.js';

const albumNow = '2026-11-01T00:00:00.000Z';
const albumAuthor = '12D3KooWPM045LocalAuthor';
const albumRelay = '12D3KooWPM045RelayPeer';
const albumRemote = '12D3KooWPM045RemoteAuthor';
const albumUuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const testSignature = 'a'.repeat(86);

function lifecycleFactory(operationId: string) {
  return (input: { context: { authorSequence: number; causalParents: string[] }; libraryId: string; authorPeerId: string;
    eventType: string; payload: JsonValue; createdAt: string }) => makeUnsignedEvent({
      eventId: operationId, libraryId: input.libraryId, authorPeerId: input.authorPeerId,
      authorSequence: input.context.authorSequence, causalParents: input.context.causalParents,
      eventType: input.eventType as AlbumSyncEventType, payload: input.payload, createdAt: input.createdAt
    });
}

function albumContext(operationId: string, requestFingerprint = '1'.repeat(64), scope: 'local' | 'global' = 'local') {
  return { operationId, principalId: 'local-admin', authorPeerId: albumAuthor, libraryId: 'family',
    requestFingerprint, createdAt: albumNow, scope } as const;
}

async function setupAlbumLifecycle() {
  const db = new Database(':memory:');
  const repository = new SqliteRepository(db);
  await repository.migrate(migrations);
  db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at)
    VALUES('asset-for-albums','family',?,'photo',?)`).run(albumAuthor, albumNow);
  const albumSync = new AlbumSyncRepository(db, () => albumNow);
  repository.setAlbumOperationEventDrafter((input) => {
    if (input.operationType !== 'album.created') return;
    albumSync.reserveLocalDraft({
      operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId, albumId: input.albumId,
      assetId: null, operationType: 'album.created', createdAt: input.createdAt,
      ...(input.title === undefined ? {} : { title: input.title }), draftFactory: lifecycleFactory(input.operationId)
    });
  });
  const created = repository.createAlbum({ ...albumContext(albumUuid(100)), title: 'Lifecycle album' });
  if (!created || created === 'writer_limit') throw new Error('album fixture create failed');
  const createDraft = albumSync.getUnsignedLocalDrafts(albumAuthor)[0]!;
  albumSync.completeLocalDraft({ ...createDraft, signature: testSignature });
  repository.setAlbumLifecycleEventDrafter((input) => albumSync.reserveLocalLifecycleDraft({
    ...input, draftFactory: lifecycleFactory(input.operationId)
  }));
  db.prepare(`INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at)
    VALUES(?, 'AQ==', ?, 'trusted', ?)`).run(albumRemote, albumRemote, albumNow);
  db.prepare(`INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at)
    VALUES(?, 'AQ==', ?, 'trusted', ?)`).run(albumRelay, albumRelay, albumNow);
  db.prepare(`INSERT INTO sync_remote_library_grants(peer_id,library_id,observed_at) VALUES(?, 'family', ?)`)
    .run(albumRelay, albumNow);
  albumSync.setAlbumDeleteGrant('family', albumRemote, albumNow);
  return { db, repository, albumSync, album: created, createEventId: createDraft.eventId };
}

describe('SQLite repository and migrations', () => {
  it('fails closed on corrupt or ambiguous SQLite quick-check results without exposing details', () => {
    expect(() => assertQuickCheckResults([{ quick_check: 'database disk image is malformed at /private/data.sqlite' }]))
      .toThrow('database integrity check failed');
    expect(() => assertQuickCheckResults([])).toThrow('database integrity check failed');
    expect(() => assertQuickCheckResults([{ quick_check: 'ok' }, { quick_check: 'unexpected row' }]))
      .toThrow('database integrity check failed');
  });

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
    expect(repository.listGalleryAssets('library', undefined, 1, { q: 'Weekend' }).items.map((asset) => asset.filename)).toEqual(['Weekend.jpg']);
    expect(repository.listGalleryAssets('library', undefined, 5, { q: '%%%' }).items).toEqual([]);
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

  it('runs a SQLite quick check before and after migrations', async () => {
    const db = new Database(':memory:');
    expect(() => verifySqliteIntegrity(db)).not.toThrow();
    const repository = new SqliteRepository(db);
    expect(() => repository.verifyIntegrity()).not.toThrow();
    await repository.migrate();
    expect(() => repository.verifyIntegrity()).not.toThrow();
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
      expiresAt: '2026-10-28T00:00:00.000Z',
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
    const jobBeforeRestart = db.prepare("SELECT state, attempts, checkpoint_json FROM jobs WHERE job_id = 'session-1'").get() as {
      state: string; attempts: number; checkpoint_json: string;
    };
    expect(repository.recoverInterruptedJobs('2026-10-27T00:00:00.000Z')).toBe(1);
    expect(db.prepare("SELECT state, attempts, checkpoint_json, updated_at FROM jobs WHERE job_id = 'session-1'").get()).toEqual({
      ...jobBeforeRestart, state: 'queued', updated_at: '2026-10-27T00:00:00.000Z'
    });
    expect(repository.getUploadSession('session-1')?.state).toBe('uploading');
    expect(repository.recoverInterruptedJobs('2026-10-27T00:00:01.000Z')).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(
      expect.arrayContaining([
        { name: 'assets' }, { name: 'asset_files' }, { name: 'file_locations' },
        { name: 'jobs' }, { name: 'events' }, { name: 'upload_sessions' }, { name: 'upload_chunks' }
      ])
    );

    db.close();
  });

  it('upgrades a populated 0006 database additively and refuses backupless or old-binary downgrade', async () => {
    const db = new Database(':memory:');
    const beforeAlbums = migrations.slice(0, 6);
    const beforeTagSync = migrations.slice(0, 5);
    const oldRepository = new SqliteRepository(db);
    await oldRepository.migrate(beforeTagSync);
    db.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('local-asset', 'family', 'node-local', 'photo', '2026-10-28T00:00:00.000Z');
    db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('family', 'local-asset', 'legacy', '2026-10-28T00:00:00.000Z');
    db.prepare(`INSERT INTO sync_event_log (event_id, library_id, author_peer_id, author_sequence, protocol_version,
      schema_version, event_type, causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES ('00000000-0000-4000-8000-000000000001', 'family', 'remote-node', 1, 1, 1, 'asset.indexed', '[]', '{}', ?, 'sig', '{}', 'ready')`)
      .run('2026-10-28T00:00:00.000Z');
    db.prepare(`INSERT INTO sync_asset_projection (library_id, asset_id, origin_node_id, kind, sha256, byte_length,
      metadata_json, tombstone_event_id, restored_by_event_id, last_event_id)
      VALUES ('family', 'projected-asset', 'remote-node', 'photo', ?, 4, '{}', NULL, NULL, '00000000-0000-4000-8000-000000000001')`)
      .run('a'.repeat(64));
    const addingTagSync = new SqliteRepository(db, { backupBeforeMigration: async () => undefined });
    await addingTagSync.migrate(beforeAlbums);
    const checksumsBefore = db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all();
    const tagCountBefore = db.prepare('SELECT count(*) AS count FROM asset_tags').get();
    const legacySeedsBefore = db.prepare('SELECT * FROM asset_tag_legacy_seeds ORDER BY library_id, asset_id, tag').all();
    const projectionCountBefore = db.prepare('SELECT count(*) AS count FROM sync_asset_projection').get();

    const backupless = new SqliteRepository(db);
    await expect(backupless.migrate(migrations)).rejects.toThrow('database backup is required');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='albums'").get()).toBeUndefined();
    expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id').all())
      .toEqual(checksumsBefore.map((row) => ({ migration_id: (row as { migration_id: string }).migration_id })));
    expect(db.prepare('SELECT count(*) AS count FROM asset_tags').get()).toEqual(tagCountBefore);
    expect(db.prepare('SELECT * FROM asset_tag_legacy_seeds ORDER BY library_id, asset_id, tag').all()).toEqual(legacySeedsBefore);
    expect(db.prepare('SELECT count(*) AS count FROM sync_asset_projection').get()).toEqual(projectionCountBefore);

    let backups = 0;
    const migrating = new SqliteRepository(db, { backupBeforeMigration: async () => { backups += 1; } });
    await migrating.migrate(migrations);
    expect(backups).toBe(1);
    expect(db.prepare('SELECT migration_id, checksum FROM schema_migrations WHERE migration_id < ? ORDER BY migration_id').all('0007_virtual_albums'))
      .toEqual(checksumsBefore);
    expect(db.prepare('SELECT count(*) AS count FROM asset_tags').get()).toEqual(tagCountBefore);
    expect(db.prepare('SELECT * FROM asset_tag_legacy_seeds ORDER BY library_id, asset_id, tag').all()).toEqual(legacySeedsBefore);
    expect(db.prepare('SELECT count(*) AS count FROM sync_asset_projection').get()).toEqual(projectionCountBefore);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='albums'").get()).toEqual({ name: 'albums' });
    await expect(new SqliteRepository(db).migrate(beforeAlbums)).rejects.toThrow('unknown migration');
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

  it('marks expired upload jobs failed instead of requeueing unusable sessions', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    repository.createUploadSession({
      sessionId: 'expired-session', idempotencyScope: 'device', idempotencyKey: 'expired-key-012345',
      requestFingerprint: 'a'.repeat(64), libraryId: 'library', filename: 'expired.jpg', sourceKind: 'upload',
      sourcePath: null, sourceNodeId: null, kind: 'photo', totalBytes: 1, expectedSha256: 'b'.repeat(64),
      expiresAt: '2026-10-20T00:00:00.000Z', finalStorageRef: 'objects/expired-session/original.blob',
      now: '2026-10-19T00:00:00.000Z'
    });

    expect(repository.recoverInterruptedJobs('2026-10-21T00:00:00.000Z')).toBe(1);
    expect(repository.getUploadSession('expired-session')?.state).toBe('failed');
    expect(db.prepare("SELECT state FROM jobs WHERE job_id = 'expired-session'").get()).toEqual({ state: 'failed' });
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
    expect(repository.countStagingMediaVersions()).toBe(1);
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
    expect(repository.countStagingMediaVersions()).toBe(0);
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

  it('hides and restores an album locally without creating album-sync events', async () => {
    const { db, repository, album, albumSync } = await setupAlbumLifecycle();
    const eventCount = db.prepare('SELECT COUNT(*) AS n FROM album_sync_event_log').get();
    const context = { ...albumContext(albumUuid(101)), albumId: album.albumId, scope: 'local' as const };
    expect(repository.deleteAlbum(context)).toBe('deleted');
    expect(repository.deleteAlbum(context)).toBe('deleted');
    expect(repository.listAlbums('family', undefined, 10)?.items).toEqual([]);
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_sync_event_log').get()).toEqual(eventCount);
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_visibility_operations').get()).toEqual({ n: 1 });
    expect(repository.restoreAlbum({ ...albumContext(albumUuid(102)), albumId: album.albumId, scope: 'local' })).toBe('restored');
    expect(repository.restoreAlbum({ ...albumContext(albumUuid(103)), albumId: album.albumId, scope: 'local' })).toBe('already_active');
    expect(repository.listAlbums('family', undefined, 10)?.items).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_sync_event_log').get()).toEqual(eventCount);
    expect(albumSync.eventsMissingForPeer(albumRelay, [])).toEqual([]);
    db.close();
  });

  it('records global delete/restore drafts with concurrent observed tokens and idempotency', async () => {
    const { db, repository, album, albumSync, createEventId } = await setupAlbumLifecycle();
    const deletedContext = { ...albumContext(albumUuid(111), '2'.repeat(64), 'global'), albumId: album.albumId };
    expect(repository.deleteAlbum(deletedContext)).toBe('deleted');
    const deleteDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((event) => event.eventId === deletedContext.operationId)!;
    expect(deleteDraft).toMatchObject({ eventType: 'album.deleted', causalParents: [createEventId], payload: { albumId: album.albumId } });
    albumSync.completeLocalDraft({ ...deleteDraft, signature: testSignature });
    expect(repository.deleteAlbum(deletedContext)).toBe('deleted');
    expect(() => repository.deleteAlbum({ ...deletedContext, requestFingerprint: '3'.repeat(64) })).toThrow(RepositoryConflictError);
    expect(() => repository.deleteAlbum({ ...deletedContext, scope: 'local' })).toThrow(RepositoryConflictError);

    const remoteDeleteId = albumUuid(112);
    const remoteDelete = { ...makeUnsignedEvent({ eventId: remoteDeleteId, libraryId: 'family', authorPeerId: albumRemote,
      authorSequence: 1, causalParents: [createEventId], eventType: 'album.deleted',
      payload: { albumId: album.albumId }, createdAt: albumNow }), signature: testSignature } satisfies EventEnvelope;
    expect(albumSync.ingest(albumRelay, remoteDelete).status).toBe('applied');
    const expectedDeleteIds = [deletedContext.operationId, remoteDeleteId].sort();
    const restoredContext = { ...albumContext(albumUuid(113), '4'.repeat(64), 'global'), albumId: album.albumId };
    expect(repository.restoreAlbum(restoredContext)).toBe('restored');
    const restoreDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((event) => event.eventId === restoredContext.operationId)!;
    expect(restoreDraft).toMatchObject({ eventType: 'album.restored', causalParents: expectedDeleteIds,
      payload: { albumId: album.albumId, observedDeleteEventIds: expectedDeleteIds } });
    albumSync.completeLocalDraft({ ...restoreDraft, signature: testSignature });
    expect(repository.restoreAlbum(restoredContext)).toBe('restored');
    expect(repository.listDeletedAlbums('family', 'global', undefined, 10)?.items).toEqual([]);
    expect(repository.listAlbums('family', undefined, 10)?.items).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_global_restore_targets WHERE restore_operation_id=?').get(restoredContext.operationId))
      .toEqual({ n: 2 });
    expect(() => repository.restoreAlbum({ ...restoredContext, scope: 'local' })).toThrow(RepositoryConflictError);
    db.close();
  });

  it('lists deletion scopes once and binds deleted-album cursors to the query scope', async () => {
    const { db, repository, album, albumSync } = await setupAlbumLifecycle();
    const otherIds = [albumUuid(120), albumUuid(121)];
    for (const [index, albumId] of otherIds.entries()) {
      db.prepare(`INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,'family',?,?,?)`)
        .run(albumId, `Other ${index}`, albumAuthor, albumNow);
    }
    expect(repository.deleteAlbum({ ...albumContext(albumUuid(122)), albumId: album.albumId, scope: 'local' })).toBe('deleted');
    expect(repository.deleteAlbum({ ...albumContext(albumUuid(123), '5'.repeat(64), 'global'), albumId: album.albumId, scope: 'global' })).toBe('deleted');
    expect(repository.deleteAlbum({ ...albumContext(albumUuid(124)), albumId: otherIds[0]!, scope: 'local' })).toBe('deleted');
    expect(repository.deleteAlbum({ ...albumContext(albumUuid(125)), albumId: otherIds[1]!, scope: 'local' })).toBe('deleted');

    const first = repository.listDeletedAlbums('family', 'all', undefined, 1)!;
    const allItems = [...first.items];
    expect(() => repository.listDeletedAlbums('family', 'global', first.nextCursor!, 1)).toThrow();
    let cursor = first.nextCursor;
    while (cursor) {
      const page = repository.listDeletedAlbums('family', 'all', cursor, 1)!;
      allItems.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(allItems.map((item) => item.albumId)).toEqual([...allItems.map((item) => item.albumId)].sort());
    expect(new Set(allItems.map((item) => item.albumId)).size).toBe(3);
    expect(allItems.find((item) => item.albumId === album.albumId)?.scopes).toEqual(['local', 'global']);
    expect(repository.listDeletedAlbums('family', 'local', undefined, 10)?.items).toHaveLength(3);
    expect(repository.listDeletedAlbums('family', 'global', undefined, 10)?.items).toHaveLength(1);
    expect(repository.listAlbums('family', undefined, 10)?.items).toEqual([]);
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)).toBeUndefined();
    expect(repository.listAlbumMembers('family', otherIds[0]!, undefined, 10)).toBeUndefined();

    expect(repository.restoreAlbum({ ...albumContext(albumUuid(126)), albumId: album.albumId, scope: 'local' })).toBe('restored');
    expect(repository.listAlbums('family', undefined, 10)?.items).toEqual([]);
    expect(repository.listDeletedAlbums('family', 'global', undefined, 10)?.items.map((item) => item.albumId)).toEqual([album.albumId]);
    const globalDeleteDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((draft) => draft.eventId === albumUuid(123))!;
    albumSync.completeLocalDraft({ ...globalDeleteDraft, signature: testSignature });
    expect(repository.restoreAlbum({ ...albumContext(albumUuid(127), 'c'.repeat(64), 'global'), albumId: album.albumId, scope: 'global' }))
      .toBe('restored');
    expect(repository.listAlbums('family', undefined, 10)?.items.map((item) => item.albumId)).toEqual([album.albumId]);
    expect(repository.listDeletedAlbums('family', 'local', undefined, 10)?.items.map((item) => item.albumId)).toEqual(otherIds);
    db.close();
  });

  it('restores all 64 active delete tokens as sorted causal parents', async () => {
    const { db, repository, album, albumSync, createEventId } = await setupAlbumLifecycle();
    const localDelete = { ...albumContext(albumUuid(140), 'a'.repeat(64), 'global'), albumId: album.albumId };
    expect(repository.deleteAlbum(localDelete)).toBe('deleted');
    const deleteDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((draft) => draft.eventId === localDelete.operationId)!;
    albumSync.completeLocalDraft({ ...deleteDraft, signature: testSignature });
    for (let index = 0; index < 63; index += 1) {
      const authorPeerId = `12D3KooWPM045Remote${index.toString().padStart(3, '0')}`;
      db.prepare(`INSERT INTO trusted_peers(peer_id,public_key,label,trust_state,created_at) VALUES(?, 'AQ==', ?, 'trusted', ?)`)
        .run(authorPeerId, authorPeerId, albumNow);
      albumSync.setAlbumDeleteGrant('family', authorPeerId, albumNow);
      const deleteEvent = { ...makeUnsignedEvent({ eventId: albumUuid(400 + index), libraryId: 'family', authorPeerId,
        authorSequence: 1, causalParents: [createEventId], eventType: 'album.deleted', payload: { albumId: album.albumId }, createdAt: albumNow }),
        signature: testSignature } satisfies EventEnvelope;
      expect(albumSync.ingest(albumRelay, deleteEvent).status).toBe('applied');
    }
    const activeIds = (db.prepare(`SELECT d.delete_event_id FROM album_global_delete_tokens d WHERE d.library_id='family' AND d.album_id=?
      AND NOT EXISTS (SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id=d.delete_event_id)
      ORDER BY d.delete_event_id COLLATE BINARY`).all(album.albumId) as Array<{ delete_event_id: string }>).map((row) => row.delete_event_id);
    expect(activeIds).toHaveLength(64);
    const restoreContext = { ...albumContext(albumUuid(141), 'b'.repeat(64), 'global'), albumId: album.albumId };
    expect(repository.restoreAlbum(restoreContext)).toBe('restored');
    const restoreDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((draft) => draft.eventId === restoreContext.operationId)!;
    expect(restoreDraft.eventType).toBe('album.restored');
    expect(restoreDraft.causalParents).toEqual(activeIds);
    expect(restoreDraft.causalParents).toHaveLength(64);
    expect(restoreDraft.causalParents).not.toContain(createEventId);
    db.close();
  });

  it('applies album-stream signing recovery rules to lifecycle drafts atomically', async () => {
    const { db, repository, album, albumSync } = await setupAlbumLifecycle();
    const deleteContext = { ...albumContext(albumUuid(128), 'd'.repeat(64), 'global'), albumId: album.albumId };
    expect(repository.deleteAlbum(deleteContext)).toBe('deleted');
    const restoreContext = { ...albumContext(albumUuid(129), 'e'.repeat(64), 'global'), albumId: album.albumId };
    expect(() => repository.restoreAlbum(restoreContext)).toThrow('earlier album draft requires signing recovery');
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_lifecycle_operations WHERE operation_id=?').get(restoreContext.operationId))
      .toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_global_restore_targets WHERE restore_operation_id=?').get(restoreContext.operationId))
      .toEqual({ n: 0 });
    const deleteDraft = albumSync.getUnsignedLocalDrafts(albumAuthor).find((draft) => draft.eventId === deleteContext.operationId)!;
    albumSync.completeLocalDraft({ ...deleteDraft, signature: testSignature });
    expect(repository.restoreAlbum(restoreContext)).toBe('restored');
    expect(albumSync.getUnsignedLocalDrafts(albumAuthor).some((draft) => draft.eventId === restoreContext.operationId)).toBe(true);
    db.close();
  });

  it('rolls back global state when lifecycle draft reservation throws', async () => {
    const { db, repository, album } = await setupAlbumLifecycle();
    repository.setAlbumLifecycleEventDrafter(() => { throw new Error('draft reservation failed'); });
    expect(() => repository.deleteAlbum({ ...albumContext(albumUuid(130), '6'.repeat(64), 'global'), albumId: album.albumId, scope: 'global' }))
      .toThrow('draft reservation failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_lifecycle_operations').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_global_delete_tokens').get()).toEqual({ n: 0 });
    expect(repository.listAlbums('family', undefined, 10)?.items).toHaveLength(1);
    expect(db.prepare('SELECT 1 FROM sync_global_id_registry WHERE global_id=?').get(albumUuid(130))).toBeUndefined();
    db.close();
  });

  it('returns writer_limit without mutation when global delete-token or author cap is reached', async () => {
    const { db, repository, album } = await setupAlbumLifecycle();
    const insertOperation = db.prepare(`INSERT INTO album_lifecycle_operations
      (operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,request_fingerprint,observed_delete_event_ids_json,result_json,created_at)
      VALUES(?, 'seed', ?, 'family', ?, 'album.deleted', ?, '[]', '{"status":"deleted"}', ?)`);
    const insertToken = db.prepare(`INSERT INTO album_global_delete_tokens(delete_event_id,library_id,album_id,author_peer_id,created_at)
      VALUES(?, 'family', ?, ?, ?)`);
    for (let index = 0; index < 65; index += 1) {
      const tokenId = albumUuid(200 + index);
      insertOperation.run(tokenId, albumAuthor, album.albumId, '7'.repeat(64), albumNow);
      insertToken.run(tokenId, album.albumId, albumAuthor, albumNow);
    }
    expect(repository.restoreAlbum({ ...albumContext(albumUuid(300), '8'.repeat(64), 'global'), albumId: album.albumId, scope: 'global' }))
      .toBe('writer_limit');
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_lifecycle_operations').get()).toEqual({ n: 65 });

    const secondAlbumId = albumUuid(301);
    db.prepare(`INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,'family','Author cap',?,?)`)
      .run(secondAlbumId, albumAuthor, albumNow);
    db.prepare(`INSERT INTO album_sync_author_registry(library_id,author_peer_id,first_seen_at)
      SELECT 'family', 'synthetic-author-' || value, ? FROM json_each(?)`)
      .run(albumNow, JSON.stringify(Array.from({ length: 63 }, (_, index) => index)));
    expect(repository.deleteAlbum({ ...albumContext(albumUuid(302), '9'.repeat(64), 'global'),
      authorPeerId: 'new-author-over-limit', albumId: secondAlbumId, scope: 'global' })).toBe('writer_limit');
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_lifecycle_operations WHERE album_id=?').get(secondAlbumId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM album_global_delete_tokens WHERE album_id=?').get(secondAlbumId)).toEqual({ n: 0 });
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
