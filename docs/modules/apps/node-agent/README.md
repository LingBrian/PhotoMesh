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

Every upload route calls `authorizeUpload`. A bare `createNodeAgentServer` denies access when no authorizer is configured. The starter executable wires upload, library, media-version and pairing authorization to the configured local administrator Bearer token; route callbacks still enforce the relevant library/session ACL, and an opaque session ID is not authorization. `/v1/health` is public; other operations require their documented authorization.

## Crash recovery and tests

Chunk bytes are flushed under a generated staging reference before their manifest and offset are committed in SQLite. Finalization streams chunks to a same-volume temporary object, verifies the complete SHA-256, and uses a no-replace hard-link publication. After restart, retry the same chunk request or call the completion endpoint again; a published object with uncommitted metadata is re-hashed and finalized idempotently. Once metadata is committed, the session's managed staging subtree is removed; a completion replay retries that cleanup if needed.

Before migrations or listeners start, the agent runs SQLite `quick_check` and fails closed with a generic error if integrity is not confirmed; it does not repair or rewrite a damaged database. Startup requeues interrupted upload jobs. Unexpired sessions whose accepted offset equals their declared size are retried automatically and still pass the full-file SHA-256 check; partial sessions retain their checkpoint and staging chunks for client-driven resume with the same session ID. On SIGINT/SIGTERM, HTTP, P2P, and external scanning are stopped/drained before media-version and upload-recovery work; SQLite is closed last. Cleanup failures produce only a generic diagnostic. No database schema change is required.

Unit tests use in-memory SQLite and `VirtualFileSystem` with injectable capacity and operation failures. Restart tests reopen a file-backed database and generated temporary object directory, verify the quick check/job checkpoint/object SHA-256, and remove only that temporary fixture; they do not inspect or modify user photo directories.

## Read-only external directories

`PHOTOMESH_EXTERNAL_ROOTS` is the explicit root allowlist. Each entry requires a stable `rootId`, `libraryId`, absolute `path`, and `pathStyle` (`win32` or `posix`). Configured roots must not overlap; overlapping canonical roots are rejected because the current location schema intentionally has no root-ownership column. The scanner hashes files in bounded streams, writes only SQLite metadata, preserves each original path as an independent source record (even when two paths have identical bytes), and never writes through an external path. NTFS roots default to case-insensitive conflict detection; ext4/Btrfs roots default to case-sensitive behavior. Set `caseSensitive` explicitly for NTFS directories with per-directory case sensitivity enabled.

The agent watches discovered directories and also performs a full scheduled scan every 15 minutes, because platform and NAS watchers can drop events. A watcher event triggers a debounced rescan. Symlinks are followed only when their resolved targets are within an explicitly configured root; directory cycles are reported and skipped. Inaccessible paths become `offline`; confirmed absent paths become `missing`. An incomplete directory scan does not infer deletions. Neither state transition deletes an asset, source file, or global metadata.

On Windows, `start.bat` asks for an optional external photo folder. The launcher verifies that the path resolves to a readable directory and serializes it as a one-entry JSON root allowlist. Invalid paths display the underlying reason and prompt again; pressing Enter skips external folders. The selected source remains read-only.

## LAN identity and pairing

Each node creates an Ed25519 libp2p identity whose private key is stored in Windows Credential Manager or Linux Secret Service; the public Peer ID/key is stored in SQLite. Linux pairing fails closed if Secret Service is unavailable. TCP connections use Noise XX and mDNS only advertises untrusted discovery hints. Configure `PHOTOMESH_LAN_BIND_ADDRESSES` with explicit private interface IPs and `PHOTOMESH_P2P_PORT` to enable LAN listening. Wildcard/public binds are rejected.

The local loopback management API requires `PHOTOMESH_ADMIN_TOKEN` for pairing actions. `POST /v1/pairing/invitations` returns a two-minute, single-use invite with a PNG QR data URL. The host must approve each authenticated peer. Pairing grants no library access by default; only explicit per-library read grants expose the index. Revocation closes the peer connection and is checked on every index request. See [LAN security pairing operations](../../../operations/LAN安全配对.md) for Windows PowerShell, firewall, Linux/NAS and Docker examples.

### Web client origins

By default, browser CORS is restricted to local Web origins and the Tauri origin. To use a Web client hosted at a remote, known origin, set `PHOTOMESH_WEB_ORIGINS` to a comma-separated allowlist of exact HTTPS origins (loopback HTTP origins may be used for development; scheme, host, and optional port only; no path, wildcard, or credentials). The agent reflects only an exact configured origin and does not enable cookie credentials. This is CORS configuration, not authorization: every protected API request still requires the current bearer credential and backend library ACL. Use HTTPS and an authenticated TLS reverse proxy when exposing the API beyond loopback; do not set a wildcard origin.

### Windows PowerShell (NTFS)

Run the agent with the intended source folder in the explicit allowlist. The source folder is never opened for writing:

```powershell
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\Photos","pathStyle":"win32"}]'
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
```

### Linux/NAS container (ext4 or Btrfs)

Mount the external library read-only and keep agent metadata on a separate writable volume:

```yaml
services:
  node-agent:
    image: photomesh/node-agent:local
    environment:
      PHOTOMESH_DATA_DIR: /data
      PHOTOMESH_EXTERNAL_ROOTS: >-
        [{"rootId":"nas-photos","libraryId":"family","path":"/external/photos","pathStyle":"posix"}]
    volumes:
      - photomesh-data:/data
      - /srv/photos:/external/photos:ro
    read_only: true
    tmpfs:
      - /tmp
volumes:
  photomesh-data:
```

Use a container UID that can read the mounted library and write `/data`; do not loosen source permissions for the scanner. The periodic scan remains active if the NAS filesystem does not provide reliable watcher events.
The example does not publish the agent API port; the starter agent binds to loopback by default. Put an explicitly configured TLS/authenticated reverse proxy in front of it before exposing any API outside the container.
