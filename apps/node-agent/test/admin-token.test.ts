import { describe, expect, it } from 'vitest';
import { createAdminTokenAuthorizer } from '../src/auth/admin-token.js';

describe('administrator bearer-token authorization', () => {
  it('fails closed when no token is configured or supplied', () => {
    expect(createAdminTokenAuthorizer(undefined)(undefined)).toBe(false);
    expect(createAdminTokenAuthorizer('fixture-token')(undefined)).toBe(false);
    expect(createAdminTokenAuthorizer(undefined)('fixture-token')).toBe(false);
    expect(createAdminTokenAuthorizer('fixture-token')('')).toBe(false);
  });

  it('accepts only the exact configured token across byte lengths', () => {
    const authorize = createAdminTokenAuthorizer('fixture-token-256-bit');
    expect(authorize('fixture-token-256-bit')).toBe(true);
    expect(authorize('fixture-token-256-bi')).toBe(false);
    expect(authorize('fixture-token-256-bit-extra')).toBe(false);
    expect(authorize('Fixture-token-256-bit')).toBe(false);
  });

  it('invalidates the previous token after a foreground rotation and process restart', () => {
    const priorToken = 'prior-test-token-not-a-real-secret';
    const rotatedToken = 'rotated-test-token-not-a-real-secret';
    const priorProcess = createAdminTokenAuthorizer(priorToken);
    const restartedProcess = createAdminTokenAuthorizer(rotatedToken);

    expect(priorProcess(priorToken)).toBe(true);
    expect(restartedProcess(rotatedToken)).toBe(true);
    expect(restartedProcess(priorToken)).toBe(false);
    expect(restartedProcess('')).toBe(false);
  });
});
