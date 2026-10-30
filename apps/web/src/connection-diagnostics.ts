export type ConnectionFailureKind = 'authorization' | 'forbidden' | 'offline' | 'timeout' | 'certificate' | 'unknown';

export function classifyConnectionFailure(cause: unknown): ConnectionFailureKind {
  if (typeof cause === 'object' && cause !== null && 'status' in cause) {
    const status = Number((cause as { status?: unknown }).status);
    if (status === 401) return 'authorization';
    if (status === 403) return 'forbidden';
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') return 'timeout';
  if (cause instanceof TypeError) return 'offline';
  if (cause instanceof Error && /certificate|tls|secure connection/i.test(cause.message)) return 'certificate';
  return 'unknown';
}
