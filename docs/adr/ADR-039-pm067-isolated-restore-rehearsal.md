# ADR-039: PM-067 isolated restore rehearsal

## Status

Implemented as a local verification and restore rehearsal. It never opens or overwrites a production directory.

## Decision

`restoreLocalBackup` first validates the backup manifest version and digest, then verifies every listed file's size and SHA-256 before copying anything. It restores only into an absolute, empty, non-overlapping destination. Existing files, source/target overlap, traversal, malformed entries, and hash mismatches abort the rehearsal. The result reports entry count, bytes, and manifest digest for recovery evidence.

This is an isolated rehearsal, not a production recovery command: it does not attach SQLite, apply migrations, alter sync cursors, resolve key references, or replace an active data directory. A future recovery workflow must separately validate database integrity, ACLs, event-cursor consistency, and key-envelope availability in the isolated target.

## Acceptance

- a valid backup restores into a new directory with matching manifest digest;
- a tampered file is rejected before restore;
- a non-empty destination is rejected;
- source and backup bytes remain unchanged.
