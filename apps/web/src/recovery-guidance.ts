import type { ConnectionFailureKind } from './connection-diagnostics.js';

export type RecoveryGuidance = { retryable: boolean; delayMs: number; messageKey: 'retryConnection' | 'authorizationRequired' | 'forbiddenRequired' | 'requestConflict' | 'rateLimited' | 'resourceUnavailable' | 'certificateFailed' };

export function recoveryGuidance(kind: ConnectionFailureKind, attempt = 0): RecoveryGuidance {
  const boundedAttempt = Math.max(0, Math.min(Math.floor(attempt), 3));
  if (kind === 'offline' || kind === 'timeout') return { retryable: true, delayMs: Math.min(8000, 500 * (2 ** boundedAttempt)), messageKey: 'retryConnection' };
  if (kind === 'rate-limited') return { retryable: true, delayMs: 5000, messageKey: 'rateLimited' };
  if (kind === 'resource') return { retryable: true, delayMs: 3000, messageKey: 'resourceUnavailable' };
  if (kind === 'authorization') return { retryable: false, delayMs: 0, messageKey: 'authorizationRequired' };
  if (kind === 'forbidden') return { retryable: false, delayMs: 0, messageKey: 'forbiddenRequired' };
  if (kind === 'conflict') return { retryable: false, delayMs: 0, messageKey: 'requestConflict' };
  if (kind === 'certificate') return { retryable: false, delayMs: 0, messageKey: 'certificateFailed' };
  return { retryable: false, delayMs: 0, messageKey: 'retryConnection' };
}
