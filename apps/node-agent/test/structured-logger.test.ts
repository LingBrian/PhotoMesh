import { describe, expect, it } from 'vitest';
import { serializeStructuredLog } from '../src/audit/structured-logger.js';

describe('structured log redaction', () => {
  it('keeps correlation fields and redacts secrets, paths, originals, and EXIF', () => {
    const line = serializeStructuredLog({ event: 'asset.read', requestId: 'req-1', outcome: 'failure', fields: { token: 'secret', bearer: 'Bearer abc', path: 'C:\\Users\\private\\a.jpg', exif: { gps: '1,2' }, safe: 'ok' } });
    expect(JSON.parse(line)).toMatchObject({ event: 'asset.read', requestId: 'req-1', fields: { token: '[REDACTED]', bearer: '[REDACTED]', path: '[REDACTED]', exif: '[REDACTED]', safe: 'ok' } });
    expect(line).not.toContain('secret');
    expect(line).not.toContain('private');
  });
  it('bounds field values and total serialized output', () => {
    const line = serializeStructuredLog({ event: 'x'.repeat(200), requestId: 'r'.repeat(200), outcome: 'success', durationMs: -3, fields: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field${index}`, 'a'.repeat(512)])) });
    expect(line.length).toBeLessThanOrEqual(4096);
    expect(line.endsWith('…')).toBe(true);
  });
});
