# ADR-041: PM-069 resource metrics and low-space admission control

## Status

Implemented as an authenticated, bounded resource endpoint and upload admission guard.

## Decision

`GET /v1/resources` is restricted to the node administrator and returns only total/available/used bytes, low-space state, admission state, and bounded queue counts. It never returns a filesystem path, user filename, secret, or media content. Metrics are `no-store` and fail closed when a source is unavailable.

When available storage is at or below the configured threshold, `acceptsNewWork` is false and new upload sessions return `507 insufficient_storage`; existing work is not silently cancelled. This gives the UI an explicit alert signal while preserving resumability and avoiding data loss.

## Compatibility and rollback

The endpoint is additive. If no resource source is configured, existing upload behavior is unchanged and the endpoint returns capability unavailable. Removing the guard does not mutate stored data or alter existing files.

## Acceptance

- low-space state and queue counts are bounded and path-free;
- unavailable metrics fail closed;
- low space prevents new upload sessions with a stable status;
- administrator ACL and no-store response headers are enforced by contract tests.
