import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const previewPng = readFileSync(new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url));
const fixtureAsset = {
  assetId: 'asset-1', libraryId: 'fixture-library', originNodeId: 'node-fixture', kind: 'photo',
  sha256: 'a'.repeat(64), availability: 'online', filename: 'fixture-photo.png', capturedAt: '2024-01-03T12:04:05.000Z',
  sourcePath: null, sourceKind: 'import', byteSize: previewPng.byteLength, version: 'v1'
};

test('Windows gallery loads image bytes only after an explicit preview action and releases preview URLs', async ({ page }, testInfo) => {
  const originalDigestBefore = Buffer.from(previewPng).toString('hex');
  let originalReads = 0;
  const thumbnailReads: string[] = [];
  const writeRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/') && request.method() !== 'GET') writeRequests.push(request.method());
  });

  await page.addInitScript(() => {
    const windowState = window as typeof window & { __idbWriteCount?: number };
    const idbPrototype = IDBObjectStore.prototype as unknown as { put: (this: IDBObjectStore, ...args: unknown[]) => IDBRequest };
    const originalPut = idbPrototype.put;
    idbPrototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
      windowState.__idbWriteCount = (windowState.__idbWriteCount ?? 0) + 1;
      return originalPut.apply(this, args);
    };
    const created: string[] = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value: Blob | MediaSource) => {
      const url = create(value);
      created.push(url);
      (window as typeof window & { __createdObjectUrls?: string[] }).__createdObjectUrls = created;
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      (window as typeof window & { __revokedObjectUrls?: string[] }).__revokedObjectUrls = revoked;
      revoke(url);
    };
  });

  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: ['mediaVersions', 'thumbnails', 'assetTags', 'gallerySearch'] } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [
    { libraryId: 'fixture-library', title: 'Fixture library' },
    { libraryId: 'other-library', title: 'Other library' },
  ] } }));
  await page.route('**/v1/assets?*', async (route) => {
    const requestedLibrary = new URL(route.request().url()).searchParams.get('libraryId') ?? 'fixture-library';
    const asset = {
      ...fixtureAsset,
      libraryId: requestedLibrary,
      filename: requestedLibrary === 'other-library' ? 'other-photo.png' : 'fixture-photo.png',
    };
    await route.fulfill({ status: 200, json: { items: requestedLibrary === 'other-library' ? [asset] : [asset, { ...asset, assetId: 'asset-video', filename: 'middle-video.mp4', kind: 'video', availability: 'offline' }, { ...asset, assetId: 'asset-2', filename: 'second-photo.png', originNodeId: 'node-second', byteSize: 2048, capturedAt: '2024-01-02T12:04:05.000Z', availability: 'cached' }, { ...asset, assetId: 'asset-unknown', filename: 'undated-photo.png', capturedAt: null, availability: 'cached' }], nextCursor: null } });
  });
  await page.route('**/v1/libraries/*/assets/*/thumbnail*', async (route) => {
    const url = new URL(route.request().url());
    const libraryId = url.pathname.split('/')[3];
    const assetId = url.pathname.split('/')[5];
    thumbnailReads.push(`${libraryId}/${assetId}`);
    expect(url.searchParams.get('profile')).toBe('timeline-192');
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    if (libraryId !== 'fixture-library') {
      await route.fulfill({ status: 404, json: { error: 'not_found' } });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/webp', body: previewPng, headers: { 'cache-control': 'private, no-store' } });
  });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/*/assets/*/tags/**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/v1/assets/*/original', async (route) => {
    originalReads += 1;
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: previewPng });
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill('https://node.example');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview fixture-photo.png' })).toBeVisible();
  const dateGroupHeadings = page.locator('.timeline-day-heading');
  await expect(dateGroupHeadings).toHaveCount(3);
  await expect(dateGroupHeadings.nth(0)).toHaveText(/.+/);
  await expect(dateGroupHeadings.nth(1)).toHaveText(/.+/);
  await expect(dateGroupHeadings.nth(2)).toHaveText('Capture time unknown');
  await expect(page.locator('.asset-preview-trigger img')).toHaveCount(3);
  await expect.poll(() => thumbnailReads.filter((request) => request.startsWith('fixture-library/')).length).toBe(3);
  expect(await page.evaluate(() => (window as typeof window & { __idbWriteCount?: number }).__idbWriteCount ?? 0)).toBe(0);
  expect(originalReads).toBe(0);

  const opener = page.getByRole('button', { name: 'Preview fixture-photo.png' });
  await opener.click();
  const dialog = page.locator('.preview-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __idbWriteCount?: number }).__idbWriteCount ?? 0)).toBe(1);
  await dialog.screenshot({ path: testInfo.outputPath('gallery-preview.png') });
  expect(originalReads).toBe(1);
  await expect(dialog.getByText('node-fixture')).toBeVisible();
  await expect(dialog.getByText('Online')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Next photo' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Preview middle-video.mp4' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next photo' }).click();
  await expect(dialog).toHaveAttribute('aria-label', 'Preview second-photo.png');
  await expect(dialog.locator('img')).toBeVisible();
  expect(originalReads).toBe(2);
  await page.getByRole('searchbox', { name: 'Search gallery' }).focus();
  await page.keyboard.press('ArrowLeft');
  expect(originalReads).toBe(2);
  await dialog.getByRole('button', { name: 'Next photo' }).focus();
  await dialog.getByRole('button', { name: 'Previous photo' }).click();
  await expect(dialog).toHaveAttribute('aria-label', 'Preview fixture-photo.png');
  expect(originalReads).toBe(3);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  const cleanup = await page.evaluate(() => ({
    created: (window as typeof window & { __createdObjectUrls?: string[] }).__createdObjectUrls ?? [],
    revoked: (window as typeof window & { __revokedObjectUrls?: string[] }).__revokedObjectUrls ?? [],
  }));
  expect(cleanup.revoked.length).toBeGreaterThan(0);
  expect(cleanup.revoked.every((url) => cleanup.created.includes(url))).toBe(true);
  expect(writeRequests).toEqual([]);
  expect(Buffer.from(previewPng).toString('hex')).toBe(originalDigestBefore);

  await page.getByRole('article').filter({ hasText: 'fixture-photo.png' }).getByRole('button', { name: 'Add a tag or create a virtual album' }).click();
  await page.getByLabel('Tag name').fill('Work');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect(page.getByText('Work', { exact: true }).first()).toBeVisible();

  await page.locator('#library-choice').selectOption('other-library');
  await expect(page.getByRole('alert')).toContainText('The library changed, so the session and its requests were cleared');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('banner').getByText('Online', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Timeline/ }).click();
  await expect(page.getByRole('button', { name: 'Preview other-photo.png' })).toBeVisible();
  await expect(page.getByText('Work', { exact: true })).toHaveCount(0);
  await expect(page.locator('.asset-preview img')).toHaveCount(0);
  expect(originalReads).toBe(3);
});

test('keeps placeholders and sends no thumbnail request to an older node without the capability', async ({ page }) => {
  let thumbnailRequests = 0;
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'fixture-library', title: 'Fixture library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [fixtureAsset], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/*/assets/*/thumbnail*', async (route) => {
    thumbnailRequests += 1;
    await route.fulfill({ status: 500, json: { error: 'unexpected_thumbnail_request' } });
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill('https://node.example');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview fixture-photo.png' })).toBeVisible();
  await expect(page.locator('.asset-preview-trigger img')).toHaveCount(0);
  expect(thumbnailRequests).toBe(0);
});
