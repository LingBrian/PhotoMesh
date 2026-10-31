import { describe, expect, it, vi } from 'vitest';
import { resolveRequestId } from '../src/audit/request-id.js';

const valid = 'A0123456789._-abcdefghijklmnopqrstuvwxyz-1234567890';
const fallbackId = '123e4567-e89b-42d3-a456-426614174000';

function headers(value: string): string[] { return ['X-Request-ID', value]; }

describe('HTTP request ID selection', () => {
  it('accepts exactly one untrimmed ASCII value within the 1–64 character rule', () => {
    const fallback = vi.fn(() => fallbackId);
    expect(resolveRequestId(headers('a'), fallback)).toBe('a');
    expect(resolveRequestId(headers(valid), fallback)).toBe(valid);
    expect(resolveRequestId(headers('A'.repeat(64)), fallback)).toBe('A'.repeat(64));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses one server-generated ID for missing, malformed, or duplicate raw headers', () => {
    const malformed = ['', ' bad', 'bad ', 'bad value', 'bad,value', 'A'.repeat(65), '\n', '\r', '\u2028', '\u2029', '\r\nInjected: x'];
    for (const value of malformed) {
      const fallback = vi.fn(() => fallbackId);
      expect(resolveRequestId(headers(value), fallback)).toBe(fallbackId);
      expect(fallback).toHaveBeenCalledOnce();
    }

    for (const rawHeaders of [
      [],
      ['X-Request-ID', 'first', 'x-request-id', 'second'],
      ['X-Request-ID', 'same', 'X-Request-ID', 'same']
    ]) {
      const fallback = vi.fn(() => fallbackId);
      expect(resolveRequestId(rawHeaders, fallback)).toBe(fallbackId);
      expect(fallback).toHaveBeenCalledOnce();
    }
  });
});
