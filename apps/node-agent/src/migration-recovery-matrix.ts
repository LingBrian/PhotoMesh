export type MigrationRecoveryInput = { currentSchema: number; targetSchema: number; backupVerified: boolean; restorePointVerified: boolean; targetVersionKnown: boolean };
export type MigrationRecoveryDecision = { allowed: boolean; reason: 'ready' | 'backup_required' | 'restore_point_required' | 'unsafe_downgrade' | 'unknown_target' };

/** Preflight-only decision; it never runs a migration or restores user data. */
export function evaluateMigrationRecovery(input: MigrationRecoveryInput): MigrationRecoveryDecision {
  if (!input.targetVersionKnown) return { allowed: false, reason: 'unknown_target' };
  if (input.targetSchema < input.currentSchema) return { allowed: false, reason: 'unsafe_downgrade' };
  if (input.targetSchema === input.currentSchema) return { allowed: false, reason: 'unsafe_downgrade' };
  if (!input.backupVerified) return { allowed: false, reason: 'backup_required' };
  if (!input.restorePointVerified) return { allowed: false, reason: 'restore_point_required' };
  return { allowed: true, reason: 'ready' };
}
