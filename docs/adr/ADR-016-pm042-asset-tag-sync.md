# ADR-016: PM-042 Asset Tag OR-Set Sync, Authority, and Compatibility

- **Status:** Draft; explicit user approval required before protocol, ACL, or database implementation.
- **Date:** 2026-10-27
- **Roadmap:** PM-042 (asset-tag events, concurrent merge, N/N-1 negotiation).
- **Depends on:** PM-041 / ADR-015 (local `asset_tags` persistence), ADR-002 (signed events and causal merge), ADR-006 (adjacent-version compatibility).

## Context

PM-041 stores the current, trimmed, case-sensitive tag set in `asset_tags` and exposes authorized idempotent element-level add/remove operations. It intentionally emits no P2P tag events. The existing event envelope is signed and causally ordered, but its author sequence is shared by all current event types. The sync hello intersects capabilities, while outbound event selection currently follows per-author cursors and does not filter event types by that intersection. An older receiver stores an unknown event as unsupported and does not apply it. Simply adding a new event type to the existing sequence could therefore stall that author's later events for an N-1 peer.

The current peer/library grant model is read-only. A read grant must not silently become authority to modify another node's tags. PM-042 must define the authorizing principal separately from the relay and preserve existing library and trust checks.

## Goals

1. Replicate authorized tag additions/removals without LWW or wall-clock conflict resolution.
2. Converge after duplicate delivery, reordering, offline edits, and concurrent changes.
3. Preserve existing PM-041 tags and their case-sensitive identity through an idempotent signed bootstrap.
4. Keep legacy event synchronization usable when a peer lacks tag-sync support; retain unsupported tag operations rather than silently acknowledging or dropping them.
5. Never modify/delete original media or use tag sync as a backup mechanism.

## Non-goals

- Web tag-editor migration, browser IndexedDB import, or preview UI changes (PM-043).
- Virtual-album membership, general ACL redesign, or photo/original-byte replication.
- Production database migration, release, push, or merge.

## Proposed decision

### 1. Observed-remove set semantics

Use two signed operation types in a dedicated `asset-tags-v1` stream:

- `asset.tag.added`: payload `{ assetId, tag }`; the envelope `eventId` is the unique add-operation ID.
- `asset.tag.removed`: payload `{ assetId, tag, observedAddEventIds }`; the list is sorted, unique, bounded to 64 UUIDs, and names only add operations the author has observed.

A remove cancels only the listed add IDs. An add concurrent with a remove and absent from its observed list remains active. Re-adding after a removal creates a new add ID. Duplicate event IDs are idempotent. Tags retain PM-041's exact trimmed, case-sensitive text identity, 128 UTF-8-byte per-tag limit, and 64-active-tags-per-asset limit. Timestamps are informational only.

The current `asset_tags` table remains the materialized view used by gallery APIs. Add-only operation records and observed-remove records are the source for rebuilding that view; they are append-only and are not compacted in PM-042. A tag is present when at least one add ID has not been observed by a remove operation.

### 2. Separate stream and N/N-1 behavior

Do not put tag operations into the existing v1 metadata author's sequence. Add a separately sequenced tag-event log, inbox/outbox, author heads, and cursors, plus a dedicated negotiated transport capability (`asset-tags-v1`). Reuse the signed event envelope and existing trust/Noise transport primitives, but keep tag-stream sequence/cursor state independent from the v1 metadata stream.

Peers without `asset-tags-v1` continue receiving supported v1 metadata events; tag operations remain durable and visibly pending for that peer and are retried after capability negotiation changes. The sender must not mark a tag operation delivered merely because the peer accepted other event types. A peer that advertises tag support but rejects an invalid tag operation receives a structured error; its tag cursor does not advance past the rejected operation. No downgrade to unsigned events is permitted.

This is preferred over mixing new required events into the v1 sequence, which can block unrelated v1 events for N-1 nodes. Implementation must prove that an N-1 peer continues metadata sync while tag sync is explicitly unavailable. The tag protocol/capability name and exact wire framing remain part of the approval review.

