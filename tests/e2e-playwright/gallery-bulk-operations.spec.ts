import { expect, test, type Page } from '@playwright/test';

type BatchFixtureOptions = { capabilities?: string[]; multipleLibraries?: boolean };

async function connectBatchFixture(page: Page, options: BatchFixtureOptions = {}): Promise<void> {
  const assets = [
    { assetId: 'asset-1', filename: 'Trip photo.jpg' },
    { assetId: 'asset-2', filename: 'Beach photo.jpg' },
    { assetId: 'asset-3', filename: 'Garden photo.jpg' },
  ].map((item) => ({
    ...item, libraryId: 'family-library', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', capturedAt: '2026-10-28T12:00:00.000Z', sourcePath: null, sourceKind: 'import', byteSize: 100,
    version: 'v1', tags: [], favorite: false,
  }));
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: {
    status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: options.capabilities ?? ['assetTags', 'assetFavorites', 'gallerySearch']
  } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: {
    items: [
      { libraryId: 'family-library', title: 'Family library' },
      ...(options.multipleLibraries ? [{ libraryId: 'other-library', title: 'Other library' }] : []),
    ]
  } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: assets, nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.goto('/');
  await page.getByLabel('Interface language').selectOption('en');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview Trip photo.jpg' })).toBeVisible();
}

async function selectTwoAssets(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: 'Select Trip photo.jpg' }).check();
  await page.getByRole('checkbox', { name: 'Select Beach photo.jpg' }).check();
  await expect(page.getByRole('status').filter({ hasText: '2 selected in Family library' })).toBeVisible();
}

