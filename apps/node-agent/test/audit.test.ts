import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AuditRepository } from '../src/audit/audit-repository.js';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository, type AlbumOperationContext } from '../src/db/repository.js';

const now = '2026-10-30T00:00:00.000Z';

function auditId(kind: string, value: string): string {
  return createHash('sha256').update(`photomesh-metadata-audit-v1\0${kind}\0${value}`, 'utf8').digest('hex');
}

const row = {
  action: 'asset.tag.add' as const,
  resourceType: 'asset' as const,
  libraryId: 'library-opaque-1',
  resourceId: 'asset-opaque-2',
  requestId: 'request-123',
  outcome: 'applied' as const,
  createdAt: now
};

async function database(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await new SqliteRepository(db).migrate();
  return db;
}

function albumContext(number: number, requestId = `audit-request-${number}`): AlbumOperationContext {
  const operationId = `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
  return {
    operationId, principalId: 'local-admin', authorPeerId: 'node-local', libraryId: 'family',
    requestFingerprint: operationId.replaceAll('-', '').padEnd(64, 'a'), createdAt: now, requestId
  };
}

function seedAlbumAsset(db: Database.Database): void {
  db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at)
    VALUES('asset-audit','family','node-local','photo',?)`).run(now);
}

describe('PM-052 metadata audit ledger', () => {
  it('appends migration 0013 without changing the existing migration tail', () => {
    expect(migrations.slice(-2).map((migration) => migration.id)).toEqual([
      '0012_gallery_filter_indexes', '0013_metadata_audit_events'
    ]);
  });

  it('backs up before applying migration 0013 and preserves all previous checksums', async () => {
    const db = new Database(':memory:');
    await new SqliteRepository(db).migrate(migrations.slice(0, -1));
    const previous = db.prepare('SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id').all();
    let backups = 0;
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { backups += 1; } });
    await repository.migrate();
    expect(backups).toBe(1);
    expect(db.prepare('SELECT migration_id,checksum FROM schema_migrations WHERE migration_id <> ? ORDER BY migration_id').all('0013_metadata_audit_events'))
      .toEqual(previous);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_audit_events'").get())
      .toEqual({ name: 'metadata_audit_events' });
  });

  it('leaves the prior schema intact when the pre-migration backup fails', async () => {
    const db = new Database(':memory:');
    await new SqliteRepository(db).migrate(migrations.slice(0, -1));
    const previous = db.prepare('SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id').all();
    const repository = new SqliteRepository(db, { backupBeforeMigration: async () => { throw new Error('backup unavailable'); } });
    await expect(repository.migrate()).rejects.toThrow('backup unavailable');
    expect(db.prepare('SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id').all()).toEqual(previous);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_audit_events'").get()).toBeUndefined();
  });

  it('stores only approved attribution fields and inserts only inside an existing transaction', async () => {
    const db = await database();
    const audit = new AuditRepository(db);
    expect(() => audit.appendInTransaction(row)).toThrow('audit write requires an active SQLite transaction');

    db.transaction(() => audit.appendInTransaction(row)).immediate();
    const columns = (db.prepare('PRAGMA table_info(metadata_audit_events)').all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toEqual([
      'audit_id', 'actor', 'action', 'resource_type', 'library_id', 'resource_id',
      'related_resource_id', 'scope', 'outcome', 'request_id', 'created_at'
    ]);
    expect(db.prepare('SELECT actor, action, resource_type, library_id, resource_id, related_resource_id, scope, outcome, request_id, created_at FROM metadata_audit_events')
      .get()).toEqual({
        actor: 'local-admin', action: 'asset.tag.add', resource_type: 'asset', library_id: 'a68906aa9ae712a52cb169bd0cd0725e0257ac71f3d2e2f33213f5665258e961',
        resource_id: 'ee8c9d82840b45e2ca78b529035de0aba0ce5b957ad5df11aa5261408ff17213', related_resource_id: null, scope: null,
        outcome: 'applied', request_id: 'request-123', created_at: now
      });
  });

  it('hashes protocol-valid path-like identifiers and rejects control characters', async () => {
    const db = await database();
    const audit = new AuditRepository(db);
    const pathLikeEntry = { ...row, libraryId: 'family library', resourceId: 'C:\\private\\photo.jpg' };
    db.transaction(() => audit.appendInTransaction(pathLikeEntry)).immediate();
    expect(() => db.transaction(() => audit.appendInTransaction({ ...row, resourceId: 'bad\nidentifier' })).immediate())
      .toThrow('invalid metadata audit entry');
    expect(() => db.transaction(() => audit.appendInTransaction({ ...row, requestId: 'bad request' })).immediate())
      .toThrow('invalid metadata audit entry');
    const stored = db.prepare('SELECT library_id,resource_id FROM metadata_audit_events').get() as { library_id: string; resource_id: string };
    expect(stored.library_id).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.resource_id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('family library');
    expect(JSON.stringify(stored)).not.toContain('C:\\private\\photo.jpg');
  });

  it('retains audit rows after a file-backed database close and reopen', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photomesh-audit-'));
    const databasePath = path.join(directory, 'audit.sqlite');
    try {
      const first = new Database(databasePath);
      try {
        await new SqliteRepository(first).migrate();
        const audit = new AuditRepository(first);
        first.transaction(() => audit.appendInTransaction(row)).immediate();
      } finally { first.close(); }
      const reopened = new Database(databasePath);
      try {
        await new SqliteRepository(reopened).migrate();
        expect(reopened.prepare('SELECT request_id,action,outcome FROM metadata_audit_events').all()).toEqual([
          { request_id: 'request-123', action: 'asset.tag.add', outcome: 'applied' }
        ]);
      } finally { reopened.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('records album create, member, local lifecycle, no-op, and replay outcomes without album titles', async () => {
    const db = await database();
    seedAlbumAsset(db);
    const audit = new AuditRepository(db);
    const repository = new SqliteRepository(db, {}, audit);
    const album = repository.createAlbum({ ...albumContext(1), title: 'Sensitive title not in audit' });
    if (!album || album === 'writer_limit') throw new Error('album fixture create failed');
    repository.createAlbum({ ...albumContext(1, 'create-retry'), title: 'Sensitive title not in audit' });

    repository.deleteAlbum({ ...albumContext(2), albumId: album.albumId, scope: 'local' });
    repository.deleteAlbum({ ...albumContext(2, 'delete-retry'), albumId: album.albumId, scope: 'local' });
    repository.deleteAlbum({ ...albumContext(3), albumId: album.albumId, scope: 'local' });
    repository.restoreAlbum({ ...albumContext(4), albumId: album.albumId, scope: 'local' });
    repository.restoreAlbum({ ...albumContext(4, 'restore-retry'), albumId: album.albumId, scope: 'local' });
    repository.restoreAlbum({ ...albumContext(5), albumId: album.albumId, scope: 'local' });

    repository.addAlbumMember({ ...albumContext(6), albumId: album.albumId, assetId: 'asset-audit' });
    repository.addAlbumMember({ ...albumContext(6, 'member-add-retry'), albumId: album.albumId, assetId: 'asset-audit' });
    repository.addAlbumMember({ ...albumContext(7), albumId: album.albumId, assetId: 'asset-audit' });
    repository.removeAlbumMember({ ...albumContext(8), albumId: album.albumId, assetId: 'asset-audit' });
    repository.removeAlbumMember({ ...albumContext(9), albumId: album.albumId, assetId: 'asset-audit' });

    const events = db.prepare(`SELECT action,resource_type,resource_id,related_resource_id,scope,outcome
      FROM metadata_audit_events ORDER BY audit_id`).all();
    expect(events).toEqual([
      { action: 'virtual_album.create', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: null, outcome: 'applied' },
      { action: 'virtual_album.create', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: null, outcome: 'replayed' },
      { action: 'virtual_album.delete', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'applied' },
      { action: 'virtual_album.delete', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'replayed' },
      { action: 'virtual_album.delete', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'unchanged' },
      { action: 'virtual_album.restore', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'applied' },
      { action: 'virtual_album.restore', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'replayed' },
      { action: 'virtual_album.restore', resource_type: 'virtual_album', resource_id: auditId('resource', album.albumId), related_resource_id: null, scope: 'local', outcome: 'unchanged' },
      { action: 'virtual_album.member.add', resource_type: 'virtual_album_member', resource_id: auditId('resource', 'asset-audit'), related_resource_id: auditId('related-resource', album.albumId), scope: null, outcome: 'applied' },
      { action: 'virtual_album.member.add', resource_type: 'virtual_album_member', resource_id: auditId('resource', 'asset-audit'), related_resource_id: auditId('related-resource', album.albumId), scope: null, outcome: 'replayed' },
      { action: 'virtual_album.member.add', resource_type: 'virtual_album_member', resource_id: auditId('resource', 'asset-audit'), related_resource_id: auditId('related-resource', album.albumId), scope: null, outcome: 'unchanged' },
      { action: 'virtual_album.member.remove', resource_type: 'virtual_album_member', resource_id: auditId('resource', 'asset-audit'), related_resource_id: auditId('related-resource', album.albumId), scope: null, outcome: 'applied' },
      { action: 'virtual_album.member.remove', resource_type: 'virtual_album_member', resource_id: auditId('resource', 'asset-audit'), related_resource_id: auditId('related-resource', album.albumId), scope: null, outcome: 'unchanged' }
    ]);
    expect(JSON.stringify(events)).not.toContain('Sensitive title not in audit');
  });

  it('audits global album delete and restore as applied, unchanged, and replayed', async () => {
    const db = await database();
    seedAlbumAsset(db);
    const audit = new AuditRepository(db);
    const repository = new SqliteRepository(db, {}, audit);
    repository.setAlbumLifecycleEventDrafter(() => undefined);
    const album = repository.createAlbum({ ...albumContext(30), title: 'Global album' });
    if (!album || album === 'writer_limit') throw new Error('album fixture create failed');

    repository.deleteAlbum({ ...albumContext(31), albumId: album.albumId, scope: 'global' });
    repository.deleteAlbum({ ...albumContext(31, 'global-delete-retry'), albumId: album.albumId, scope: 'global' });
    repository.deleteAlbum({ ...albumContext(32), albumId: album.albumId, scope: 'global' });
    repository.restoreAlbum({ ...albumContext(33), albumId: album.albumId, scope: 'global' });
    repository.restoreAlbum({ ...albumContext(33, 'global-restore-retry'), albumId: album.albumId, scope: 'global' });
    repository.restoreAlbum({ ...albumContext(34), albumId: album.albumId, scope: 'global' });

    expect(db.prepare('SELECT action,scope,outcome FROM metadata_audit_events WHERE resource_type = ? ORDER BY audit_id')
      .all('virtual_album')).toEqual([
        { action: 'virtual_album.create', scope: null, outcome: 'applied' },
        { action: 'virtual_album.delete', scope: 'global', outcome: 'applied' },
        { action: 'virtual_album.delete', scope: 'global', outcome: 'replayed' },
        { action: 'virtual_album.delete', scope: 'global', outcome: 'unchanged' },
        { action: 'virtual_album.restore', scope: 'global', outcome: 'applied' },
        { action: 'virtual_album.restore', scope: 'global', outcome: 'replayed' },
        { action: 'virtual_album.restore', scope: 'global', outcome: 'unchanged' }
      ]);
  });

  it('rolls back a global album mutation and same-transaction draft callback on audit failure', async () => {
    const db = await database();
    seedAlbumAsset(db);
    const audit = new AuditRepository(db);
    const repository = new SqliteRepository(db, {}, audit);
    const album = repository.createAlbum({ ...albumContext(40), title: 'Atomic global album' });
    if (!album || album === 'writer_limit') throw new Error('album fixture create failed');
    db.exec('CREATE TABLE test_album_drafts(operation_id TEXT PRIMARY KEY)');
    repository.setAlbumLifecycleEventDrafter((input) => {
      db.prepare('INSERT INTO test_album_drafts(operation_id) VALUES(?)').run(input.operationId);
    });
    db.exec(`CREATE TRIGGER fail_metadata_audit BEFORE INSERT ON metadata_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit insert rejected'); END`);

    expect(() => repository.deleteAlbum({ ...albumContext(41), albumId: album.albumId, scope: 'global' }))
      .toThrow('audit insert rejected');
    expect(db.prepare('SELECT count(*) AS count FROM album_global_delete_tokens').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM album_lifecycle_operations').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM test_album_drafts').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM metadata_audit_events').get()).toEqual({ count: 1 });
  });

  it('rolls back album creation and operation state when the audit insert fails', async () => {
    const db = await database();
    seedAlbumAsset(db);
    const audit = new AuditRepository(db);
    const repository = new SqliteRepository(db, {}, audit);
    db.exec(`CREATE TRIGGER fail_metadata_audit BEFORE INSERT ON metadata_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit insert rejected'); END`);

    expect(() => repository.createAlbum({ ...albumContext(20), title: 'Rollback album' })).toThrow('audit insert rejected');
    expect(db.prepare('SELECT count(*) AS count FROM albums').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM album_operations').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM metadata_audit_events').get()).toEqual({ count: 0 });
  });
});
