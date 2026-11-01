import { expect, test, type Page } from '@playwright/test';

type SearchFixtureOptions = { searchCapability?: boolean; failOnce?: boolean; captureProvenance?: 'offset' | 'floating'; delaySearchResponseMs?: number };

async function connectSearchFixture(page: Page, options: SearchFixtureOptions = {}): Promise<{ queries: string[]; assetQueries: string[] }> {
  const queries: string[] = [];
  const assetQueries: string[] = [];
  let failOnce = options.failOnce ?? false;
  await page.route('**/v1/health', (route) => route.fulfill({
    status: 200,
    json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: options.searchCapability === false ? [] : ['gallerySearch'] }
  }));
  await page.route('**/v1/libraries', (route) => route.fulfill({
    status: 200,
    json: { items: [{ libraryId: 'library-search', title: 'Search fixture' }] }
  }));
  await page.route('**/v1/assets?*', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q');
    assetQueries.push(q ?? '');
    if (q) queries.push(q);
    if (q && options.delaySearchResponseMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delaySearchResponseMs));
    }
    if (q && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, json: { error: 'capability_unavailable', requestId: 'fixture' } });
      return;
    }
    const items = q && q !== 'no-match'
      ? [{
          assetId: 'asset-id-42', libraryId: 'library-search', originNodeId: 'node-search', kind: 'photo',
          sha256: 'a'.repeat(64), availability: 'online', filename: 'Trip photo.jpg', capturedAt: '2026-10-29T00:00:00.000Z',
          sourcePath: null, sourceKind: 'import', byteSize: 10, version: 'v1',
          ...(options.captureProvenance === 'floating' ? {
            capturedAt: null, captureLocalTime: '2026-10-29T12:00:00.000', captureOffsetMinutes: null,
            captureSource: 'exif_floating', captureConfidence: 'medium'
          } : options.captureProvenance === 'offset' ? {
            captureLocalTime: '2026-10-29T15:00:00.000', captureOffsetMinutes: 180,
            captureSource: 'exif_offset', captureConfidence: 'high'
          } : {})
        }]
      : [];
    await route.fulfill({ status: 200, json: { items, nextCursor: null } });
  });
  await page.goto('/');
  await page.getByLabel('Interface language').selectOption('en');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  return { queries, assetQueries };
}

test('provides a localized keyboard skip link to the main content', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('photomesh-ui-locale', 'en'));
  await page.goto('/');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('skip-to-main-content-focused.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByRole('link', { name: '跳转到主要内容' })).toHaveCount(1);
});

test('uses system focus colors for the skip link and main content in forced-colors mode', async ({ page }, testInfo) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.addInitScript(() => localStorage.setItem('photomesh-ui-locale', 'en'));
  await page.goto('/');
  const systemHighlight = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'Highlight';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  const skipOutline = await skipLink.evaluate((element) => getComputedStyle(element).outlineColor);
  expect(skipOutline).toBe(systemHighlight);
  await page.screenshot({ path: testInfo.outputPath('forced-colors-skip-link-focused.png') });

  await page.keyboard.press('Enter');
  const main = page.getByRole('main');
  await expect(main).toBeFocused();
  const mainOutline = await main.evaluate((element) => getComputedStyle(element).outlineColor);
  expect(mainOutline).toBe(systemHighlight);
});

test('exposes timeline request loading state to assistive technology', async ({ page }) => {
  await connectSearchFixture(page, { delaySearchResponseMs: 250 });
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toHaveAttribute('aria-busy', 'false');

  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  await search.fill('Trip');
  await search.press('Enter');
  await expect(timeline).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'Trip photo.jpg' })).toBeVisible();
  await expect(timeline).toHaveAttribute('aria-busy', 'false');
});

