import { describe, expect, it } from 'vitest';
import { validateSoakReport, type SoakReportInput } from '../src/sync/soak-report.js';

const complete: SoakReportInput = { reachableAtRecovery: true, expectedAssetHashes: ['a', 'b'], finalAssetHashes: ['a', 'b'], expectedEventIds: ['e1'], acceptedEventIds: ['e1'], deniedEventIds: ['denied-1'], retainedDeniedEventIds: ['denied-1'], recoveryMs: 120 };

describe('two-node soak evidence', () => {
  it('accepts equal final hashes, complete accepted events, and retained denied events', () => {
    expect(validateSoakReport(complete)).toEqual({ publishable: true, reasons: [] });
  });
  it('rejects loss, hash divergence, or unauthorized event acceptance', () => {
    expect(validateSoakReport({ ...complete, finalAssetHashes: ['a', 'c'] }).reasons).toContain('asset_hash_mismatch');
    expect(validateSoakReport({ ...complete, acceptedEventIds: [] }).reasons).toContain('event_missing');
    expect(validateSoakReport({ ...complete, acceptedEventIds: ['e1', 'denied-1'] }).reasons).toContain('denied_event_accepted');
    expect(validateSoakReport({ ...complete, retainedDeniedEventIds: [] }).reasons).toContain('denied_event_not_retained');
  });
  it('does not invent an SLA when recovery was unreachable', () => {
    expect(validateSoakReport({ ...complete, reachableAtRecovery: false, recoveryMs: null })).toEqual({ publishable: true, reasons: [] });
    expect(validateSoakReport({ ...complete, recoveryMs: null }).reasons).toContain('recovery_measurement_missing');
  });
});
