import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appendMetadataAudit, type AuditRepository } from '../audit/audit-repository.js';
import { migrations, type Migration } from './migrations.js';
import { maxAssetTagsPerAsset } from '../asset-tag-limits.js';
import { decodeAlbumCursor, encodeAlbumCursor, type AlbumCursorScope } from '../albums/album-utils.js';
import { SyncRepository } from '../sync/sync-repository.js';
import type { EventDraftFactory } from '../sync/event-envelope.js';
import { isCanonicalCaptureLocalTime, isCaptureDateMetadata, type CaptureDateMetadata, type CaptureDateConfidence, type CaptureDateSource } from '../metadata/capture-date.js';

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
  captureDate: CaptureDateMetadata;
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

export interface PairingInviteRecord {
  inviteId: string;
  secretSha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface TrustedPeerRecord {
  peerId: string;
  publicKey: string;
  label: string;
  trustState: 'trusted' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

export interface LibraryIndexAsset {
  assetId: string;
  libraryId: string;
  originNodeId: string;
  kind: AssetKind;
  sha256: string;
  availability: 'online' | 'cached' | 'offline' | 'missing';
}

export interface GalleryAssetRecord extends LibraryIndexAsset {
  filename: string;
  capturedAt: string | null;
  captureLocalTime: string | null;
  captureOffsetMinutes: number | null;
  captureSource: CaptureDateSource;
  captureConfidence: CaptureDateConfidence;
  sourcePath: string | null;
  sourceKind: SourceKind;
  byteSize: number;
  version: string;
  tags: string[];
  favorite: boolean;
  rating: number | null;
  ratingConflict: boolean;
  ratingCandidates: Array<number | null>;
}

export interface GallerySearchFilters {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  kind?: AssetKind;
  sourceKind?: SourceKind;
  availability?: GalleryAssetRecord['availability'];
}

export type AssetTagMutationResult = 'added' | 'already_present' | 'removed' | 'unchanged' | 'not_found' | 'limit_reached';

export interface AlbumRecord {
  albumId: string;
  libraryId: string;
  title: string;
  createdByPeerId: string;
  createdAt: string;
}

export interface AlbumPage {
  items: AlbumRecord[];
  nextCursor: string | null;
}

export interface AlbumMemberPage {
  items: Array<{ assetId: string }>;
  nextCursor: string | null;
}

export interface AlbumOperationContext {
  operationId: string;
  principalId: string;
  authorPeerId: string;
  libraryId: string;
  requestFingerprint: string;
  createdAt: string;
  requestId?: string;
}

export interface AlbumOperationEventDraftInput {
  operationId: string;
  authorPeerId: string;
  libraryId: string;
  albumId: string;
  assetId: string | null;
  operationType: 'album.created' | 'member.added' | 'member.removed';
  createdAt: string;
  title?: string;
  observedAddIds?: readonly string[];
}
export type AlbumOperationEventDrafter = (input: AlbumOperationEventDraftInput) => void;

export interface AlbumLifecycleEventDraftInput {
  operationId: string;
  authorPeerId: string;
  libraryId: string;
  albumId: string;
  operationType: 'album.deleted' | 'album.restored';
  createdAt: string;
  observedDeleteIds?: readonly string[];
}
export type AlbumLifecycleEventDrafter = (input: AlbumLifecycleEventDraftInput) => void;
export type AlbumDeleteScope = 'local' | 'global';
export type AlbumDeletedQueryScope = 'all' | AlbumDeleteScope;
export interface DeletedAlbumRecord extends AlbumRecord { scopes: AlbumDeleteScope[]; deletedAt: string }
export interface DeletedAlbumPage { items: DeletedAlbumRecord[]; nextCursor: string | null }
export type AlbumDeletionResult = 'deleted' | 'already_deleted' | 'not_found' | 'writer_limit';
export type AlbumRestoreResult = 'restored' | 'already_active' | 'not_found' | 'writer_limit';

export type AlbumMemberMutationResult =
  | { status: 'added' | 'already_present' | 'removed' | 'unchanged' | 'not_found' | 'writer_limit'; observedAddIds?: string[] };

export interface GalleryMediaRecord {
  libraryId: string;
  filename: string;
  sha256: string;
  byteSize: number;
  storageRef: string;
  originalPath: string | null;
  availability: 'online' | 'cached' | 'offline' | 'missing';
}

export interface MediaVersionTransform {
  crop: { x: number; y: number; width: number; height: number };
  rotation: 0 | 90 | 180 | 270;
}

export type MediaVersionStatus = 'staging' | 'ready' | 'failed';

export interface MediaVersionSourceRecord extends GalleryMediaRecord {
  assetId: string;
  sourceVersionId: string | null;
  kind: AssetKind;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | null;
}

export interface MediaVersionRecord {
  versionId: string;
  assetId: string;
  libraryId: string;
  sourceVersionId: string | null;
  sourceSha256: string;
  transform: MediaVersionTransform;
  idempotencyScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: MediaVersionStatus;
  storageRef: string;
  outputSha256: string | null;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  errorCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMediaVersionRecord {
  versionId: string;
  assetId: string;
  libraryId: string;
  sourceVersionId: string | null;
  sourceSha256: string;
  transform: MediaVersionTransform;
  idempotencyScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  storageRef: string;
  createdBy: string;
  createdAt: string;
}

export interface UploadRepository {
  getUploadSession(sessionId: string): UploadSessionRecord | undefined;
  listRecoverableUploadSessionIds(now: string): string[];
  getUploadSessionByIdempotency(scope: string, key: string): UploadSessionRecord | undefined;
  createUploadSession(record: CreateUploadSessionRecord): void;
  getUploadChunk(sessionId: string, chunkIndex: number): UploadChunkRecord | undefined;
  getUploadChunks(sessionId: string): UploadChunkRecord[];
  recordChunk(record: UploadChunkRecord, expectedOffset: number, now: string): void;
  markVerifying(sessionId: string, now: string): void;
  markFailed(sessionId: string, now: string): void;
  finalizeUpload(sessionId: string, assetId: string, fileId: string, locationId: string, nodeId: string, now: string,
    captureDate: CaptureDateMetadata, eventFactory?: EventDraftFactory): void;
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

export class StaleGalleryCursorError extends Error {
  constructor() {
    super('legacy null-date cursor must be restarted');
    this.name = 'StaleGalleryCursorError';
  }
}

export interface RepositoryFaults {
  beforeFinalize?: () => void;
  beforeRecordChunk?: () => void;
  beforeAlbumOperationCommit?: () => void;
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

interface MediaVersionSqlRow {
  version_id: string;
  asset_id: string;
  library_id: string;
  source_version_id: string | null;
  source_sha256: string;
  transform_json: string;
  idempotency_scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: MediaVersionStatus;
  storage_ref: string;
  output_sha256: string | null;
  mime_type: MediaVersionRecord['mimeType'];
  byte_size: number | null;
  width: number | null;
  height: number | null;
  error_code: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function assertQuickCheckResults(results: unknown): void {
  if (!Array.isArray(results) || results.length !== 1) throw new Error('database integrity check failed');
  const row: unknown = results[0];
  if (typeof row !== 'object' || row === null || !('quick_check' in row) || row.quick_check !== 'ok') {
    throw new Error('database integrity check failed');
  }
}

export function verifySqliteIntegrity(database: Database.Database): void {
  try {
    assertQuickCheckResults(database.prepare('PRAGMA quick_check').all());
  } catch {
    throw new Error('database integrity check failed');
  }
}

export class SqliteRepository implements UploadRepository {
  private albumOperationEventDrafter: AlbumOperationEventDrafter | undefined;
  private albumLifecycleEventDrafter: AlbumLifecycleEventDrafter | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly faults: RepositoryFaults = {},
    private readonly auditRepository?: AuditRepository
  ) {
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
  }

  setAlbumOperationEventDrafter(drafter: AlbumOperationEventDrafter): void {
    this.albumOperationEventDrafter = drafter;
  }

  setAlbumLifecycleEventDrafter(drafter: AlbumLifecycleEventDrafter): void {
    this.albumLifecycleEventDrafter = drafter;
  }

  verifyIntegrity(): void {
    verifySqliteIntegrity(this.db);
  }

  recoverInterruptedJobs(now: string): number {
    const recover = this.db.transaction(() => {
      this.db.prepare(`UPDATE upload_sessions SET state = 'failed', updated_at = ?
        WHERE state IN ('created', 'uploading', 'verifying') AND expires_at <= ?`).run(now, now);
      const expired = this.db.prepare(`UPDATE jobs SET state = 'failed', lease_until = NULL, updated_at = ?
        WHERE job_type = 'upload' AND state IN ('queued', 'running')
          AND EXISTS (SELECT 1 FROM upload_sessions s
            WHERE s.session_id = jobs.job_id AND s.state = 'failed' AND s.expires_at <= ?)`).run(now, now);
      const requeued = this.db.prepare(`UPDATE jobs SET state = 'queued', lease_until = NULL, updated_at = ?
        WHERE job_type = 'upload' AND state = 'running'
          AND EXISTS (SELECT 1 FROM upload_sessions s
            WHERE s.session_id = jobs.job_id AND s.state IN ('created', 'uploading', 'verifying') AND s.expires_at > ?)`)
        .run(now, now);
      return expired.changes + requeued.changes;
    });
    return recover.immediate();
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

  setLocalIdentity(peerId: string, publicKey: string, createdAt: string): void {
    const existing = this.db.prepare('SELECT peer_id, public_key FROM node_identity WHERE singleton = 1').get() as
      { peer_id: string; public_key: string } | undefined;
    if (existing) {
      if (existing.peer_id !== peerId || existing.public_key !== publicKey) {
        throw new RepositoryConflictError('local node identity cannot be silently replaced');
      }
      return;
    }
    this.db.prepare('INSERT INTO node_identity (singleton, peer_id, public_key, created_at) VALUES (1, ?, ?, ?)')
      .run(peerId, publicKey, createdAt);
  }

  getLocalIdentity(): { peerId: string; publicKey: string } | undefined {
    const row = this.db.prepare('SELECT peer_id, public_key FROM node_identity WHERE singleton = 1').get() as
      { peer_id: string; public_key: string } | undefined;
    return row ? { peerId: row.peer_id, publicKey: row.public_key } : undefined;
  }

  createPairingInvite(record: PairingInviteRecord): void {
    this.db.prepare(`INSERT INTO pairing_invites (invite_id, secret_sha256, created_at, expires_at)
      VALUES (@inviteId, @secretSha256, @createdAt, @expiresAt)`).run(record);
  }

  consumePairingInvite(inviteId: string, secretSha256: string, now: string): boolean {
    const consume = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT secret_sha256, expires_at, consumed_at FROM pairing_invites WHERE invite_id = ?`)
        .get(inviteId) as { secret_sha256: string; expires_at: string; consumed_at: string | null } | undefined;
      if (!row || row.consumed_at !== null || row.expires_at <= now || !safeHashEquals(row.secret_sha256, secretSha256)) return false;
      const result = this.db.prepare(`UPDATE pairing_invites SET consumed_at = ?
        WHERE invite_id = ? AND consumed_at IS NULL AND expires_at > ?`).run(now, inviteId, now);
      return result.changes === 1;
    });
    return consume.immediate();
  }

  trustPeer(record: TrustedPeerRecord): void {
    const existing = this.getTrustedPeer(record.peerId);
    if (existing?.trustState === 'revoked') throw new RepositoryConflictError('revoked peer identity cannot be re-trusted');
    this.db.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
      VALUES (@peerId, @publicKey, @label, 'trusted', @createdAt, NULL)
      ON CONFLICT(peer_id) DO UPDATE SET public_key = excluded.public_key, label = excluded.label
      WHERE trusted_peers.trust_state = 'trusted'`).run(record);
  }

  getTrustedPeer(peerId: string): TrustedPeerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM trusted_peers WHERE peer_id = ?').get(peerId) as {
      peer_id: string; public_key: string; label: string; trust_state: 'trusted' | 'revoked'; created_at: string; revoked_at: string | null;
    } | undefined;
    return row ? {
      peerId: row.peer_id, publicKey: row.public_key, label: row.label,
      trustState: row.trust_state, createdAt: row.created_at, revokedAt: row.revoked_at
    } : undefined;
  }

  listTrustedPeers(): TrustedPeerRecord[] {
    const rows = this.db.prepare('SELECT * FROM trusted_peers ORDER BY created_at, peer_id').all() as Array<{
      peer_id: string; public_key: string; label: string; trust_state: 'trusted' | 'revoked'; created_at: string; revoked_at: string | null;
    }>;
    return rows.map((row) => ({
      peerId: row.peer_id, publicKey: row.public_key, label: row.label,
      trustState: row.trust_state, createdAt: row.created_at, revokedAt: row.revoked_at
    }));
  }

  revokePeer(peerId: string, revokedAt: string): boolean {
    const result = this.db.prepare(`UPDATE trusted_peers SET trust_state = 'revoked', revoked_at = ?
      WHERE peer_id = ? AND trust_state = 'trusted'`).run(revokedAt, peerId);
    return result.changes === 1;
  }

  grantLibraryRead(peerId: string, libraryId: string, createdAt: string): void {
    if (this.getTrustedPeer(peerId)?.trustState !== 'trusted') throw new RepositoryConflictError('library read grant requires a trusted peer');
    this.db.prepare(`INSERT OR IGNORE INTO library_grants (peer_id, library_id, permission, created_at)
      SELECT peer_id, ?, 'read', ? FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`)
      .run(libraryId, createdAt, peerId);
    const grant = this.db.prepare(`SELECT 1 FROM library_grants WHERE peer_id = ? AND library_id = ? AND permission = 'read'`)
      .get(peerId, libraryId);
    if (!grant) throw new RepositoryConflictError('library read grant requires a trusted peer');
  }

  canReadLibrary(peerId: string, libraryId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM trusted_peers p JOIN library_grants g ON g.peer_id = p.peer_id
      WHERE p.peer_id = ? AND p.trust_state = 'trusted' AND g.library_id = ? AND g.permission = 'read'`)
      .get(peerId, libraryId) !== undefined;
  }

  listLibraryIndex(peerId: string, libraryId: string): LibraryIndexAsset[] | undefined {
    if (!this.canReadLibrary(peerId, libraryId)) return undefined;
    const rows = this.db.prepare(`SELECT a.asset_id, a.library_id, a.origin_node_id, a.kind, f.sha256,
        COALESCE((SELECT CASE WHEN l.availability IN ('online', 'cached') THEN l.availability ELSE l.availability END
          FROM file_locations l WHERE l.file_id = f.file_id ORDER BY CASE l.availability WHEN 'online' THEN 0 WHEN 'cached' THEN 1 ELSE 2 END LIMIT 1), 'missing') AS availability
      FROM assets a JOIN asset_files f ON f.asset_id = a.asset_id AND f.media_role = 'original'
      WHERE a.library_id = ? AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p
        WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
      ORDER BY a.created_at DESC, a.asset_id`).all(libraryId) as Array<{
        asset_id: string; library_id: string; origin_node_id: string; kind: AssetKind; sha256: string;
        availability: LibraryIndexAsset['availability'];
      }>;
    const assets = new Map(rows.map((row) => [row.asset_id, {
      assetId: row.asset_id, libraryId: row.library_id, originNodeId: row.origin_node_id,
      kind: row.kind, sha256: row.sha256, availability: row.availability
    }]));
    const projections = this.db.prepare(`SELECT p.asset_id, p.library_id, p.origin_node_id, p.kind, p.sha256
      FROM sync_asset_projection p WHERE p.library_id = ? AND p.tombstone_event_id IS NULL`).all(libraryId) as Array<{
        asset_id: string; library_id: string; origin_node_id: string; kind: AssetKind; sha256: string;
      }>;
    for (const row of projections) if (!assets.has(row.asset_id)) assets.set(row.asset_id, {
      assetId: row.asset_id, libraryId: row.library_id, originNodeId: row.origin_node_id,
      kind: row.kind, sha256: row.sha256, availability: 'missing'
    });
    return [...assets.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
  }

  listGalleryLibraries(): Array<{ libraryId: string; title: string }> {
    const rows = this.db.prepare(`SELECT library_id FROM assets UNION SELECT library_id FROM sync_asset_projection
      ORDER BY library_id`).all() as Array<{ library_id: string }>;
    return rows.map((row) => ({ libraryId: row.library_id, title: row.library_id }));
  }

  createAlbum(input: AlbumOperationContext & { title: string }): AlbumRecord | 'writer_limit' | undefined {
    const write = this.db.transaction((): AlbumRecord | 'writer_limit' | undefined => {
      const replay = this.getAlbumOperationReplay<AlbumRecord>(input, ['album.created']);
      if (replay !== undefined) {
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.create', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: replay.albumId, outcome: 'replayed', requestId: input.requestId, createdAt: input.createdAt
        });
        return replay;
      }
      if (!this.hasGalleryLibrary(input.libraryId)) return undefined;
      if (!this.canAuthorAlbumOperation(input.libraryId, input.authorPeerId)) return 'writer_limit';
      const album: AlbumRecord = {
        albumId: randomUUID(), libraryId: input.libraryId, title: input.title,
        createdByPeerId: input.authorPeerId, createdAt: input.createdAt
      };
      this.db.prepare(`INSERT INTO albums (album_id, library_id, title, created_by_peer_id, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(album.albumId, album.libraryId, album.title, album.createdByPeerId, album.createdAt);
      this.insertAlbumOperation(input, album.albumId, null, 'album.created', album);
      this.albumOperationEventDrafter?.({
        operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId,
        albumId: album.albumId, assetId: null, operationType: 'album.created', createdAt: input.createdAt, title: album.title
      });
      appendMetadataAudit(this.auditRepository, {
        action: 'virtual_album.create', resourceType: 'virtual_album', libraryId: input.libraryId,
        resourceId: album.albumId, outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      this.faults.beforeAlbumOperationCommit?.();
      return album;
    });
    return write.immediate();
  }

  listAlbums(libraryId: string, cursor: string | undefined, limit: number): AlbumPage | undefined {
    this.validateAlbumLimit(limit);
    if (!this.hasGalleryLibrary(libraryId)) return undefined;
    const scope: AlbumCursorScope = { collection: 'albums', libraryId };
    const lastId = cursor === undefined ? undefined : decodeAlbumCursor(cursor, scope);
    const visibilityFilter = this.hasAlbumLifecycleTables() ? `
        AND NOT EXISTS (SELECT 1 FROM album_local_visibility v WHERE v.library_id = albums.library_id AND v.album_id = albums.album_id)
        AND NOT EXISTS (SELECT 1 FROM album_global_delete_tokens d WHERE d.library_id = albums.library_id AND d.album_id = albums.album_id
          AND NOT EXISTS (SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id = d.delete_event_id))` : '';
    const rows = this.db.prepare(`SELECT album_id, library_id, title, created_by_peer_id, created_at FROM albums
      WHERE library_id = ? ${visibilityFilter}
        ${lastId === undefined ? '' : 'AND album_id COLLATE BINARY > ?'}
      ORDER BY album_id COLLATE BINARY LIMIT ?`).all(
        libraryId, ...(lastId === undefined ? [] : [lastId]), limit + 1
      ) as AlbumSqlRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toAlbumRecord);
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? encodeAlbumCursor(scope, items[items.length - 1]!.albumId) : null
    };
  }

  listDeletedAlbums(libraryId: string, scope: AlbumDeletedQueryScope, cursor: string | undefined, limit: number): DeletedAlbumPage | undefined {
    this.validateAlbumLimit(limit);
    if (!this.hasAlbumLifecycleTables() || !this.hasGalleryLibrary(libraryId)) return undefined;
    const cursorScope: AlbumCursorScope = { collection: 'deleted', libraryId, scope };
    const lastId = cursor === undefined ? undefined : decodeAlbumCursor(cursor, cursorScope);
    const filter = scope === 'all' ? '(local_hidden_at IS NOT NULL OR global_deleted_at IS NOT NULL)'
      : scope === 'local' ? 'local_hidden_at IS NOT NULL' : 'global_deleted_at IS NOT NULL';
    const rows = this.db.prepare(`WITH active_global AS (
        SELECT d.library_id, d.album_id, MAX(d.created_at) AS global_deleted_at
        FROM album_global_delete_tokens d
        WHERE NOT EXISTS (SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id = d.delete_event_id)
        GROUP BY d.library_id, d.album_id
      ), album_state AS (
        SELECT a.album_id, a.library_id, a.title, a.created_by_peer_id, a.created_at,
          v.hidden_at AS local_hidden_at, g.global_deleted_at
        FROM albums a
        LEFT JOIN album_local_visibility v ON v.library_id = a.library_id AND v.album_id = a.album_id
        LEFT JOIN active_global g ON g.library_id = a.library_id AND g.album_id = a.album_id
        WHERE a.library_id = ?
      )
      SELECT album_id, library_id, title, created_by_peer_id, created_at, local_hidden_at, global_deleted_at
      FROM album_state WHERE ${filter} ${lastId === undefined ? '' : 'AND album_id COLLATE BINARY > ?'}
      ORDER BY album_id COLLATE BINARY LIMIT ?`).all(
        libraryId, ...(lastId === undefined ? [] : [lastId]), limit + 1
      ) as DeletedAlbumSqlRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row): DeletedAlbumRecord => {
      const scopes: AlbumDeleteScope[] = [];
      if (row.local_hidden_at !== null) scopes.push('local');
      if (row.global_deleted_at !== null) scopes.push('global');
      const deletedAt = [row.local_hidden_at, row.global_deleted_at].filter((value): value is string => value !== null).sort()[0]!;
      return { ...toAlbumRecord(row), scopes, deletedAt };
    });
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? encodeAlbumCursor(cursorScope, items[items.length - 1]!.albumId) : null
    };
  }

  deleteAlbum(input: AlbumOperationContext & { albumId: string; scope: AlbumDeleteScope }): AlbumDeletionResult {
    const write = this.db.transaction((): AlbumDeletionResult => {
      const replay = this.getAlbumLifecycleReplay<AlbumDeletionResult>(input, input.scope, ['local.hidden', 'local.hide.noop', 'album.deleted', 'album.delete.noop']);
      if (replay !== undefined) {
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.delete', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: 'replayed', requestId: input.requestId, createdAt: input.createdAt
        });
        return replay;
      }
      if (!this.hasAlbum(input.libraryId, input.albumId)) return 'not_found';
      if (input.scope === 'local') {
        const hidden = this.db.prepare('SELECT 1 FROM album_local_visibility WHERE library_id = ? AND album_id = ?')
          .get(input.libraryId, input.albumId);
        const result: AlbumDeletionResult = hidden ? 'already_deleted' : 'deleted';
        const operationType = hidden ? 'local.hide.noop' : 'local.hidden';
        this.insertAlbumVisibilityOperation(input, input.albumId, operationType, result);
        if (!hidden) this.db.prepare(`INSERT INTO album_local_visibility(library_id,album_id,operation_id,hidden_at) VALUES(?,?,?,?)`)
          .run(input.libraryId, input.albumId, input.operationId, input.createdAt);
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.delete', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: hidden ? 'unchanged' : 'applied', requestId: input.requestId, createdAt: input.createdAt
        });
        this.faults.beforeAlbumOperationCommit?.();
        return result;
      }
      if (!this.canAuthorAlbumLifecycleOperation(input.libraryId, input.authorPeerId)) return 'writer_limit';
      const active = this.getActiveAlbumDeleteIds(input.libraryId, input.albumId);
      if (active.length > 0) {
        const result: AlbumDeletionResult = 'already_deleted';
        this.insertAlbumLifecycleOperation(input, input.albumId, 'album.delete.noop', [], result);
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.delete', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        this.faults.beforeAlbumOperationCommit?.();
        return result;
      }
      if (!this.albumLifecycleEventDrafter) throw new RepositoryConflictError('album lifecycle event drafter is unavailable');
      const result: AlbumDeletionResult = 'deleted';
      this.insertAlbumLifecycleOperation(input, input.albumId, 'album.deleted', [], result);
      this.db.prepare(`INSERT INTO album_global_delete_tokens(delete_event_id,library_id,album_id,author_peer_id,created_at)
        VALUES(?,?,?,?,?)`).run(input.operationId, input.libraryId, input.albumId, input.authorPeerId, input.createdAt);
      this.albumLifecycleEventDrafter({
        operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId,
        albumId: input.albumId, operationType: 'album.deleted', createdAt: input.createdAt
      });
      appendMetadataAudit(this.auditRepository, {
        action: 'virtual_album.delete', resourceType: 'virtual_album', libraryId: input.libraryId,
        resourceId: input.albumId, scope: input.scope, outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      this.faults.beforeAlbumOperationCommit?.();
      return result;
    });
    return write.immediate();
  }

  restoreAlbum(input: AlbumOperationContext & { albumId: string; scope: AlbumDeleteScope }): AlbumRestoreResult {
    const write = this.db.transaction((): AlbumRestoreResult => {
      const replay = this.getAlbumLifecycleReplay<AlbumRestoreResult>(input, input.scope, ['local.restored', 'local.restore.noop', 'album.restored', 'album.restore.noop']);
      if (replay !== undefined) {
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.restore', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: 'replayed', requestId: input.requestId, createdAt: input.createdAt
        });
        return replay;
      }
      if (!this.hasAlbum(input.libraryId, input.albumId)) return 'not_found';
      if (input.scope === 'local') {
        const hidden = this.db.prepare('SELECT 1 FROM album_local_visibility WHERE library_id = ? AND album_id = ?')
          .get(input.libraryId, input.albumId);
        const result: AlbumRestoreResult = hidden ? 'restored' : 'already_active';
        const operationType = hidden ? 'local.restored' : 'local.restore.noop';
        this.insertAlbumVisibilityOperation(input, input.albumId, operationType, result);
        if (hidden) this.db.prepare('DELETE FROM album_local_visibility WHERE library_id = ? AND album_id = ?')
          .run(input.libraryId, input.albumId);
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.restore', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: hidden ? 'applied' : 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        this.faults.beforeAlbumOperationCommit?.();
        return result;
      }
      const observedDeleteIds = this.getActiveAlbumDeleteIds(input.libraryId, input.albumId);
      if (observedDeleteIds.length > 64) return 'writer_limit';
      if (!this.canAuthorAlbumLifecycleOperation(input.libraryId, input.authorPeerId)) return 'writer_limit';
      if (observedDeleteIds.length === 0) {
        const result: AlbumRestoreResult = 'already_active';
        this.insertAlbumLifecycleOperation(input, input.albumId, 'album.restore.noop', [], result);
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.restore', resourceType: 'virtual_album', libraryId: input.libraryId,
          resourceId: input.albumId, scope: input.scope, outcome: 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        this.faults.beforeAlbumOperationCommit?.();
        return result;
      }
      if (!this.albumLifecycleEventDrafter) throw new RepositoryConflictError('album lifecycle event drafter is unavailable');
      const result: AlbumRestoreResult = 'restored';
      this.insertAlbumLifecycleOperation(input, input.albumId, 'album.restored', observedDeleteIds, result);
      const insertTarget = this.db.prepare(`INSERT INTO album_global_restore_targets
        (restore_operation_id,observed_delete_event_id,library_id,album_id) VALUES(?,?,?,?)`);
      for (const deleteEventId of observedDeleteIds) insertTarget.run(input.operationId, deleteEventId, input.libraryId, input.albumId);
      this.albumLifecycleEventDrafter({
        operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId,
        albumId: input.albumId, operationType: 'album.restored', createdAt: input.createdAt, observedDeleteIds
      });
      appendMetadataAudit(this.auditRepository, {
        action: 'virtual_album.restore', resourceType: 'virtual_album', libraryId: input.libraryId,
        resourceId: input.albumId, scope: input.scope, outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      this.faults.beforeAlbumOperationCommit?.();
      return result;
    });
    return write.immediate();
  }

  listAlbumMembers(libraryId: string, albumId: string, cursor: string | undefined, limit: number): AlbumMemberPage | undefined {
    this.validateAlbumLimit(limit);
    if (!this.hasVisibleAlbum(libraryId, albumId)) return undefined;
    const scope: AlbumCursorScope = { collection: 'members', libraryId, albumId };
    const lastId = cursor === undefined ? undefined : decodeAlbumCursor(cursor, scope);
    const rows = this.db.prepare(`SELECT DISTINCT m.asset_id FROM album_memberships m
      WHERE m.library_id = ? AND m.album_id = ? ${lastId === undefined ? '' : 'AND m.asset_id COLLATE BINARY > ?'}
        AND EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = m.library_id AND a.asset_id = m.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id
              AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
          UNION ALL
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = m.library_id AND p.asset_id = m.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
        )
      ORDER BY m.asset_id COLLATE BINARY LIMIT ?`).all(
        libraryId, albumId, ...(lastId === undefined ? [] : [lastId]), limit + 1
      ) as Array<{ asset_id: string }>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({ assetId: row.asset_id }));
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? encodeAlbumCursor(scope, items[items.length - 1]!.assetId) : null
    };
  }

  addAlbumMember(input: AlbumOperationContext & { albumId: string; assetId: string }): AlbumMemberMutationResult {
    const write = this.db.transaction((): AlbumMemberMutationResult => {
      const replay = this.getAlbumOperationReplay<AlbumMemberMutationResult>(input, ['member.added', 'member.add.noop']);
      if (replay !== undefined) {
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.member.add', resourceType: 'virtual_album_member', libraryId: input.libraryId,
          resourceId: input.assetId, relatedResourceId: input.albumId, outcome: 'replayed', requestId: input.requestId, createdAt: input.createdAt
        });
        return replay;
      }
      if (!this.hasVisibleAlbum(input.libraryId, input.albumId) || !this.hasVisibleGalleryAsset(input.libraryId, input.assetId)) {
        return { status: 'not_found' };
      }
      if (!this.canAuthorAlbumOperation(input.libraryId, input.authorPeerId)) return { status: 'writer_limit' };
      const active = this.db.prepare(`SELECT add_operation_id FROM album_memberships
        WHERE library_id = ? AND album_id = ? AND asset_id = ? AND author_peer_id = ?`)
        .get(input.libraryId, input.albumId, input.assetId, input.authorPeerId) as { add_operation_id: string } | undefined;
      if (active) {
        const result: AlbumMemberMutationResult = { status: 'already_present' };
        this.insertAlbumOperation(input, input.albumId, input.assetId, 'member.add.noop', result);
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.member.add', resourceType: 'virtual_album_member', libraryId: input.libraryId,
          resourceId: input.assetId, relatedResourceId: input.albumId, outcome: 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        this.faults.beforeAlbumOperationCommit?.();
        return result;
      }
      const result: AlbumMemberMutationResult = { status: 'added' };
      this.insertAlbumOperation(input, input.albumId, input.assetId, 'member.added', result);
      this.db.prepare(`INSERT INTO album_memberships
        (library_id, album_id, asset_id, author_peer_id, add_operation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.libraryId, input.albumId, input.assetId,
          input.authorPeerId, input.operationId, input.createdAt);
      this.albumOperationEventDrafter?.({
        operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId,
        albumId: input.albumId, assetId: input.assetId, operationType: 'member.added', createdAt: input.createdAt
      });
      appendMetadataAudit(this.auditRepository, {
        action: 'virtual_album.member.add', resourceType: 'virtual_album_member', libraryId: input.libraryId,
        resourceId: input.assetId, relatedResourceId: input.albumId, outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      this.faults.beforeAlbumOperationCommit?.();
      return result;
    });
    return write.immediate();
  }

  removeAlbumMember(input: AlbumOperationContext & { albumId: string; assetId: string }): AlbumMemberMutationResult {
    const write = this.db.transaction((): AlbumMemberMutationResult => {
      const replay = this.getAlbumOperationReplay<AlbumMemberMutationResult>(input, ['member.removed', 'member.remove.noop']);
      if (replay !== undefined) {
        appendMetadataAudit(this.auditRepository, {
          action: 'virtual_album.member.remove', resourceType: 'virtual_album_member', libraryId: input.libraryId,
          resourceId: input.assetId, relatedResourceId: input.albumId, outcome: 'replayed', requestId: input.requestId, createdAt: input.createdAt
        });
        return replay;
      }
      if (!this.hasVisibleAlbum(input.libraryId, input.albumId) || !this.hasVisibleGalleryAsset(input.libraryId, input.assetId)) {
        return { status: 'not_found' };
      }
      if (!this.canAuthorAlbumOperation(input.libraryId, input.authorPeerId)) return { status: 'writer_limit' };
      const targets = this.db.prepare(`SELECT add_operation_id FROM album_memberships
        WHERE library_id = ? AND album_id = ? AND asset_id = ? ORDER BY add_operation_id COLLATE BINARY`)
        .all(input.libraryId, input.albumId, input.assetId) as Array<{ add_operation_id: string }>;
      if (targets.length > 64) return { status: 'writer_limit' };
      const observedAddIds = targets.map((target) => target.add_operation_id);
      const result: AlbumMemberMutationResult = targets.length > 0
        ? { status: 'removed', observedAddIds }
        : { status: 'unchanged', observedAddIds: [] };
      const operationType = targets.length > 0 ? 'member.removed' : 'member.remove.noop';
      this.insertAlbumOperation(input, input.albumId, input.assetId, operationType, result);
      for (const target of targets) {
        this.db.prepare(`INSERT INTO album_membership_remove_targets
          (remove_operation_id, observed_add_operation_id, library_id, album_id, asset_id)
          VALUES (?, ?, ?, ?, ?)`).run(input.operationId, target.add_operation_id,
            input.libraryId, input.albumId, input.assetId);
        this.db.prepare(`DELETE FROM album_memberships WHERE library_id = ? AND album_id = ? AND asset_id = ?
          AND add_operation_id = ?`).run(input.libraryId, input.albumId, input.assetId, target.add_operation_id);
      }
      if (targets.length > 0) this.albumOperationEventDrafter?.({
        operationId: input.operationId, authorPeerId: input.authorPeerId, libraryId: input.libraryId,
        albumId: input.albumId, assetId: input.assetId, operationType: 'member.removed', createdAt: input.createdAt,
        observedAddIds
      });
      appendMetadataAudit(this.auditRepository, {
        action: 'virtual_album.member.remove', resourceType: 'virtual_album_member', libraryId: input.libraryId,
        resourceId: input.assetId, relatedResourceId: input.albumId,
        outcome: targets.length > 0 ? 'applied' : 'unchanged', requestId: input.requestId, createdAt: input.createdAt
      });
      this.faults.beforeAlbumOperationCommit?.();
      return result;
    });
    return write.immediate();
  }

  addAssetTag(libraryId: string, assetId: string, tag: string, createdAt: string, requestId?: string): AssetTagMutationResult {
    const write = this.db.transaction((): AssetTagMutationResult => {
      if (!this.hasVisibleGalleryAsset(libraryId, assetId)) return 'not_found';
      if (this.db.prepare('SELECT 1 FROM asset_tags WHERE library_id = ? AND asset_id = ? AND tag = ?')
        .get(libraryId, assetId, tag)) {
        appendMetadataAudit(this.auditRepository, {
          action: 'asset.tag.add', resourceType: 'asset', libraryId, resourceId: assetId,
          outcome: 'unchanged', requestId, createdAt
        });
        return 'already_present';
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE library_id = ? AND asset_id = ?')
        .get(libraryId, assetId) as { count: number };
      if (count.count >= maxAssetTagsPerAsset) return 'limit_reached';
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO asset_tags (library_id, asset_id, tag, created_at)
        VALUES (?, ?, ?, ?)`).run(libraryId, assetId, tag, createdAt);
      const result = inserted.changes === 1 ? 'added' : 'already_present';
      appendMetadataAudit(this.auditRepository, {
        action: 'asset.tag.add', resourceType: 'asset', libraryId, resourceId: assetId,
        outcome: inserted.changes === 1 ? 'applied' : 'unchanged', requestId, createdAt
      });
      return result;
    });
    return write.immediate();
  }

  removeAssetTag(libraryId: string, assetId: string, tag: string, createdAt: string = new Date().toISOString(), requestId?: string): AssetTagMutationResult {
    const write = this.db.transaction((): AssetTagMutationResult => {
      if (!this.hasVisibleGalleryAsset(libraryId, assetId)) return 'not_found';
      const removed = this.db.prepare('DELETE FROM asset_tags WHERE library_id = ? AND asset_id = ? AND tag = ?')
        .run(libraryId, assetId, tag);
      appendMetadataAudit(this.auditRepository, {
        action: 'asset.tag.remove', resourceType: 'asset', libraryId, resourceId: assetId,
        outcome: removed.changes === 1 ? 'applied' : 'unchanged', requestId, createdAt
      });
      return removed.changes === 1 ? 'removed' : 'unchanged';
    });
    return write.immediate();
  }

  private hasGalleryLibrary(libraryId: string): boolean {
    const row = this.db.prepare(`SELECT EXISTS (
      SELECT 1 FROM assets WHERE library_id = ?
      UNION ALL SELECT 1 FROM sync_asset_projection WHERE library_id = ?
    ) AS present`).get(libraryId, libraryId) as { present: number };
    return row.present === 1;
  }

  private hasAlbum(libraryId: string, albumId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM albums WHERE library_id = ? AND album_id = ?').get(libraryId, albumId));
  }

  private hasAlbumLifecycleTables(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='album_global_delete_tokens'").get());
  }

  private hasVisibleAlbum(libraryId: string, albumId: string): boolean {
    if (!this.hasAlbumLifecycleTables()) return this.hasAlbum(libraryId, albumId);
    return Boolean(this.db.prepare(`SELECT 1 FROM albums a WHERE a.library_id = ? AND a.album_id = ?
      AND NOT EXISTS (SELECT 1 FROM album_local_visibility v WHERE v.library_id = a.library_id AND v.album_id = a.album_id)
      AND NOT EXISTS (SELECT 1 FROM album_global_delete_tokens d WHERE d.library_id = a.library_id AND d.album_id = a.album_id
        AND NOT EXISTS (SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id = d.delete_event_id))`)
      .get(libraryId, albumId));
  }

  private canAuthorAlbumLifecycleOperation(libraryId: string, authorPeerId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM album_sync_author_registry WHERE library_id = ? AND author_peer_id = ?')
      .get(libraryId, authorPeerId)) return true;
    const count = this.db.prepare('SELECT count(*) AS count FROM album_sync_author_registry WHERE library_id = ?')
      .get(libraryId) as { count: number };
    return count.count < 64;
  }

  private getActiveAlbumDeleteIds(libraryId: string, albumId: string): string[] {
    return (this.db.prepare(`SELECT d.delete_event_id FROM album_global_delete_tokens d
      WHERE d.library_id = ? AND d.album_id = ?
        AND NOT EXISTS (SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id = d.delete_event_id)
      ORDER BY d.delete_event_id COLLATE BINARY`).all(libraryId, albumId) as Array<{ delete_event_id: string }>)
      .map((row) => row.delete_event_id);
  }

  private insertAlbumLifecycleOperation(
    input: AlbumOperationContext,
    albumId: string,
    operationType: 'album.deleted' | 'album.delete.noop' | 'album.restored' | 'album.restore.noop',
    observedDeleteIds: readonly string[],
    result: AlbumDeletionResult | AlbumRestoreResult
  ): void {
    this.db.prepare(`INSERT INTO album_lifecycle_operations
      (operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,request_fingerprint,
       observed_delete_event_ids_json,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(input.operationId, input.principalId, input.authorPeerId, input.libraryId, albumId, operationType,
        input.requestFingerprint, JSON.stringify(observedDeleteIds), JSON.stringify(result), input.createdAt);
  }

  private insertAlbumVisibilityOperation(
    input: AlbumOperationContext,
    albumId: string,
    operationType: 'local.hidden' | 'local.hide.noop' | 'local.restored' | 'local.restore.noop',
    result: AlbumDeletionResult | AlbumRestoreResult
  ): void {
    this.db.prepare(`INSERT INTO album_visibility_operations
      (operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,request_fingerprint,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(input.operationId, input.principalId, input.authorPeerId, input.libraryId, albumId, operationType,
        input.requestFingerprint, JSON.stringify(result), input.createdAt);
  }

  private getAlbumLifecycleReplay<T>(
    input: AlbumOperationContext,
    scope: AlbumDeleteScope,
    allowedTypes: readonly string[]
  ): T | undefined {
    type LifecycleReplayRow = { principal_id: string; request_fingerprint: string; operation_type: string; result_json: string };
    const local = this.db.prepare(`SELECT principal_id,request_fingerprint,operation_type,result_json FROM album_visibility_operations WHERE operation_id=?`)
      .get(input.operationId) as LifecycleReplayRow | undefined;
    const global = this.db.prepare(`SELECT principal_id,request_fingerprint,operation_type,result_json FROM album_lifecycle_operations WHERE operation_id=?`)
      .get(input.operationId) as LifecycleReplayRow | undefined;
    const priorAlbumOperation = this.db.prepare('SELECT 1 FROM album_operations WHERE operation_id=?').get(input.operationId);
    const expected = scope === 'local' ? local : global;
    const opposite = scope === 'local' ? global : local;
    if (!expected) {
      const registered = this.db.prepare('SELECT 1 FROM sync_global_id_registry WHERE global_id=?').get(input.operationId);
      if (opposite || priorAlbumOperation || registered) {
        throw new RepositoryConflictError('album idempotency key conflicts with an existing operation');
      }
      return undefined;
    }
    if (opposite || priorAlbumOperation || expected.principal_id !== input.principalId ||
        expected.request_fingerprint !== input.requestFingerprint || !allowedTypes.includes(expected.operation_type)) {
      throw new RepositoryConflictError('album idempotency key conflicts with an existing operation');
    }
    return JSON.parse(expected.result_json) as T;
  }

  private canAuthorAlbumOperation(libraryId: string, authorPeerId: string): boolean {
    const known = this.db.prepare('SELECT 1 FROM album_operations WHERE library_id = ? AND author_peer_id = ? LIMIT 1')
      .get(libraryId, authorPeerId);
    if (known) return true;
    const count = this.db.prepare('SELECT count(DISTINCT author_peer_id) AS count FROM album_operations WHERE library_id = ?')
      .get(libraryId) as { count: number };
    return count.count < 64;
  }

  private validateAlbumLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('invalid album page limit');
  }

  private insertAlbumOperation(
    input: AlbumOperationContext,
    albumId: string,
    assetId: string | null,
    operationType: 'album.created' | 'member.added' | 'member.add.noop' | 'member.removed' | 'member.remove.noop',
    result: unknown
  ): void {
    this.db.prepare(`INSERT INTO album_operations
      (operation_id, principal_id, author_peer_id, library_id, album_id, asset_id, operation_type,
       request_fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.operationId, input.principalId, input.authorPeerId, input.libraryId, albumId, assetId,
        operationType, input.requestFingerprint, JSON.stringify(result), input.createdAt
      );
  }

  private getAlbumOperationReplay<T>(input: AlbumOperationContext, allowedTypes: readonly string[]): T | undefined {
    const row = this.db.prepare(`SELECT principal_id, request_fingerprint, operation_type, result_json
      FROM album_operations WHERE operation_id = ?`).get(input.operationId) as {
        principal_id: string; request_fingerprint: string; operation_type: string; result_json: string;
      } | undefined;
    if (!row) {
      if (this.hasAlbumLifecycleTables() && this.db.prepare('SELECT 1 FROM sync_global_id_registry WHERE global_id = ?').get(input.operationId)) {
        throw new RepositoryConflictError('album idempotency key conflicts with an existing operation');
      }
      return undefined;
    }
    if (row.principal_id !== input.principalId || row.request_fingerprint !== input.requestFingerprint ||
      !allowedTypes.includes(row.operation_type)) {
      throw new RepositoryConflictError('album idempotency key conflicts with an existing operation');
    }
    return JSON.parse(row.result_json) as T;
  }

  private hasVisibleGalleryAsset(libraryId: string, assetId: string): boolean {
    const row = this.db.prepare(`SELECT EXISTS (
      SELECT 1 FROM assets a WHERE a.library_id = ? AND a.asset_id = ?
        AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id
          AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
      UNION ALL
      SELECT 1 FROM sync_asset_projection p WHERE p.library_id = ? AND p.asset_id = ? AND p.tombstone_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
    ) AS visible`).get(libraryId, assetId, libraryId, assetId) as { visible: number };
    return row.visible === 1;
  }

  private listAssetTags(libraryId: string, assetIds: string[]): Map<string, string[]> {
    const result = new Map(assetIds.map((assetId) => [assetId, [] as string[]]));
    if (assetIds.length === 0) return result;
    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT asset_id, tag FROM asset_tags WHERE library_id = ? AND asset_id IN (${placeholders})
      ORDER BY asset_id COLLATE BINARY, tag COLLATE BINARY`).all(libraryId, ...assetIds) as Array<{ asset_id: string; tag: string }>;
    for (const row of rows) result.get(row.asset_id)?.push(row.tag);
    return result;
  }

  listGalleryAssets(
    libraryId: string, cursor: string | undefined, limit: number, search: GallerySearchFilters = {}
  ): { items: GalleryAssetRecord[]; nextCursor: string | null } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid gallery limit');
    const filters = normalizeGallerySearchFilters(search);
    const position = cursor ? decodeGalleryCursor(cursor, libraryId, filters) : undefined;
    const captureLocalExpression = "COALESCE(local_capture.capture_local_time,json_extract(remote_capture.metadata_json,'$.capture.localTime'))";
    const captureOffsetExpression = "COALESCE(local_capture.capture_offset_minutes,json_extract(remote_capture.metadata_json,'$.capture.offsetMinutes'))";
    const captureSourceExpression = `COALESCE(local_capture.capture_source,json_extract(remote_capture.metadata_json,'$.capture.source'),
      CASE WHEN c.captured_at IS NULL THEN 'unknown' ELSE 'legacy_unknown' END)`;
    const captureConfidenceExpression = `COALESCE(local_capture.capture_confidence,json_extract(remote_capture.metadata_json,'$.capture.confidence'),
      CASE WHEN c.captured_at IS NULL THEN 'unknown' ELSE 'unknown' END)`;
    const sortRankExpression = `CASE WHEN c.captured_at IS NOT NULL THEN 0 WHEN ${captureLocalExpression} IS NOT NULL THEN 1 ELSE 2 END`;
    const sortKeyExpression = `CASE WHEN c.captured_at IS NOT NULL THEN c.captured_at ELSE ${captureLocalExpression} END`;
    const where: string[] = ['c.library_id = ?'];
    const parameters: Array<string | number> = [libraryId];
    if (filters.q) {
      where.push(`c.rowid IN (SELECT rowid FROM gallery_search_fts WHERE gallery_search_fts MATCH ?)`);
      parameters.push(toFts5Phrase(filters.q));
    }
    if (filters.dateFrom) {
      where.push('c.captured_at >= ?');
      parameters.push(`${filters.dateFrom}T00:00:00.000Z`);
    }
    if (filters.dateTo) {
      where.push('c.captured_at < ?');
      parameters.push(`${filters.dateTo}T00:00:00.000Z`);
    }
    if (filters.kind) { where.push('c.kind = ?'); parameters.push(filters.kind); }
    if (filters.sourceKind) { where.push('c.source_kind = ?'); parameters.push(filters.sourceKind); }
    if (filters.availability) { where.push('c.availability = ?'); parameters.push(filters.availability); }
    if (position) {
      if (position.sortRank === 2) {
        where.push(`(${sortRankExpression} > ? OR (${sortRankExpression} = ? AND c.asset_id COLLATE BINARY < ?))`);
        parameters.push(position.sortRank, position.sortRank, position.assetId);
      } else {
        where.push(`(${sortRankExpression} > ? OR (${sortRankExpression} = ? AND
          (${sortKeyExpression} < ? OR (${sortKeyExpression} = ? AND c.asset_id COLLATE BINARY < ?))))`);
        parameters.push(position.sortRank, position.sortRank, position.sortKey!, position.sortKey!, position.assetId);
      }
    }
    const rows = this.db.prepare(`SELECT c.asset_id,c.library_id,c.origin_node_id,c.kind,c.captured_at AS captured_at,
        ${captureLocalExpression} AS capture_local_time,${captureOffsetExpression} AS capture_offset_minutes,
        ${captureSourceExpression} AS capture_source,${captureConfidenceExpression} AS capture_confidence,
        ${sortRankExpression} AS sort_rank,${sortKeyExpression} AS sort_key,
        c.sha256,c.byte_size,c.filename,NULLIF(c.source_path,'') AS source_path,c.source_kind,c.availability,
        CASE WHEN fav.asset_id IS NULL THEN 0 ELSE 1 END AS favorite,
        r.rating AS rating,COALESCE(r.conflict,0) AS rating_conflict,
        COALESCE(r.candidates_json,'[]') AS rating_candidates_json
      FROM gallery_search_content c
      LEFT JOIN assets local_capture ON local_capture.library_id=c.library_id AND local_capture.asset_id=c.asset_id
      LEFT JOIN sync_asset_projection remote_capture ON remote_capture.library_id=c.library_id AND remote_capture.asset_id=c.asset_id
      LEFT JOIN asset_favorites fav ON fav.library_id=c.library_id AND fav.asset_id=c.asset_id
      LEFT JOIN asset_rating_projection r ON r.library_id=c.library_id AND r.asset_id=c.asset_id
      WHERE ${where.join(' AND ')}
      ORDER BY sort_rank ASC,sort_key DESC,c.asset_id COLLATE BINARY DESC LIMIT ?`).all(...parameters, limit + 1) as GalleryAssetSqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const page = pageRows.map(toGalleryAsset);
    const last = pageRows.at(-1);
    const tagsByAsset = this.listAssetTags(libraryId, page.map((asset) => asset.assetId));
    return {
      items: page.map((asset) => ({ ...asset, tags: tagsByAsset.get(asset.assetId) ?? [] })),
      nextCursor: hasMore && last
        ? encodeGalleryCursor(last.sort_rank as 0 | 1 | 2, last.sort_key, last.asset_id, libraryId, filters)
        : null
    };
  }

  getGalleryMedia(assetId: string): GalleryMediaRecord | undefined {
    const row = this.db.prepare(`SELECT a.library_id, f.storage_ref, f.sha256, f.byte_size,
        COALESCE(l.original_filename, a.asset_id) AS filename,
        COALESCE(l.availability, 'missing') AS availability, l.storage_class, l.original_path
      FROM assets a JOIN asset_files f ON f.asset_id = a.asset_id AND f.media_role = 'original'
      LEFT JOIN file_locations l ON l.file_id = f.file_id
      WHERE a.asset_id = ? AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id
        AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
      ORDER BY CASE l.storage_class WHEN 'managed' THEN 0 ELSE 1 END LIMIT 1`).get(assetId) as {
        library_id: string; storage_ref: string; sha256: string; byte_size: number; filename: string;
        availability: GalleryMediaRecord['availability']; storage_class: string | null; original_path: string | null
      } | undefined;
    if (!row) return undefined;
    return { libraryId: row.library_id, storageRef: row.storage_ref, sha256: row.sha256, byteSize: row.byte_size,
      filename: row.filename, originalPath: row.original_path, availability: row.availability };
  }

  getMediaVersionSource(libraryId: string, assetId: string, sourceVersionId: string | null): MediaVersionSourceRecord | undefined {
    const asset = this.db.prepare(`SELECT a.kind FROM assets a WHERE a.asset_id = ? AND a.library_id = ?
      AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id
        AND p.tombstone_event_id IS NOT NULL)`).get(assetId, libraryId) as { kind: AssetKind } | undefined;
    if (!asset || asset.kind !== 'photo') return undefined;
    if (sourceVersionId === null) {
      const original = this.getGalleryMedia(assetId);
      if (!original || original.libraryId !== libraryId) return undefined;
      return { ...original, assetId, sourceVersionId: null, kind: asset.kind, mimeType: null };
    }
    const version = this.getMediaVersion(libraryId, assetId, sourceVersionId);
    if (!version || version.status !== 'ready' || !version.outputSha256 || !version.mimeType ||
      version.byteSize === null || version.width === null || version.height === null) return undefined;
    const original = this.getGalleryMedia(assetId);
    return {
      assetId, libraryId, sourceVersionId: version.versionId, kind: asset.kind,
      filename: original?.filename ?? assetId, sha256: version.outputSha256, byteSize: version.byteSize,
      storageRef: version.storageRef, originalPath: null, availability: 'online', mimeType: version.mimeType
    };
  }

  listMediaVersions(libraryId: string, assetId: string): MediaVersionRecord[] {
    const rows = this.db.prepare(`SELECT v.* FROM media_versions v JOIN assets a
      ON a.asset_id = v.asset_id AND a.library_id = v.library_id
      WHERE v.library_id = ? AND v.asset_id = ? AND NOT EXISTS (
        SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id
          AND p.tombstone_event_id IS NOT NULL)
      ORDER BY v.created_at, v.version_id`).all(libraryId, assetId) as MediaVersionSqlRow[];
    return rows.map(toMediaVersionRecord);
  }

  getMediaVersion(libraryId: string, assetId: string, versionId: string): MediaVersionRecord | undefined {
    const row = this.db.prepare(`SELECT v.* FROM media_versions v JOIN assets a
      ON a.asset_id = v.asset_id AND a.library_id = v.library_id
      WHERE v.library_id = ? AND v.asset_id = ? AND v.version_id = ? AND NOT EXISTS (
        SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id
          AND p.tombstone_event_id IS NOT NULL)`).get(libraryId, assetId, versionId) as MediaVersionSqlRow | undefined;
    return row ? toMediaVersionRecord(row) : undefined;
  }

  getMediaVersionById(versionId: string): MediaVersionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM media_versions WHERE version_id = ?').get(versionId) as MediaVersionSqlRow | undefined;
    return row ? toMediaVersionRecord(row) : undefined;
  }

  getMediaVersionByIdempotency(libraryId: string, scope: string, key: string): MediaVersionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM media_versions WHERE library_id = ? AND idempotency_scope = ? AND idempotency_key = ?')
      .get(libraryId, scope, key) as MediaVersionSqlRow | undefined;
    return row ? toMediaVersionRecord(row) : undefined;
  }

  createMediaVersion(record: CreateMediaVersionRecord): void {
    this.db.prepare(`INSERT INTO media_versions (
      version_id, asset_id, library_id, source_version_id, source_sha256, transform_json, idempotency_scope,
      idempotency_key, request_fingerprint, status, storage_ref, output_sha256, mime_type, byte_size, width, height,
      error_code, created_by, created_at, updated_at
    ) VALUES (
      @versionId, @assetId, @libraryId, @sourceVersionId, @sourceSha256, @transformJson, @idempotencyScope,
      @idempotencyKey, @requestFingerprint, 'staging', @storageRef, NULL, NULL, NULL, NULL, NULL,
      NULL, @createdBy, @createdAt, @createdAt
    )`).run({ ...record, transformJson: JSON.stringify(record.transform) });
  }

  markMediaVersionReady(versionId: string, output: {
    sha256: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; byteSize: number; width: number; height: number;
  }, now: string): boolean {
    const result = this.db.prepare(`UPDATE media_versions SET status = 'ready', output_sha256 = ?, mime_type = ?,
      byte_size = ?, width = ?, height = ?, updated_at = ? WHERE version_id = ? AND status = 'staging'`)
      .run(output.sha256, output.mimeType, output.byteSize, output.width, output.height, now, versionId);
    return result.changes === 1;
  }

  markMediaVersionFailed(versionId: string, errorCode: string, now: string): boolean {
    const result = this.db.prepare(`UPDATE media_versions SET status = 'failed', error_code = ?, updated_at = ?
      WHERE version_id = ? AND status = 'staging'`).run(errorCode, now, versionId);
    return result.changes === 1;
  }

  countStagingMediaVersions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM media_versions WHERE status = 'staging'").get() as { count: number };
    return row.count;
  }

  listStagingMediaVersions(): MediaVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM media_versions WHERE status = 'staging' ORDER BY created_at, version_id")
      .all() as MediaVersionSqlRow[];
    return rows.map(toMediaVersionRecord);
  }

  listActiveTombstones(libraryId?: string): Array<{ assetId: string; libraryId: string; eventId: string }> {
    const rows = libraryId
      ? this.db.prepare(`SELECT t.asset_id, t.library_id, t.event_id FROM sync_tombstones t
          WHERE t.library_id = ? AND t.restored_by_event_id IS NULL ORDER BY t.event_id`).all(libraryId)
      : this.db.prepare(`SELECT t.asset_id, t.library_id, t.event_id FROM sync_tombstones t
          WHERE t.restored_by_event_id IS NULL ORDER BY t.library_id, t.event_id`).all();
    return (rows as Array<{ asset_id: string; library_id: string; event_id: string }>).map((row) => ({
      assetId: row.asset_id, libraryId: row.library_id, eventId: row.event_id
    }));
  }

  markExternalLocationsOffline(nodeId: string): number {
    const result = this.db.prepare(`UPDATE file_locations SET availability = 'offline'
      WHERE node_id = ? AND storage_class = 'external' AND availability IN ('online', 'cached')`).run(nodeId);
    return result.changes;
  }

  getUploadSession(sessionId: string): UploadSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  listRecoverableUploadSessionIds(now: string): string[] {
    const rows = this.db.prepare(`SELECT s.session_id FROM upload_sessions s
      JOIN jobs j ON j.job_id = s.session_id
      WHERE j.job_type = 'upload' AND j.state IN ('queued', 'running')
        AND s.state IN ('created', 'uploading', 'verifying')
        AND s.offset_bytes = s.total_bytes AND s.expires_at > ?
      ORDER BY s.created_at, s.session_id`).all(now) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
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

  finalizeUpload(sessionId: string, assetId: string, fileId: string, locationId: string, nodeId: string, now: string,
    captureDate: CaptureDateMetadata, eventFactory?: EventDraftFactory): void {
    if (!isCaptureDateMetadata(captureDate)) throw new RepositoryConflictError('capture date metadata is invalid');
    const finalize = this.db.transaction(() => {
      const session = this.getUploadSession(sessionId);
      if (!session) throw new RepositoryConflictError('upload session not found');
      if (session.state === 'completed') return;
      if (session.state !== 'verifying' || session.offset !== session.totalBytes) throw new RepositoryConflictError('upload is not ready to finalize');
      this.faults.beforeFinalize?.();
      this.db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, capture_local_time,
        capture_offset_minutes, capture_source, capture_confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(assetId, session.libraryId, nodeId, session.kind, captureDate.capturedAt,
          captureDate.localTime, captureDate.offsetMinutes, captureDate.source, captureDate.confidence, now);
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
      if (eventFactory) new SyncRepository(this.db, () => now).reserveLocalEventDraft(session.libraryId, nodeId, eventFactory);
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

  recordExternalFile(record: ExternalLocationRecord, eventFactory?: EventDraftFactory): string {
    if (!isCaptureDateMetadata(record.captureDate)) throw new RepositoryConflictError('capture date metadata is invalid');
    const write = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT l.location_id, f.asset_id, f.sha256 FROM file_locations l
        JOIN asset_files f ON f.file_id = l.file_id
        WHERE l.node_id = ? AND l.storage_class = 'external' AND l.original_path = ?
        ORDER BY l.created_at DESC LIMIT 1`).get(record.nodeId, record.originalPath) as {
          location_id: string; asset_id: string; sha256: string;
        } | undefined;
      if (existing?.sha256 === record.sha256) {
        this.db.prepare("UPDATE file_locations SET availability = 'online' WHERE location_id = ?").run(existing.location_id);
        if (record.captureDate.source === 'exif_offset' || record.captureDate.source === 'exif_floating') {
          this.db.prepare(`UPDATE assets SET capture_ts=?,capture_local_time=?,capture_offset_minutes=?,capture_source=?,capture_confidence=?
            WHERE asset_id=? AND capture_source IN ('unknown','legacy_unknown')`)
            .run(record.captureDate.capturedAt, record.captureDate.localTime, record.captureDate.offsetMinutes,
              record.captureDate.source, record.captureDate.confidence, existing.asset_id);
        }
        return existing.location_id;
      }
      if (existing) this.db.prepare("UPDATE file_locations SET availability = 'missing' WHERE location_id = ?").run(existing.location_id);
      this.db.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, capture_local_time,
        capture_offset_minutes, capture_source, capture_confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.assetId, record.libraryId, record.nodeId, record.kind,
          record.captureDate.capturedAt, record.captureDate.localTime, record.captureDate.offsetMinutes,
          record.captureDate.source, record.captureDate.confidence, record.now);
      this.db.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
        VALUES (?, ?, ?, ?, 'original', ?, ?)`).run(record.fileId, record.assetId, record.sha256, record.byteSize, record.storageRef, record.now);
      this.db.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path,
        source_kind, source_node_id, path_ref, storage_class, availability, created_at)
        VALUES (?, ?, ?, ?, ?, 'import', NULL, ?, 'external', 'online', ?)`)
        .run(record.locationId, record.fileId, record.nodeId, record.filename, record.originalPath, record.originalPath, record.now);
      if (eventFactory) new SyncRepository(this.db, () => record.now).reserveLocalEventDraft(record.libraryId, record.nodeId, eventFactory);
      return record.locationId;
    });
    return write.immediate();
  }

  setExternalAvailability(locationId: string, availability: IndexedExternalLocation['availability']): void {
    this.db.prepare("UPDATE file_locations SET availability = ? WHERE location_id = ? AND storage_class = 'external'")
      .run(availability, locationId);
  }
}

function safeHashEquals(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface AlbumSqlRow {
  album_id: string;
  library_id: string;
  title: string;
  created_by_peer_id: string;
  created_at: string;
}

interface DeletedAlbumSqlRow extends AlbumSqlRow {
  local_hidden_at: string | null;
  global_deleted_at: string | null;
}

function toAlbumRecord(row: AlbumSqlRow): AlbumRecord {
  return {
    albumId: row.album_id, libraryId: row.library_id, title: row.title,
    createdByPeerId: row.created_by_peer_id, createdAt: row.created_at
  };
}

interface GalleryAssetSqlRow {
  asset_id: string;
  library_id: string;
  origin_node_id: string;
  kind: AssetKind;
  captured_at: unknown;
  capture_local_time: unknown;
  capture_offset_minutes: unknown;
  capture_source: unknown;
  capture_confidence: unknown;
  sort_rank: number;
  sort_key: string | null;
  sha256: string | null;
  byte_size: number | null;
  filename: unknown;
  source_path: unknown;
  source_kind: unknown;
  availability: GalleryAssetRecord['availability'];
  favorite: number | boolean | null;
  rating: number | null;
  rating_conflict: number | boolean | null;
  rating_candidates_json: string | null;
}

function toGalleryAsset(row: GalleryAssetSqlRow): GalleryAssetRecord {
  const capturedAt = typeof row.captured_at === 'string' ? row.captured_at : null;
  const captureDate = normalizeStoredCaptureDate({
    capturedAt,
    localTime: typeof row.capture_local_time === 'string' ? row.capture_local_time : null,
    offsetMinutes: typeof row.capture_offset_minutes === 'number' ? row.capture_offset_minutes : null,
    source: row.capture_source,
    confidence: row.capture_confidence
  });
  const parsedCandidates = parseRatingCandidates(row.rating_candidates_json);
  const ratingConflict = Boolean(row.rating_conflict);
  return {
    assetId: row.asset_id, libraryId: row.library_id, originNodeId: row.origin_node_id, kind: row.kind,
    sha256: row.sha256 ?? '', availability: row.availability,
    filename: typeof row.filename === 'string' ? row.filename : row.asset_id,
    capturedAt: captureDate.capturedAt, captureLocalTime: captureDate.localTime,
    captureOffsetMinutes: captureDate.offsetMinutes, captureSource: captureDate.source,
    captureConfidence: captureDate.confidence, sourcePath: typeof row.source_path === 'string' ? row.source_path : null,
    sourceKind: row.source_kind === 'upload' ? 'upload' : 'import',
    byteSize: row.byte_size ?? 0, version: row.sha256 ?? row.asset_id, tags: [], favorite: Boolean(row.favorite),
    rating: ratingConflict ? null : row.rating,
    ratingConflict,
    ratingCandidates: parsedCandidates
  };
}

function normalizeStoredCaptureDate(value: Record<string, unknown>): CaptureDateMetadata {
  const candidate = {
    capturedAt: value.capturedAt ?? null,
    localTime: value.localTime ?? null,
    offsetMinutes: value.offsetMinutes ?? null,
    source: value.source,
    confidence: value.confidence
  };
  if (isCaptureDateMetadata(candidate)) return candidate;
  const capturedAt = typeof value.capturedAt === 'string' && isCanonicalUtcTimestamp(value.capturedAt) ? value.capturedAt : null;
  return capturedAt
    ? { capturedAt, localTime: null, offsetMinutes: null, source: 'legacy_unknown', confidence: 'unknown' }
    : { capturedAt: null, localTime: null, offsetMinutes: null, source: 'unknown', confidence: 'unknown' };
}

function parseRatingCandidates(value: string | null): Array<number | null> {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => item === null || (Number.isInteger(item) && Number(item) >= 1 && Number(item) <= 5))) return [];
    return [...new Set(parsed as Array<number | null>)].sort((left, right) => left === right ? 0 : left === null ? -1 : right === null ? 1 : left - right);
  } catch { return []; }
}

interface NormalizedGallerySearchFilters {
  q: string;
  dateFrom: string | null;
  dateTo: string | null;
  kind: AssetKind | null;
  sourceKind: SourceKind | null;
  availability: GalleryAssetRecord['availability'] | null;
}

interface GalleryCursorPosition {
  sortRank: 0 | 1 | 2;
  sortKey: string | null;
  assetId: string;
}

const LEGACY_GALLERY_CURSOR_SORT = 'capture-desc-asset-binary-desc-v1';
const GALLERY_CURSOR_SORT = 'capture-groups-desc-asset-binary-desc-v2';
const LEGACY_GALLERY_CURSOR_KEYS = ['assetId', 'capturedAt', 'filterHash', 'libraryId', 'sort', 'version'];
const GALLERY_CURSOR_KEYS = ['assetId', 'filterHash', 'libraryId', 'sort', 'sortKey', 'sortRank', 'version'];

export function normalizeGallerySearchFilters(filters: GallerySearchFilters): NormalizedGallerySearchFilters {
  const q = filters.q ?? '';
  if (typeof q !== 'string' || q.length > 256 || (q !== '' && Array.from(q).length < 3)) {
    throw new Error('invalid gallery search query');
  }
  const dateFrom = normalizeGalleryDate(filters.dateFrom);
  const dateTo = normalizeGalleryDate(filters.dateTo);
  if (dateFrom && dateTo && dateFrom >= dateTo) throw new Error('invalid gallery date range');
  const kind = normalizeGalleryEnum(filters.kind, ['photo', 'video', 'live_photo'], 'kind');
  const sourceKind = normalizeGalleryEnum(filters.sourceKind, ['upload', 'import'], 'source kind');
  const availability = normalizeGalleryEnum(filters.availability, ['online', 'cached', 'offline', 'missing'], 'availability');
  return { q, dateFrom, dateTo, kind, sourceKind, availability };
}

function normalizeGalleryEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`invalid gallery ${label}`);
  return value as T;
}

function normalizeGalleryDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid gallery date');
  const timestamp = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== value) throw new Error('invalid gallery date');
  return value;
}

function toFts5Phrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function galleryCursorVersion(filters: NormalizedGallerySearchFilters): 1 | 2 {
  return filters.kind || filters.sourceKind || filters.availability ? 2 : 1;
}

function gallerySearchFilterHash(filters: NormalizedGallerySearchFilters, version: 1 | 2 | 3): string {
  const canonical = version === 1
    ? { q: filters.q, dateFrom: filters.dateFrom, dateTo: filters.dateTo }
    : { q: filters.q, dateFrom: filters.dateFrom, dateTo: filters.dateTo, kind: filters.kind, sourceKind: filters.sourceKind, availability: filters.availability };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function encodeGalleryCursor(
  sortRank: 0 | 1 | 2, sortKey: string | null, assetId: string, libraryId: string, filters: NormalizedGallerySearchFilters
): string {
  return Buffer.from(JSON.stringify({
    version: 3, libraryId, filterHash: gallerySearchFilterHash(filters, 3), sort: GALLERY_CURSOR_SORT, sortRank, sortKey, assetId
  }), 'utf8').toString('base64url');
}

function decodeGalleryCursor(
  value: string, libraryId: string, filters: NormalizedGallerySearchFilters
): GalleryCursorPosition {
  try {
    if (value.length > 2048 || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error('invalid cursor');
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const version = decoded.version;
    if (typeof decoded.assetId !== 'string' || decoded.assetId.length < 1 || decoded.assetId.length > 256 || decoded.libraryId !== libraryId) {
      throw new Error('invalid cursor');
    }
    if (version === 3) {
      if (Object.keys(decoded).sort().join(',') !== GALLERY_CURSOR_KEYS.join(',') || decoded.sort !== GALLERY_CURSOR_SORT ||
          decoded.filterHash !== gallerySearchFilterHash(filters, 3) ||
          !(decoded.sortRank === 0 || decoded.sortRank === 1 || decoded.sortRank === 2) ||
          (decoded.sortRank === 0 && !isCanonicalUtcTimestamp(decoded.sortKey)) ||
          (decoded.sortRank === 1 && !isCanonicalCaptureLocalTime(decoded.sortKey)) ||
          (decoded.sortRank === 2 && decoded.sortKey !== null)) throw new Error('invalid cursor');
      return { sortRank: decoded.sortRank, sortKey: decoded.sortKey as string | null, assetId: decoded.assetId };
    }
    if ((version !== 1 && version !== 2) || version !== galleryCursorVersion(filters) ||
        Object.keys(decoded).sort().join(',') !== LEGACY_GALLERY_CURSOR_KEYS.join(',') ||
        decoded.filterHash !== gallerySearchFilterHash(filters, version) || decoded.sort !== LEGACY_GALLERY_CURSOR_SORT ||
        !(decoded.capturedAt === null || isCanonicalUtcTimestamp(decoded.capturedAt))) throw new Error('invalid cursor');
    if (decoded.capturedAt === null) throw new StaleGalleryCursorError();
    return { sortRank: 0, sortKey: decoded.capturedAt as string, assetId: decoded.assetId };
  } catch (cause) {
    if (cause instanceof StaleGalleryCursorError) throw cause;
    throw new Error('invalid gallery cursor', { cause });
  }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
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

function toMediaVersionRecord(row: MediaVersionSqlRow): MediaVersionRecord {
  return {
    versionId: row.version_id, assetId: row.asset_id, libraryId: row.library_id,
    sourceVersionId: row.source_version_id, sourceSha256: row.source_sha256,
    transform: JSON.parse(row.transform_json) as MediaVersionTransform,
    idempotencyScope: row.idempotency_scope, idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint, status: row.status, storageRef: row.storage_ref,
    outputSha256: row.output_sha256, mimeType: row.mime_type, byteSize: row.byte_size,
    width: row.width, height: row.height, errorCode: row.error_code,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
