# ADR-070: PM-098 N/N-1 migration, backup, and recovery matrix

## Status

Added a preflight decision matrix and tests. It does not execute migrations, downgrade a database, restore user data, or alter production state.

## Decision

A known forward target schema requires both a verified backup and a verified restore point before migration is admitted. Unknown targets, same-schema reapplication, and backward schema movement are fail-closed as unsafe downgrade. Existing repository behavior also refuses unknown applied migrations and requires a backup callback before applying pending migrations.

N/N-1 tests must cover the current and previous supported binary/schema pair, forward migration with backup failure, interrupted migration, restart recovery, backup hash/manifest mismatch, missing restore point, unknown migration, and attempted downgrade. Recovery is valid only in an isolated destination after manifest/path/hash validation; originals and the live database are never overwritten during preflight or test recovery.

## Acceptance and approval gate

CI verifies the matrix decisions and existing upgrade/backup tests. Real version-combination migrations and restore drills remain release-gated, require disposable databases and retained reports, and must be explicitly approved before any production migration. No migration or data deletion is performed by PM-098.
