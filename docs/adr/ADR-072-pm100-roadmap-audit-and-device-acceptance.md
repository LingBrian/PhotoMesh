# ADR-072: PM-100 roadmap audit and post-release device acceptance

## Status

Implemented an evidence-shape validator. PM-100 itself remains deferred until real release-candidate, Windows, NAS, and post-release evidence exists; this is intentional and not a completion claim.

## Decision

The PM-100 audit enumerates each PM-033–PM-099 item and links code/ADR, CI/integration tests, and device or operational evidence. A task may be marked complete only when all three evidence classes are present. A task without implementation or real measurement must be marked `deferred` or `blocked` with an explicit note; missing entries, unsupported completion claims, and unexpected task IDs fail the audit.

The audit must retain the exact commit/worktree, commands and outputs, security/license results, migration/recovery reports, artifact hashes, rollback result, and real Windows/NAS/device evidence. No “release” or “post-release” status is inferred from local unit tests. PM-100 does not trigger release, deployment, migration, push, or deletion.

## Acceptance

CI tests cover complete evidence, missing items, incomplete completion claims, explicit deferrals, and unexpected IDs. The final audit remains a human-reviewed gate and must preserve known unmeasured/deferred items rather than hiding them.
