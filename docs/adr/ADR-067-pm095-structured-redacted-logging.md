# ADR-067: PM-095 structured redacted logging

## Status

Implemented a bounded serialization/redaction helper. Wiring all server events to a sink and selecting retention/storage remains an integration task.

## Decision

Structured events carry a short event name, request ID, outcome, optional bounded duration, and sanitized fields. Sensitive keys (tokens, secrets, passwords, private/recovery keys, originals, EXIF/GPS, paths, filenames) are replaced with `[REDACTED]`; bearer values are redacted even when the key is not sensitive. Strings, arrays, object keys, and serialized output are bounded to prevent log amplification. Logs must not contain original bytes or user paths.

Request IDs correlate an operation without becoming credentials. Audit records remain the authoritative durable mutation trail; operational logs are diagnostic and may be retained only under a bounded, documented policy. Logging failures must not change authorization or falsely report a successful mutation.

## Acceptance

Tests scan serialized events for bearer tokens, paths, filenames, EXIF/GPS and secret values, verify request correlation, and enforce a 4 KiB line bound. Production wiring requires a sink/retention review and must preserve redaction before formatting, transport, telemetry, or error reporting.
