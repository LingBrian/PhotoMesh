# ADR-045: PM-073 local accounts, credential protection, and recovery

## Status

Design and approval boundary only. No account table, password endpoint, or credential migration is implemented.

## Credential storage

Local account passwords must be stored only as an adaptive password hash using a maintained password-hashing library (Argon2id preferred; a reviewed equivalent is acceptable when platform support requires it). Store algorithm parameters, salt, and a format version with the hash. Never store plaintext, reversible encryption, password-derived keys, recovery answers, or bearer tokens in SQLite, logs, telemetry, backups, or API errors. Password comparison is constant-time through the library and does not reveal whether an account exists.

The initial administrator bootstrap must require an interactive local setup or an explicit one-time enrollment secret. There is no default password, magic fallback, or password printed to logs. A bearer session token remains distinct from the password hash and is short-lived, revocable, audience-bound, and memory-only on the Web client.

## Rate limiting and audit

Failed login attempts use a bounded per-account and per-source rate limiter with exponential backoff and a cap; successful login resets only the appropriate account counter. The limiter must avoid turning user enumeration into a side channel and must not use an unbounded in-memory map. Audit records contain actor ID digest, outcome category, request ID, and timestamp, but never password, token, IP address, path, or request body.

Sensitive operations require recent re-authentication: changing credentials, issuing recovery material, changing owner/admin grants, revoking devices, and enabling private sharing. Sessions are invalidated on credential reset and can be revoked per device.

## Recovery

Recovery requires one of: an already authenticated owner/admin session with recent re-authentication, or a pre-generated offline recovery code set stored by the user. Codes are single-use, high-entropy, hashed at rest, rate-limited, and rotated after use. There is no support backdoor and no recovery by guessing personal information. If all owner credentials and recovery material are lost, encrypted content is not promised to be recoverable.

Recovery must preserve ACL epochs, device trust revocations, tombstones, audit history, and key-envelope references. It must not silently create a new owner or re-trust a device. A recovery operation requires an independent backup, isolated restore rehearsal, explicit audit evidence, and a rollback point.

## Required approval and tests

Before implementation, security review must approve the hashing parameters/library, bootstrap ceremony, session/token model, rate-limit persistence, recovery UX, backup interaction, and threat model. The future test matrix must cover enumeration resistance, brute-force backoff, token/session revocation, replay, recovery-code reuse, lost-device recovery, backup restore, and no-secret logging. PM-074 and PM-075 remain blocked on this review.
