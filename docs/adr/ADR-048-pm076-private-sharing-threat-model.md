# ADR-048: PM-076 private sharing threat model and invitation semantics

## Status

Design-only threat model. No share endpoint, public link, invite token, or schema is implemented.

## Share subject and scope

A private share targets an explicit recipient identity or previously authenticated device, an explicit library/album scope, and an explicit capability set. It is not a bearer link and it never grants a whole library by accident. The recipient must authenticate the intended identity through an approved pairing/account flow; a display name, IP address, QR screenshot, or forwarded message is not identity proof.

The invitation record is one-time, high entropy, short lived, hashed at rest, bound to issuer, recipient, scope, capability epoch, and protocol version. It contains no original bytes, encryption keys, filesystem paths, GPS/EXIF payload, or long-lived bearer credential. Acceptance is auditable and idempotent; duplicate or replayed acceptance fails without widening access.

## Lifecycle

- **Pending:** visible only to the issuer and intended recipient channel; bounded attempts and expiry.
- **Accepted:** creates a least-privilege grant with an epoch and optional end time; recipient can see only the listed scope.
- **Expired/revoked:** future access fails immediately at the Node and P2P grant checks; existing sessions are invalidated.
- **Deleted/closed:** retains a non-secret audit summary, not the invitation secret or media payload.

Issuer revocation is explicit and does not delete source media, event history, or already cached recipient data. The UI must state that revocation blocks future access but cannot guarantee remote erasure of cached thumbnails or originals.

## Threats and mitigations

1. **Forwarding/replay:** bind one use to recipient identity and scope; hash secrets; enforce expiry, attempt caps, idempotency, and signed acceptance.
2. **Cross-library IDOR:** authorize library and album scope on every request, including thumbnails, originals, metadata, recycle-bin and conditional/cache hits.
3. **Metadata leakage:** default to minimal filename/kind/size metadata; omit source paths, EXIF/GPS, keys, and unrelated album membership; path visibility remains a separate capability.
4. **Enumeration:** use uniform pending/invalid/expired errors and bounded timing; do not reveal whether an email/device/account exists.
5. **Revocation race:** check grant epoch and revocation at every backend read and write; no cached authorization survives an epoch change.
6. **Abuse:** rate-limit creation and acceptance per issuer/recipient/device, cap active shares and scope size, audit attempts without tokens or personal content.
7. **Compromised recipient:** least privilege, expiry, device revocation, no re-sharing by default, and clear cached-data limits.
8. **Untrusted relay/plugin:** sharing secrets and grant authority never enter logs, telemetry, MCP, or plugins without a separate approved capability.

## Approval gates

PM-077 requires security review of recipient verification, token/hash format, cache headers, EXIF/GPS policy, rate limits, audit retention, and cross-library negative tests. PM-078/079 are separate public-link decisions and must not reuse private-share semantics by default. No production sharing schema, invite API, or public endpoint is authorized by this ADR.
