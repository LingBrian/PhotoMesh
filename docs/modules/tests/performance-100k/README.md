# 100k performance

The browser scroll/search scenario is implemented in `../e2e-playwright/gallery-100k.spec.ts`. It seeds 100,000 metadata rows in SQLite behind the real Node API, then checks paginated scrolling, server-side query filtering and DOM window size. The fixture has no original media bytes, and tests never write to a user's photo library.

For a local run, use `pnpm test:e2e` after installing the Playwright Chromium binary. Keep timing measurements in the Playwright report with CPU/OS details when comparing hardware; do not use a wall-clock threshold as the only correctness gate.
