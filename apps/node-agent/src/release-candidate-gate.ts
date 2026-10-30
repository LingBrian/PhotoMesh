export type ReleaseGateInput = {
  requiredCi: boolean;
  security: boolean;
  performance: boolean;
  migration: boolean;
  build: boolean;
  rollback: boolean;
  reports: readonly string[];
  productionApproval: boolean;
};
export type ReleaseGateResult = { eligible: boolean; reasons: string[] };

/** Release preflight only; it never publishes, deploys, or changes a release channel. */
export function evaluateReleaseCandidateGate(input: ReleaseGateInput): ReleaseGateResult {
  const reasons: string[] = [];
  for (const [name, passed] of Object.entries(input).slice(0, 6)) if (passed !== true) reasons.push(`${name}_required`);
  if (input.reports.length < 1 || input.reports.some((report) => !report.trim())) reasons.push('evidence_reports_required');
  if (input.productionApproval) reasons.push('production_approval_not_part_of_local_gate');
  return { eligible: reasons.length === 0, reasons };
}
