# ADR-032: PM-060 authorized metadata export

## Status

Accepted for the bounded PM-060 slice.

## Decision

The Node API exposes a bounded, read-only metadata export for an authorized library:

`GET /v1/libraries/{libraryId}/metadata-export?format=json|csv`

The export contains metadata only: stable asset ID, filename, kind, hash, byte size, capture date/provenance, availability, source kind, tags, favorite, and rating. Original bytes, keys, and secrets are never exported. Local source paths are included only when the separate path-visibility permission is granted; otherwise the field is null. The export is capped at 5,000 records and uses the existing keyset gallery pagination.

CSV uses a fixed header order, RFC-style quoting, and neutralizes spreadsheet formula prefixes (`=`, `+`, `-`, `@`) with a leading apostrophe. JSON is emitted as an object containing `items`. The endpoint is read-only and applies the same library ACL and no-store policy as gallery reads.

## Compatibility and rollback

This is an additive HTTP capability; no database migration or P2P event change is required. Older clients ignore the route. Removing the route does not change indexed data or source files.

## Acceptance

- unauthorized libraries are rejected;
- JSON and CSV stay within the record/field bounds;
- CSV injection payloads are neutralized and cells are quoted;
- path visibility follows PM-058;
- no original bytes, keys, or secrets are exported.
