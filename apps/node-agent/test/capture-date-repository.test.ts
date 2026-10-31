import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';

const legacyTime = '2020-04-05T06:07:08.000Z';

describe('PM-053 capture date migration', () => {
  it('appends 0014, preserves prior checksums and capture values, and marks legacy provenance unknown', async () => {
    expect(migrations.slice(-2).map(({ id }) => id)).toEqual([
      '0013_metadata_audit_events', '0014_capture_date_provenance'
    ]);
    const db = new Database(':memory:');
    try {
      const priorRepository = new SqliteRepository(db);
      await priorRepository.migrate(migrations.slice(0, -1));
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,capture_ts,created_at)
        VALUES('legacy-asset','family','node-a','photo',?,'2026-10-01T00:00:00.000Z')`).run(legacyTime);
      const previousChecksums = db.prepare('SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id').all();
      let backups = 0;
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backups += 1; } });
      await repository.migrate(migrations);
      expect(backups).toBe(1);
      expect(db.prepare('SELECT migration_id,checksum FROM schema_migrations WHERE migration_id<>? ORDER BY migration_id')
        .all('0014_capture_date_provenance')).toEqual(previousChecksums);
      expect(db.prepare(`SELECT capture_ts,capture_local_time,capture_offset_minutes,capture_source,capture_confidence
        FROM assets WHERE asset_id='legacy-asset'`).get()).toEqual({
        capture_ts: legacyTime, capture_local_time: null, capture_offset_minutes: null,
        capture_source: 'legacy_unknown', capture_confidence: 'unknown'
      });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='assets_library_capture_local_idx'").get())
        .toEqual({ name: 'assets_library_capture_local_idx' });
    } finally {
      db.close();
    }
  });

  it('does not apply 0014 when the pre-migration backup fails', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations.slice(0, -1));
      const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { throw new Error('backup unavailable'); } });
      await expect(repository.migrate(migrations)).rejects.toThrow(/backup unavailable/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 13 });
      expect(db.prepare("SELECT 1 FROM pragma_table_info('assets') WHERE name='capture_source'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
