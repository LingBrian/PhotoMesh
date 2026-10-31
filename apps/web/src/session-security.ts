export type SessionRequestLease = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  release: () => void;
};

export class SessionRequestScope {
  private generation = 0;
  private revokedReason: string | null = null;
  private readonly activeControllers = new Set<AbortController>();

  begin(parentSignal?: AbortSignal | null): SessionRequestLease {
    const controller = new AbortController();
    const requestGeneration = this.generation;
    if (this.revokedReason !== null) controller.abort();
    const abortFromParent = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    this.activeControllers.add(controller);
    let released = false;

    return {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && requestGeneration === this.generation,
      release: () => {
        if (released) return;
        released = true;
        this.activeControllers.delete(controller);
        parentSignal?.removeEventListener('abort', abortFromParent);
      },
    };
  }

  invalidate(): void {
    this.generation += 1;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  revoke(reason = 'session_revoked'): void {
    this.revokedReason = reason || 'session_revoked';
    this.invalidate();
  }

  reset(): void {
    this.revokedReason = null;
    this.generation += 1;
  }

  isRevoked(): boolean { return this.revokedReason !== null; }
  revocationReason(): string | null { return this.revokedReason; }
}

export function isAuthorizationFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export function isRequestAborted(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError';
}

export function revokeObjectUrls(urls: Iterable<string>, revoke: (url: string) => void): void {
  for (const url of new Set(urls)) if (url) revoke(url);
}
