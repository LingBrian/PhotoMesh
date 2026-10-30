import { describe, expect, it } from 'vitest';
import { canCancelMediaVersion, canCompareMediaVersions, isSafeMediaVersionTransition } from '../src/media/media-version-policy.js';

describe('media version workflow policy', () => {
  it('allows cancellation only while work is staging', () => {
    expect(canCancelMediaVersion('staging')).toBe(true);
    expect(canCancelMediaVersion('ready')).toBe(false);
    expect(canCancelMediaVersion('failed')).toBe(false);
  });
  it('compares only ready versions with verified output hashes', () => {
    expect(canCompareMediaVersions({ status: 'ready', outputSha256: 'a' }, { status: 'ready', outputSha256: 'b' })).toBe(true);
    expect(canCompareMediaVersions({ status: 'processing', outputSha256: 'a' }, { status: 'ready', outputSha256: 'b' })).toBe(false);
    expect(canCompareMediaVersions({ status: 'ready', outputSha256: null }, { status: 'ready', outputSha256: 'b' })).toBe(false);
  });
  it('allows terminal transitions once and never rewrites a terminal state', () => {
    expect(isSafeMediaVersionTransition('staging', 'ready')).toBe(true);
    expect(isSafeMediaVersionTransition('staging', 'cancelled')).toBe(true);
    expect(isSafeMediaVersionTransition('ready', 'ready')).toBe(true);
    expect(isSafeMediaVersionTransition('ready', 'failed')).toBe(false);
    expect(isSafeMediaVersionTransition('failed', 'staging')).toBe(false);
  });
});
