import { describe, expect, it } from 'vitest';
import { classifyConnectionFailure } from '../src/connection-diagnostics.js';

describe('connection diagnostics', () => {
  it('distinguishes authorization and forbidden responses', () => {
    expect(classifyConnectionFailure({ status: 401 })).toBe('authorization');
    expect(classifyConnectionFailure({ status: 403 })).toBe('forbidden');
  });
  it('distinguishes transport failures without exposing credentials', () => {
    expect(classifyConnectionFailure(new TypeError('Failed to fetch'))).toBe('offline');
    expect(classifyConnectionFailure(new Error('TLS certificate name mismatch'))).toBe('certificate');
    expect(classifyConnectionFailure(new DOMException('request timed out', 'TimeoutError'))).toBe('timeout');
    expect(classifyConnectionFailure(new Error('unexpected'))).toBe('unknown');
  });
});
