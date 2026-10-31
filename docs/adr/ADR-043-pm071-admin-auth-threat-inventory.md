# ADR-043: PM-071 single-administrator authorization inventory

## Status

Accepted as a documented threat and capability inventory. This is not a multi-user authorization design and makes no multi-user product claim.

## Trust boundaries and subjects

| Subject | Credential/identity | Current authority | Boundary and primary risk |
| --- | --- | --- | --- |
| Local administrator | short-lived/locally configured bearer token | diagnostics, pairing approval, grants, resource metrics, media-version administration | token theft or unsafe local exposure; every admin route must fail closed |
| Authorized library principal | token mapped to a library grant | library metadata, thumbnails, originals subject to source/path ACL, metadata mutations | cross-library confusion and path disclosure |
| Paired peer | verified Ed25519/libp2p identity plus explicit library grants | signed P2P events and only granted sync capabilities | name/IP spoofing, stale revocation, unauthorized event author |
| Untrusted LAN client | no accepted credential | no protected resource | accidental local-network trust; mDNS/address is never authority |
| External source | filesystem path reference, read-only | scan/index/read only when separately authorized | symlink/path escape and mistaken deletion |
| Plugin/MCP or future integration | not enabled by this inventory | none by default | must not inherit administrator or library grants implicitly |

## API capability map

- `/v1/health` is intentionally public and status-only; it must not disclose paths, credentials, library contents, or sensitive capacity details.
- `/v1/diagnostics` and `/v1/resources` require the local administrator authorizer and return enumerated status/counts only.
- `/v1/pairing/*` requires administrator approval for invitations, trust changes, and grant changes; the paired peer's public key is verified independently of its label or address.
- `/v1/libraries`, asset search/filter/export, thumbnails, originals, scan review, recycle-bin and metadata mutation routes require real library ACL checks. Path fields use the separate path-read decision.
- Upload routes require operation-scoped authorization (`create`, `read`, `write`, `complete`) and idempotency; an upload principal is not an administrator.
- P2P ingestion requires trusted identity, signature, library grant, capability negotiation, causal validation, and idempotency; HTTP bearer tokens are not accepted as P2P identity.

## Threats and mitigations

1. **Bearer disclosure:** keep tokens in memory, avoid logs/telemetry, use no-store responses, and fail closed when absent or invalid.
2. **Confused deputy/cross-library access:** pass library ID into every authorizer and test denied, revoked, and cross-library requests.
3. **Path disclosure:** require the separate path permission; redact source/original paths by default.
4. **Peer impersonation:** verify signed keys and trust state, never names, IPs, or broadcast metadata.
5. **Revocation race:** recheck grants at each protected read/write and leave denied events pending rather than ACKing them.
6. **Replay/duplicate mutation:** require idempotency keys, operation fingerprints, causal parents, and bounded audit events.
7. **Secret/media leakage:** response projections are metadata-only where appropriate; keys, bearer tokens, and original bytes never enter logs or contracts.
8. **Local privilege ambiguity:** a single admin token is not a role system; do not expose owner/member/guest semantics until PM-072 is separately approved.

## Residual risks and review gates

OS credential-store failures, token rotation/recovery, compromised administrator devices, and secure LAN boundary configuration remain deployment/release evidence items. PM-072 must define any additional principals and migration before adding role or multi-user schema/API behavior. No schema or permission broadening is authorized by PM-071.
