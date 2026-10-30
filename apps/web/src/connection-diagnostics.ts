export type ConnectionFailureKind = 'authorization' | 'forbidden' | 'offline' | 'timeout' | 'certificate' | 'conflict' | 'rate-limited' | 'resource' | 'unknown';

export function classifyConnectionFailure(cause: unknown): ConnectionFailureKind {
  if (typeof cause === 'object' && cause !== null && 'status' in cause) {
    const status = Number((cause as { status?: unknown }).status);
    if (status === 401) return 'authorization';
    if (status === 403) return 'forbidden';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate-limited';
    if (status === 503 || status === 507) return 'resource';
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') return 'timeout';
  if (cause instanceof TypeError) return 'offline';
  if (cause instanceof Error && /certificate|tls|secure connection/i.test(cause.message)) return 'certificate';
  return 'unknown';
}
