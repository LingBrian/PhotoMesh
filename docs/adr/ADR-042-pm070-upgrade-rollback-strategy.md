# ADR-042: PM-070 upgrade, migration backup, and rollback strategy

## Status

Accepted with a local compatibility gate. No production upgrade, migration, or rollback is executed by this slice.

## Decision

Forward upgrades must have a strictly greater SemVer target, a non-decreasing schema revision, and a verified independent backup before migration begins. Same-version requests are no-ops; any downgrade is refused, with an explicit incompatible-downgrade result when it would lower the schema revision. The existing repository migration hook remains responsible for requiring a backup and preserving migration checksums.

A failed forward migration leaves the pre-upgrade backup as the rollback point. Recovery is performed only into an isolated directory first; the active production directory is never overwritten by an automatic rollback. Protocol/event compatibility is evaluated separately from application SemVer and must not be inferred from version strings.

## Safety and compatibility

The gate is pure and additive. It does not alter schema, migration order, event history, key material, or files. It exposes no paths or secrets. Unknown or malformed versions fail closed.

## Acceptance

- forward upgrades without verified backup are blocked;
- verified forward upgrades are allowed when schema does not regress;
- schema-lowering downgrades and same-version requests are blocked;
- existing migration tests continue to enforce backup-before-migration and checksum stability.
