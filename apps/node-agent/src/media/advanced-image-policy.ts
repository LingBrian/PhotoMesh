export type AdvancedImageFormat = 'heic' | 'heif' | 'avif' | 'raw' | 'jpeg' | 'png' | 'webp' | 'unknown';
export type AdvancedImageDecision = { previewable: boolean; reason: 'supported' | 'decoder_not_enabled' | 'format_unknown'; originalImmutable: true; requiresLicenseReview: boolean };

/** Explicit format decision only; it never probes or decodes source bytes. */
export function evaluateAdvancedImageFormat(format: AdvancedImageFormat): AdvancedImageDecision {
  if (format === 'jpeg' || format === 'png' || format === 'webp') return { previewable: true, reason: 'supported', originalImmutable: true, requiresLicenseReview: false };
  if (format === 'heic' || format === 'heif' || format === 'avif' || format === 'raw') return { previewable: false, reason: 'decoder_not_enabled', originalImmutable: true, requiresLicenseReview: true };
  return { previewable: false, reason: 'format_unknown', originalImmutable: true, requiresLicenseReview: false };
}
