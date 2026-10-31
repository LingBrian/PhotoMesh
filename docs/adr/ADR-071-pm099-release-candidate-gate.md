# ADR-071: PM-099 release candidate acceptance gate

## Status

Implemented a local evidence gate only. It never tags, publishes, deploys, pushes, or changes a release channel.

## Decision

A candidate is locally eligible only when required CI, security, performance, migration/recovery, build, and rollback checks are all explicitly passing and at least one non-empty evidence report is attached. The gate is evidence-based and does not infer success from a missing or stale report. Production approval is intentionally outside this local function and cannot trigger an irreversible action.

The candidate checklist must retain exact commands, commit, dependency/license evidence, ACL/security results, measured Windows/NAS performance, migration/recovery matrix, artifact hashes, and rollback result. Any skipped, blocked, synthetic-only, or unmeasured criterion remains ineligible or deferred; it must not be presented as green.

## Acceptance and limits

CI tests cover complete evidence, failed gates, missing reports, and the separation of production approval from local eligibility. Real release-candidate validation remains a human-approved release process; PM-099 performs no release or deployment operation.