test('applies reversible tags and shared favorites with explicit scope and retryable partial failures', async ({ page }) => {
  const tagCalls: Array<{ assetId: string; method: string; tag: string }> = [];
  const favoriteCalls: Array<{ assetId: string; favorite: boolean; key: string }> = [];
  const serverTagProjection = new Set<string>();
  const serverFavoriteProjection = new Map<string, boolean>();
  let failTagOnce = true;
  let failFavoriteOnce = true;
  const unexpectedWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && !/\/v1\/libraries\/family-library\/assets\/[^/]+\/(?:tags\/[^/]+|favorite)$/.test(new URL(request.url()).pathname)) {
      unexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route('**/v1/libraries/family-library/assets/*/tags/*', async (route) => {
    const url = new URL(route.request().url());
    const assetId = url.pathname.split('/').at(-3) ?? '';
    const tag = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const method = route.request().method();
    tagCalls.push({ assetId, method, tag });
    if (method === 'PUT') serverTagProjection.add(`${assetId}:${tag}`);
    else serverTagProjection.delete(`${assetId}:${tag}`);
    if (assetId === 'asset-2' && failTagOnce && method === 'PUT') {
      failTagOnce = false;
      await route.fulfill({ status: 503, json: { error: 'capability_unavailable', requestId: 'fixture' } });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  await page.route('**/v1/libraries/family-library/assets/*/favorite', async (route) => {
    const url = new URL(route.request().url());
    const assetId = url.pathname.split('/').at(-2) ?? '';
    const body = route.request().postDataJSON() as { favorite: boolean };
    const key = route.request().headers()['idempotency-key'] ?? '';
    favoriteCalls.push({ assetId, favorite: body.favorite, key });
    serverFavoriteProjection.set(assetId, body.favorite);
    if (assetId === 'asset-2' && body.favorite && failFavoriteOnce) {
      failFavoriteOnce = false;
      await route.fulfill({ status: 503, json: { error: 'capability_unavailable', requestId: 'fixture' } });
      return;
    }
    await route.fulfill({ status: 200, json: { favorite: body.favorite } });
  });
  await connectBatchFixture(page);

  await selectTwoAssets(page);
  await page.getByRole('button', { name: 'Add tag to selected' }).click();
  const addTagDialog = page.getByRole('dialog', { name: 'Add tag to 2 selected assets' });
  await expect(addTagDialog).toContainText('Family library');
  await expect(addTagDialog).toContainText('Only these selected assets');
  await addTagDialog.getByLabel('Tag name').fill('Project');
  await addTagDialog.getByRole('button', { name: 'Add tag to 2 assets' }).click();
  await expect(addTagDialog.getByRole('status').filter({ hasText: '1 updated; 1 failed' })).toBeVisible();
  await addTagDialog.getByRole('button', { name: 'Retry failed items' }).click();
  await expect(addTagDialog.getByRole('status').filter({ hasText: '2 updated; 0 failed' })).toBeVisible();
  expect(tagCalls).toEqual([
    { assetId: 'asset-1', method: 'PUT', tag: 'Project' },
    { assetId: 'asset-2', method: 'PUT', tag: 'Project' },
    { assetId: 'asset-2', method: 'PUT', tag: 'Project' },
  ]);
  expect(serverTagProjection).toEqual(new Set(['asset-1:Project', 'asset-2:Project']));
  await expect(page.getByRole('article').filter({ hasText: 'Trip photo.jpg' }).getByText('Project', { exact: true })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: 'Beach photo.jpg' }).getByText('Project', { exact: true })).toBeVisible();
  await addTagDialog.getByRole('button', { name: 'Close' }).last().click();

  await selectTwoAssets(page);
  await page.getByRole('button', { name: 'Remove tag from selected' }).click();
  const removeTagDialog = page.getByRole('dialog', { name: 'Remove tag from 2 selected assets' });
  await removeTagDialog.getByLabel('Tag to remove').selectOption('Project');
  await removeTagDialog.getByRole('button', { name: 'Remove tag from 2 assets' }).click();
  await expect(removeTagDialog.getByRole('status').filter({ hasText: '2 updated; 0 failed' })).toBeVisible();
  expect(tagCalls.slice(3)).toEqual([
    { assetId: 'asset-1', method: 'DELETE', tag: 'Project' },
    { assetId: 'asset-2', method: 'DELETE', tag: 'Project' },
  ]);
  expect(serverTagProjection.size).toBe(0);
  await removeTagDialog.getByRole('button', { name: 'Close' }).last().click();

  await selectTwoAssets(page);
  await page.getByRole('button', { name: 'Favorite selected', exact: true }).click();
  const favoriteDialog = page.getByRole('dialog', { name: 'Favorite 2 selected assets' });
  await expect(favoriteDialog).toContainText('library-wide shared favorite');
  if (process.env.PHOTOMESH_BULK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PHOTOMESH_BULK_SCREENSHOT_PATH });
  await favoriteDialog.getByRole('button', { name: 'Set favorite for 2 assets' }).click();
  await expect(favoriteDialog.getByRole('status').filter({ hasText: '1 updated; 1 failed' })).toBeVisible();
  await favoriteDialog.getByRole('button', { name: 'Retry failed items' }).click();
  await expect(favoriteDialog.getByRole('status').filter({ hasText: '2 updated; 0 failed' })).toBeVisible();
  const favoriteOnCalls = favoriteCalls.filter((call) => call.favorite);
  expect(favoriteOnCalls.map(({ assetId }) => assetId)).toEqual(['asset-1', 'asset-2', 'asset-2']);
  expect(favoriteOnCalls.every(({ key }) => /^[0-9a-f-]{36}$/i.test(key))).toBe(true);
  expect(favoriteOnCalls[1]?.key).toBe(favoriteOnCalls[2]?.key);
  expect(favoriteOnCalls[0]?.key).not.toBe(favoriteOnCalls[1]?.key);
  expect([...serverFavoriteProjection].sort()).toEqual([['asset-1', true], ['asset-2', true]]);
  await expect(page.getByRole('article').filter({ hasText: 'Trip photo.jpg' }).getByText('Shared favorite', { exact: true })).toBeVisible();
  await favoriteDialog.getByRole('button', { name: 'Close' }).last().click();

  await selectTwoAssets(page);
  await page.getByRole('button', { name: 'Unfavorite selected', exact: true }).click();
  const unfavoriteDialog = page.getByRole('dialog', { name: 'Unfavorite 2 selected assets' });
  await unfavoriteDialog.getByRole('button', { name: 'Remove favorite for 2 assets' }).click();
  await expect(unfavoriteDialog.getByRole('status').filter({ hasText: '2 updated; 0 failed' })).toBeVisible();
  const favoriteOffCalls = favoriteCalls.filter((call) => !call.favorite);
  expect(favoriteOffCalls.map(({ assetId }) => assetId)).toEqual(['asset-1', 'asset-2']);
  expect(favoriteOffCalls.every(({ key }) => /^[0-9a-f-]{36}$/i.test(key))).toBe(true);
  expect(new Set(favoriteOffCalls.map(({ key }) => key)).size).toBe(2);
  expect([...serverFavoriteProjection].sort()).toEqual([['asset-1', false], ['asset-2', false]]);
  await expect(page.getByRole('article').filter({ hasText: 'Trip photo.jpg' }).getByText('Shared favorite', { exact: true })).toHaveCount(0);
  expect(unexpectedWrites).toEqual([]);
});

