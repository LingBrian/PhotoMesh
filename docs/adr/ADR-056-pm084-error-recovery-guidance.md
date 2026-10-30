# ADR-056: PM-084 error classification, retry, and recovery guidance

## Status

Implemented a bounded Web classifier and recovery policy. No automatic retry is wired into destructive or mutating operations.

## Decision

HTTP and transport failures are classified as authorization, forbidden, offline, timeout, certificate, conflict, rate-limited, resource, or unknown. Authorization, forbidden, conflict, and certificate failures are non-retryable and require user action. Offline/timeout failures use bounded exponential guidance (500 ms to 4 s); rate limiting and resource exhaustion use fixed waits. Unknown failures fail closed with a generic localized message.

The policy does not retry uploads, metadata mutations, deletes, restores, sharing, or sync acknowledgements automatically. Any future read-only retry must retain the existing request ID/idempotency and authorization checks. UI guidance never includes response bodies, tokens, filesystem paths, or stack traces; resource guidance explicitly states that existing work was not canceled.

## Acceptance

- 401/403, offline, conflict, rate-limit, resource, certificate, and timeout cases are distinct;
- retry delays are bounded and deterministic;
- authorization/conflict/certificate paths do not retry automatically;
- localized guidance is actionable without sensitive details;
- tests cover classification and retry policy boundaries.