### 3. Explicit tag-write authority

Keep existing read grants read-only. Add a distinct per-library tag-write grant, default denied, managed by an authenticated local Node administrator. A receiver accepts a tag event only when:

- the authenticated relay is trusted and may read the library under existing policy;
- the event author's Peer ID is trusted and has an explicit tag-write grant for that library; and
- signature, stream sequence, causal dependencies, and payload all validate.

Authorization is checked against the **event author**, not just the relay. Relaying does not grant authorship. Revoking a tag-write grant blocks future operations from that author but cannot retract operations already replicated to offline nodes; the API must report this limitation. Grant/revoke requires a protected admin API and an operator-visible control. Whether the control is added to existing pairing approval UI in PM-042 or left to a separate UI task must be decided before implementation; default remains deny.

### 4. SQLite projection and migration

Add an append-only migration (proposed `0006_asset_tag_sync`) without modifying checksums for `0001`–`0005`. It adds tag-operation state, per-stream event/cursor state, and the per-library tag-writer grant. The precise normalized table layout is an implementation detail subject to tests, but constraints must bind each add/remove to the same library, asset, and tag; prevent cross-library references; and make replay idempotent.

The migration copies every existing PM-041 `asset_tags` row into an idempotent legacy-seed queue and never deletes the source row. After local identity is loaded, a recovery-safe bootstrap creates one locally authored, signed `asset.tag.added` operation per seed and atomically associates its event ID with the OR-Set state. Pending signatures resume after restart; repeated bootstrap does not create duplicate adds. `created_at` is not treated as causal order. No tag is considered synchronized until it is accepted by a tag-capable peer.

Tag events never resurrect a tombstoned asset. Local HTTP mutations continue returning not-found for hidden/tombstoned assets. A valid event for a known but tombstoned asset is retained in tag history while the asset remains hidden; restore reveals the active tag projection. An event for an unknown asset waits for its indexed-asset causal dependency or is quarantined with an explicit error; it is never silently discarded.

### 5. Compatibility, backup, and rollback

The migration is additive and requires the existing pre-migration backup path for non-empty databases. Older binaries cannot safely use a database containing migration `0006`; rollback requires restoring the pre-migration backup and may lose tag operations written after that backup. Do not run a production migration without separate approval, validated backup, and restore rehearsal.

## Acceptance plan

1. Pure OR-Set tests: concurrent same-tag adds; remove only observed adds; concurrent unseen add survives; re-add after remove; duplicate/reordered delivery; case sensitivity; malformed/oversized operation payloads.
2. SQLite tests: migration checksum preservation, backup missing/failure behavior, cross-library/asset/tag rejection, projection rebuild, legacy-seed bootstrap exactly once, interrupted signing recovery, 64-active-tag cap, tombstone/restore behavior.
3. Authorization tests: untrusted author, read-only peer without tag-write grant, revoked writer, relay-versus-author distinction, and a valid explicitly granted writer.
4. Mixed-version two-node tests: N-1 continues v1 metadata sync while tag operations are retained and unacknowledged; N/N peers converge after reconnect; unsupported/malformed tag events never advance the tag cursor.
5. Run the existing `pnpm test:sync-compose` (script exists at `scripts/sync-compose-smoke.mjs`) with new assertions for tag convergence and original-byte immutability, plus `pnpm install --frozen-lockfile`, root lint/typecheck/test/contracts/build. If Docker is unavailable, report that integration test as blocked rather than passed.

## Approval questions

1. Approve the separate `asset-tags-v1` event stream to preserve N-1 metadata sync, rather than allowing tag events to stall the existing v1 per-author sequence?
2. Approve a separate default-deny per-library tag-write grant, without interpreting current read grants as write authority?
3. Approve observed-remove semantics and signed, idempotent bootstrap of all existing PM-041 tags?

No protocol, ACL, or database code should be changed until these decisions are approved.
