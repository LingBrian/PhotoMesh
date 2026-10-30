# ADR-038: PM-066 local consistency backup prototype

## Status

Implemented as a local, explicit-source prototype. It does not run automatically and does not overwrite production data.

## Decision

`createLocalBackup` accepts a user-selected absolute destination and an explicit source list. It rejects source/destination overlap, traversal or duplicate relative paths, directories, and existing target files. Each copied file is hashed before and after copying; a sorted `manifest.json` is written only after all hashes match. The manifest records format version, entry kind, relative path, byte size, and SHA-256.

The prototype copies only the caller-provided database, event-log, managed-object, and config-reference entries. It does not discover files implicitly, copy external originals, export identity/private keys, or create a remote backup. A failed copy or mismatch aborts without claiming a valid backup.

## Recovery and rollback

The destination is an independent directory selected by the user. The prototype never opens the production database for writing and never removes or replaces a source. Re-running into the same destination fails on existing files, preserving the original backup for review.

## Acceptance

- explicit sources copy to an independent directory;
- pre/post SHA-256 and manifest digest are recorded;
- overlap, traversal, duplicate paths, and overwrite attempts fail;
- tests use temporary directories and verify the source remains unchanged.
