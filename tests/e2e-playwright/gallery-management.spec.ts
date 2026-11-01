import { expect, test, type Page, type Route } from '@playwright/test';

async function setUpNode(page: Page, options: { capabilities?: string[]; assets?: () => unknown[]; nextCursor?: string | null } = {}): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: options.capabilities ?? [] } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: options.assets?.() ?? [], nextCursor: options.nextCursor ?? null } }));
  await page.goto('/');
  await reconnectNode(page);
}

async function reconnectNode(page: Page): Promise<void> {
  // A same-tab reload restores the stored node session, so the connect form may be absent.
  if (await page.getByLabel('Admin access token').count() === 0) {
    await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
    return;
  }
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
}

async function seedLegacyTags(page: Page, tagsByAsset: Record<string, string[]>): Promise<void> {
  await page.goto('/');
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onupgradeneeded = () => {
      for (const store of ['thumbnails', 'tags', 'albums']) {
        if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store, { keyPath: 'key' });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      tx.objectStore('tags').put({ key: JSON.stringify(['http://127.0.0.1:8443', 'library-1']), value });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), tagsByAsset);
}

async function readLegacyTags(page: Page): Promise<Record<string, string[]> | undefined> {
  return page.evaluate(() => new Promise<Record<string, string[]> | undefined>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('tags').objectStore('tags').get(JSON.stringify(['http://127.0.0.1:8443', 'library-1']));
      req.onsuccess = () => { db.close(); resolve(req.result?.value as Record<string, string[]> | undefined); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

async function replaceLegacyTags(page: Page, assetId: string, tags: string[]): Promise<void> {
  await page.evaluate(({ assetId: id, tags: values }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      const store = tx.objectStore('tags');
      const key = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const req = store.get(key);
      req.onsuccess = () => {
        if (!req.result) { db.close(); reject(new Error('legacy tag record is missing')); return; }
        const stored = req.result.value as Record<string, string[]>;
        store.put({ ...req.result, value: { ...stored, [id]: values } });
      };
      req.onerror = () => { db.close(); reject(req.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { assetId, tags });
}

async function readLegacyImportMarker(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => new Promise<string[] | undefined>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const metadataKey = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const markerKey = JSON.stringify([metadataKey, 'asset-1']);
      const req = db.transaction('tag-imports').objectStore('tag-imports').get(markerKey);
      req.onsuccess = () => { db.close(); resolve(req.result?.value?.importedTags as string[] | undefined); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

async function appendLegacyTag(page: Page, assetId: string, tag: string): Promise<void> {
  await page.evaluate(({ assetId: id, tag: value }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      const store = tx.objectStore('tags');
      const key = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const req = store.get(key);
      req.onsuccess = () => {
        if (!req.result) { db.close(); reject(new Error('legacy tag record is missing')); return; }
        const stored = req.result.value as Record<string, string[]>;
        store.put({ ...req.result, value: { ...stored, [id]: [...(stored[id] ?? []), value] } });
      };
      req.onerror = () => { db.close(); reject(req.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { assetId, tag });
}

test('exposes the active gallery destination to assistive technology', async ({ page }) => {
  await setUpNode(page);

  const navigation = page.getByRole('navigation', { name: 'Gallery navigation' });
  await expect(navigation.getByRole('button', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Interface language').selectOption('zh-CN');
  const localizedNavigation = page.getByRole('navigation', { name: '图库导航' });
  await expect(localizedNavigation.getByRole('button', { name: '时间线' })).toHaveAttribute('aria-current', 'page');
  await localizedNavigation.getByRole('button', { name: '节点设置' }).click();
  await expect(localizedNavigation.getByRole('button', { name: '节点设置' })).toHaveAttribute('aria-current', 'page');
  await expect(localizedNavigation.getByRole('button', { name: '时间线' })).not.toHaveAttribute('aria-current', 'page');
});

test('announces the loaded timeline result count in both locales', async ({ page }) => {
  const makeAsset = (assetId: string, kind: string, filename: string) => ({
    assetId, libraryId: 'library-1', originNodeId: 'node-1', kind, sha256: 'a'.repeat(64),
    availability: 'online', filename, capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  });
  const photo = makeAsset('asset-photo', 'photo', 'photo.jpg');
  const video = makeAsset('asset-video', 'video', 'video.mp4');
  let responseAssets: unknown[] = [photo, video];
  await setUpNode(page, { capabilities: ['galleryFilters'], assets: () => responseAssets });

  const announcement = page.locator('#timeline-results-announcement');
  await expect(page.locator('.count-chip')).toHaveText('2 items');
  await expect(announcement).toHaveText('2 items loaded.');
  await expect(announcement).toHaveAttribute('aria-live', 'polite');
  await expect(announcement).toHaveAttribute('aria-atomic', 'true');
  responseAssets = [video];
  await page.getByLabel('Media type').selectOption('video');
  await expect(page.locator('.count-chip')).toHaveText('1 item');
  await expect(announcement).toHaveText('1 item loaded.');
  await page.screenshot({ path: 'test-results/timeline-result-counts.png' });
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.locator('.count-chip')).toHaveText('1 项');
  await expect(announcement).toHaveText('已加载 1 项。');
});

test('keeps virtualized timeline spacers aligned with responsive row heights', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const assets = Array.from({ length: 60 }, (_, index) => ({
    assetId: `asset-${index}`, libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo',
    sha256: index.toString(16).padStart(64, '0'), availability: 'online', filename: `photo-${index}.jpg`,
    capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  }));
  await setUpNode(page, { assets: () => assets });
  const timeline = page.locator('.timeline-scroll');
  const readMetrics = () => timeline.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll<HTMLElement>('.asset-row'));
    const spacers = Array.from(element.querySelectorAll<HTMLElement>(':scope > [aria-hidden="true"]'));
    return {
      rowHeight: rows[0]?.getBoundingClientRect().height ?? 0,
      renderedRows: rows.length,
      topSpacerHeight: spacers[0]?.getBoundingClientRect().height ?? -1,
      bottomSpacerHeight: spacers[1]?.getBoundingClientRect().height ?? -1
    };
  });

  await expect.poll(async () => (await readMetrics()).renderedRows).toBe(24);
  const mobileMetrics = await readMetrics();
  expect(mobileMetrics.rowHeight).toBe(130);
  expect(mobileMetrics.topSpacerHeight + mobileMetrics.renderedRows * mobileMetrics.rowHeight + mobileMetrics.bottomSpacerHeight).toBe(assets.length * mobileMetrics.rowHeight);
  await page.screenshot({ path: testInfo.outputPath('mobile-virtualized-row-height.png') });

  await timeline.evaluate((element) => { element.scrollTop = 1300; });
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(1300);
  await expect(timeline.locator('.asset-row').first().locator('h2')).toHaveText('photo-7.jpg');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => (await readMetrics()).rowHeight).toBe(164);
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(1640);
  await expect(timeline.locator('.asset-row').first().locator('h2')).toHaveText('photo-7.jpg');
  const desktopMetrics = await readMetrics();
  expect(desktopMetrics.topSpacerHeight + desktopMetrics.renderedRows * desktopMetrics.rowHeight + desktopMetrics.bottomSpacerHeight).toBe(assets.length * desktopMetrics.rowHeight);
});

test('announces the end of the timeline politely in both locales', async ({ page }) => {
  const asset = {
    assetId: 'last-asset', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'last-photo.jpg', capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1'
  };
  await setUpNode(page, { assets: () => [asset], nextCursor: '' });
  const endStatus = page.locator('.timeline-scroll .end-row');
  await expect(endStatus).toHaveText('All indexed results are shown');
  await expect(endStatus).toHaveAttribute('role', 'status');
  await expect(endStatus).toHaveAttribute('aria-live', 'polite');
  await expect(endStatus).toHaveAttribute('aria-atomic', 'true');
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(endStatus).toHaveText('已显示全部索引结果');
});

test('explains when more timeline results are available by scrolling', async ({ page }, testInfo) => {
  const assets = Array.from({ length: 60 }, (_, index) => ({
    assetId: `asset-${index}`, libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo',
    sha256: index.toString(16).padStart(64, '0'), availability: 'online', filename: `photo-${index}.jpg`,
    capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  }));
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: [] } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => {
    const isContinuation = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({ status: 200, json: { items: isContinuation ? [] : assets, nextCursor: isContinuation ? null : 'next-page' } });
  });
  await page.goto('/');
  await reconnectNode(page);

  await expect(page.locator('.count-chip')).toHaveText('60 items');
  await expect(page.getByText('More items load as you scroll', { exact: true })).toBeVisible();
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(page.locator('.count-chip')).toHaveText('60 项');
  const localizedHint = page.getByText('滚动时会继续加载更多项目', { exact: true });
  await expect(localizedHint).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('timeline-more-results-hint.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(localizedHint).toBeVisible();
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
  await page.screenshot({ path: testInfo.outputPath('timeline-more-results-hint-mobile.png') });
});

test('shows a localized accessible return-to-top button after timeline scrolling', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const assets = Array.from({ length: 60 }, (_, index) => ({
    assetId: `asset-${index}`, libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo',
    sha256: index.toString(16).padStart(64, '0'), availability: 'online', filename: `photo-${index}.jpg`,
    capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  }));
  await setUpNode(page, { assets: () => assets });

  const timeline = page.getByRole('region', { name: 'Timeline' });
  const backToTop = page.getByRole('button', { name: 'Back to top' });
  await expect(backToTop).toHaveCount(0);
  await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(328);
  await expect(backToTop).toBeVisible();
  const geometry = await backToTop.evaluate((button) => {
    const nav = document.querySelector('.sidebar')?.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    return { buttonHeight: bounds.height, buttonBottom: bounds.bottom, navTop: nav?.top ?? 0 };
  });
  expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.buttonBottom).toBeLessThan(geometry.navTop);

  await page.locator('#locale-choice').selectOption('zh-CN');
  const localizedBackToTop = page.getByRole('button', { name: '回到顶部' });
  const localizedTimeline = page.getByRole('region', { name: '时间线' });
  await expect(localizedBackToTop).toBeVisible();
  await expect(localizedBackToTop).toHaveAttribute('aria-controls', 'timeline-scroll');
  await page.screenshot({ path: testInfo.outputPath('timeline-back-to-top-mobile.png') });
  await localizedBackToTop.click();
  await expect.poll(() => localizedTimeline.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(localizedTimeline).toBeFocused();
  await expect(localizedBackToTop).toHaveCount(0);
});

test('applies timeline filters through the authorized server pagination API', async ({ page }) => {
  const assetRequests: URL[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/assets') assetRequests.push(new URL(request.url()));
  });
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });

  const filters = page.getByRole('group', { name: 'Timeline filters' });
  await expect(filters.getByLabel('Media type')).toBeEnabled();
  await filters.getByLabel('Media type').selectOption('video');
  await filters.getByLabel('Source').selectOption('upload');
  await filters.getByLabel('Availability').selectOption('offline');
  await filters.getByLabel('From date (UTC, inclusive)').fill('2026-10-01');
  await filters.getByLabel('Before date (UTC, exclusive)').fill('2026-11-01');
  await page.getByRole('searchbox', { name: 'Search gallery' }).fill('summer');
  await page.getByRole('searchbox', { name: 'Search gallery' }).press('Enter');

  await expect.poll(() => assetRequests.some((url) => url.searchParams.get('kind') === 'video'
    && url.searchParams.get('sourceKind') === 'upload'
    && url.searchParams.get('availability') === 'offline'
    && url.searchParams.get('dateFrom') === '2026-10-01'
    && url.searchParams.get('dateTo') === '2026-11-01'
    && url.searchParams.get('q') === 'summer')).toBe(true);
  const filteredRequest = assetRequests.find((url) => url.searchParams.get('dateFrom') === '2026-10-01');
  expect(filteredRequest?.searchParams.get('libraryId')).toBe('library-1');
  expect(filteredRequest?.searchParams.has('cursor')).toBe(false);
});

test('summarizes active filters and clears them one at a time in both locales', async ({ page }) => {
  const assetRequests: URL[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/assets') assetRequests.push(new URL(request.url()));
  });
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });
  let filters = page.getByRole('group', { name: 'Timeline filters' });
  await filters.getByLabel('Media type').selectOption('video');
  await filters.getByLabel('From date (UTC, inclusive)').fill('2026-10-01');

  let activeFilters = page.getByRole('group', { name: 'Active filters' });
  await expect(activeFilters.getByRole('button', { name: 'Remove filter: Media type: Videos' })).toBeVisible();
  await expect(activeFilters.getByRole('button', { name: 'Remove filter: From date (UTC, inclusive): 2026-10-01' })).toBeVisible();
  await page.screenshot({ path: 'test-results/active-timeline-filters.png' });
  await page.getByLabel('Interface language').selectOption('zh-CN');
  filters = page.getByRole('group', { name: '时间线筛选' });
  activeFilters = page.getByRole('group', { name: '已选筛选项' });
  await activeFilters.getByRole('button', { name: '移除筛选：媒体类型: 视频' }).click();
  await expect(activeFilters).toBeFocused();
  await expect(filters.getByLabel('媒体类型')).toHaveValue('');
  await expect(activeFilters.getByRole('button', { name: '移除筛选：开始日期（UTC，包含）: 2026-10-01' })).toBeVisible();
  await expect.poll(() => assetRequests.some((url) => url.searchParams.get('dateFrom') === '2026-10-01' && !url.searchParams.has('kind'))).toBe(true);
  await activeFilters.getByRole('button', { name: '移除筛选：开始日期（UTC，包含）: 2026-10-01' }).click();
  await expect(page.getByRole('group', { name: '已选筛选项' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '时间线' })).toBeFocused();
});

