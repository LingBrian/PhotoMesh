# Playwright E2E

`gallery-100k.spec.ts` drives the built Vue app against the real Node API and an in-memory SQLite fixture seeded with 100,000 metadata rows. It scrolls through at least 10,000 records, asserts that the DOM window stays bounded, verifies the page-size ceiling, and checks SQLite-backed search.

Run locally with `pnpm exec playwright install chromium` followed by `pnpm test:e2e`. CI runs the same test with Chromium dependencies installed.

The fixture contains metadata only and no user originals. SQLite cursor ordering, query filtering, and ACL checks are also covered by Node agent repository/API tests.
