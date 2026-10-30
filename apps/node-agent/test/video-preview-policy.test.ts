import { describe, expect, it } from 'vitest';
import { evaluateVideoPreviewPolicy, maxVideoPreviewOutputBytes } from '../src/media/video-preview-policy.js';

const base = { enabled: true, mimeType: 'video/mp4', sourceBytes: 1024, durationSeconds: 30, availableBytes: maxVideoPreviewOutputBytes * 2, queueDepth: 0 };

describe('video preview admission policy', () => {
  it('stays disabled until the reviewed capability is enabled', () => {
    expect(evaluateVideoPreviewPolicy({ ...base, enabled: false })).toEqual({ allowed: false, reason: 'capability_disabled' });
    expect(evaluateVideoPreviewPolicy({ ...base, mimeType: 'video/quicktime' }).reason).toBe('unsupported_format');
  });
  it('rejects resource and queue violations before any decode work', () => {
    expect(evaluateVideoPreviewPolicy({ ...base, sourceBytes: 256 * 1024 * 1024 + 1 }).reason).toBe('source_too_large');
    expect(evaluateVideoPreviewPolicy({ ...base, durationSeconds: 601 }).reason).toBe('duration_too_long');
    expect(evaluateVideoPreviewPolicy({ ...base, queueDepth: 1 }).reason).toBe('queue_full');
    expect(evaluateVideoPreviewPolicy({ ...base, availableBytes: maxVideoPreviewOutputBytes }).reason).toBe('insufficient_storage');
    expect(evaluateVideoPreviewPolicy(base)).toEqual({ allowed: true, reason: 'ready' });
  });
});
