# ADR-037: PM-065 backup inventory, format, and key references

## Status

Accepted as a design-only compatibility contract. No backup job or key export is introduced.

## Backup set

A restorable PhotoMesh backup is a versioned directory or archive containing:

- SQLite database and migration/schema revision;
- signed event log, inbox/outbox records, author cursors, and sync protocol bounds;
- managed-object manifest with asset/file IDs, storage references, byte sizes, SHA-256, and source node;
- configuration needed to reconstruct paths and policy, with secrets replaced by references;
- a backup manifest describing every included entry, format version, creation time, tool version, and per-entry SHA-256.

External folders are never copied by the Node backup. Their entries remain references with path visibility controlled by existing ACLs; a restore must report them as external dependencies rather than claiming the original bytes are backed up.

## Key boundary

Identity private keys, recovery keys, bearer tokens, and encryption key material are not placed in the archive. The manifest may contain a non-secret key-envelope reference, key identifier, algorithm/version, and whether a separately managed escrow is required. Restore must fail closed when the required key reference cannot be resolved; it must not generate a replacement identity that silently changes trust.

## Compatibility

Every backup declares `formatVersion`, `minimumReaderVersion`, `maximumWriterVersion`, schema revision, and protocol min/max. Readers accept the current and explicitly supported N-1 format only; unknown future fields are preserved in a sidecar or cause a safe refusal where semantics are security-sensitive. Downgrades that would lose event causality, tombstones, ACL state, or hashes are rejected.

## Integrity and recovery

The top-level manifest digest covers canonical sorted entries and all metadata. Restore first verifies the archive into a new directory, then validates database integrity, event cursor consistency, object count, and SHA-256 before any application opens it. Production directories are never overwritten by this design. Recovery evidence must record the isolated target, tool versions, and pass/fail summaries without user paths, tokens, or media.

## Non-goals and approval

PM-065 does not implement backup, restore, key rotation, or deletion. PM-066 may implement a local prototype only after using this format and writing to a user-selected independent directory. Production backup retention, remote destinations, and recovery of encrypted material require separate approval.
