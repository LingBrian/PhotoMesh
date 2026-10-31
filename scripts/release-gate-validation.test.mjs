import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceReportPasses, reconnectDurationWithinLimit, reconnectEvidencePasses } from './release-gate-validation.mjs';

const report = (p95Ms, overrides = {}) => ({
  dataset: { assets: 100_000, queries: 1_000, ...overrides.dataset },
  queryApi: { p95Ms, ...overrides.queryApi }
});

const reconnectEvidence = (reconnectSeconds, networkRestoredAt = '2026-04-01T00:00:00.000Z', firstEventAckAt = '2026-04-01T00:00:00.000Z') => ({
  reconnectSeconds, networkRestoredAt, firstEventAckAt
});

test('accepts only finite numeric Compose reconnect durations within 60 seconds', () => {
  assert.equal(reconnectDurationWithinLimit(0), true);
  assert.equal(reconnectDurationWithinLimit(60_000), true);
  assert.equal(reconnectDurationWithinLimit(60_000.01), false);
  assert.equal(reconnectDurationWithinLimit(-1), false);
  assert.equal(reconnectDurationWithinLimit(null), false);
  assert.equal(reconnectDurationWithinLimit('0'), false);
  assert.equal(reconnectDurationWithinLimit(Number.NaN), false);
  assert.equal(reconnectDurationWithinLimit(Number.POSITIVE_INFINITY), false);
});

test('accepts only numeric, timestamp-backed reconnect evidence within 60 seconds', () => {
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0)), true);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(60, '2026-04-01T00:00:00.000Z', '2026-04-01T00:01:00.000Z')), true);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(null)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence('0')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(Number.NaN)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(Number.POSITIVE_INFINITY)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(-0.1)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(60.1)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, 0, 0)), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, 'not-a-date')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2026-13-40T00:00:00.000Z')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2026-02-30T00:00:00.000Z')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2024-02-29T00:00:00.000Z', '2024-02-29T00:00:00.000Z')), true);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2026-04-01T01:00:00.000+01:00')), true);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2026-04-01T00:00:00.000+24:00')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(0, '2026-04-01T00:00:00.000+00:60')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(1, '2026-04-01T00:00:02.500Z', '2026-04-01T00:00:00.000Z')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(60, '2026-04-01T00:00:00.000Z', '2026-04-01T00:01:00.500Z')), false);
  assert.equal(reconnectEvidencePasses(reconnectEvidence(1, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:02.500Z')), false);
  assert.equal(reconnectEvidencePasses(null), false);
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
