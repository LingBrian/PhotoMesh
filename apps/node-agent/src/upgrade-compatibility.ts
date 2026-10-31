export interface UpgradeCheckInput { currentVersion: string; targetVersion: string; currentSchema: number; targetSchema: number; backupVerified: boolean }
export interface UpgradeCheck { allowed: boolean; reason: 'ready' | 'backup_required' | 'incompatible_downgrade' | 'downgrade_blocked' | 'invalid_version' }

function version(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function compare(left: [number, number, number], right: [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function checkUpgrade(input: UpgradeCheckInput): UpgradeCheck {
  const current = version(input.currentVersion); const target = version(input.targetVersion);
  if (!current || !target || !Number.isSafeInteger(input.currentSchema) || !Number.isSafeInteger(input.targetSchema)) return { allowed: false, reason: 'invalid_version' };
  const direction = compare(target, current);
  if (direction < 0) return { allowed: false, reason: input.targetSchema < input.currentSchema ? 'incompatible_downgrade' : 'downgrade_blocked' };
  if (direction === 0) return { allowed: false, reason: 'downgrade_blocked' };
  if (!input.backupVerified) return { allowed: false, reason: 'backup_required' };
  return { allowed: true, reason: 'ready' };
}
