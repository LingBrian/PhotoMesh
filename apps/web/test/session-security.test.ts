import { describe, expect, it, vi } from 'vitest';
import { isAuthorizationFailure, isRequestAborted, revokeObjectUrls, SessionRequestScope } from '../src/session-security.js';

describe('session security primitives', () => {
  it('aborts active requests and makes their leases stale on invalidation', () => {
    const scope = new SessionRequestScope();
    const first = scope.begin();
    const second = scope.begin();

    expect(first.isCurrent()).toBe(true);
    expect(second.isCurrent()).toBe(true);
    scope.invalidate();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
  });

  it('blocks new requests after session or device revocation until a new session is established', () => {
    const scope = new SessionRequestScope();
    const active = scope.begin();
    scope.revoke('device_revoked');
    expect(active.signal.aborted).toBe(true);
    expect(scope.isRevoked()).toBe(true);
    expect(scope.revocationReason()).toBe('device_revoked');
    const blocked = scope.begin();
    expect(blocked.signal.aborted).toBe(true);
    scope.reset();
    expect(scope.isRevoked()).toBe(false);
    expect(scope.begin().isCurrent()).toBe(true);
  });

  it('does not abort a request after its lease has been released', () => {
    const scope = new SessionRequestScope();
    const request = scope.begin();
    request.release();
    scope.invalidate();
    expect(request.signal.aborted).toBe(false);
    expect(request.isCurrent()).toBe(false);
  });

  it('propagates caller cancellation to the session-scoped request', () => {
    const scope = new SessionRequestScope();
    const caller = new AbortController();
    const request = scope.begin(caller.signal);
    caller.abort();
    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    request.release();
  });

  it('starts canceled if the caller was already aborted', () => {
    const scope = new SessionRequestScope();
    const caller = new AbortController();
    caller.abort();
    const request = scope.begin(caller.signal);
    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    request.release();
  });

  it('recognizes aborted work without misclassifying other failures', () => {
    expect(isRequestAborted({ name: 'AbortError' })).toBe(true);
    expect(isRequestAborted(new Error('network failure'))).toBe(false);
    expect(isRequestAborted(null)).toBe(false);
  });

  it('classifies only unauthorized and forbidden responses as session invalidation', () => {
    expect(isAuthorizationFailure(401)).toBe(true);
    expect(isAuthorizationFailure(403)).toBe(true);
    expect(isAuthorizationFailure(404)).toBe(false);
    expect(isAuthorizationFailure(500)).toBe(false);
  });

  it('revokes all distinct non-empty object URLs exactly once', () => {
    const revoke = vi.fn();
    revokeObjectUrls(['blob:first', 'blob:second', 'blob:first', ''], revoke);
    expect(revoke.mock.calls).toEqual([['blob:first'], ['blob:second']]);
  });
});
