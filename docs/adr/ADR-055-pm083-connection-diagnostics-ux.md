# ADR-055: PM-083 connection diagnostics and credential UX

## Status

Implemented a Web-side bounded diagnostic classifier and localized messages; no credential persistence or network policy is weakened.

## Decision

The connect form keeps the node origin and admin token separate, masks the token, stores it only in page memory, and requires explicit remote-node acknowledgement where applicable. Libraries are selected from the authenticated node response, not from user-supplied IDs. Failures are classified into authorization (401), forbidden (403), offline transport, timeout, certificate/TLS, conflict, and generic status categories so the user receives actionable guidance without raw response bodies, tokens, paths, or stack traces.

The existing secure endpoint checks remain authoritative: HTTPS is required for remote nodes, loopback HTTP is the only local exception, and peer identity/certificate verification is not bypassed by the UI. A failed connection does not silently reuse credentials or broaden the selected library.

## Acceptance

- 401 and 403 are distinguishable from offline, timeout, certificate, and conflict conditions;
- token input is password-masked and is not persisted or logged;
- library selection comes from authorized node results and reconnect preserves scope only when valid;
- diagnostics are localized and do not expose internal response details;
- tests cover failure classification and no data/original mutation occurs.