test('disables server filters when the node does not declare filter capability', async ({ page }) => {
  await setUpNode(page);
  const filters = page.getByRole('group', { name: 'Timeline filters' });
  await expect(filters.getByLabel('Media type')).toBeDisabled();
  await expect(filters.getByLabel('From date (UTC, inclusive)')).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Media type, source, and availability filters are not supported by this node' })).toBeVisible();
});

test('keeps UTC date search enabled when category-filter capability is absent', async ({ page }) => {
  await setUpNode(page, { capabilities: ['gallerySearch'] });
  const filters = page.getByRole('group', { name: 'Timeline filters' });
  await expect(filters.getByLabel('Media type')).toBeDisabled();
  await expect(filters.getByLabel('From date (UTC, inclusive)')).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Media type, source, and availability filters are not supported by this node' })).toBeVisible();
});

test('rejects an invalid UTC date interval without sending it to the node', async ({ page }) => {
  const assetRequests: URL[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/assets') assetRequests.push(new URL(request.url()));
  });
  await setUpNode(page, { capabilities: ['gallerySearch'] });
  const filters = page.getByRole('group', { name: 'Timeline filters' });
  await filters.getByLabel('From date (UTC, inclusive)').fill('2026-11-01');
  await filters.getByLabel('Before date (UTC, exclusive)').fill('2026-10-01');
  await expect(page.getByRole('alert').filter({ hasText: 'The start date must be earlier than the exclusive end date.' })).toBeVisible();
  expect(assetRequests.some((url) => url.searchParams.get('dateFrom') === '2026-11-01' && url.searchParams.get('dateTo') === '2026-10-01')).toBe(false);
});

