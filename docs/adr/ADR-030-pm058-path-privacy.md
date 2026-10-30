# ADR-030: PM-058 original-path minimization

## Status

Accepted for the bounded PM-058 slice.

## Decision

Original filesystem paths are sensitive metadata. Library authorization alone permits reading authorized asset metadata, but does not grant path disclosure. Node APIs therefore use a separate optional path-visibility decision:

- `authorizeLibraryRead` authorizes library metadata/media access;
- `authorizeLibraryPathRead` authorizes returning `sourcePath`/`originalPath`.

When path visibility is absent or denied, all API responses redact path fields to `null` (or omit review location paths) while retaining stable asset IDs, filenames, node IDs, availability, and hashes where already permitted. The scan-review report returns a path only to a principal with path visibility; otherwise its affected location entries contain the location ID and availability but no local path.

The built-in local administrator is explicitly granted both permissions. Other integrations must opt in to path visibility. No path is written to logs, diagnostics, or telemetry by this change. Existing external sources remain read-only.

## Compatibility and rollback

This is an additive server option and does not change database or P2P schemas. Older clients continue to accept nullable paths. A rollback removes redaction wiring without data migration; no stored data is changed.

## Acceptance

- authorized library reads without path permission cannot receive local paths;
- path-authorized reads preserve paths;
- duplicate and scan-review responses obey the same rule;
- ACL denial remains unchanged;
- OpenAPI describes nullable/redacted path fields and tests cover both decisions.
