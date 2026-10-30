# ADR-050: PM-078 public-link product, privacy, and abuse review

## Status

Design review only. Public links remain disabled by default; PM-079 implementation requires separate approval and security testing.

## Product boundary

A public link is an explicitly created, opaque, signed capability for one exact share scope and a bounded expiry. There is no default public visibility, indexable listing, open library browsing, or permanent link. Creation requires recent authenticated administrator/owner confirmation and produces an audit record. The link can be revoked immediately and is invalid after expiry or grant-epoch change.

## Privacy defaults

Public responses expose only the minimum selected media representation. They exclude source paths, library identifiers, EXIF/GPS, face embeddings, OCR, tags unrelated to the share, encryption/key references, and internal hashes unless a reviewed product requirement explicitly needs one. Original-byte download is off by default; previews use isolated derived files and fixed size/type limits. Response and CDN/browser caching must be private/no-store or keyed to the share epoch, and revocation must invalidate future requests. Cached bytes cannot be promised to disappear from an uncontrolled client.

## Abuse controls

Tokens are high entropy and opaque; the server stores only a digest or verifies a signature without storing the secret. Every request is rate-limited per token, source, and scope with bounded concurrency and uniform failure responses. Creation, redemption, and failed attempts have quotas and audit summaries without token, path, IP, or content. Expired, revoked, malformed, and over-limit requests must not reveal whether a resource exists. Link scope and lifetime have hard maxima; no chaining or automatic re-sharing.

## Threats and approval gates

Review must cover forwarding/replay, token brute force, cross-library IDOR, EXIF/GPS leakage, cache persistence, revocation races, enumeration, hotlink/DoS, screenshot/referrer leakage, compromised owner, and analytics/log leakage. PM-079 requires signed-token verification tests, negative ACL/expiry/revocation tests, privacy fixture inspection, rate-limit/load evidence, independent penetration review, and explicit human approval. This ADR authorizes none of those production changes.
