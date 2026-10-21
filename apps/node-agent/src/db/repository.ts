import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { migrations, type Migration } from './migrations.js';

export type UploadState = 'created' | 'uploading' | 'verifying' | 'completed' | 'failed';
export type AssetKind = 'photo' | 'video' | 'live_photo';
export type SourceKind = 'upload' | 'import';

export interface CreateUploadSessionRecord {
  sessionId: string;
  idempotencyScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  libraryId: string;
  filename: string;
  sourceKind: SourceKind;
  sourcePath: string | null;
  sourceNodeId: string | null;
  kind: AssetKind;
  totalBytes: number;
  expectedSha256: string;
  expiresAt: string;
  finalStorageRef: string;
  now: string;
}

export interface UploadSessionRecord extends CreateUploadSessionRecord {
  state: UploadState;
  offset: number;
  assetId: string | null;
  fileId: string | null;
  storageRef: string;
  updatedAt: string;
}

export interface UploadChunkRecord {
  sessionId: string;
  chunkIndex: number;
  byteLength: number;
  sha256: string;
  stagingRef: string;
  acceptedOffset: number;
  createdAt: string;
}

export interface CompletedLocationRecord {
  originalFilename: string;
  originalPath: string | null;
  sourceKind: SourceKind;
  sourceNodeId: string | null;
  pathRef: string;
}

export interface ExternalLocationRecord {
  locationId: string;
  fileId: string;
  assetId: string;
  nodeId: string;
  libraryId: string;
  kind: AssetKind;
  filename: string;
  originalPath: string;
  byteSize: number;
  sha256: string;
  storageRef: string;
  now: string;
}

export interface IndexedExternalLocation {
  locationId: string;
  originalPath: string;
  availability: 'online' | 'cached' | 'offline' | 'missing';
}

export interface UploadRepository {
  getUploadSession(sessionId: string): UploadSessionRecord | undefined;
  getUploadSessionByIdempotency(scope: string, key: string): UploadSessionRecord | undefined;
  createUploadSession(record: CreateUploadSessionRecord): void;
  getUploadChunk(sessionId: string, chunkIndex: number): UploadChunkRecord | undefined;
  getUploadChunks(sessionId: string): UploadChunkRecord[];
  recordChunk(record: UploadChunkRecord, expectedOffset: number, now: string): void;
  markVerifying(sessionId: string, now: string): void;
  markFailed(sessionId: string, now: string): void;
  finalizeUpload(sessionId: string, assetId: string, fileId: string, locationId: string, nodeId: string, now: string): void;
  getLocationForSession(sessionId: string): CompletedLocationRecord | undefined;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export interface RepositoryFaults {
  beforeFinalize?: () => void;
  beforeRecordChunk?: () => void;
  backupBeforeMigration?: () => Promise<void>;
}

interface SessionRow {
  session_id: string;
  idempotency_scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  library_id: string;
  filename: string;
  source_kind: SourceKind;
  source_path: string | null;
  source_node_id: string | null;
  kind: AssetKind;
  total_bytes: number;
  expected_sha256: string;
  state: UploadState;
  offset_bytes: number;
  expires_at: string;
  final_storage_ref: string;
  completed_asset_id: string | null;
  completed_file_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  session_id: string;
  chunk_index: number;
  byte_length: number;
  sha256: string;
  staging_ref: string;
  accepted_offset: number;
  created_at: string;
}

export class SqliteRepository implements UploadRepository {
  constructor(private readonly db: Database.Database, private readonly faults: RepositoryFaults = {}) {
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
  }

