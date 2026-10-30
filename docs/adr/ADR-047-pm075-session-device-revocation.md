# ADR-047: PM-075 Web/Windows session and device revocation

## Status

Implemented the client-side fail-closed session boundary. Server-side account/device revocation remains dependent on PM-073/PM-074 approval and existing pairing controls.

## Decision

The Web/Windows session request scope supports explicit revocation with a bounded reason, aborts all active requests, blocks new request leases, and exposes no credential or path in the reason. A new authenticated session must explicitly reset the scope; revocation is not silently cleared by reconnect UI. Existing authorization failures remain session invalidation signals.

Device revocation is authoritative at the Node: future HTTP and P2P authorization checks must fail, while already cached thumbnails/media may remain on the device and cannot be promised to be remotely erased. Cache cleanup is a separate explicit user action. Revocation does not delete originals, metadata, or event history.

## Acceptance

- active requests abort on session/device revoke;
- new requests remain blocked until a new authenticated session is established;
- the revocation reason is bounded and non-secret;
- UI copy must explain that future access is blocked but cached data cannot be remotely wiped;
- no production account or device schema is changed by this slice.
