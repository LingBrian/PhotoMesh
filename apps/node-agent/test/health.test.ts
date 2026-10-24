import { describe, expect, it } from 'vitest';
import { getHealth } from '../src/health.js';

describe('getHealth', () => {
  it('returns the negotiated protocol range and explicit capabilities', () => {
    expect(getHealth()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: [] });
    expect(getHealth(['mediaVersions'])).toEqual({
      status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: ['mediaVersions']
    });
  });
});
