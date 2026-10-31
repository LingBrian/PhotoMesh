# ADR-063: PM-091 Node API ACL negative matrix

## Status

Added a versioned route-family inventory and CI guard. Existing endpoint integration tests remain the source of runtime behavior; this slice does not broaden authorization or change API responses.

## Matrix scope

The matrix covers library listing, scan review, metadata export, thumbnails, originals, media versions, timeline assets, tags, albums/members, uploads, recycle-bin/restore, pairing, resources, and diagnostics. Each family records methods, required capability, accepted unauthenticated/denied status envelope, and a cross-library non-disclosure requirement. `/v1/health` is intentionally excluded as the documented status-only public exception.

A negative test must exercise absent credentials, invalid credentials, revoked session/device, wrong library, wrong path capability, wrong operation grant, stale ACL epoch/cache, and untrusted peer where applicable. A route may return 404 instead of 403 when hiding resource existence, but it must not reveal paths, hashes, tokens, key references, or cross-library membership. Denied P2P events must not be ACKed or advance cursors.

## Acceptance and follow-up

CI checks that every protected family has a capability and 401/403-safe denial expectation, and that no health exception is accidentally added to the protected list. Server integration coverage must remain required for each matrix row; adding a new protected route requires updating the matrix in the same change. No schema, migration, or user-data operation is introduced.
