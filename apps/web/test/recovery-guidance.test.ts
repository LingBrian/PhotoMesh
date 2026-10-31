import { describe, expect, it } from 'vitest';
import { recoveryGuidance } from '../src/recovery-guidance.js';

describe('recovery guidance', () => {
  it('uses bounded exponential retry for transport failures', () => {
    expect(recoveryGuidance('offline', 0)).toMatchObject({ retryable: true, delayMs: 500 });
    expect(recoveryGuidance('timeout', 3)).toMatchObject({ retryable: true, delayMs: 4000 });
    expect(recoveryGuidance('offline', 99).delayMs).toBe(4000);
  });
  it('does not retry authorization, conflict, or certificate failures', () => {
    expect(recoveryGuidance('authorization')).toMatchObject({ retryable: false, delayMs: 0 });
    expect(recoveryGuidance('conflict')).toMatchObject({ retryable: false, delayMs: 0 });
    expect(recoveryGuidance('certificate')).toMatchObject({ retryable: false, delayMs: 0 });
    expect(recoveryGuidance('rate-limited')).toMatchObject({ retryable: true, delayMs: 5000 });
    expect(recoveryGuidance('resource')).toMatchObject({ retryable: true, delayMs: 3000 });
  });
});
