# PhotoMesh Node Agent

The Node agent owns local metadata and a managed immutable object store. It uses SQLite by default; clients only access assets through the authenticated API.

## Local storage

`PHOTOMESH_DATA_DIR` selects the agent data directory. The agent creates `photomesh.sqlite` there and writes managed chunks and objects below `managed/`. On startup, the migration runner backs up a non-empty database before applying pending migrations. It refuses to migrate an existing database without a configured backup callback and refuses changed or unknown migration checksums.

Original filenames and source paths are persisted as metadata. They are never used to create managed storage paths, and upload code never opens a source path for writing. Managed object names are generated from an upload session ID.

## Upload API

The HTTP service supports:

- `POST /v1/uploads` with `Idempotency-Key` to create or replay a session.
- `GET /v1/uploads/{sessionId}` to read its durable offset.
- `PUT /v1/uploads/{sessionId}/chunks/{chunkIndex}` with `Upload-Offset` and `Upload-Chunk-SHA256` headers and an `application/octet-stream` body.
- `POST /v1/uploads/{sessionId}/complete` to verify full size and SHA-256, publish the object without replacing an existing path, and commit metadata.

Chunk writes are ordered and bounded to 8 MiB by default; the default file limit is 100 GiB. Configure limits by constructing `UploadService` with explicit limits. A retry with identical bytes is idempotent. Conflicting keys, offsets, or chunks return a conflict. Insufficient capacity returns `507` and does not advance the session offset. Full-file checksum mismatch returns `422` and cannot mark the session complete.

Every upload route calls `authorizeUpload`. The server denies access when no authorizer is configured. The authorizer must validate the bearer token and the caller's library/session ACL for each action; an opaque session ID is not authorization. The starter executable intentionally has no default user credentials, so upload routes remain denied until an authentication/ACL provider is wired in.

## Crash recovery and tests

Chunk bytes are flushed under a generated staging reference before their manifest and offset are committed in SQLite. Finalization streams chunks to a same-volume temporary object, verifies the complete SHA-256, and uses a no-replace hard-link publication. After restart, retry the same chunk request or call the completion endpoint again; a published object with uncommitted metadata is re-hashed and finalized idempotently. Once metadata is committed, the session's managed staging subtree is removed; a completion replay retries that cleanup if needed.

Unit tests use an in-memory SQLite database and `VirtualFileSystem` with injectable capacity and operation failures. Adapter tests use generated temporary directories only; they do not inspect or modify user photo directories.
