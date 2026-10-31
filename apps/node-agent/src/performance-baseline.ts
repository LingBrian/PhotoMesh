export type PerformanceBaselineInput = {
  hardware: { platform: string; architecture: string; ramBytes: number; cpuCores: number };
  dataset: { assetCount: number; bytes: number; synthetic: boolean; description: string };
  cacheMode: 'cold' | 'warm' | 'mixed';
  measurements: { durationMs: number; peakRssBytes: number; throughputAssetsPerSecond: number; failures: number; retries: number; hashMismatches: number };
};
export type PerformanceBaselineResult = { publishable: boolean; reasons: string[] };

/** Validates evidence metadata; it does not benchmark or infer unmeasured performance. */
export function validatePerformanceBaseline(input: PerformanceBaselineInput): PerformanceBaselineResult {
  const reasons: string[] = [];
  if (!input.hardware.platform || !input.hardware.architecture || !Number.isSafeInteger(input.hardware.ramBytes) || input.hardware.ramBytes < 1 || !Number.isSafeInteger(input.hardware.cpuCores) || input.hardware.cpuCores < 1) reasons.push('hardware_incomplete');
  if (!Number.isSafeInteger(input.dataset.assetCount) || input.dataset.assetCount < 1 || !Number.isSafeInteger(input.dataset.bytes) || input.dataset.bytes < 1 || !input.dataset.description) reasons.push('dataset_incomplete');
  if (!['cold', 'warm', 'mixed'].includes(input.cacheMode)) reasons.push('cache_mode_invalid');
  const values = Object.values(input.measurements);
  if (values.some((value) => !Number.isFinite(value) || value < 0) || input.measurements.durationMs <= 0 || input.measurements.hashMismatches > 0) reasons.push('measurements_invalid');
  if (input.measurements.failures > 0) reasons.push('failures_present');
  return { publishable: reasons.length === 0, reasons };
}
