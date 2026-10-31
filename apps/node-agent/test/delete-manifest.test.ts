import { describe, expect, it } from 'vitest';
import { createDeleteManifest, isManifestUnchanged, validateDeleteExecutionApproval, type ManagedDeleteCandidate } from '../src/retention/delete-manifest.js';

const base: ManagedDeleteCandidate = { libraryId: 'library', assetId: 'asset', fileId: 'file', storageRef: 'objects/file', storageClass: 'managed', sha256: 'a'.repeat(64), byteSize: 12, tombstoneEventId: 'tombstone', nodeId: 'node' };

describe('permanent-delete dry-run manifest', () => {
  it('includes only verified managed tombstoned candidates and is deterministic', () => {
    const manifest = createDeleteManifest([base, { ...base, assetId: 'external', storageClass: 'external' }, { ...base, assetId: 'live', tombstoneEventId: null }], { createdAt: '2026-10-31T00:00:00.000Z', policyRevision: 'pm063-v1' });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.assetId).toBe('asset');
    expect(isManifestUnchanged(manifest)).toBe(true);
  });
  it('requires an unchanged manifest, verified backup, and two distinct confirmations', () => {
    const manifest = createDeleteManifest([base], { createdAt: '2026-10-31T00:00:00.000Z', policyRevision: 'pm063-v1' });
    expect(validateDeleteExecutionApproval(manifest, undefined)).toEqual(['approval_missing']);
    expect(validateDeleteExecutionApproval(manifest, { manifestDigest: manifest.digest, backupDigest: 'b'.repeat(64), firstConfirmation: 'one', secondConfirmation: 'two' })).toEqual([]);
    expect(validateDeleteExecutionApproval(manifest, { manifestDigest: manifest.digest, backupDigest: 'not-hash', firstConfirmation: 'same', secondConfirmation: 'same' })).toEqual(['backup_unverified', 'dual_confirmation_missing']);
  });
});
