import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { makeUnsignedEvent, MAX_ALBUM_OBSERVED_IDS } from '../src/sync/event-envelope.js';
import { SqliteRepository } from '../src/db/repository.js';

const now = '2026-10-28T00:00:00.000Z';
const peerId = '12D3KooWPM045LocalAuthor';
const authorId = '12D3KooWPM045RemoteAuthor';

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

function fingerprint(number: number): string {
  return number.toString(16).padStart(64, '0');
}

function insertMetadataEvent(db: Database.Database, eventId: string, sequence = 1): void {
  db.prepare(`INSERT INTO sync_event_log
    (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
     causal_parents_json, payload_json, created_at, signature, envelope_json, state)
    VALUES (?, 'family', ?, ?, 1, 1, 'asset.indexed', '[]', '{}', ?, 'signature', '{}', 'ready')`)
    .run(eventId, authorId, sequence, now);
}

function insertTagEvent(db: Database.Database, eventId: string, sequence = 1): void {
  db.prepare(`INSERT INTO tag_sync_event_log
    (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
     causal_parents_json, payload_json, created_at, signature, envelope_json, state)
    VALUES (?, 'family', ?, ?, 1, 1, 'asset.tag.added', '[]', '{}', ?, 'signature', '{}', 'ready')`)
    .run(eventId, authorId, sequence, now);
}

async function migrateTo0007(db: Database.Database): Promise<SqliteRepository> {
  const repository = new SqliteRepository(db);
  await repository.migrate(migrations.slice(0, 7));
  return repository;
}

async function migrateToLatest(db: Database.Database, backupBeforeMigration = vi.fn(async () => undefined)): Promise<SqliteRepository> {
  const repository = new SqliteRepository(db, { backupBeforeMigration });
  await repository.migrate();
  return repository;
}

