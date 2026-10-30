export interface PublicShareRequest { approved: boolean; now: string; expiresAt: string; requestedOriginal: boolean; includeSensitiveMetadata: boolean; scopeItems: number }
export interface PublicShareDecision { allowed: boolean; reason: 'ready' | 'approval_required' | 'expiry_invalid' | 'scope_too_large' | 'privacy_policy_violation'; maxLifetimeSeconds: number; responseProfile: 'derived_preview_without_sensitive_metadata' | 'disabled' }

const maxLifetimeSeconds = 24 * 60 * 60;
const maxScopeItems = 100;

/** Policy gate only: deliberately does not mint a public token or expose an endpoint. */
export function evaluatePublicShareRequest(input: PublicShareRequest): PublicShareDecision {
  const lifetime = (Date.parse(input.expiresAt) - Date.parse(input.now)) / 1000;
  if (!input.approved) return { allowed: false, reason: 'approval_required', maxLifetimeSeconds, responseProfile: 'disabled' };
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > maxLifetimeSeconds) return { allowed: false, reason: 'expiry_invalid', maxLifetimeSeconds, responseProfile: 'disabled' };
  if (!Number.isSafeInteger(input.scopeItems) || input.scopeItems < 1 || input.scopeItems > maxScopeItems) return { allowed: false, reason: 'scope_too_large', maxLifetimeSeconds, responseProfile: 'disabled' };
  if (input.requestedOriginal || input.includeSensitiveMetadata) return { allowed: false, reason: 'privacy_policy_violation', maxLifetimeSeconds, responseProfile: 'disabled' };
  return { allowed: true, reason: 'ready', maxLifetimeSeconds, responseProfile: 'derived_preview_without_sensitive_metadata' };
}
