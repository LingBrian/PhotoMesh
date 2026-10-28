import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { decodeAlbumCursor, encodeAlbumCursor, normalizeAlbumTitle } from '../src/albums/album-utils.js';
import { RepositoryConflictError, SqliteRepository } from '../src/db/repository.js';

const now = '2026-10-28T00:00:00.000Z';

function operationId(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

function baseOperation(operation: number, overrides: Partial<{
  principalId: string; authorPeerId: string; libraryId: string; albumId: string; assetId: string;
}> = {}) {
  return {
    operationId: operationId(operation), principalId: 'local-admin', authorPeerId: 'node-local',
    requestFingerprint: operationId(operation).replaceAll('-', '').padEnd(64, 'a'),
    createdAt: now, libraryId: 'family', albumId: 'album-1', assetId: 'asset-local', ...overrides
  };
}

function addLocalAsset(db: Database.Database, assetId: string, libraryId = 'family'): void {
  db.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(assetId, libraryId, 'node-local', 'photo', now);
}

function addProjectedAsset(db: Database.Database, assetId: string, libraryId = 'family', tombstoneEventId: string | null = null): void {
  const eventId = `event-${assetId}`;
  db.prepare(`INSERT INTO sync_event_log (event_id, library_id, author_peer_id, author_sequence, protocol_version,
    schema_version, event_type, causal_parents_json, payload_json, created_at, signature, envelope_json, state)
    VALUES (?, ?, 'node-remote', 1, 1, 1, 'asset.indexed', '[]', '{}', ?, 'sig', '{}', 'ready')`)
    .run(eventId, libraryId, now);
  db.prepare(`INSERT INTO sync_asset_projection (library_id, asset_id, origin_node_id, kind, sha256, byte_length,
    metadata_json, tombstone_event_id, restored_by_event_id, last_event_id)
    VALUES (?, ?, 'node-remote', 'photo', ?, 4, '{}', ?, NULL, ?)`)
    .run(libraryId, assetId, 'a'.repeat(64), tombstoneEventId, eventId);
}

async function setup(faults?: ConstructorParameters<typeof SqliteRepository>[1]) {
  const db = new Database(':memory:');
  const repository = new SqliteRepository(db, faults);
  await repository.migrate();
  addLocalAsset(db, 'asset-local');
  addLocalAsset(db, 'asset-other-library', 'other');
  addProjectedAsset(db, 'asset-projected');
  return { db, repository };
}

async function createAlbum(repository: SqliteRepository, operation = 1, title = 'Family trip') {
  const result = repository.createAlbum({ ...baseOperation(operation), title });
  if (!result || result === 'writer_limit') throw new Error('library and author should be available');
  return result;
}

describe('album title and keyset cursor helpers', () => {
  it('uses ECMAScript trim and UTF-8 byte limits without Unicode normalization', () => {
    expect(normalizeAlbumTitle('\u00a0\ufeffTravel\u3000')).toBe('Travel');
    expect(normalizeAlbumTitle('\u00a0\u3000\ufeff')).toBeUndefined();
    expect(normalizeAlbumTitle('é'.repeat(128))).toBe('é'.repeat(128));
    expect(normalizeAlbumTitle(`${'é'.repeat(128)}a`)).toBeUndefined();
    expect(normalizeAlbumTitle('e\u0301')).toBe('e\u0301');
    expect(normalizeAlbumTitle('é')).toBe('é');
  });

  it('binds cursors to collection, library and album and rejects malformed or oversized values', () => {
    const scope = { collection: 'members' as const, libraryId: 'family', albumId: 'album-1' };
    const cursor = encodeAlbumCursor(scope, 'asset-2');
    expect(decodeAlbumCursor(cursor, scope)).toBe('asset-2');
    expect(() => decodeAlbumCursor(cursor, { ...scope, libraryId: 'other' })).toThrow();
    expect(() => decodeAlbumCursor(cursor, { ...scope, albumId: 'album-2' })).toThrow();
    expect(() => decodeAlbumCursor('not a cursor', scope)).toThrow();
    expect(() => decodeAlbumCursor('x'.repeat(2049), scope)).toThrow();
  });
});

describe('SQLite virtual albums', () => {
  it('creates albums idempotently, permits duplicate titles and pages by stable album ID', async () => {
    const { db, repository } = await setup();
    const first = await createAlbum(repository, 1);
    const replay = new SqliteRepository(db).createAlbum({ ...baseOperation(1), title: 'Family trip' });
    expect(replay).toEqual(first);
    const second = await createAlbum(repository, 2, 'Family trip');
    expect(second.albumId).not.toBe(first.albumId);
    expect(repository.listAlbums('family', undefined, 1)?.items).toHaveLength(1);
    const page1 = repository.listAlbums('family', undefined, 1)!;
    const page2 = repository.listAlbums('family', page1.nextCursor!, 1)!;
    expect(page2.nextCursor).toBeNull();
    expect([...page1.items, ...page2.items].map((album) => album.albumId)).toEqual(
      [...page1.items, ...page2.items].map((album) => album.albumId).sort()
    );
    expect(repository.listAlbums('missing-library', undefined, 10)).toBeUndefined();
    expect(() => repository.createAlbum({ ...baseOperation(1), title: 'Different', requestFingerprint: 'b'.repeat(64) }))
      .toThrow(RepositoryConflictError);
    expect(() => repository.createAlbum({ ...baseOperation(1, { principalId: 'different-principal' }), title: 'Family trip' }))
      .toThrow(RepositoryConflictError);
    expect(() => repository.addAlbumMember({ ...baseOperation(1, { albumId: first.albumId }) }))
      .toThrow(RepositoryConflictError);
    expect(db.prepare('SELECT count(*) AS count FROM albums').get()).toEqual({ count: 2 });
    db.close();
  });

  it('adds/removes observed membership operations atomically and preserves unseen concurrent additions', async () => {
    const { db, repository } = await setup();
    const album = await createAlbum(repository);
    expect(repository.addAlbumMember({ ...baseOperation(2, { albumId: album.albumId, authorPeerId: 'node-a' }) })).toMatchObject({ status: 'added' });
    expect(repository.addAlbumMember({ ...baseOperation(3, { albumId: album.albumId, authorPeerId: 'node-a' }) })).toMatchObject({ status: 'already_present' });
    expect(repository.addAlbumMember({ ...baseOperation(4, { albumId: album.albumId, authorPeerId: 'node-b' }) })).toMatchObject({ status: 'added' });
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)?.items).toEqual([{ assetId: 'asset-local' }]);

    const removeInput = baseOperation(5, { albumId: album.albumId, authorPeerId: 'node-a' });
    const removed = repository.removeAlbumMember(removeInput);
    expect(removed).toMatchObject({ status: 'removed', observedAddIds: [operationId(2), operationId(4)] });
    expect(repository.removeAlbumMember(removeInput)).toEqual(removed);
    expect(db.prepare('SELECT observed_add_operation_id FROM album_membership_remove_targets WHERE remove_operation_id = ? ORDER BY observed_add_operation_id')
      .all(operationId(5))).toEqual([{ observed_add_operation_id: operationId(2) }, { observed_add_operation_id: operationId(4) }]);
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)?.items).toEqual([]);

    expect(repository.addAlbumMember({ ...baseOperation(6, { albumId: album.albumId, authorPeerId: 'node-b' }) })).toMatchObject({ status: 'added' });
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)?.items).toEqual([{ assetId: 'asset-local' }]);
    db.close();
  });

  it('rejects cross-library, absent and tombstoned additions while preserving membership through tombstone/restore', async () => {
    const { db, repository } = await setup();
    const album = await createAlbum(repository);
    expect(repository.addAlbumMember({ ...baseOperation(2, { albumId: album.albumId, assetId: 'asset-other-library' }) }).status).toBe('not_found');
    expect(repository.addAlbumMember({ ...baseOperation(3, { albumId: album.albumId, assetId: 'missing' }) }).status).toBe('not_found');
    expect(repository.addAlbumMember({ ...baseOperation(4, { albumId: album.albumId, assetId: 'asset-projected' }) }).status).toBe('added');
    expect(repository.addAlbumMember({ ...baseOperation(6, { albumId: album.albumId, assetId: 'asset-local' }) }).status).toBe('added');
    const firstPage = repository.listAlbumMembers('family', album.albumId, undefined, 1)!;
    expect(firstPage.items).toEqual([{ assetId: 'asset-local' }]);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(repository.listAlbumMembers('family', album.albumId, firstPage.nextCursor!, 1)?.items)
      .toEqual([{ assetId: 'asset-projected' }]);

    db.prepare("UPDATE sync_asset_projection SET tombstone_event_id = 'tombstone-event' WHERE asset_id = 'asset-projected'").run();
    const filteredPage = repository.listAlbumMembers('family', album.albumId, undefined, 1)!;
    expect(filteredPage.items).toEqual([{ assetId: 'asset-local' }]);
    expect(filteredPage.nextCursor).toBeNull();
    expect(repository.addAlbumMember({ ...baseOperation(5, { albumId: album.albumId, assetId: 'asset-projected' }) }).status).toBe('not_found');
    db.prepare('UPDATE sync_asset_projection SET tombstone_event_id = NULL, restored_by_event_id = ? WHERE asset_id = ?')
      .run('restore-event', 'asset-projected');
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 1)?.nextCursor).toBeTruthy();
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)?.items)
      .toEqual([{ assetId: 'asset-local' }, { assetId: 'asset-projected' }]);
    expect(repository.listAlbumMembers('other', album.albumId, undefined, 10)).toBeUndefined();
    db.close();
  });

  it('bounds active writers at 64 and never truncates observed removal targets', async () => {
    const { db, repository } = await setup();
    const album = await createAlbum(repository);
    expect(repository.addAlbumMember({ ...baseOperation(99, { albumId: album.albumId, authorPeerId: 'node-local' }) }).status).toBe('added');
    for (let writer = 0; writer < 63; writer += 1) {
      const op = 100 + writer;
      const result = repository.addAlbumMember({
        ...baseOperation(op, { albumId: album.albumId, authorPeerId: `peer-${writer}` })
      });
      expect(result.status).toBe('added');
    }
    expect(repository.addAlbumMember({ ...baseOperation(200, { albumId: album.albumId, authorPeerId: 'peer-overflow' }) }).status)
      .toBe('writer_limit');
    expect(repository.createAlbum({ ...baseOperation(202, { authorPeerId: 'peer-overflow' }), title: 'Over limit' })).toBe('writer_limit');
    expect(db.prepare('SELECT count(*) AS count FROM albums').get()).toEqual({ count: 1 });
    const removed = repository.removeAlbumMember(baseOperation(201, { albumId: album.albumId, authorPeerId: 'node-local' }));
    expect(removed.status).toBe('removed');
    expect(removed.observedAddIds).toHaveLength(64);
    db.close();
  });

  it('keeps more than 64 historical operations without reactivating removed memberships', async () => {
    const { db, repository } = await setup();
    const album = await createAlbum(repository);
    for (let index = 1; index <= 40; index += 1) {
      expect(repository.addAlbumMember({ ...baseOperation(300 + index * 2, { albumId: album.albumId }) }).status).toBe('added');
      expect(repository.removeAlbumMember(baseOperation(301 + index * 2, { albumId: album.albumId })).status).toBe('removed');
    }
    expect(repository.addAlbumMember({ ...baseOperation(500, { albumId: album.albumId }) }).status).toBe('added');
    expect(repository.listAlbumMembers('family', album.albumId, undefined, 10)?.items).toEqual([{ assetId: 'asset-local' }]);
    expect((db.prepare('SELECT count(*) AS count FROM album_operations').get() as { count: number }).count).toBeGreaterThan(64);
    db.close();
  });

  it('rolls back idempotency records, operations and projections together on injected failure', async () => {
    let shouldFail = false;
    const fault = vi.fn(() => { if (shouldFail) throw new Error('injected album transaction fault'); });
    const { db, repository } = await setup({ beforeAlbumOperationCommit: fault });
    const album = await createAlbum(repository, 899, 'Atomic');
    shouldFail = true;
    expect(() => repository.createAlbum({ ...baseOperation(900), title: 'Rolled back' })).toThrow('injected album transaction fault');
    expect(() => repository.addAlbumMember({ ...baseOperation(901, { albumId: album.albumId }) }))
      .toThrow('injected album transaction fault');
    expect(db.prepare('SELECT count(*) AS count FROM albums').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM album_operations').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM album_memberships').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT 1 FROM album_operations WHERE operation_id = ?').get(operationId(901))).toBeUndefined();

    shouldFail = false;
    expect(repository.addAlbumMember({ ...baseOperation(901, { albumId: album.albumId }) }).status).toBe('added');
    shouldFail = true;
    expect(() => repository.removeAlbumMember(baseOperation(902, { albumId: album.albumId })))
      .toThrow('injected album transaction fault');
    expect(db.prepare('SELECT count(*) AS count FROM album_operations').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM album_memberships').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM album_membership_remove_targets').get()).toEqual({ count: 0 });
    shouldFail = false;
    expect(repository.removeAlbumMember(baseOperation(902, { albumId: album.albumId })).status).toBe('removed');
    expect(db.prepare('SELECT count(*) AS count FROM album_memberships').get()).toEqual({ count: 0 });
    db.close();
  });

  it('rejects direct SQL writes that violate album/library/add/remove integrity', async () => {
    const { db, repository } = await setup();
    const album = await createAlbum(repository);
    const addResult = repository.addAlbumMember({ ...baseOperation(2, { albumId: album.albumId }) });
    expect(addResult.status).toBe('added');
    expect(() => db.prepare('UPDATE albums SET title = ? WHERE album_id = ?').run('Renamed', album.albumId)).toThrow();
    expect(() => db.prepare('DELETE FROM albums WHERE album_id = ?').run(album.albumId)).toThrow();
    expect(() => db.prepare('UPDATE album_operations SET result_json = ? WHERE operation_id = ?').run('{}', operationId(2))).toThrow();
    expect(() => db.prepare('DELETE FROM album_operations WHERE operation_id = ?').run(operationId(2))).toThrow();
    expect(() => db.prepare('UPDATE album_memberships SET author_peer_id = ? WHERE add_operation_id = ?')
      .run('forged-author', operationId(2))).toThrow();
    expect(() => db.prepare('DELETE FROM album_memberships WHERE add_operation_id = ?').run(operationId(2))).toThrow();
    expect(() => db.prepare(`INSERT INTO albums (album_id, library_id, title, created_by_peer_id, created_at)
      VALUES ('unknown-library', 'missing-library', 'Hidden', 'node-local', ?)`)
      .run(now)).toThrow();
    expect(() => db.prepare(`INSERT INTO album_memberships
      (library_id, album_id, asset_id, author_peer_id, add_operation_id, created_at)
      VALUES ('family', ?, 'asset-local', 'node-local', '00000000-0000-4000-8000-000000000099', ?)`)
      .run(album.albumId, now)).toThrow();
    expect(() => db.prepare(`INSERT INTO album_memberships
      (library_id, album_id, asset_id, author_peer_id, add_operation_id, created_at)
      VALUES ('family', ?, 'asset-other-library', 'node-local', ?, ?)`)
      .run(album.albumId, operationId(2), now)).toThrow();

    const insertOperation = db.prepare(`INSERT INTO album_operations
      (operation_id, principal_id, author_peer_id, library_id, album_id, asset_id, operation_type,
       request_fingerprint, result_json, created_at)
      VALUES (?, 'local-admin', 'node-local', 'family', ?, ?, 'member.added', ?, '{"status":"added"}', ?)`);
    expect(() => insertOperation.run(operationId(3), album.albumId, 'asset-other-library', 'a'.repeat(64), now)).toThrow();
    expect(() => insertOperation.run(operationId(4), album.albumId, 'missing-asset', 'b'.repeat(64), now)).toThrow();

    expect(repository.removeAlbumMember(baseOperation(5, { albumId: album.albumId })).status).toBe('removed');
    expect(() => db.prepare('UPDATE album_membership_remove_targets SET asset_id = ? WHERE remove_operation_id = ?')
      .run('tampered', operationId(5))).toThrow();
    expect(() => db.prepare('DELETE FROM album_membership_remove_targets WHERE remove_operation_id = ?').run(operationId(5))).toThrow();
    expect(() => db.prepare(`INSERT INTO album_membership_remove_targets
      (remove_operation_id, observed_add_operation_id, library_id, album_id, asset_id)
      VALUES (?, ?, 'family', ?, 'asset-other-library')`).run(operationId(5), operationId(2), album.albumId)).toThrow();

    db.prepare("UPDATE sync_asset_projection SET tombstone_event_id = 'tombstone-event' WHERE asset_id = 'asset-projected'").run();
    expect(() => insertOperation.run(operationId(6), album.albumId, 'asset-projected', 'c'.repeat(64), now)).toThrow();
    expect(() => db.prepare(`INSERT INTO albums (album_id, library_id, title, created_by_peer_id, created_at)
      VALUES ('invalid-title', 'family', ?, 'node-local', ?)`)
      .run('\u00a0\u3000', now)).toThrow();
    expect(() => db.prepare(`INSERT INTO albums (album_id, library_id, title, created_by_peer_id, created_at)
      VALUES ('too-long-title', 'family', ?, 'node-local', ?)`)
      .run(`${'é'.repeat(128)}a`, now)).toThrow();
    db.close();
  });
});
