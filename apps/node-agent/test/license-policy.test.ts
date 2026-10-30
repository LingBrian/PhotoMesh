import { describe, expect, it } from 'vitest';
import { reviewDependencyLicense } from '../src/license-policy.js';

describe('dependency license review gate', () => {
  it('accepts known permissive metadata only for non-native dependencies', () => {
    expect(reviewDependencyLicense({ packageName: 'example', license: 'MIT', sourceAvailable: true, nativeCode: false })).toEqual({ approved: true, reason: 'approved' });
    expect(reviewDependencyLicense({ packageName: 'example', license: 'Apache-2.0', sourceAvailable: true, nativeCode: false })).toEqual({ approved: true, reason: 'approved' });
    expect(reviewDependencyLicense({ packageName: 'native', license: 'MIT', sourceAvailable: true, nativeCode: true }).reason).toBe('native-review-required');
  });
  it('fails missing, unknown, and conditional metadata closed', () => {
    expect(reviewDependencyLicense({ packageName: 'unknown', license: null, sourceAvailable: false, nativeCode: false }).reason).toBe('missing-license');
    expect(reviewDependencyLicense({ packageName: 'unknown', license: 'Proprietary', sourceAvailable: true, nativeCode: false }).reason).toBe('unapproved-license');
    expect(reviewDependencyLicense({ packageName: 'lgpl', license: 'LGPL-3.0-only', sourceAvailable: false, nativeCode: false }).reason).toBe('source-required');
    expect(reviewDependencyLicense({ packageName: 'lgpl', license: 'LGPL-3.0-only', sourceAvailable: true, nativeCode: false })).toEqual({ approved: true, reason: 'approved' });
  });
});
