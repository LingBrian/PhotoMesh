# ADR-069: PM-097 two-node soak evidence validator

## Status

Implemented a report validator only. It does not start nodes, open network connections, replay events, or alter a library.

## Decision

A two-node soak report is publishable only when final asset SHA-256 sequences equal the expected sequence, every expected event is accepted exactly through the normal causal path, denied events are not accepted, and denied events remain retained for review/retry. When the peer is reachable after interruption, recovery duration must be measured; when it is not reachable, no recovery SLA is invented and the report must state that reachability boundary.

The test plan covers disconnect, process restart, duplicate delivery, out-of-order delivery, stale/revoked grant, reconnect, and replay. It checks that accepted events are idempotent, cursors do not advance for denied/untrusted events, tombstones are retained, and final file hashes converge. Any unresolved divergence is a failed/blocked evidence result, never a silent pass.

## Acceptance

CI validates the report invariants. Real two-node soak execution remains a required integration/release gate using isolated test libraries and synthetic data; no production peer, user data, or irreversible event is touched by PM-097.
