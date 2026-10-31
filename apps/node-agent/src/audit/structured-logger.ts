export type StructuredLogEvent = { event: string; requestId: string; outcome: 'start' | 'success' | 'failure'; durationMs?: number; fields?: Record<string, unknown> };

const sensitiveKey = /token|secret|password|private.?key|recovery|original|exif|gps|path|filename|bearer/i;
const bearerValue = /^Bearer\s+\S+$/i;
const maxLogBytes = 4096;

function sanitize(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return bearerValue.test(value) ? '[REDACTED]' : value.slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitize(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }
  return value;
}

export function serializeStructuredLog(input: StructuredLogEvent): string {
  const safe = { event: input.event.slice(0, 80), requestId: input.requestId.slice(0, 64), outcome: input.outcome, ...(input.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.min(input.durationMs, 86_400_000)) }), ...(input.fields ? { fields: sanitize(input.fields) } : {}) };
  const serialized = JSON.stringify(safe);
  return serialized.length <= maxLogBytes ? serialized : `${serialized.slice(0, maxLogBytes - 1)}…`;
}