test('keeps the single-item gallery available without bulk feature capabilities', async ({ page }) => {
  await connectBatchFixture(page, { capabilities: ['gallerySearch'] });
  await expect(page.getByRole('button', { name: 'Preview Trip photo.jpg' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select Trip photo.jpg' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);
});

test('clears selection when search or library scope changes', async ({ page }) => {
  await connectBatchFixture(page, { multipleLibraries: true });
  await page.getByRole('checkbox', { name: 'Select Trip photo.jpg' }).check();
  await expect(page.getByRole('status').filter({ hasText: '1 selected in Family library' })).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  await search.fill('Trip');
  await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);
  await search.fill('');
  await expect(page.getByRole('button', { name: 'Preview Trip photo.jpg' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select Trip photo.jpg' }).check();
  await page.getByRole('combobox', { name: 'Choose library' }).selectOption('other-library');
  await expect(page.getByRole('checkbox', { name: 'Select Trip photo.jpg' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);
});

test('reports uncertain and unstarted items if the session changes during a batch', async ({ page }) => {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let releaseRoute!: () => void;
  const release = new Promise<void>((resolve) => { releaseRoute = resolve; });
  let finishRoute!: () => void;
  const routeFinished = new Promise<void>((resolve) => { finishRoute = resolve; });
  const favoriteCalls: string[] = [];

  await page.route('**/v1/libraries/family-library/assets/*/favorite', async (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    favoriteCalls.push(assetId);
    if (assetId === 'asset-1') {
      await route.fulfill({ status: 200, json: { favorite: true } });
      return;
    }
    if (assetId === 'asset-2') {
      signalStarted();
      await release;
      try { await route.fulfill({ status: 200, json: { favorite: true } }); } catch { /* Session invalidation may already have aborted this client request. */ }
      finishRoute();
      return;
    }
    await route.fulfill({ status: 200, json: { favorite: true } });
  });

  await connectBatchFixture(page);
  await selectTwoAssets(page);
  await page.getByRole('checkbox', { name: 'Select Garden photo.jpg' }).check();
  await page.getByRole('button', { name: 'Favorite selected', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Favorite 3 selected assets' });
  await dialog.getByRole('button', { name: 'Set favorite for 3 assets' }).click();
  await started;

  try {
    await page.getByRole('button', { name: 'Node settings' }).dispatchEvent('click');
    await page.getByLabel('Node address').fill('http://127.0.0.1:8444', { force: true });
    await expect(page.getByRole('alert').filter({ hasText: '1 confirmed; 0 failed; 1 outcome unknown; 1 not started' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Nothing resumed automatically' })).toBeVisible();
  } finally {
    releaseRoute();
    await routeFinished;
  }
  expect(favoriteCalls).toEqual(['asset-1', 'asset-2']);
});