test('shows a filtered-empty state instead of claiming the library is empty', async ({ page }) => {
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });
  let filters = page.getByRole('group', { name: 'Timeline filters' });
  await filters.getByLabel('Media type').selectOption('video');
  await expect(page.getByRole('heading', { name: 'No items match these filters.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This library has no photos yet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset filters' })).toBeVisible();
  await page.screenshot({ path: 'test-results/timeline-filters-empty-state.png' });
  await page.getByLabel('Interface language').selectOption('zh-CN');
  filters = page.getByRole('group', { name: '时间线筛选' });
  await expect(page.getByRole('heading', { name: '没有项目符合这些筛选条件。' })).toBeVisible();
  await page.getByRole('button', { name: '重置筛选条件' }).click();
  await expect(filters.getByLabel('媒体类型')).toHaveValue('');
  await expect(page.getByRole('heading', { name: '这个图库还没有照片' })).toBeVisible();
});

test('keeps the timeline filter controls usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });
  const filters = page.getByRole('group', { name: 'Timeline filters' });
  await expect(filters).toBeVisible();
  await expect(filters.getByLabel('Media type')).toBeVisible();
  await expect(filters.getByLabel('Source')).toBeVisible();
  await expect(filters.getByLabel('Availability')).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
  await page.screenshot({ path: 'test-results/timeline-filters-mobile.png', fullPage: true });
});

