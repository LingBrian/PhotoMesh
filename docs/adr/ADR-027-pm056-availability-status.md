# ADR-027: PM-056 Availability and Access Statuses

- **Status:** Proposed for PM-056 implementation; no production migration or deletion.
- **Scope:** Distinguish node/source state in authorized gallery metadata and content-read errors.

## Decision

1. `online` and `cached` mean a readable local source; `offline` means the owning/source node is currently unreachable or its external source is unavailable; `missing` means the indexed source location is known but the file is absent. These values remain metadata, never deletion instructions.
2. Content routes use stable error codes: `source_offline` for `offline`, `source_missing` for `missing`, and `forbidden`/`unauthorized` for access refusal. Both source errors remain HTTP 409 because the asset may become readable without changing its identity; clients must not retry them as deletion.
3. Unknown assets and unauthorized library enumeration continue to use the existing indistinguishable 404 behavior. An authenticated client that already has an authorized asset record may display access refusal from 401/403 without exposing paths or bytes.
4. External scans may update an external location to `offline` or `missing`, but never create a tombstone or delete the logical asset. Only an explicit later destructive workflow may do so.

## Compatibility and rollback

The new `source_missing` error is additive to the API error enum. Older clients treating unknown 409 errors as unavailable remain safe. No database schema change is required; rollback removes the new mapping while retaining existing availability values.

## Acceptance

- API and web tests distinguish offline, missing, and authorization failures.
- Gallery labels show the exact availability state and preview errors do not claim that an asset was deleted.
- Existing ACL checks remain before thumbnail/original reads and no original bytes are modified.
