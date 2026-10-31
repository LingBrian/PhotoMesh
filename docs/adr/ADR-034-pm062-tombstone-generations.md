# ADR-034: PM-062 tombstone generation protection

## Status

Accepted and implemented for asset restore.

## Decision

A library may retain more than one active delete event for the same asset while replicas converge. The projection records the single current tombstone generation. Restore requests must reference that exact generation; an older active event returns a conflict and cannot create a restore event. Existing causal-parent, signed-event, and idempotent retry checks remain mandatory.

This prevents an old delayed restore from reviving an asset after a newer delete. It does not purge old event history or delete external files. A future policy for removing history remains behind PM-063's separate approval gate.

## Compatibility and rollback

No schema or wire-format change. The check uses the existing projection tombstone event ID and returns the existing `conflict` result. Rolling back the code restores prior behavior without altering stored events.

## Acceptance

- two active delete generations leave the projection tombstoned;
- restoring the older generation returns conflict and writes no restore event;
- current-generation restore and committed retry behavior remain green.
