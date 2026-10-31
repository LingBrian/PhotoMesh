# ADR-035: PM-063 permanent deletion scope and approval gates

## Status

Accepted as a design-only safety gate. No deletion or purge implementation is authorized by this ADR.

## Scope

Permanent deletion, if ever approved, may apply only to Node-managed objects explicitly listed by a dry-run. It must never apply to external source files, files on another node without an independently verified local authorization, or event history needed for causal recovery unless a separate history-retention decision is approved.

## Required preconditions

1. A human-approved retention policy identifies the exact library, object IDs, tombstone generations, replicas, and event-history scope. “Older than N days” alone is insufficient.
2. A dry-run produces a deterministic manifest containing object IDs, SHA-256, byte size, storage class, node, reason, current tombstone generation, and backup reference. The manifest is reviewed before execution and is immutable once approved.
3. A restorable backup exists outside the target data directory and is independently hash-verified. A same-volume copy is not sufficient. The recovery directory and tested restore procedure are recorded without storing secrets or user paths in logs.
4. Execution requires two explicit confirmations in the same authenticated administrative session, with request ID, manifest digest, actor, timestamp, and policy revision recorded in bounded audit logs.
5. Any manifest mismatch, missing replica, offline node, uncertain causal state, failed hash check, low space, or partial write aborts before deletion. There is no best-effort continuation.

## Rollback and audit

Deletion is irreversible for the selected managed bytes, so “rollback” means restoring from the verified backup into an isolated directory and re-indexing only after review; it does not claim to resurrect a deleted external file. The operation must support a preflight-only mode, an execution summary, and a failure report. No automatic tombstone purge or P2P event compaction is included.

## Explicit non-goals

PM-063 does not add a background purge worker, delete endpoint, shared-link cleanup, external-folder deletion, key destruction, or production migration. PM-064 may implement only after this gate is separately approved and supplies a concrete dry-run/backup implementation.

## Acceptance evidence

The design is accepted only when the future implementation can attach a dry-run manifest, backup hash/recovery proof, two-confirmation audit record, and abort-on-uncertainty tests. Until then, the feature remains unavailable and the release checklist must report it as not implemented.