function addAsset(db: Database.Database): void {
  db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, created_at)
    VALUES ('asset-1', 'family', ?, 'photo', ?)`)
    .run(peerId, now);
}

describe('PM-045 migration and global identifier registry', () => {
  it('preserves the isolated virtual album stream and event-ID registry after migrations through 0012', async () => {
    const db = new Database(':memory:');
    try {
      const repository = await migrateToLatest(db);
      const version = db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string };
      expect(version.migration_id).toBe('0012_gallery_filter_indexes');
      for (const table of [
        'sync_global_id_registry', 'library_album_write_grants', 'library_album_delete_grants',
        'album_sync_event_log', 'album_sync_inbox', 'album_sync_outbox', 'album_sync_author_heads',
        'album_sync_peer_cursors', 'album_lifecycle_operations', 'album_visibility_operations',
        'album_local_visibility', 'album_global_delete_tokens', 'album_global_restore_targets',
        'library_favorite_write_grants', 'favorite_sync_event_log', 'favorite_sync_inbox', 'favorite_sync_outbox',
        'favorite_sync_author_heads', 'favorite_sync_peer_cursors', 'favorite_operations', 'favorite_add_tokens',
        'favorite_remove_targets', 'asset_favorites', 'library_rating_write_grants', 'rating_sync_event_log',
        'rating_sync_inbox', 'rating_sync_outbox', 'rating_sync_author_heads', 'rating_sync_peer_cursors',
        'rating_sync_author_registry', 'rating_sync_conflicts', 'rating_operations', 'rating_values',
        'rating_observations', 'asset_rating_projection'
      ]) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table).toBeDefined();
      }
      expect(repository).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('backfills metadata, tag, effective album, and no-op operation IDs into one namespace', async () => {
    const db = new Database(':memory:');
    try {
      const repository = await migrateTo0007(db);
      addAsset(db);
      const album = repository.createAlbum({
        operationId: uuid(1), principalId: 'admin', authorPeerId: peerId, libraryId: 'family',
        requestFingerprint: fingerprint(1), createdAt: now, title: 'Travel'
      });
      if (!album || album === 'writer_limit') throw new Error('album setup failed');
      expect(repository.addAlbumMember({
        operationId: uuid(2), principalId: 'admin', authorPeerId: peerId, libraryId: 'family',
        requestFingerprint: fingerprint(2), createdAt: now, albumId: album.albumId, assetId: 'asset-1'
      }).status).toBe('added');
      expect(repository.addAlbumMember({
        operationId: uuid(3), principalId: 'admin', authorPeerId: peerId, libraryId: 'family',
        requestFingerprint: fingerprint(3), createdAt: now, albumId: album.albumId, assetId: 'asset-1'
      }).status).toBe('already_present');
      insertMetadataEvent(db, uuid(10));
      insertTagEvent(db, uuid(11));

      await migrateToLatest(db);
      const rows = db.prepare(`SELECT global_id, event_stream, operation_kind FROM sync_global_id_registry ORDER BY global_id`)
        .all() as Array<{ global_id: string; event_stream: string | null; operation_kind: string | null }>;
      const byId = new Map(rows.map((row) => [row.global_id, row]));
      expect(byId.get(uuid(1))).toMatchObject({ event_stream: 'virtual-albums-v1', operation_kind: 'album-operation' });
      expect(byId.get(uuid(2))).toMatchObject({ event_stream: 'virtual-albums-v1', operation_kind: 'album-operation' });
      expect(byId.get(uuid(3))).toMatchObject({ event_stream: null, operation_kind: 'album-operation' });
      expect(byId.get(uuid(10))).toMatchObject({ event_stream: 'asset-metadata-v1', operation_kind: null });
      expect(byId.get(uuid(11))).toMatchObject({ event_stream: 'asset-tags-v1', operation_kind: null });
    } finally {
      db.close();
    }
  });

  it('requires a backup before 0008 and leaves the populated 0007 database unchanged on backup failure', async () => {
    const db = new Database(':memory:');
    try {
      await migrateTo0007(db);
      insertMetadataEvent(db, uuid(19));
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { throw new Error('backup unavailable'); } });

      await expect(repository.migrate()).rejects.toThrow(/backup unavailable/);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_global_id_registry'").get()).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 7 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sync_event_log WHERE event_id = ?').get(uuid(19))).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('refuses an old 0007 binary after current migrations have been applied', async () => {
    const db = new Database(':memory:');
    try {
      await migrateToLatest(db);
      const oldBinary = new SqliteRepository(db);
      await expect(oldBinary.migrate(migrations.slice(0, 7))).rejects.toThrow(/unknown migration 0008_virtual_album_sync/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 12 });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'album_sync_event_log'").get()).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('fails closed on populated-0007 cross-stream UUID collision without applying 0008', async () => {
    const db = new Database(':memory:');
    try {
      await migrateTo0007(db);
      insertMetadataEvent(db, uuid(20));
      insertTagEvent(db, uuid(20));
      const backup = vi.fn(async () => undefined);
      const repository = new SqliteRepository(db, { backupBeforeMigration: backup });

      await expect(repository.migrate()).rejects.toThrow(new RegExp('failed applying migration 0008_virtual_album_sync'));
      expect(backup).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_global_id_registry'").get()).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 7 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sync_event_log WHERE event_id = ?').get(uuid(20))).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM tag_sync_event_log WHERE event_id = ?').get(uuid(20))).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects new cross-stream event-ID collisions after migration', async () => {
    const db = new Database(':memory:');
    try {
      await migrateToLatest(db);
      insertMetadataEvent(db, uuid(30));
      expect(() => insertTagEvent(db, uuid(30))).toThrow(/global event ID/i);
      expect(db.prepare('SELECT event_stream FROM sync_global_id_registry WHERE global_id = ?').get(uuid(30)))
        .toEqual({ event_stream: 'asset-metadata-v1' });
    } finally {
      db.close();
    }
  });

  it('validates album envelopes and accepts all approved observed-ID bounds', () => {
    const ids = Array.from({ length: MAX_ALBUM_OBSERVED_IDS }, (_, index) => uuid(100 + index));
    const base = {
      libraryId: 'family', authorPeerId: peerId, authorSequence: 1, createdAt: now
    };
    expect(() => makeUnsignedEvent({
      ...base, eventId: uuid(50), causalParents: [], eventType: 'album.created',
      payload: { albumId: uuid(51), title: 'Travel', createdAt: now }
    })).not.toThrow();
    expect(() => makeUnsignedEvent({
      ...base, eventId: uuid(52), causalParents: ids, eventType: 'album.member.removed',
      payload: { albumId: uuid(51), assetId: 'asset-1', observedAddEventIds: ids }
    })).not.toThrow();
    expect(() => makeUnsignedEvent({
      ...base, eventId: uuid(53), causalParents: ids, eventType: 'album.restored',
      payload: { albumId: uuid(51), observedDeleteEventIds: ids }
    })).not.toThrow();
    expect(() => makeUnsignedEvent({
      ...base, eventId: uuid(54), causalParents: ids.slice(0, MAX_ALBUM_OBSERVED_IDS - 1), eventType: 'album.member.removed',
      payload: { albumId: uuid(51), assetId: 'asset-1', observedAddEventIds: [...ids, uuid(200)] }
    })).toThrow(/album observed-event payload/);
  });
});