test('collapses mobile timeline filters without losing the active selection', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });
  const filters = page.locator('#timeline-filters');
  await expect(filters).toHaveAttribute('role', 'group');
  await expect(filters).toHaveAttribute('aria-label', 'Timeline filters');
  await expect(filters).toBeVisible();
  await filters.getByLabel('Media type').selectOption('photo');
  const activeFilters = page.getByRole('group', { name: 'Active filters' });
  await expect(activeFilters).toBeVisible();

  const hideButton = page.getByRole('button', { name: 'Hide filters' });
  await expect(hideButton).toHaveAttribute('aria-expanded', 'true');
  await expect(hideButton).toHaveAttribute('aria-controls', 'timeline-filters');
  await hideButton.click();
  await expect(filters).toBeHidden();
  await expect(activeFilters).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show filters' })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: testInfo.outputPath('mobile-filters-collapsed.png') });
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(filters).toHaveAttribute('aria-label', '时间线筛选');
  const showButton = page.getByRole('button', { name: '展开筛选' });
  await expect(showButton).toHaveAttribute('aria-expanded', 'false');
  await expect(showButton).toHaveAttribute('aria-controls', 'timeline-filters');
  await showButton.click();
  await expect(filters).toBeVisible();
  await expect(filters.getByLabel('媒体类型')).toHaveValue('photo');
});

test('persists timeline filter visibility across reloads without storing credentials', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUpNode(page, { capabilities: ['galleryFilters', 'gallerySearch'] });
  await page.getByRole('button', { name: 'Hide filters' }).click();
  await expect(page.locator('#timeline-filters')).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photomesh-ui-timeline-filters-collapsed'))).toBe('true');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-token');

  await page.reload();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show filters' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#timeline-filters')).toBeHidden();

  await page.getByRole('button', { name: 'Show filters' }).click();
  await expect(page.locator('#timeline-filters')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photomesh-ui-timeline-filters-collapsed'))).toBe('false');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide filters' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#timeline-filters')).toBeVisible();
});

test('reserves the device safe area below mobile navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUpNode(page);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');

  await page.addStyleTag({ content: ':root { --safe-area-top: 44px !important; --safe-area-bottom: 28px !important; }' });
  const measurements = await page.evaluate(() => {
    const topbar = document.querySelector<HTMLElement>('.topbar');
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const content = document.querySelector<HTMLElement>('.content');
    if (!topbar || !sidebar || !content) throw new Error('Mobile navigation layout is unavailable');
    const sidebarStyle = getComputedStyle(sidebar);
    return {
      topbarTop: `${topbar.getBoundingClientRect().top}px`,
      sidebarHeight: sidebarStyle.height,
      sidebarPaddingBottom: sidebarStyle.paddingBottom,
      contentPaddingBottom: getComputedStyle(content).paddingBottom,
    };
  });
  expect(measurements).toEqual({ topbarTop: '44px', sidebarHeight: '86px', sidebarPaddingBottom: '33px', contentPaddingBottom: '104px' });
  await page.screenshot({ path: testInfo.outputPath('mobile-safe-area-navigation.png') });
});

