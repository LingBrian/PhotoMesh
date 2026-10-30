# ADR-049: PM-077 private sharing and revocation prototype

## Status

Implemented as an in-memory, non-HTTP prototype. Persistence, account integration, and production sharing endpoints remain behind security review.

## Decision

`PrivateShareService` creates a high-entropy one-time token bound to a recipient ID, library, album, and expiry. Only a SHA-256 token digest is retained; acceptance compares digests in constant time, consumes the invitation, and returns a least-privilege grant without the secret. Invalid attempts are bounded, recipient mismatches do not disclose existence, and expired/revoked/consumed invitations cannot be accepted.

Grant authorization checks recipient, exact library/album scope, acceptance, revocation, and expiry on every call. Revocation does not delete media, event history, or recipient cache. The module is not wired to HTTP or persistence, so no production access path is added by this slice.

## Acceptance

- recipient and scope binding prevents cross-device and cross-library access;
- invitation is one-time, expires, revokes, and rate-limits attempts;
- stored service state and JSON output do not contain the raw token;
- tests cover invalid, replayed, expired, revoked, and wrong-library cases.
