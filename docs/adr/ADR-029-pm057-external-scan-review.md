# ADR-029: PM-057 external scan review

## Status

Accepted for the bounded PM-057 slice.

## Decision

External folders remain read-only. A scan may update an indexed location's availability only when the observation is direct and safe; an incomplete scan must not infer that unobserved files were deleted. PM-057 exposes the latest in-memory scan result and the affected indexed paths through an authenticated, read-only review endpoint:

`GET /v1/libraries/{libraryId}/external-scan-review`

The endpoint returns scan completeness, issue codes, and only indexed paths currently marked `missing` or `offline`. It never triggers a scan, writes tombstones, deletes files, or changes availability. Library authorization is checked before any review data is returned; unauthorized libraries use the existing not-found response policy.

The Web client presents this as a review panel. “Confirm” is intentionally not implemented in PM-057: no user action from this panel can delete an asset or create a tombstone. A future approved task may define a separate mutation and its audit/rollback semantics.

## Compatibility and rollback

This is an optional capability. Older nodes ignore the route; clients hide the panel when the capability is absent. No database migration or protocol event change is required. Removing the endpoint and UI is a code rollback; existing availability values remain valid.

## Acceptance evidence

- unit tests cover complete scans, incomplete scans, missing/offline path reporting, and no mutation from review reads;
- server tests cover ACL denial, capability absence, and authorized responses;
- Web tests cover capability gating and bilingual review labels;
- existing lint, typecheck, tests, contract checks, and build remain green.
