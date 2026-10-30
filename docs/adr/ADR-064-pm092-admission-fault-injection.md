# ADR-064: PM-092 admission faults and bounded retry policy

## Status

Implemented as a pure fault-to-outcome policy and test fixture. Existing upload, thumbnail, and media-version services remain responsible for their injected dependency errors and cleanup.

## Decision

- Full disk and partial writes return `507`, clean partial derived/staging output, and remain retryable only after capacity/recovery checks.
- Processing timeout returns `504`, cancels the active read/worker, cleans partial output, and is bounded for retry.
- Queue saturation returns `429` without claiming success and without creating output; callers honor a bounded `Retry-After` policy.
- A changed source returns `409`, cleans any temporary output, and is not silently retried because the source SHA-256 precondition no longer holds.

No fault path marks an upload, thumbnail, or media version as successfully published. Original bytes and previously ready outputs are never deleted or replaced by fault recovery. Fault injection tests must cover full disk, timeout, partial write, queue full, malformed source, and source-change races, including restart recovery and idempotency.

This slice adds no endpoint, schema, migration, or production fault trigger. It is a CI-verifiable contract for future adapters and existing service tests.
