# ADR-044: PM-072 local multi-user roles and library ACL matrix

## Status

Design only; not approved for schema, API, or authentication implementation. The current single-administrator model remains authoritative until a separate security review approves this ADR and its migration plan.

## Proposed subjects and roles

| Role | Library metadata | Original/thumbnail read | Metadata mutation | Album/member write | Share/grant/admin | Permanent delete |
| --- | --- | --- | --- | --- | --- | --- |
| owner | yes | policy-scoped | yes | yes | yes | never implicit; separate approval |
| administrator | yes | policy-scoped | yes | yes | delegated grants only | never implicit; separate approval |
| contributor | yes | yes if granted | tags/favorites/ratings only | only explicit album-write | no | no |
| viewer | yes | yes if granted | no | no | no | no |
| guest/share recipient | only explicitly shared scope | only explicitly shared media | no | no | no | no |

Roles are library-scoped and deny by default. A device trust relationship, node identity, path-read permission, sync grant, and role grant are separate facts; none implies the others. Cached media cannot be retroactively erased by revocation.

## Route capability matrix

- Health remains status-only and public.
- Diagnostics, resource metrics, pairing approval, grant management, and device revocation require an administrator capability.
- Library listing, search/filter, metadata export, scan review, recycle-bin listing, thumbnails, and originals require library-scoped read plus any separate path/original capability.
- Tags, favorites, ratings, and album membership mutations require distinct contributor/write grants.
- Album deletion/restoration requires a distinct album-delete grant and remains subject to tombstone generation checks.
- Upload create/read/write/complete remains operation-scoped and must not be inferred from a viewer or peer read role.
- P2P events require a trusted signed author, library grant, stream capability, causal validation, and revocation check; HTTP roles are not copied into event signatures.

## Migration and recovery gates

A future implementation must introduce an additive ACL/grant schema with versioned epochs and immutable audit events. Existing local-admin access must be represented by an explicit bootstrap owner/admin subject without silently widening access. Migration requires a preflight report, independent backup, isolated restore test, rollback point, and N/N-1 reader behavior. Existing bearer tokens must not be guessable role IDs; password/account credentials are PM-073, not this ADR.

Every route needs a positive and negative matrix for each role, including cross-library IDOR, revoked grants, stale cache, path privacy, tombstones, and peer-vs-HTTP confusion. Unknown roles, epochs, or grant signatures fail closed. No role implementation, token issuance, public sharing, or production migration is authorized by PM-072 alone.
