import { createHash } from 'node:crypto';

export interface ManagedDeleteCandidate {
  libraryId: string;
  assetId: string;
  fileId: string;
  storageRef: string;
  storageClass: 'managed' | 'external';
  sha256: string;
  byteSize: number;
  tombstoneEventId: string | null;
  nodeId: string;
}

export interface DeleteManifestEntry extends Omit<ManagedDeleteCandidate, 'storageClass'> { reason: 'retention_due' }
export interface DeleteManifest { manifestVersion: 1; createdAt: string; policyRevision: string; entries: DeleteManifestEntry[]; digest: string }

function canonicalEntries(entries: readonly DeleteManifestEntry[]): string {
  return JSON.stringify(entries.map(({ assetId, byteSize, fileId, libraryId, nodeId, reason, sha256, storageRef, tombstoneEventId }) =>
    ({ assetId, byteSize, fileId, libraryId, nodeId, reason, sha256, storageRef, tombstoneEventId })));
}

export function createDeleteManifest(candidates: readonly ManagedDeleteCandidate[], input: { createdAt: string; policyRevision: string }): DeleteManifest {
  const entries = candidates.filter((candidate) => candidate.storageClass === 'managed' && candidate.tombstoneEventId !== null && /^[0-9a-f]{64}$/.test(candidate.sha256) && Number.isSafeInteger(candidate.byteSize) && candidate.byteSize >= 0)
    .map((candidate) => ({ libraryId: candidate.libraryId, assetId: candidate.assetId, fileId: candidate.fileId, storageRef: candidate.storageRef, sha256: candidate.sha256, byteSize: candidate.byteSize, tombstoneEventId: candidate.tombstoneEventId, nodeId: candidate.nodeId, reason: 'retention_due' as const }))
    .sort((left, right) => `${left.libraryId}\0${left.assetId}\0${left.fileId}`.localeCompare(`${right.libraryId}\0${right.assetId}\0${right.fileId}`));
  const digest = createHash('sha256').update(canonicalEntries(entries)).digest('hex');
  return { manifestVersion: 1, createdAt: input.createdAt, policyRevision: input.policyRevision, entries, digest };
}

export function isManifestUnchanged(manifest: DeleteManifest): boolean {
  const digest = createHash('sha256').update(canonicalEntries(manifest.entries)).digest('hex');
  return digest === manifest.digest;
}

export interface DeleteExecutionApproval { manifestDigest: string; backupDigest: string; firstConfirmation: string; secondConfirmation: string }
export function validateDeleteExecutionApproval(manifest: DeleteManifest, approval: DeleteExecutionApproval | undefined): string[] {
  if (!approval) return ['approval_missing'];
  const errors: string[] = [];
  if (approval.manifestDigest !== manifest.digest || !isManifestUnchanged(manifest)) errors.push('manifest_changed');
  if (!/^[0-9a-f]{64}$/.test(approval.backupDigest)) errors.push('backup_unverified');
  if (!approval.firstConfirmation || !approval.secondConfirmation || approval.firstConfirmation === approval.secondConfirmation) errors.push('dual_confirmation_missing');
  return errors;
}
