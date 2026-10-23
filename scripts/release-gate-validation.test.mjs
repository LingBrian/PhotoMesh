import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceReportPasses } from './release-gate-validation.mjs';

const report = (p95Ms, overrides = {}) => ({
  dataset: { assets: 100_000, queries: 1_000, ...overrides.dataset },
  queryApi: { p95Ms, ...overrides.queryApi }
});

test('accepts only the required dataset and a finite nonnegative P95 below one second', () => {
  assert.equal(performanceReportPasses(report(0)), true);
  assert.equal(performanceReportPasses(report(999.99)), true);
  assert.equal(performanceReportPasses(report(1_000)), false);
  assert.equal(performanceReportPasses(report(-0.01)), false);
  assert.equal(performanceReportPasses(report(null)), false);
  assert.equal(performanceReportPasses(report('999')), false);
  assert.equal(performanceReportPasses(report(Number.NaN)), false);
  assert.equal(performanceReportPasses(report(Number.POSITIVE_INFINITY)), false);
  assert.equal(performanceReportPasses(report(50, { dataset: { assets: 99_999 } })), false);
  assert.equal(performanceReportPasses(report(50, { dataset: { queries: 999 } })), false);
  assert.equal(performanceReportPasses({}), false);
  assert.equal(performanceReportPasses(null), false);
});
