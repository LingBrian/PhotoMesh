# ADR-051: PM-079 expiring public-share policy gate

## Status

Implemented only as a pure policy gate. No public token is minted, no endpoint is exposed, and no production share is created because this high-risk feature still requires the separate human approval and penetration review required by PM-078.

## Decision

The policy accepts a request only when explicit approval is present, expiry is positive and no longer than 24 hours, scope contains at most 100 items, originals are not requested, and sensitive metadata is excluded. The only permitted response profile is a derived preview without sensitive metadata. Invalid requests fail closed with a reason suitable for local UI, not a public response.

This module deliberately has no signing key, persistence, rate-limit store, cache, or media reader. It cannot accidentally publish a link. A future approved implementation must add signed opaque tokens, revocation/epoch checks, per-token/source rate limits, uniform enumeration-safe errors, no-store/epoch-bound caching, privacy fixture tests, audit summaries, and independent penetration review.

## Acceptance

- approval, expiry, scope, original-byte, and sensitive-metadata gates are tested;
- policy output contains no token, path, secret, or media bytes;
- the default remains disabled until explicit approval and security evidence exist.
