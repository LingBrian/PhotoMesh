# ADR-033: PM-061 recycle retention and visibility

## Status

Accepted as a design-only slice. No expiry worker or destructive operation is introduced.

## Scope

This policy covers Node-managed asset tombstones and shared virtual-album soft tombstones. External folders remain read-only and are never deleted by recycle-bin policy.

## Decision

1. Retention is a visibility policy, not an automatic purge permission. The recycle view may label a tombstone as `active`, `retention_due`, or `retention_unknown`, but no background job permanently removes files, tombstones, or event history.
2. Until a future approved implementation supplies a library policy, the effective state is `retention_unknown`; existing restore behavior remains available subject to causal/tombstone checks. A missing or malformed timestamp must never be treated as expired.
3. A future library policy must be explicit and versioned, with a minimum retention duration, the policy revision, and an effective time. It applies to the local library view and does not silently claim that every replica has purged the same history.
4. Shared album soft tombstones retain separate scopes: `local` hides the album on the authoring node, while `global` records a shared deletion intent. Visibility must show the scope and never collapse it into permanent deletion. Replica lag or a missing peer must show `retention_unknown`, not `expired`.
5. Expiry is advisory until PM-063's separately approved dry-run, backup, audit, and rollback design. A UI may offer an explicit future review action, but PM-061 does not add a mutation endpoint, purge job, file deletion, or event-history compaction.

## Safety and compatibility

No schema, API, sync event, or migration changes are made by PM-061. Existing `/v1/recycle-bin` and restore routes retain their ACL and no-store behavior. This ADR deliberately leaves destructive implementation behind the PM-063 approval gate.

## Acceptance evidence

- policy distinguishes active, due, and unknown without deleting data;
- local/global shared-album scopes remain visible;
- external source files are excluded;
- a future implementation must provide dry-run, backup, audit, and rollback evidence before any purge.
