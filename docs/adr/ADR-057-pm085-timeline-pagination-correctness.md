# ADR-057: PM-085 timeline pagination and filtering correctness

## Status

Implemented bounded client-side page merging and regression tests; server cursor semantics remain authoritative.

## Decision

Timeline pages are appended in server cursor order while deduplicating by immutable `assetId`, retaining the first occurrence and never reordering earlier records. A missing `nextCursor` is normalized to the exhausted state. Search resets the page generation and cursor, so stale responses cannot repopulate a newer query; local album filtering is applied only to the merged authorized set.

Virtual rendering computes visible rows from the filtered set and loads the next cursor near the end without copying the whole list into the DOM. A cursor rollover (HTTP 410) clears the stale projection and restarts from the first page. Duplicate page items do not inflate counts, scroll spacers, selection, or preview navigation.

## Acceptance

- 10,000 synthetic records across 100 pages traverse with no duplicates or gaps;
- overlapping pages keep stable first-seen order;
- search/library generation changes cannot append stale results;
- album filtering and preview navigation operate on the merged filtered set;
- exhaustion and cursor rollover are explicit and safe, with no media or original-file mutation.