test('keeps mobile header controls touch-sized without overlapping timeline content', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUpNode(page);
  const controlSizes = await page.locator('.searchbox, #locale-choice, #theme-choice').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }));
  expect(controlSizes).toHaveLength(3);
  for (const size of controlSizes) expect(size.height).toBeGreaterThanOrEqual(40);

  const layout = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
    const workspace = document.querySelector('.workspace')!.getBoundingClientRect();
    return {
      topbarBottom: topbar.bottom,
      workspaceTop: workspace.top,
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.workspaceTop).toBeGreaterThanOrEqual(layout.topbarBottom);
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
  await page.screenshot({ path: testInfo.outputPath('mobile-header-touch-targets.png') });

  await page.setViewportSize({ width: 360, height: 844 });
  const narrowLayout = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
    const workspace = document.querySelector('.workspace')!.getBoundingClientRect();
    return {
      topbarBottom: topbar.bottom,
      workspaceTop: workspace.top,
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll('.searchbox, #locale-choice, #theme-choice')].map((element) => element.getBoundingClientRect().height),
    };
  });
  expect(narrowLayout.controls).toHaveLength(3);
  expect(narrowLayout.controls.every((height) => height >= 40)).toBe(true);
  expect(narrowLayout.workspaceTop).toBeGreaterThanOrEqual(narrowLayout.topbarBottom);
  expect(narrowLayout.pageWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
});

test('restores a tombstone to the index without deleting original bytes', async ({ page }) => {
  let tombstones = [{ assetId: 'asset-deleted', libraryId: 'library-1', eventId: 'tombstone-1' }];
  let restoreRequest: { libraryId: string; eventId: string } | undefined;
  const destructiveRequests: string[] = [];
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/recycle-bin?*', (route) => route.fulfill({ status: 200, json: { items: tombstones } }));
  await page.route('**/v1/recycle-bin/restore', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    restoreRequest = route.request().postDataJSON() as { libraryId: string; eventId: string };
    tombstones = [];
    await route.fulfill({ status: 200, json: { tombstoneEventId: restoreRequest.eventId, restoreEventId: 'restore-event-1' } });
  });
  await page.route('**/v1/assets/*/original', async (route) => {
    destructiveRequests.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 404 });
  });
  await page.route('**/v1/**', (route) => {
    if (route.request().method() === 'DELETE') destructiveRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.fallback();
  });

  await setUpNode(page);
  await page.getByRole('button', { name: 'Recycle bin' }).click();
  await expect(page.getByText('asset-deleted', { exact: true })).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Original bytes will remain unchanged');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Restore to library' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Item restored to the library index' })).toBeVisible();
  expect(restoreRequest).toEqual({ libraryId: 'library-1', eventId: 'tombstone-1' });
  expect(destructiveRequests).toEqual([]);
});

test('requires explicit approval and separate library read grant', async ({ page }) => {
  const pending = [{ peerId: 'peer-verified-1', publicKey: 'public-key-fixture', proposedLabel: 'Phone', requestedAt: '2025-01-01T00:00:00.000Z' }];
  let peers: Array<{ peerId: string; label: string; trustState: string }> = [];
  let approvalBody: { approved: boolean; label?: string; libraryIds?: string[] } | undefined;
  let libraryGrantPath: string | undefined;
  await page.route('**/v1/pairing/peers', async (route) => {
    await route.fulfill({ status: 200, json: { peers, pending } });
  });
  await page.route('**/v1/pairing/peers/peer-verified-1/approval', async (route) => {
    approvalBody = route.request().postDataJSON() as { approved: boolean; label?: string; libraryIds?: string[] };
    peers = [{ peerId: 'peer-verified-1', label: 'Phone', trustState: 'trusted' }];
    pending.length = 0;
    await route.fulfill({ status: 200, json: { approved: true } });
  });
  await page.route('**/v1/pairing/peers/peer-verified-1/libraries/library-1', async (route) => {
    libraryGrantPath = route.request().url();
    await route.fulfill({ status: 204 });
  });

  await setUpNode(page);
  await page.getByRole('button', { name: 'Node settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Tag P2P sync is unavailable on this node' })).toBeVisible();
  await expect(page.getByText('Verified Peer ID: peer-verified-1')).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('No library access will be granted');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Approve device' }).click();
  await expect(page.getByText(/peer-verified-1/)).toBeVisible();
  expect(approvalBody).toEqual({ approved: true, label: 'Phone', libraryIds: [] });

  await page.getByRole('button', { name: 'Grant access' }).click();
  expect(libraryGrantPath).toContain('/v1/pairing/peers/peer-verified-1/libraries/library-1');
});

