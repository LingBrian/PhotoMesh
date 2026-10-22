# ADR-009: SQLite upload persistence and immutable object commit

- Status: Approved by user on 2026-10-21
- Date: 2026-10-21
- Scope: M1 Node agent local persistence and upload API
- Supersedes: none

## Context

The Node agent currently has only a health endpoint. The M0 OpenAPI draft defines upload creation and session lookup, but it does not define resumable chunk writes or finalization. The product requirements require restart-safe chunk upload, full-object SHA-256 verification, atomic publication, and preservation of every source name/path. A database schema and API contract change therefore precede implementation.

No production database exists in this repository. The first migration will be an additive bootstrap migration; it will create tables and indexes but will not modify or delete files or existing rows.

## Decision proposed

### SQLite and repository boundary

- Use SQLite as the Node agent default, behind a repository interface.
- Enable foreign keys, WAL mode, and a bounded busy timeout at connection startup.
- Use serialized write transactions (`BEGIN IMMEDIATE`) for idempotency and session state transitions. Keep filesystem writes outside long-running database transactions.
- Use a migration ledger with ordered, checksummed SQL migrations. Refuse to apply an already-seen migration whose checksum changed. Apply each SQL migration and ledger update in one SQLite transaction.
- Do not add a PostgreSQL adapter in this change.

### Tables

Required core tables:

- `assets`: logical asset ID, library ID, origin node ID, kind, capture timestamp, creation timestamp.
- `asset_files`: immutable content identity, asset ID, SHA-256, byte length, media role, managed storage reference.
- `file_locations`: file ID, node ID, original filename, exact source path/reference, source kind, storage class, availability, and managed storage reference. Source path/name are metadata and are never used as a destination path.
- `jobs`: durable job type/state, retry count, lease, checkpoint JSON, timestamps.
- `events`: opaque local event/outbox record with event ID, type, aggregate ID, JSON payload, creation/publication timestamps. It is not the P2P signed wire format and does not settle ADR-002.

Additional persistence required for resumable upload:

- `upload_sessions`: idempotency scope/key, immutable request fingerprint, expected total bytes and SHA-256, original filename/source metadata, state, accepted offset, expiry, and completion references.
- `upload_chunks`: session ID, chunk index, byte length, chunk SHA-256, generated staging reference. Unique `(session_id, chunk_index)`.

All IDs are opaque generated identifiers. Original names and paths are stored as supplied after validation; they are not concatenated into managed storage paths. Foreign keys and non-negative length/offset checks are enforced. Cross-library/global hash uniqueness is intentionally absent to avoid conflating logical assets or leaking cross-security-domain equality.

### Upload API contract

Extend the draft OpenAPI and JSON Schema source of truth:

- `POST /v1/uploads` with mandatory `Idempotency-Key`, declared file length/hash, library, original filename and source metadata. Reusing the same key and identical request returns the existing session; reusing it with a different request returns `409`.
- `GET /v1/uploads/{sessionId}` returns durable accepted offset/state.
- `PUT /v1/uploads/{sessionId}/chunks/{chunkIndex}` accepts one bounded chunk with expected offset and chunk SHA-256. Same index and identical bytes is idempotent; conflicting bytes or offset returns `409`.
- `POST /v1/uploads/{sessionId}/complete` verifies completeness and full SHA-256, then commits. Success is returned only after a recoverable atomic publication and durable metadata transaction.

Return structured `409` for idempotency/offset conflicts, `413` for configured per-file/chunk limits, `507` for capacity exhaustion, and `422` for checksum mismatch. These errors never mark the session complete.

### Staging and publication

- Store each accepted chunk as a generated immutable file under the managed staging root. Never write to or rename over the submitted source path.
- Write a chunk to a temporary staging name, flush it, verify its chunk hash, atomically create its final staging name without replacement, then commit its chunk manifest/offset in SQLite. Orphan stage files after a crash are reconciled as staging-only artifacts; they cannot become user-visible originals.
- Serialize writes per session and use SQLite uniqueness/transactions across processes. Generated object names are independent of client filenames and source paths.
- Completion assembles chunks into a same-filesystem generated temporary object, verifies exact size and full SHA-256, flushes it, and publishes with a no-replace atomic operation. If the object already exists, verify its bytes before treating it as an idempotent retry. Never overwrite an existing object.
- Commit assets/files/locations and completed session state transactionally only after publication. Recovery handles the publish-succeeded/DB-commit-failed window by verifying the published object and completing the metadata transaction idempotently.
- Disk-full and I/O failures preserve the prior durable offset and return retryable errors. No API success precedes content verification and publication.

### Compatibility and migration

- API draft version remains 0.1.0 while the repository has no released clients; add the new paths and request/response fields as part of this pre-release contract. Existing upload create/session shapes remain readable; new `source` metadata is optional for compatibility.
- Migration `0001_upload_foundation` creates the seven tables and indexes only. It contains no data rewrite, file operation, or destructive down migration. Existing installations without a database get an empty initialized database. If a future existing database is found, migration runner takes a SQLite backup before applying and reports a recoverable failure; it does not delete or rewrite user files.
- After release, schema evolution uses additive expand/backfill/contract migrations with compatibility tests. Downgrades that drop non-empty tables are not automated.
- The `events` row is explicitly a local persistence envelope; P2P signatures, sequence/causality, tombstones, and wire compatibility remain blocked on ADR-002/006.

## Consequences and risks

- Adds SQLite runtime and test dependencies; select a maintained Node-compatible driver and pin it through the lockfile.
- Filesystem atomicity is guaranteed only on the same managed volume and for the selected no-replace primitive; the storage adapter must report unsupported semantics rather than silently falling back to overwrite/cross-volume rename.
- SQLite and filesystem cannot share one transaction. The staging manifest, immutable publication, and recovery reconciliation address crash windows; fault-injection tests must cover each boundary.
- ACL checks remain the caller/service responsibility and must happen before upload session creation and every subsequent session/chunk/finalize access. This persistence module must not imply authorization from an unguessable session ID.

## Test and acceptance plan

- Migration/repository tests use a temporary SQLite database and verify constraints, transaction rollback, migration checksum refusal, and repository round trips.
- Virtual filesystem tests inject write, flush, rename/no-replace, read, and capacity failures; assert source path bytes are unchanged and incomplete uploads are never reported complete.
- Upload tests cover duplicate create/chunk/finalize, conflicting idempotency key, concurrent chunk writes, offset mismatch, wrong chunk/full hash, ENOSPC, process interruption at every durable boundary, and restart recovery.
- Contract validation checks OpenAPI and JSON Schema agree with request/response behavior.
- Run existing root commands plus focused Node tests. Flutter is unaffected and is not a dependency of this change.

## Rollback

The bootstrap migration is additive and has no automatic down migration. Application rollback may use the pre-migration SQLite backup. Staging artifacts can be reconciled only within the managed staging root; source paths and existing originals are never cleanup targets. This change does not run migrations against any user database or inspect/write user source files.

## Approval

The user approved the table set (including `upload_sessions` and `upload_chunks`), the upload endpoints, and the recovery/publication model on 2026-10-21. The SQLite runtime driver selected for implementation is `better-sqlite3`, which supports maintained Node.js releases, transactions, and Windows/Linux ARM64 targets through platform binaries or source builds. Native build scripts are explicitly allowlisted in `pnpm-workspace.yaml`.
