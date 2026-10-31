import { describe, expect, it } from 'vitest';
import { admissionFaultDecision } from '../src/jobs/admission-fault-policy.js';

describe('admission fault policy', () => {
  it('never reports injected media/upload faults as success', () => {
    for (const fault of ['full-disk', 'timeout', 'partial-write', 'queue-full', 'source-changed'] as const) {
      expect(admissionFaultDecision(fault).publishSuccess).toBe(false);
    }
  });
  it('maps recoverable capacity faults to bounded retry statuses', () => {
    expect(admissionFaultDecision('full-disk')).toMatchObject({ httpStatus: 507, retryable: true, cleanupPartialOutput: true });
    expect(admissionFaultDecision('partial-write')).toMatchObject({ httpStatus: 507, retryable: true, cleanupPartialOutput: true });
    expect(admissionFaultDecision('timeout')).toMatchObject({ httpStatus: 504, retryable: true, cleanupPartialOutput: true });
    expect(admissionFaultDecision('queue-full')).toMatchObject({ httpStatus: 429, retryable: true, cleanupPartialOutput: false });
  });
  it('does not retry a changed source silently', () => {
    expect(admissionFaultDecision('source-changed')).toEqual({ httpStatus: 409, retryable: false, publishSuccess: false, cleanupPartialOutput: true });
  });
});