test('stacks trusted-peer controls vertically on a narrow settings viewport', async ({ page }, testInfo) => {
  const peerId = 'peer-verified-1';
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: {
    peers: [{ peerId, label: 'Trusted phone', trustState: 'trusted' }], pending: []
  } }));
  await page.route(`**/v1/pairing/peers/${peerId}/tag-sync-status`, (route) => route.fulfill({ status: 200, json: { pending: 0, lastError: null } }));
  await page.route('**/v1/pairing/libraries/library-1/tag-writers', (route) => route.fulfill({ status: 200, json: { writers: [] } }));

  await setUpNode(page, { capabilities: ['tagSync'] });
  await page.getByRole('button', { name: 'Node settings' }).click();
  const peerRow = page.locator('.peer-row').first();
  await expect(peerRow.getByRole('button', { name: 'Grant access' })).toBeVisible();
  await expect(peerRow.getByRole('button', { name: 'Grant tag writing' })).toBeVisible();
  const layout = await peerRow.evaluate((row) => {
    const identity = row.children[0].getBoundingClientRect();
    const actions = row.querySelector('.peer-actions')?.getBoundingClientRect();
    return { identityBottom: identity.bottom, actionsTop: actions?.top ?? 0, rowRight: row.getBoundingClientRect().right, actionsRight: actions?.right ?? 0 };
  });
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.identityBottom - 1);
  expect(layout.actionsRight).toBeLessThanOrEqual(layout.rowRight + 1);
  await peerRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('narrow-peer-settings.png') });
});

test('manages per-library tag-writer grants and explains revocation limits', async ({ page }, testInfo) => {
  const peerId = 'peer-verified-1';
  let writerEnabled = false;
  const grantMethods: string[] = [];
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: {
    peers: [{ peerId, label: 'Phone', trustState: 'trusted' }], pending: []
  } }));
  await page.route(`**/v1/pairing/peers/${peerId}/tag-sync-status`, (route) => route.fulfill({ status: 200, json: {
    pending: 2, lastError: 'peer_missing_asset_tags_v1'
  } }));
  await page.route('**/v1/pairing/libraries/library-1/tag-writers', (route) => route.fulfill({
    status: 200, json: { writers: writerEnabled ? [peerId] : [] }
  }));
  await page.route(`**/v1/pairing/peers/${peerId}/libraries/library-1/tag-write`, async (route) => {
    grantMethods.push(route.request().method());
    if (route.request().method() === 'PUT') {
      writerEnabled = true;
      await route.fulfill({ status: 204 });
    } else {
      writerEnabled = false;
      await route.fulfill({ status: 200, json: { status: 'revoked', replicatedEventsRemain: true } });
    }
  });

  const healthResponsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/health'));
  await setUpNode(page, { capabilities: ['tagSync'] });
  expect(await (await healthResponsePromise).json()).toMatchObject({ capabilities: ['tagSync'] });
  await page.getByRole('button', { name: 'Node settings' }).click();
  await expect(page.getByRole('button', { name: 'Grant tag writing' })).toBeVisible();
  await expect(page.locator('.peer-sync-status')).toContainText('2 tag events pending');
  await expect(page.locator('.peer-sync-status')).toContainText('Peer lacks asset-tags-v1');
  await page.getByRole('button', { name: 'Grant tag writing' }).click();
  await expect(page.getByRole('button', { name: 'Revoke tag writing' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke tag writing' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'already replicated to trusted peers cannot be retracted' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pm042-tag-writer-settings.png') });
  expect(grantMethods).toEqual(['PUT', 'DELETE']);
});

test('requires explicit trust before Tauri sends credentials to a remote HTTPS node', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} }); });
  let healthRequests = 0;
  await page.route('**/v1/health', async (route) => {
    healthRequests += 1;
    await route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } });
  });
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('https://remote.example.com');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Confirm that you trust this remote HTTPS node');
  expect(healthRequests).toBe(0);
  await page.locator('.remote-node-trust input').check();
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  expect(healthRequests).toBe(1);
});

test('requires HTTPS for remote Web node credentials', async ({ page }) => {
  let healthRequests = 0;
  await page.route('**/v1/health', async (route) => {
    healthRequests += 1;
    await route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } });
  });
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('http://192.168.1.20:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Remote nodes must use HTTPS');
  expect(healthRequests).toBe(0);

  await page.getByLabel('Node address').fill('https://remote.example.com');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('button', { name: 'Save and connect' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Online', { exact: true })).toBeVisible();
  expect(healthRequests).toBe(1);
});

