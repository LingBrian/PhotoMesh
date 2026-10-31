import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requestIdPattern } from './request-id.js';

export const metadataAuditActions = [
  'asset.tag.add',
  'asset.tag.remove',
  'asset.favorite.set',
  'asset.rating.set',
  'asset.rating.clear',
  'virtual_album.create',
  'virtual_album.member.add',
  'virtual_album.member.remove',
  'virtual_album.delete',
  'virtual_album.restore'
] as const;
export type MetadataAuditAction = typeof metadataAuditActions[number];
export type MetadataAuditResourceType = 'asset' | 'virtual_album' | 'virtual_album_member';
export type MetadataAuditOutcome = 'applied' | 'unchanged' | 'replayed';

export interface MetadataAuditEntry {
  action: MetadataAuditAction;
  resourceType: MetadataAuditResourceType;
  libraryId: string;
  resourceId: string;
  relatedResourceId?: string;
  scope?: 'local' | 'global';
  outcome: MetadataAuditOutcome;
  requestId: string;
  createdAt: string;
}

const allowedActions = new Set<string>(metadataAuditActions);
const allowedResourceTypes = new Set<MetadataAuditResourceType>(['asset', 'virtual_album', 'virtual_album_member']);
const allowedOutcomes = new Set<MetadataAuditOutcome>(['applied', 'unchanged', 'replayed']);

export type MetadataAuditMutationEntry = Omit<MetadataAuditEntry, 'requestId'> & { requestId?: string | undefined };

export function appendMetadataAudit(
  repository: AuditRepository | undefined,
  entry: MetadataAuditMutationEntry
): void {
  if (!repository) return;
  if (!entry.requestId) throw new Error('audit request ID is required');
  repository.appendInTransaction({ ...entry, requestId: entry.requestId });
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  appendInTransaction(entry: MetadataAuditEntry): void {
    if (!this.db.inTransaction) throw new Error('audit write requires an active SQLite transaction');
    const hasAlbumScope = entry.action === 'virtual_album.delete' || entry.action === 'virtual_album.restore';
    if (!allowedActions.has(entry.action) || !allowedResourceTypes.has(entry.resourceType) || !allowedOutcomes.has(entry.outcome) ||
        !requestIdPattern.test(entry.requestId) || !isAuditIdentifier(entry.libraryId) || !isAuditIdentifier(entry.resourceId) ||
        (entry.relatedResourceId !== undefined && !isAuditIdentifier(entry.relatedResourceId)) ||
        (hasAlbumScope ? entry.scope !== 'local' && entry.scope !== 'global' : entry.scope !== undefined) ||
        !isUtcTimestamp(entry.createdAt)) {
      throw new Error('invalid metadata audit entry');
    }
    this.db.prepare(`INSERT INTO metadata_audit_events
      (actor, action, resource_type, library_id, resource_id, related_resource_id, scope, outcome, request_id, created_at)
      VALUES ('local-admin', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.action, entry.resourceType, hashAuditIdentifier('library', entry.libraryId), hashAuditIdentifier('resource', entry.resourceId),
        entry.relatedResourceId === undefined ? null : hashAuditIdentifier('related-resource', entry.relatedResourceId),
        entry.scope ?? null, entry.outcome, entry.requestId, entry.createdAt);
  }
}

function isAuditIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20);
}

function hashAuditIdentifier(kind: string, value: string): string {
  return createHash('sha256').update(`photomesh-metadata-audit-v1\0${kind}\0${value}`, 'utf8').digest('hex');
}

function isUtcTimestamp(value: string): boolean {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