  async migrate(orderedMigrations: readonly Migration[] = migrations): Promise<void> {
    const existingTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const hasLedger = existingTables.some((table) => table.name === 'schema_migrations');
    const applied = hasLedger
      ? this.db.prepare('SELECT migration_id, checksum FROM schema_migrations').all() as Array<{ migration_id: string; checksum: string }>
      : [];
    const appliedById = new Map(applied.map((record) => [record.migration_id, record.checksum]));
    const seenIds = new Set<string>();
    let previousId: string | undefined;
    let pendingCount = 0;
    for (const migration of orderedMigrations) {
      if (seenIds.has(migration.id)) throw new MigrationError(`duplicate migration id: ${migration.id}`);
      if (previousId !== undefined && migration.id.localeCompare(previousId) <= 0) throw new MigrationError('migrations must be supplied in strictly increasing ID order');
      seenIds.add(migration.id);
      previousId = migration.id;
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previousChecksum = appliedById.get(migration.id);
      if (previousChecksum && previousChecksum !== checksum) throw new MigrationError(`checksum changed for migration ${migration.id}`);
      if (!previousChecksum) pendingCount += 1;
    }
    for (const appliedId of appliedById.keys()) {
      if (!seenIds.has(appliedId)) throw new MigrationError(`database contains unknown migration ${appliedId}; refusing a possible downgrade`);
    }
    const hasUserTables = existingTables.some((table) => table.name !== 'schema_migrations');
    if (pendingCount > 0 && hasUserTables) {
      if (!this.faults.backupBeforeMigration) throw new MigrationError('database backup is required before applying pending migrations to an existing database');
      await this.faults.backupBeforeMigration();
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    for (const migration of orderedMigrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const applyOne = this.db.transaction(() => {
        const prior = this.db.prepare('SELECT checksum FROM schema_migrations WHERE migration_id = ?').get(migration.id) as { checksum: string } | undefined;
        if (prior) {
          if (prior.checksum !== checksum) throw new MigrationError(`checksum changed for migration ${migration.id}`);
          return;
        }
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations (migration_id, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.id, checksum, new Date().toISOString());
      });
      try {
        applyOne.immediate();
      } catch (error) {
        if (error instanceof MigrationError) throw error;
        throw new MigrationError(`failed applying migration ${migration.id}`, { cause: error });
      }
    }
  }

  getUploadSession(sessionId: string): UploadSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  getUploadSessionByIdempotency(scope: string, key: string): UploadSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE idempotency_scope = ? AND idempotency_key = ?').get(scope, key) as SessionRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  createUploadSession(record: CreateUploadSessionRecord): void {
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO upload_sessions (
        session_id, idempotency_scope, idempotency_key, request_fingerprint, library_id, filename, source_kind,
        source_path, source_node_id, kind, total_bytes, expected_sha256, state, offset_bytes, expires_at,
        final_storage_ref, created_at, updated_at
      ) VALUES (
        @sessionId, @idempotencyScope, @idempotencyKey, @requestFingerprint, @libraryId, @filename, @sourceKind,
        @sourcePath, @sourceNodeId, @kind, @totalBytes, @expectedSha256, 'created', 0, @expiresAt,
        @finalStorageRef, @now, @now
      )`).run(record);
      this.db.prepare(`INSERT INTO jobs (job_id, job_type, state, attempts, checkpoint_json, created_at, updated_at)
        VALUES (?, 'upload', 'queued', 0, ?, ?, ?)`).run(record.sessionId, JSON.stringify({ sessionId: record.sessionId, offset: 0 }), record.now, record.now);
    });
    create.immediate();
  }

  getUploadChunk(sessionId: string, chunkIndex: number): UploadChunkRecord | undefined {
    const row = this.db.prepare('SELECT * FROM upload_chunks WHERE session_id = ? AND chunk_index = ?').get(sessionId, chunkIndex) as ChunkRow | undefined;
    return row ? toChunkRecord(row) : undefined;
  }

  getUploadChunks(sessionId: string): UploadChunkRecord[] {
    const rows = this.db.prepare('SELECT * FROM upload_chunks WHERE session_id = ? ORDER BY chunk_index').all(sessionId) as ChunkRow[];
    return rows.map(toChunkRecord);
  }

  recordChunk(record: UploadChunkRecord, expectedOffset: number, now: string): void {
    const write = this.db.transaction(() => {
      const session = this.getUploadSession(record.sessionId);
      if (!session || session.offset !== expectedOffset || !['created', 'uploading'].includes(session.state)) {
        throw new RepositoryConflictError('upload offset or state changed');
      }
      this.db.prepare(`INSERT INTO upload_chunks
        (session_id, chunk_index, byte_length, sha256, staging_ref, accepted_offset, created_at)
        VALUES (@sessionId, @chunkIndex, @byteLength, @sha256, @stagingRef, @acceptedOffset, @createdAt)`).run(record);
      this.faults.beforeRecordChunk?.();
      const update = this.db.prepare(`UPDATE upload_sessions SET offset_bytes = ?, state = 'uploading', updated_at = ?
        WHERE session_id = ? AND offset_bytes = ? AND state IN ('created', 'uploading')`)
        .run(expectedOffset + record.byteLength, now, record.sessionId, expectedOffset);
      if (update.changes !== 1) throw new RepositoryConflictError('upload offset changed');
      this.db.prepare(`UPDATE jobs SET state = 'running', checkpoint_json = ?, updated_at = ? WHERE job_id = ?`)
        .run(JSON.stringify({ sessionId: record.sessionId, offset: expectedOffset + record.byteLength, chunkIndex: record.chunkIndex }), now, record.sessionId);
    });
    write.immediate();
  }

  markVerifying(sessionId: string, now: string): void {
    const update = this.db.prepare(`UPDATE upload_sessions SET state = 'verifying', updated_at = ?
      WHERE session_id = ? AND state IN ('created', 'uploading', 'verifying')`).run(now, sessionId);
    if (update.changes !== 1) throw new RepositoryConflictError('session is not verifiable');
    this.db.prepare(`UPDATE jobs SET state = 'running', checkpoint_json = ?, updated_at = ? WHERE job_id = ?`)
      .run(JSON.stringify({ sessionId, phase: 'verifying' }), now, sessionId);
  }

  markFailed(sessionId: string, now: string): void {
    this.db.prepare(`UPDATE upload_sessions SET state = 'failed', updated_at = ? WHERE session_id = ? AND state <> 'completed'`)
      .run(now, sessionId);
    this.db.prepare(`UPDATE jobs SET state = 'failed', updated_at = ? WHERE job_id = ?`).run(now, sessionId);
  }

  finalizeUpload(sessionId: string, assetId: string, fileId: string, locationId: string, nodeId: string, now: string): void {
    const finalize = this.db.transaction(() => {
      const session = this.getUploadSession(sessionId);
      if (!session) throw new RepositoryConflictError('upload session not found');
      if (session.state === 'completed') return;
      if (session.state !== 'verifying' || session.offset !== session.totalBytes) throw new RepositoryConflictError('upload is not ready to finalize');
      this.faults.beforeFinalize?.();
      this.db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`).run(assetId, session.libraryId, nodeId, session.kind, now);
      this.db.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
        VALUES (?, ?, ?, ?, 'original', ?, ?)`).run(fileId, assetId, session.expectedSha256, session.totalBytes, session.finalStorageRef, now);
      this.db.prepare(`INSERT INTO file_locations (
        location_id, file_id, node_id, original_filename, original_path, source_kind, source_node_id,
        path_ref, storage_class, availability, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', 'online', ?)`).run(
        locationId, fileId, nodeId, session.filename, session.sourcePath, session.sourceKind,
        session.sourceNodeId, session.finalStorageRef, now
      );
      this.db.prepare(`UPDATE upload_sessions SET state = 'completed', completed_asset_id = ?, completed_file_id = ?, updated_at = ?
        WHERE session_id = ? AND state = 'verifying'`).run(assetId, fileId, now, sessionId);
      this.db.prepare(`UPDATE jobs SET state = 'succeeded', attempts = attempts + 1, checkpoint_json = ?, updated_at = ?
        WHERE job_id = ?`).run(JSON.stringify({ sessionId, assetId, fileId }), now, sessionId);
      this.db.prepare(`INSERT INTO events (event_id, event_type, aggregate_id, payload_json, created_at)
        VALUES (?, 'asset.uploaded', ?, ?, ?)`).run(randomUUID(), assetId, JSON.stringify({ assetId, fileId, libraryId: session.libraryId }), now);
    });
    finalize.immediate();
  }

  getLocationForSession(sessionId: string): CompletedLocationRecord | undefined {
    const row = this.db.prepare(`SELECT l.original_filename, l.original_path, l.source_kind, l.source_node_id, l.path_ref
      FROM upload_sessions s JOIN file_locations l ON l.file_id = s.completed_file_id
      WHERE s.session_id = ?`).get(sessionId) as {
      original_filename: string; original_path: string | null; source_kind: SourceKind; source_node_id: string | null; path_ref: string;
    } | undefined;
    if (!row) return undefined;
    return { originalFilename: row.original_filename, originalPath: row.original_path, sourceKind: row.source_kind, sourceNodeId: row.source_node_id, pathRef: row.path_ref };
  }

  listExternalLocations(nodeId: string): IndexedExternalLocation[] {
    return this.db.prepare(`SELECT location_id, original_path, availability FROM file_locations
      WHERE node_id = ? AND storage_class = 'external' AND original_path IS NOT NULL`).all(nodeId)
      .map((row) => {
        const value = row as { location_id: string; original_path: string; availability: IndexedExternalLocation['availability'] };
        return { locationId: value.location_id, originalPath: value.original_path, availability: value.availability };
      });
  }

  recordExternalFile(record: ExternalLocationRecord): string {
    const write = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT l.location_id, f.sha256 FROM file_locations l
        JOIN asset_files f ON f.file_id = l.file_id
        WHERE l.node_id = ? AND l.storage_class = 'external' AND l.original_path = ?
        ORDER BY l.created_at DESC LIMIT 1`).get(record.nodeId, record.originalPath) as { location_id: string; sha256: string } | undefined;
      if (existing?.sha256 === record.sha256) {
        this.db.prepare("UPDATE file_locations SET availability = 'online' WHERE location_id = ?").run(existing.location_id);
        return existing.location_id;
      }
      if (existing) this.db.prepare("UPDATE file_locations SET availability = 'missing' WHERE location_id = ?").run(existing.location_id);
      this.db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`).run(record.assetId, record.libraryId, record.nodeId, record.kind, record.now);
      this.db.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
        VALUES (?, ?, ?, ?, 'original', ?, ?)`).run(record.fileId, record.assetId, record.sha256, record.byteSize, record.storageRef, record.now);
      this.db.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path,
        source_kind, source_node_id, path_ref, storage_class, availability, created_at)
        VALUES (?, ?, ?, ?, ?, 'import', NULL, ?, 'external', 'online', ?)`)
        .run(record.locationId, record.fileId, record.nodeId, record.filename, record.originalPath, record.originalPath, record.now);
      return record.locationId;
    });
    return write.immediate();
  }

  setExternalAvailability(locationId: string, availability: IndexedExternalLocation['availability']): void {
    this.db.prepare("UPDATE file_locations SET availability = ? WHERE location_id = ? AND storage_class = 'external'")
      .run(availability, locationId);
  }
}

function toSessionRecord(row: SessionRow): UploadSessionRecord {
  return {
    sessionId: row.session_id,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    libraryId: row.library_id,
    filename: row.filename,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    sourceNodeId: row.source_node_id,
    kind: row.kind,
    totalBytes: row.total_bytes,
    expectedSha256: row.expected_sha256,
    state: row.state,
    offset: row.offset_bytes,
    expiresAt: row.expires_at,
    finalStorageRef: row.final_storage_ref,
    assetId: row.completed_asset_id,
    fileId: row.completed_file_id,
    storageRef: row.final_storage_ref,
    now: row.created_at,
    updatedAt: row.updated_at
  };
}

function toChunkRecord(row: ChunkRow): UploadChunkRecord {
  return {
    sessionId: row.session_id,
    chunkIndex: row.chunk_index,
    byteLength: row.byte_length,
    sha256: row.sha256,
    stagingRef: row.staging_ref,
    acceptedOffset: row.accepted_offset,
    createdAt: row.created_at
  };
}