test('announces connection status changes politely in both locales', async ({ page }) => {
  await setUpNode(page);
  const connectionStatus = page.locator('.topbar .connection-pill');
  await expect(connectionStatus).toHaveText('Online');
  await expect(connectionStatus).toHaveAttribute('role', 'status');
  await expect(connectionStatus).toHaveAttribute('aria-live', 'polite');
  await expect(connectionStatus).toHaveAttribute('aria-atomic', 'true');

  await page.getByRole('button', { name: 'Node settings' }).click();
  await page.getByRole('button', { name: 'Disconnect and clear session memory' }).click();
  await expect(connectionStatus).toHaveText('Offline');
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(connectionStatus).toHaveText('离线');
});

test('clears in-memory credentials on explicit disconnect', async ({ page }) => {
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await setUpNode(page);
  await page.getByRole('button', { name: 'Node settings' }).click();
  await page.getByRole('button', { name: 'Disconnect and clear session memory' }).click();
  await expect(page.getByLabel('Admin access token')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Connect node' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.toLowerCase().includes('token')))).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('photomesh-node-session'))).toBeNull();
});

test('persists the Chinese locale and a tab-scoped node session without disk credentials', async ({ page }) => {
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await setUpNode(page);
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(page.getByRole('region', { name: '时间线' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photomesh-ui-locale'))).toBe('zh-CN');
  await page.reload();
  await expect(page.locator('#locale-choice')).toHaveValue('zh-CN');
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
  // The refreshed tab reconnects from sessionStorage; the token never reaches
  // localStorage, the URL, or any other durable store.
  await expect(page.getByRole('region', { name: '时间线' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-token');
  expect(await page.evaluate(() => sessionStorage.getItem('photomesh-node-session') ?? '')).toContain('fixture-token');
});

test('follows system color changes until a manual theme is selected', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const themeChoice = page.locator('#theme-choice');
  const documentTheme = () => page.locator('html').getAttribute('data-theme');
  await expect(themeChoice).toHaveValue('system');
  await expect.poll(documentTheme).toBe('light');

  await themeChoice.selectOption('dark');
  await expect.poll(documentTheme).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(documentTheme).toBe('dark');
  await themeChoice.selectOption('system');
  await expect.poll(documentTheme).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(documentTheme).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('photomesh-ui-theme'))).toBe('system');

  await page.reload();
  await expect(themeChoice).toHaveValue('system');
  await expect.poll(documentTheme).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(documentTheme).toBe('light');
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(themeChoice.locator('option[value="system"]')).toHaveText('跟随系统');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(documentTheme).toBe('dark');
  await page.screenshot({ path: testInfo.outputPath('system-theme-zh-cn.png') });
});

test('returns focus to the tag action after the editor is dismissed', async ({ page }, testInfo) => {
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'focus-photo.jpg', capturedAt: null, sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1'
  };
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [asset] });
  const trigger = page.getByRole('article').locator('.icon-button');
  const dialog = page.getByRole('dialog', { name: 'Add a tag or create a virtual album' });
  await expect(trigger).toHaveAttribute('aria-label', 'Manage tags for focus-photo.jpg');
  await expect(page.getByRole('button', { name: 'Manage tags for focus-photo.jpg' })).toBeVisible();
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(trigger).toHaveAttribute('aria-label', '管理 focus-photo.jpg 的标签');
  await expect(page.getByRole('button', { name: '管理 focus-photo.jpg 的标签' })).toBeVisible();
  await page.locator('#locale-choice').selectOption('en');
  await trigger.focus();
  await page.screenshot({ path: testInfo.outputPath('asset-specific-tag-action.png') });

  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Tag name')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('tag-dialog-initial-focus.png') });
  await page.getByLabel('Tag name').fill('not-saved');
  const closeButton = dialog.getByRole('button', { name: 'Close' });
  await page.getByRole('button', { name: 'Save tag' }).focus();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Save tag' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('merges legacy browser tags into Node storage and reloads server-authoritative tags', async ({ page }, testInfo) => {
  const serverTags = ['already-on-node'];
  const tagWrites: string[] = [];
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'tagged-photo.jpg', capturedAt: '2026-10-27T00:00:00.000Z',
    sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: [...serverTags]
  };
  await seedLegacyTags(page, { 'asset-1': ['legacy-tag', 'already-on-node'] });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    expect(route.request().method()).toBe('PUT');
    const encodedTag = new URL(route.request().url()).pathname.split('/').pop()!;
    const tag = decodeURIComponent(encodedTag);
    tagWrites.push(tag);
    if (!serverTags.includes(tag)) serverTags.push(tag);
    await route.fulfill({ status: 204 });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [{ ...asset, tags: [...serverTags] }] });
  await expect.poll(() => serverTags.includes('legacy-tag')).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Legacy tags for these assets were saved to the node' })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('already-on-node', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('legacy-tag', { exact: true })).toBeVisible();
  expect(tagWrites).toEqual(['already-on-node', 'legacy-tag']);
  await page.screenshot({ path: testInfo.outputPath('pm043-web-tag-editor.png') });

  await page.getByRole('article').filter({ hasText: 'tagged-photo.jpg' }).getByRole('button', { name: 'Manage tags for tagged-photo.jpg' }).click();
  await page.getByLabel('Tag name').fill('new-server-tag');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect.poll(() => serverTags.includes('new-server-tag')).toBe(true);
  await expect(page.locator('.tag-list').getByText('new-server-tag', { exact: true })).toBeVisible();
  await appendLegacyTag(page, 'asset-1', 'late-local-tag');

  await page.reload();
  await reconnectNode(page);
  await expect(page.locator('.tag-list').getByText('legacy-tag', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('new-server-tag', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('late-local-tag', { exact: true })).toBeVisible();
  expect(await readLegacyTags(page)).toEqual({ 'asset-1': ['legacy-tag', 'already-on-node', 'late-local-tag'] });
  expect(tagWrites).toEqual(['already-on-node', 'legacy-tag', 'new-server-tag', 'late-local-tag']);
});

