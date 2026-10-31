import { describe, expect, it } from 'vitest';
import { validatePerformanceBaseline, type PerformanceBaselineInput } from '../src/performance-baseline.js';

const complete: PerformanceBaselineInput = {
  hardware: { platform: 'windows', architecture: 'x64', ramBytes: 8 * 1024 ** 3, cpuCores: 4 },
  dataset: { assetCount: 1000, bytes: 1000, synthetic: true, description: 'bounded synthetic corpus v1' },
  cacheMode: 'cold',
  measurements: { durationMs: 1000, peakRssBytes: 100, throughputAssetsPerSecond: 1000, failures: 0, retries: 0, hashMismatches: 0 }
};

describe('performance baseline evidence', () => {
  it('accepts complete measured evidence without inventing a target', () => {
    expect(validatePerformanceBaseline(complete)).toEqual({ publishable: true, reasons: [] });
  });
  it('does not publish incomplete or failed measurements', () => {
    expect(validatePerformanceBaseline({ ...complete, hardware: { ...complete.hardware, ramBytes: 0 } })).toMatchObject({ publishable: false, reasons: ['hardware_incomplete'] });
    expect(validatePerformanceBaseline({ ...complete, measurements: { ...complete.measurements, failures: 1 } }).publishable).toBe(false);
    expect(validatePerformanceBaseline({ ...complete, measurements: { ...complete.measurements, hashMismatches: 1 } }).reasons).toContain('measurements_invalid');
  });
});
