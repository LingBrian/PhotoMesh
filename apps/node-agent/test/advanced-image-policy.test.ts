import { describe, expect, it } from 'vitest';
import { evaluateAdvancedImageFormat } from '../src/media/advanced-image-policy.js';

describe('advanced image format policy', () => {
  it('keeps HEIC/HEIF/AVIF/RAW explicitly unavailable until review', () => {
    for (const format of ['heic', 'heif', 'avif', 'raw'] as const) {
      expect(evaluateAdvancedImageFormat(format)).toEqual({ previewable: false, reason: 'decoder_not_enabled', originalImmutable: true, requiresLicenseReview: true });
    }
  });
  it('allows only the currently bounded image formats and fails unknown formats closed', () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) expect(evaluateAdvancedImageFormat(format).previewable).toBe(true);
    expect(evaluateAdvancedImageFormat('unknown')).toEqual({ previewable: false, reason: 'format_unknown', originalImmutable: true, requiresLicenseReview: false });
  });
});
