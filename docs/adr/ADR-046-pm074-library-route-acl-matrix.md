# ADR-046: PM-074 library-scoped ACL route matrix

## Status

Design/test matrix only. It depends on PM-072/PM-073 approval and does not change the current authorization model or schema.

## Matrix

| Route family | Read capability | Mutation capability | Required negative cases |
| --- | --- | --- | --- |
| library list, asset search/filter, duplicate candidates | library-list/read | none | missing/revoked admin, unknown library, cross-library IDOR |
| metadata export, scan review | library-read | none | unauthorized library, path permission absent, cache replay |
| thumbnail, original, media-version collection/content | library-read plus media/path capability | media-version write only for authorized admin/contributor | cross-library asset, tombstone, offline source, stale cached response |
| tags, favorites, ratings | library-read | distinct tag/favorite/rating write grant | read-only role, revoked writer, duplicate/idempotency replay |
| recycle-bin list/restore | library-read | restore/admin or explicit future role | cross-library event, old tombstone generation, revoked session |
| album list/members | library-read | album-write | album from another library, tombstone, peer grant mismatch |
| album delete/restore | library-read | separate album-delete | album-write without delete, stale generation, revoked peer |
| uploads | operation-scoped create/read/write/complete | operation-scoped upload authorization | missing action, wrong session, low storage, replayed idempotency key |
| pairing, grants, device approval/revoke, diagnostics/resources | node administrator | administrator | any library role without admin, untrusted peer, missing token |

The matrix applies to every HTTP response, including cache hits and conditional requests. Cache keys must include the authorized subject, library, capability epoch, and resource scope; revoked or changed ACL epochs invalidate prior authorization. `Cache-Control: private, no-store` remains the default for sensitive metadata and control responses.

## Enforcement rules

1. Authorize before existence-sensitive projection where the route could enumerate a library, asset, album, event, or path. Use the established uniform error envelope and avoid cross-library existence leaks.
2. Library read never implies path read, original-byte access, mutation, peer sync, album delete, or administrator control.
3. P2P signed authors require trusted identity plus the matching library stream grant; an HTTP role or relay identity cannot substitute for the event author.
4. Tombstones, offline/missing sources, and old generations are checked after ACL and before projection/mutation. A denied request never advances a cursor or writes a mutation.
5. Authorization failures must not reveal paths, hashes, tokens, key references, or whether another library contains a matching asset.

## Required integration evidence before implementation

For every route family, run both positive and negative cases for owner/admin/contributor/viewer/guest, untrusted peer, revoked device, wrong library, stale cache, and tombstoned resource. Include request-id and no-store/header assertions. The migration must be additive, backup-gated, isolated-restore tested, and N/N-1 compatible. Until PM-072/PM-073 security approval is recorded, the current single-admin callbacks remain the only supported behavior.
