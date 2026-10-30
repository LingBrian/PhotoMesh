import { describe, expect, it } from 'vitest';
import { getResourceMetrics } from '../src/resource-metrics.js';

describe('resource metrics', () => {
  it('reports low space and refuses new work without exposing a path', async () => {
    const result = await getResourceMetrics({ disk: () => ({ totalBytes: 1000, availableBytes: 99 }), queue: () => ({ pending: 2, running: 1, failed: 3 }), lowSpaceBytes: 100 });
    expect(result).toEqual({ status: 'low_space', acceptsNewWork: false, storage: { totalBytes: 1000, availableBytes: 99, usedBytes: 901, lowSpace: true }, queue: { pending: 2, running: 1, failed: 3 } });
    expect(result).not.toHaveProperty('path');
  });
  it('fails closed when a source is unavailable and clamps invalid values', async () => {
    const degraded = await getResourceMetrics({ disk: () => ({ totalBytes: 100, availableBytes: 200 }), queue: () => ({ pending: -1, running: Number.NaN, failed: 1 }), lowSpaceBytes: 10 });
    expect(degraded.status).toBe('ok');
    expect(degraded.storage.availableBytes).toBe(100);
    await expect(getResourceMetrics({ disk: () => { throw new Error('denied'); }, queue: () => ({ pending: 1, running: 0, failed: 0 }) })).resolves.toMatchObject({ status: 'unavailable', acceptsNewWork: false });
  });
});
