export type VideoPreviewPolicyInput = {
  enabled: boolean;
  mimeType: string;
  sourceBytes: number;
  durationSeconds: number;
  availableBytes: number;
  queueDepth: number;
};
export type VideoPreviewPolicyDecision = { allowed: boolean; reason: 'ready' | 'capability_disabled' | 'unsupported_format' | 'source_too_large' | 'duration_too_long' | 'insufficient_storage' | 'queue_full' };

const supportedPreviewTypes = new Set(['video/mp4', 'video/webm']);
export const maxVideoPreviewSourceBytes = 256 * 1024 * 1024;
export const maxVideoPreviewDurationSeconds = 10 * 60;
export const maxVideoPreviewQueueDepth = 1;
export const maxVideoPreviewOutputBytes = 16 * 1024 * 1024;

/** Admission policy only: it does not read, decode, or publish media bytes. */
export function evaluateVideoPreviewPolicy(input: VideoPreviewPolicyInput): VideoPreviewPolicyDecision {
  if (!input.enabled) return { allowed: false, reason: 'capability_disabled' };
  if (!supportedPreviewTypes.has(input.mimeType)) return { allowed: false, reason: 'unsupported_format' };
  if (!Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 1 || input.sourceBytes > maxVideoPreviewSourceBytes) return { allowed: false, reason: 'source_too_large' };
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > maxVideoPreviewDurationSeconds) return { allowed: false, reason: 'duration_too_long' };
  if (!Number.isSafeInteger(input.queueDepth) || input.queueDepth >= maxVideoPreviewQueueDepth) return { allowed: false, reason: 'queue_full' };
  if (!Number.isSafeInteger(input.availableBytes) || input.availableBytes < maxVideoPreviewOutputBytes * 2) return { allowed: false, reason: 'insufficient_storage' };
  return { allowed: true, reason: 'ready' };
}
