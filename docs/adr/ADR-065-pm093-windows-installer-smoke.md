# ADR-065: PM-093 Windows installer smoke safety policy

## Status

Implemented as a dry-run policy and desktop unit tests. No installer is executed, no registry/firewall is modified, and no user directory is removed.

## Decision

The Windows packaging smoke plan covers clean install, upgrade with an existing data directory, uninstall, and port conflict. Upgrade and uninstall must preserve the user library/data directory. A port conflict fails closed and must not auto-select an unexpected port or open/modify firewall rules. Clean install is allowed only after an available-port check and remains a packaging concern, not a data deletion operation.

The installer must keep application binaries/configuration separate from user library data. Uninstall removes only application-owned files after an explicit product-level decision; it never recursively removes the user library. Upgrade must be restart-safe and retain database/object hashes. Conflict smoke tests must verify the existing listener remains unaffected.

## Acceptance and limits

CI validates the dry-run decisions and desktop build. A real clean Windows VM/package smoke remains required before release: install, launch, upgrade, rollback/failed upgrade, uninstall, retained data, conflict port, and firewall inspection. PM-093 does not claim that a real Windows installer has been run.
