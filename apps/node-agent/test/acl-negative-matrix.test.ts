import { describe, expect, it } from 'vitest';
import { aclNegativeMatrix } from '../src/authz/acl-negative-matrix.js';

describe('Node API ACL negative matrix', () => {
  it('covers every protected route family with an explicit capability and safe statuses', () => {
    expect(aclNegativeMatrix.length).toBeGreaterThanOrEqual(17);
    for (const entry of aclNegativeMatrix) {
      expect(entry.routeFamily).toMatch(/^\/v1\//);
      expect(entry.methods.length).toBeGreaterThan(0);
      expect(entry.requiredCapability).toBeTruthy();
      expect(entry.unauthenticatedStatuses).toEqual(expect.arrayContaining([401, 403]));
      expect(entry.crossLibraryMustNotReveal).toBe(true);
    }
  });
  it('does not treat the public health probe as a protected library capability', () => {
    expect(aclNegativeMatrix.some((entry) => entry.routeFamily === '/v1/health')).toBe(false);
  });
});
