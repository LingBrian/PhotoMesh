import { describe, expect, it } from 'vitest';
import { validateRoadmapAudit } from '../src/roadmap-audit.js';

const ids = ['PM-098', 'PM-099', 'PM-100'];

describe('roadmap audit evidence', () => {
  it('accepts complete entries only when code, tests, and device evidence are linked', () => {
    expect(validateRoadmapAudit([{ id: 'PM-098', status: 'complete', codeEvidence: ['commit'], testEvidence: ['ci'], deviceEvidence: ['vm-report'] }], ['PM-098'])).toEqual({ auditable: true, reasons: [] });
  });
  it('requires every expected item and refuses unsupported completion claims', () => {
    expect(validateRoadmapAudit([{ id: 'PM-099', status: 'complete', codeEvidence: ['commit'], testEvidence: ['ci'], deviceEvidence: [] }], ids).reasons).toEqual(expect.arrayContaining(['missing:PM-098', 'complete_without_evidence:PM-099', 'missing:PM-100']));
  });
  it('allows explicit deferral without pretending the requirement passed', () => {
    expect(validateRoadmapAudit(ids.map((id) => ({ id, status: 'deferred' as const, codeEvidence: [], testEvidence: [], deviceEvidence: [], note: 'real device evidence pending' })), ids)).toEqual({ auditable: true, reasons: [] });
    expect(validateRoadmapAudit([{ id: 'PM-098', status: 'deferred', codeEvidence: [], testEvidence: [], deviceEvidence: [] }], ['PM-098']).reasons).toContain('deferred_without_note:PM-098');
  });
});
