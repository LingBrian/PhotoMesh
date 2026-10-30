export type LicenseReviewInput = { packageName: string; license: string | null; sourceAvailable: boolean; nativeCode: boolean };
export type LicenseReviewDecision = { approved: boolean; reason: 'approved' | 'missing-license' | 'unapproved-license' | 'source-required' | 'native-review-required' };

const permissiveSpdx = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const conditionalSpdx = new Set(['LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later']);

/** Metadata gate only; it does not replace a full lockfile/SBOM/legal review. */
export function reviewDependencyLicense(input: LicenseReviewInput): LicenseReviewDecision {
  if (!input.license) return { approved: false, reason: 'missing-license' };
  if (conditionalSpdx.has(input.license) && !input.sourceAvailable) return { approved: false, reason: 'source-required' };
  if (!permissiveSpdx.has(input.license) && !conditionalSpdx.has(input.license)) return { approved: false, reason: 'unapproved-license' };
  if (input.nativeCode) return { approved: false, reason: 'native-review-required' };
  return { approved: true, reason: 'approved' };
}