test('merges marker updates from simultaneous legacy imports in two tabs', async ({ page, context }) => {
  const serverTags: string[] = [];
  const tagWrites: string[] = [];
  const started = new Set<string>();
  const release = new Map<string, () => void>();
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'shared-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1'
  };
  const handleTagWrite = async (route: Route): Promise<void> => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    const tag = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    tagWrites.push(tag);
    if (tag.startsWith('parallel-')) {
      started.add(tag);
      await new Promise<void>((resolve) => release.set(tag, resolve));
    }
    if (!serverTags.includes(tag)) serverTags.push(tag);
    await route.fulfill({ status: 204 });
  };
  const fixtureAssets = () => [{ ...asset, tags: [...serverTags] }];
  await seedLegacyTags(page, { 'asset-1': ['seed'] });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', handleTagWrite);
  await setUpNode(page, { capabilities: ['assetTags'], assets: fixtureAssets });
  await expect.poll(() => serverTags.includes('seed')).toBe(true);

  const secondTab = await context.newPage();
  await secondTab.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await secondTab.route('**/v1/libraries/library-1/assets/asset-1/tags/**', handleTagWrite);
  await setUpNode(secondTab, { capabilities: ['assetTags'], assets: fixtureAssets });
  await expect(secondTab.getByRole('status').filter({ hasText: 'Legacy tags for these assets were saved to the node' })).toBeVisible();

  await appendLegacyTag(page, 'asset-1', 'parallel-a');
  await page.reload();
  await reconnectNode(page);
  await expect.poll(() => started.has('parallel-a')).toBe(true);

  await replaceLegacyTags(secondTab, 'asset-1', ['seed', 'parallel-b']);
  await secondTab.reload();
  await reconnectNode(secondTab);
  await expect.poll(() => started.has('parallel-b')).toBe(true);

  release.get('parallel-a')?.();
  release.get('parallel-b')?.();
  await expect.poll(() => serverTags.includes('parallel-a') && serverTags.includes('parallel-b')).toBe(true);
  await expect.poll(async () => await readLegacyImportMarker(page)).toEqual(['parallel-a', 'parallel-b', 'seed']);
  expect(tagWrites).toEqual(['seed', 'parallel-a', 'parallel-b']);
  await secondTab.close();
});

test('keeps the tag editor open and reports failure when Node rejects an edit', async ({ page }) => {
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'tagged-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  };
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/network-failure')) return route.abort('failed');
    await route.fulfill({ status: 400, json: { error: 'invalid_request' } });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [asset] });
  await page.getByRole('article').getByRole('button', { name: 'Manage tags for tagged-photo.jpg' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a tag or create a virtual album' });
  await page.getByLabel('Tag name').fill('over-limit');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'The node rejected this tag' })).toBeVisible();
  await expect(page.getByLabel('Tag name')).toHaveValue('over-limit');
  await expect(page.locator('.tag-list').getByText('over-limit', { exact: true })).toHaveCount(0);

  await page.getByLabel('Tag name').fill('network-failure');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Reconnect' })).toBeVisible();
  await expect(page.getByLabel('Tag name')).toHaveValue('network-failure');
  await expect(page.locator('.tag-list').getByText('network-failure', { exact: true })).toHaveCount(0);
});

test('retains legacy tags that exceed server limits instead of silently dropping them', async ({ page }) => {
  const oversizedTag = '界'.repeat(43);
  const legacy = { 'asset-1': [oversizedTag] };
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'legacy-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  };
  let putCount = 0;
  await seedLegacyTags(page, legacy);
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    putCount += 1;
    await route.fulfill({ status: 204 });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [asset] });
  await expect(page.getByRole('alert').filter({ hasText: 'legacy asset tag group(s) could not be saved' })).toBeVisible();
  await expect(page.locator('.tag-list').getByText(oversizedTag, { exact: true })).toBeVisible();
  expect(await readLegacyTags(page)).toEqual(legacy);
  expect(putCount).toBe(0);
});
