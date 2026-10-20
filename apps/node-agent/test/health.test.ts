import { describe, expect, it } from 'vitest';
import { getHealth } from '../src/health.js';

describe('getHealth', () => {
  it('returns the negotiated protocol range without private metadata', () => {
    expect(getHealth()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0 });
  });
});
