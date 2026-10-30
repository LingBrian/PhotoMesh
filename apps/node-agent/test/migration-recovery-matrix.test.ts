import { describe, expect, it } from 'vitest';
import { evaluateMigrationRecovery } from '../src/migration-recovery-matrix.js';

describe('N/N-1 migration and recovery matrix', () => {
  it('requires both a verified backup and restore point for forward migration', () => {
    const base = { currentSchema: 4, targetSchema: 5, targetVersionKnown: true };
    expect(evaluateMigrationRecovery({ ...base, backupVerified: false, restorePointVerified: false }).reason).toBe('backup_required');
    expect(evaluateMigrationRecovery({ ...base, backupVerified: true, restorePointVerified: false }).reason).toBe('restore_point_required');
    expect(evaluateMigrationRecovery({ ...base, backupVerified: true, restorePointVerified: true })).toEqual({ allowed: true, reason: 'ready' });
  });
  it('rejects unknown targets and all same/backward schema attempts', () => {
    expect(evaluateMigrationRecovery({ currentSchema: 4, targetSchema: 5, targetVersionKnown: false, backupVerified: true, restorePointVerified: true }).reason).toBe('unknown_target');
    expect(evaluateMigrationRecovery({ currentSchema: 5, targetSchema: 5, targetVersionKnown: true, backupVerified: true, restorePointVerified: true }).reason).toBe('unsafe_downgrade');
    expect(evaluateMigrationRecovery({ currentSchema: 5, targetSchema: 4, targetVersionKnown: true, backupVerified: true, restorePointVerified: true }).reason).toBe('unsafe_downgrade');
  });
});
