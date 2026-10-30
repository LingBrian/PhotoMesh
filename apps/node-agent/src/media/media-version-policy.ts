export type MediaVersionState = 'staging' | 'ready' | 'failed' | 'cancelled' | 'error';

export function canCancelMediaVersion(status: string): boolean {
  return status.toLowerCase() === 'staging';
}

export function canCompareMediaVersions(left: { status: string; outputSha256: string | null }, right: { status: string; outputSha256: string | null }): boolean {
  return left.status.toLowerCase() === 'ready' && right.status.toLowerCase() === 'ready' && Boolean(left.outputSha256) && Boolean(right.outputSha256);
}

export function isSafeMediaVersionTransition(from: string, to: MediaVersionState): boolean {
  const current = from.toLowerCase();
  if (current === 'staging') return ['ready', 'failed', 'cancelled', 'error'].includes(to);
  return current === to;
}
