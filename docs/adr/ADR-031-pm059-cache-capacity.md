# ADR-031: PM-059 Web thumbnail cache capacity

## Status

Accepted for the bounded PM-059 slice.

## Decision

Web/Windows regenerable thumbnail cache is not a backup and never contains original media. Users may configure bounded byte and entry limits. Values are clamped to 1–64 MiB and 16–512 entries. A persistent LRU index evicts oldest thumbnail records when either limit is exceeded; clearing the cache removes only the thumbnail store and its local index.

Cache settings are local to the browser/desktop profile, do not affect the Node library, and are safe to lose. Cache failures are surfaced as a recoverable notice; original preview behavior is unchanged.

## Compatibility and rollback

No database, API, or P2P schema changes. Existing cache records remain readable; the first write after upgrade indexes and bounds them. Removing the feature leaves source media and library metadata untouched.

## Acceptance

- settings persist locally and clamp unsafe values;
- count and byte eviction remove oldest entries until both bounds hold;
- clear action does not touch originals or server data;
- bilingual labels and unit tests cover the policy.