test('discloses search shortcuts visually and to assistive technology in both locales', async ({ page }, testInfo) => {
  const visibleShortcut = page.locator('.search-shortcut-hint');
  await page.goto('/');
  const disconnectedSearch = page.getByRole('searchbox', { name: 'Search gallery' });
  await expect(disconnectedSearch).toBeDisabled();
  await expect(visibleShortcut).toHaveCount(0);
  expect(await disconnectedSearch.getAttribute('aria-keyshortcuts')).toBeNull();

  await connectSearchFixture(page);
  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  const accessibleHint = page.locator('#search-shortcut-description');
  await expect(visibleShortcut).toHaveText('/');
  await expect(visibleShortcut).toBeVisible();
  await expect(visibleShortcut).toHaveAttribute('aria-hidden', 'true');
  await expect(search).toHaveAttribute('aria-keyshortcuts', '/ Control+K Meta+K');
  await expect(search).toHaveAttribute('aria-describedby', 'search-shortcut-description');
  await expect(accessibleHint).toHaveText('Press slash or Control/Command plus K to focus search.');
  await page.screenshot({ path: testInfo.outputPath('search-shortcut-hint.png') });

  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(accessibleHint).toHaveText('按斜杠或 Control/Command+K 聚焦搜索框。');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(visibleShortcut).toBeHidden();
  await expect(accessibleHint).toHaveText('按斜杠或 Control/Command+K 聚焦搜索框。');
});

test('supports keyboard search, validates short terms locally, and keeps terms out of navigation and storage', async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  const { queries, assetQueries } = await connectSearchFixture(page);
  const search = page.getByRole('searchbox', { name: 'Search gallery' });

  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await page.locator('body').click();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('😀😀');
  await expect(page.getByRole('status').filter({ hasText: 'at least 3 characters' })).toBeVisible();
  expect(queries).toEqual([]);

  await search.fill('asset-id-42');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: 'Trip photo.jpg' })).toBeVisible();
  await expect.poll(() => queries).toContain('asset-id-42');
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).not.toContain('asset-id-42');
  await expect(page.getByRole('status').filter({ hasText: 'Search results loaded.' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage, sessionStorage].flatMap((storage) =>
    Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? '') ?? '')).join('\n'))).not.toContain('asset-id-42');
  expect(consoleMessages.join('\n')).not.toContain('asset-id-42');

  await search.fill('no-match');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: 'No matching photos' })).toBeVisible();
  await expect(page.locator('.empty-state').getByText('Try different words or clear your search.')).toBeVisible();

  const requestsBeforeClear = assetQueries.length;
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect.poll(() => assetQueries.length).toBeGreaterThan(requestsBeforeClear);
  expect(assetQueries.at(-1)).toBe('');
  expect(queries).toEqual(['asset-id-42', 'no-match']);
  expect(new URL(page.url()).search).toBe('');
  if (process.env.PHOTOMESH_SEARCH_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.PHOTOMESH_SEARCH_SCREENSHOT_PATH, fullPage: true });
  }
});

test('labels timezone-less EXIF as floating and retains its camera wall time', async ({ page }) => {
  await connectSearchFixture(page, { captureProvenance: 'floating' });
  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  await search.fill('Trip');
  await search.press('Enter');

  await expect(page.getByRole('heading', { name: 'Trip photo.jpg' })).toBeVisible();
  await expect(page.locator('.asset-date time')).toContainText('Time zone unknown');
  await expect(page.locator('.asset-date time')).toHaveAttribute('datetime', '2026-10-29T12:00:00.000');
  await expect(page.locator('.capture-confidence')).toHaveText('EXIF local time');
  if (process.env.PHOTOMESH_CAPTURE_DATE_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.PHOTOMESH_CAPTURE_DATE_SCREENSHOT_PATH, fullPage: true });
  }
});

test('shows an actionable search error and retries the current query', async ({ page }) => {
  const { queries } = await connectSearchFixture(page, { failOnce: true });
  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  await search.fill('orchid');
  await expect(page.getByRole('alert').filter({ hasText: 'The node is busy or low on resources' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry search' }).click();
  await expect(page.getByRole('heading', { name: 'Trip photo.jpg' })).toBeVisible();
  expect(queries).toEqual(['orchid', 'orchid']);
});

test('disables search when the node does not advertise gallery search', async ({ page }) => {
  const { queries } = await connectSearchFixture(page, { searchCapability: false });
  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  await expect(search).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Search is not supported by this node.' })).toBeVisible();
  expect(queries).toEqual([]);
});
