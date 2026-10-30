# ADR-040: PM-068 Windows backup and restore status UI

## Status

Implemented as a localized status panel in the existing desktop-capable Web UI. The panel is display-only until a backend backup job contract is approved and connected.

## Decision

The settings screen exposes backup/recovery state with status, bytes completed/total, elapsed seconds, result, error, start, and cancel affordances. The snapshot model supports `idle`, `preparing`, `running`, `cancelling`, `success`, `failed`, and `cancelled`. Start/cancel remain disabled in this slice because no implicit backup or destructive restore operation is allowed; a future job API can bind the same model without changing the safety copy.

All text is present in Simplified Chinese and English. The panel states that source files are never overwritten and that recovery must target a new empty directory with explicit confirmation before covering user data.

## Safety and compatibility

No filesystem or production-data operation is triggered by the UI. No token, path, key, or media bytes are persisted. Existing gallery session and ACL behavior is unchanged.

## Acceptance

- status, progress bytes, elapsed time, result, error, start and cancel controls render;
- controls are disabled until a future authorized job capability is available;
- overwrite and isolated-directory guidance is localized;
- Web lint, typecheck, tests, and build remain green.
