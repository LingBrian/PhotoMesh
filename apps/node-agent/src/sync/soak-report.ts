export type SoakReportInput = {
  reachableAtRecovery: boolean;
  expectedAssetHashes: readonly string[];
  finalAssetHashes: readonly string[];
  expectedEventIds: readonly string[];
  acceptedEventIds: readonly string[];
  deniedEventIds: readonly string[];
  retainedDeniedEventIds: readonly string[];
  recoveryMs: number | null;
};
export type SoakReportResult = { publishable: boolean; reasons: string[] };

/** Validates recorded two-node soak evidence; it does not run transport or mutate data. */
export function validateSoakReport(input: SoakReportInput): SoakReportResult {
  const reasons: string[] = [];
  if (input.expectedAssetHashes.length !== input.finalAssetHashes.length || input.expectedAssetHashes.some((hash, index) => hash !== input.finalAssetHashes[index])) reasons.push('asset_hash_mismatch');
  if (input.expectedEventIds.some((id) => !input.acceptedEventIds.includes(id))) reasons.push('event_missing');
  if (input.deniedEventIds.some((id) => input.acceptedEventIds.includes(id))) reasons.push('denied_event_accepted');
  if (input.deniedEventIds.some((id) => !input.retainedDeniedEventIds.includes(id))) reasons.push('denied_event_not_retained');
  if (input.reachableAtRecovery && (!Number.isFinite(input.recoveryMs) || (input.recoveryMs ?? -1) < 0)) reasons.push('recovery_measurement_missing');
  return { publishable: reasons.length === 0, reasons };
}
