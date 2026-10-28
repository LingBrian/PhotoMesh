import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { createNodeAgentServer } from '../src/server.js';

const migrationIds = [
  '0001_upload_foundation', '0002_lan_pairing', '0003_sync_event_log',
  '0004_media_versions', '0005_asset_tags', '0006_asset_tag_sync', '0007_virtual_albums', '0008_virtual_album_sync', '0009_asset_favorites'
];

function seedLocalAsset(db: Database.Database, libraryId: string, assetId: string): void {
  db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
    VALUES (?, ?, 'node-local', 'photo', NULL, '2026-10-27T00:00:00.000Z')`).run(assetId, libraryId);
}

function seedProjectedAsset(db: Database.Database, libraryId: string, assetId: string): void {
  db.prepare(`INSERT INTO sync_event_log (event_id, library_id, author_peer_id, author_sequence, protocol_version,
    schema_version, event_type, causal_parents_json, payload_json, created_at, signature, envelope_json, state)
    VALUES (?, ?, 'peer-origin', 1, 1, 1, 'asset.indexed', '[]', '{}', '2026-10-27T00:00:00.000Z', 'sig', '{}', 'ready')`)
    .run(`event-${assetId}`, libraryId);
  db.prepare(`INSERT INTO sync_asset_projection
    (library_id, asset_id, origin_node_id, kind, sha256, byte_length, metadata_json, tombstone_event_id, restored_by_event_id, last_event_id)
    VALUES (?, ?, 'peer-origin', 'photo', ?, 4, ?, NULL, NULL, ?)`)
    .run(libraryId, assetId, 'a'.repeat(64), JSON.stringify({ filename: `${assetId}.jpg`, sourceKind: 'import' }), `event-${assetId}`);
}

describe('server-persisted asset tags', () => {
  it('adds an append-only migration without changing earlier checksums and backs up before upgrade', async () => {
    expect(migrations.map(({ id }) => id)).toEqual(migrationIds);
    const db = new Database(':memory:');
    let backupCalls = 0;
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backupCalls += 1; } });

    await repository.migrate(migrations.slice(0, 4));
    const priorChecksums = db.prepare('SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id').all();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_tags'").get()).toBeUndefined();

    await repository.migrate(migrations);
    expect(backupCalls).toBe(1);
    expect(db.prepare(`SELECT migration_id, checksum FROM schema_migrations
      WHERE migration_id NOT IN ('0005_asset_tags', '0006_asset_tag_sync', '0007_virtual_albums', '0008_virtual_album_sync', '0009_asset_favorites') ORDER BY migration_id`).all())
      .toEqual(priorChecksums);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_tags'").get()).toEqual({ name: 'asset_tags' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'asset_tags_insert_guard'").get())
      .toEqual({ name: 'asset_tags_insert_guard' });
    db.close();
  });

  it('does not apply the new migration when a pre-migration backup fails', async () => {
    const db = new Database(':memory:');
    let backupCalls = 0;
    const repository = new SqliteRepository(db, {
      backupBeforeMigration: async () => { backupCalls += 1; throw new Error('backup failed'); }
    });
    await repository.migrate(migrations.slice(0, 4));
    await expect(repository.migrate(migrations)).rejects.toThrow('backup failed');
    expect(backupCalls).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_tags'").get()).toBeUndefined();
    expect(db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id').all())
      .toEqual(migrationIds.slice(0, 4).map((migration_id) => ({ migration_id })));
    db.close();
  });

  it('supports idempotent add/remove on local and projected assets while hiding tombstones', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db, 'library-a', 'local-asset');
    seedProjectedAsset(db, 'library-a', 'remote-asset');
    expect(() => db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('other-library', 'local-asset', 'Cross-library', '2026-10-27T00:00:00.000Z')).toThrow();

    expect(repository.addAssetTag('library-a', 'local-asset', 'Summer', '2026-10-27T01:00:00.000Z')).toBe('added');
    expect(repository.addAssetTag('library-a', 'local-asset', 'Summer', '2026-10-27T02:00:00.000Z')).toBe('already_present');
    expect(repository.addAssetTag('library-a', 'remote-asset', 'Summer', '2026-10-27T03:00:00.000Z')).toBe('added');
    expect(repository.addAssetTag('other-library', 'local-asset', 'Private', '2026-10-27T04:00:00.000Z')).toBe('not_found');

    const page = repository.listGalleryAssets('library-a', undefined, 10);
    expect(page.items.find(({ assetId }) => assetId === 'local-asset')?.tags).toEqual(['Summer']);
    expect(page.items.find(({ assetId }) => assetId === 'remote-asset')?.tags).toEqual(['Summer']);
    expect(page.items.every(({ tags }) => Array.isArray(tags))).toBe(true);

    expect(repository.removeAssetTag('library-a', 'local-asset', 'Summer')).toBe('removed');
    expect(repository.removeAssetTag('library-a', 'local-asset', 'Summer')).toBe('unchanged');
    expect(repository.listGalleryAssets('library-a', undefined, 10).items.find(({ assetId }) => assetId === 'local-asset')?.tags)
      .toEqual([]);

    db.prepare('UPDATE sync_asset_projection SET tombstone_event_id = ? WHERE library_id = ? AND asset_id = ?')
      .run('tombstone-1', 'library-a', 'remote-asset');
    expect(repository.addAssetTag('library-a', 'remote-asset', 'Hidden', '2026-10-27T05:00:00.000Z')).toBe('not_found');
    expect(() => db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('library-a', 'remote-asset', 'Blocked by tombstone', '2026-10-27T05:00:00.000Z')).toThrow();
    expect(db.prepare('SELECT tag FROM asset_tags WHERE library_id = ? AND asset_id = ?').all('library-a', 'remote-asset'))
      .toEqual([{ tag: 'Summer' }]);
    expect(repository.listGalleryAssets('library-a', undefined, 10).items.some(({ assetId }) => assetId === 'remote-asset')).toBe(false);
    db.close();
  });

  it('enforces tag count and byte limits in repository storage', async () => {
    const db = new Database(':memory:');
    const repository = new SqliteRepository(db);
    await repository.migrate();
    seedLocalAsset(db, 'library-a', 'asset-a');
    for (let index = 0; index < 64; index += 1) {
      expect(repository.addAssetTag('library-a', 'asset-a', `tag-${index}`, '2026-10-27T00:00:00.000Z')).toBe('added');
    }
    expect(repository.addAssetTag('library-a', 'asset-a', 'overflow', '2026-10-27T00:00:00.000Z')).toBe('limit_reached');
    expect(repository.addAssetTag('library-a', 'asset-a', 'tag-0', '2026-10-27T00:00:00.000Z')).toBe('already_present');
    expect(() => db.prepare(`INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)`)
      .run('library-a', 'asset-a', 'x'.repeat(129), 'now')).toThrow();
    expect(() => db.prepare('INSERT INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)')
      .run('library-a', 'missing', 'orphan', 'now')).toThrow();
    db.close();
  });

  it('retains tags after closing and reopening the SQLite database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photomesh-tags-'));
    const databasePath = path.join(directory, 'tags.sqlite');
    try {
      const firstDatabase = new Database(databasePath);
      try {
        const firstRepository = new SqliteRepository(firstDatabase);
        await firstRepository.migrate();
        seedLocalAsset(firstDatabase, 'library-a', 'asset-a');
        expect(firstRepository.addAssetTag('library-a', 'asset-a', 'Keepsake', '2026-10-27T00:00:00.000Z')).toBe('added');
      } finally {
        firstDatabase.close();
      }

      const reopenedDatabase = new Database(databasePath);
      try {
        const reopenedRepository = new SqliteRepository(reopenedDatabase);
        await reopenedRepository.migrate();
        expect(reopenedRepository.listGalleryAssets('library-a', undefined, 10).items[0]?.tags).toEqual(['Keepsake']);
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('protects tag mutations with authorization and validates idempotent state transitions', async () => {
    const tags = new Set<string>();
    let visible = true;
    const server = createNodeAgentServer({
      authorizeLibraryRead: (token, libraryId) => token === 'admin' && libraryId === 'library-a' ? 'local-admin' : undefined,
      assetTags: {
        addAssetTag: (_libraryId, _assetId, tag) => {
          if (!visible) return 'not_found';
          if (tag === 'limit') return 'limit_reached';
          if (tags.has(tag)) return 'already_present';
          tags.add(tag);
          return 'added';
        },
        removeAssetTag: (_libraryId, _assetId, tag) => {
          if (!visible) return 'not_found';
          return tags.delete(tag) ? 'removed' : 'unchanged';
        }
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP address');
    const send = (method: 'PUT' | 'DELETE', tag: string, authorized = true, requestId = 'tag-api-test') => fetch(
      `http://127.0.0.1:${address.port}/v1/libraries/library-a/assets/asset-a/tags/${tag}`,
      { method, headers: { 'x-request-id': requestId, ...(authorized ? { authorization: 'Bearer admin' } : {}) } }
    );
    try {
      const denied = await send('PUT', 'denied', false, 'tag-api-denied');
      expect(denied.status).toBe(403);
      expect(denied.headers.get('x-request-id')).toBe('tag-api-denied');
      expect(await denied.json()).toMatchObject({ error: 'forbidden', requestId: 'tag-api-denied' });

      expect((await send('PUT', '%20%20')).status).toBe(400);
      expect((await send('PUT', 'limit')).status).toBe(400);
      expect((await send('PUT', '%ZZ')).status).toBe(400);
      expect((await send('PUT', 'Summer')).status).toBe(204);
      expect((await send('PUT', 'Summer')).status).toBe(204);
      expect((await send('DELETE', 'Summer')).status).toBe(204);
      expect((await send('DELETE', 'Summer')).status).toBe(204);
      visible = false;
      expect((await send('PUT', 'Hidden')).status).toBe(404);
      expect((await send('DELETE', 'Hidden')).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('returns capability unavailable when the authorized tag service is absent', async () => {
    const server = createNodeAgentServer({ authorizeLibraryRead: () => 'local-admin' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/libraries/library-a/assets/asset-a/tags/Summer`, {
        method: 'PUT', headers: { 'x-request-id': 'tag-api-unavailable', authorization: 'Bearer admin' }
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('x-request-id')).toBe('tag-api-unavailable');
      expect(await response.json()).toMatchObject({ error: 'capability_unavailable', requestId: 'tag-api-unavailable' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
