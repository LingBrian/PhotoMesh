# ADR-062: PM-090 media-version workflow safety policy

## Status

Implemented workflow policy checks alongside the existing idempotent media-version service. No new endpoint or database migration is added.

## Decision

A media version is created with a source SHA-256, immutable transform, and idempotency key. It may be cancelled only while staging. A terminal version is never rewritten; failure and cancellation remain visible and a retry must use a new idempotency key/version. Comparison is allowed only for two ready versions with non-empty output SHA-256 values. Existing originals and ready derived outputs are never overwritten or deleted by a retry.

The existing service's staging recovery, atomic publication, output verification, and idempotent conflict behavior remain authoritative. Client polling must treat ready, failed, cancelled, and error as terminal and must stop polling after cancellation or authorization failure. Any future cancel endpoint requires its own ACL and API contract review; this slice does not invent one.

## Acceptance

- cancellation, terminal transition, and comparison guards are tested;
- repeated idempotency requests do not create a second version or mutate the first transform;
- failed/cancelled states are recoverable through a new request without altering originals;
- output comparison requires verified ready hashes;
- no new schema, endpoint, or destructive path is introduced.
