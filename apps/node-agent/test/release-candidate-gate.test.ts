import { describe, expect, it } from 'vitest';
import { evaluateReleaseCandidateGate, type ReleaseGateInput } from '../src/release-candidate-gate.js';

const complete: ReleaseGateInput = { requiredCi: true, security: true, performance: true, migration: true, build: true, rollback: true, reports: ['ci.txt', 'security.txt', 'performance.txt'], productionApproval: false };

describe('release candidate gate', () => {
  it('accepts a complete local evidence set without performing release actions', () => {
    expect(evaluateReleaseCandidateGate(complete)).toEqual({ eligible: true, reasons: [] });
  });
  it('blocks any failed required gate or missing evidence', () => {
    expect(evaluateReleaseCandidateGate({ ...complete, security: false })).toMatchObject({ eligible: false, reasons: ['security_required'] });
    expect(evaluateReleaseCandidateGate({ ...complete, reports: [] }).reasons).toContain('evidence_reports_required');
  });
  it('does not treat production approval as an automatic local release action', () => {
    expect(evaluateReleaseCandidateGate({ ...complete, productionApproval: true }).reasons).toContain('production_approval_not_part_of_local_gate');
  });
});
