# ADR-068: PM-096 reproducible Windows/NAS performance baseline

## Status

Implemented an evidence validator only. It does not run a benchmark or claim that a device meets a performance target.

## Decision

Every baseline report must record hardware platform/architecture/RAM/CPU, dataset asset count/bytes/synthetic status/description, cache mode (cold/warm/mixed), duration, peak RSS, throughput, failures, retries, and hash mismatches. Evidence is publishable only when the metadata is complete, measured values are finite/nonnegative, duration is positive, failures are zero, and hash mismatches are zero. Synthetic CI data must be labelled synthetic and must not be presented as a real NAS throughput result.

The required 2GB-NAS acceptance remains a measured operational baseline: core upload, sync, search, and browsing must remain viable while AI/professional transcode are disabled. RSS must include startup, steady state, hashing, SQLite/cache, and queue behavior, with OS headroom documented. No unmeasured SLA or hardware claim is inferred.

## Acceptance

Tests cover complete evidence, missing hardware/dataset metadata, failed runs, hash mismatch, and invalid measurements. Release candidates require repeated cold/incremental/interrupted runs and retained raw measurements; this slice introduces no benchmark data, migration, or deployment.
