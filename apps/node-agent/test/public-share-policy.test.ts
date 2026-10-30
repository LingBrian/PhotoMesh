import { describe, expect, it } from 'vitest';
import { evaluatePublicShareRequest } from '../src/sharing/public-share-policy.js';

const base = { approved: true, now: '2026-10-31T00:00:00.000Z', expiresAt: '2026-10-31T01:00:00.000Z', requestedOriginal: false, includeSensitiveMetadata: false, scopeItems: 1 };

describe('public share policy gate', () => {
  it('requires approval and bounds expiry/scope', () => {
    expect(evaluatePublicShareRequest({ ...base, approved: false }).reason).toBe('approval_required');
    expect(evaluatePublicShareRequest({ ...base, expiresAt: '2026-11-02T00:00:00.000Z' }).reason).toBe('expiry_invalid');
    expect(evaluatePublicShareRequest({ ...base, scopeItems: 101 }).reason).toBe('scope_too_large');
  });
  it('rejects originals and sensitive metadata, otherwise selects a derived preview profile', () => {
    expect(evaluatePublicShareRequest({ ...base, requestedOriginal: true }).reason).toBe('privacy_policy_violation');
    expect(evaluatePublicShareRequest({ ...base, includeSensitiveMetadata: true }).reason).toBe('privacy_policy_violation');
    expect(evaluatePublicShareRequest(base)).toMatchObject({ allowed: true, responseProfile: 'derived_preview_without_sensitive_metadata' });
  });
});
