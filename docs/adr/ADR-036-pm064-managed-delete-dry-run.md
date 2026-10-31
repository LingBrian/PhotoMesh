# ADR-036: PM-064 managed deletion dry-run gate

## Status

Implemented as a dry-run manifest and approval validator only. No byte deletion path is exposed.

## Decision

PM-064 generates a deterministic manifest only from managed, tombstoned candidates with verified SHA-256 and safe byte sizes. External locations, live objects, missing hashes, and uncertain tombstone state are excluded. Entries are sorted and the manifest digest covers the exact immutable entry set.

An execution approval validator requires the same manifest digest, a verified backup digest, and two distinct non-empty confirmations. This slice does not execute deletion: the validator is a safety boundary for a future separately approved executor. No external file, event history, or database row is removed.

## Compatibility and rollback

No schema, API, or P2P change. The module is pure and can be removed without modifying stored data. Any future deletion executor must add a separate ADR review and end-to-end failure/restore evidence.

## Acceptance

- deterministic manifests exclude external/live/unverified candidates;
- manifest tampering is detected;
- missing backup or confirmations blocks execution;
- tests prove no deletion side effect because no delete operation exists.
