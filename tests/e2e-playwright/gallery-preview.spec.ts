import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const previewPng = readFileSync(new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url));
const fixtureAsset = {
  assetId: 'asset-1', libraryId: 'fixture-library', originNodeId: 'node-fixture', kind: 'photo',
  sha256: 'a'.repeat(64), availability: 'online', filename: 'fixture-photo.png', capturedAt: '2024-01-02T03:04:05.000Z',
  sourcePath: null, sourceKind: 'import', byteSize: previewPng.byteLength, version: 'v1'
};

test('Windows gallery loads image bytes only after an explicit preview action and releases preview URLs', async ({ page }, testInfo) => {
  const originalDigestBefore = Buffer.from(previewPng).toString('hex');
  let originalReads = 0;
  const writeRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/') && request.method() !== 'GET') writeRequests.push(request.method());
  });

  await page.addInitScript(() => {
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

  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } }));
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
    await route.fulfill({ status: 200, json: { items: [asset], nextCursor: null } });
  });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [] } }));
  await page.route('**/v1/assets/asset-1/original', async (route) => {
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
  expect(originalReads).toBe(0);

  await page.getByRole('button', { name: 'Preview fixture-photo.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview fixture-photo.png' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath('gallery-preview.png') });
  expect(originalReads).toBe(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const cleanup = await page.evaluate(() => ({
    created: (window as typeof window & { __createdObjectUrls?: string[] }).__createdObjectUrls ?? [],
    revoked: (window as typeof window & { __revokedObjectUrls?: string[] }).__revokedObjectUrls ?? [],
  }));
  expect(cleanup.revoked.length).toBeGreaterThan(0);
  expect(cleanup.revoked.every((url) => cleanup.created.includes(url))).toBe(true);
  expect(writeRequests).toEqual([]);
  expect(Buffer.from(previewPng).toString('hex')).toBe(originalDigestBefore);

  await page.locator('#library-choice').selectOption('other-library');
  await expect(page.getByRole('button', { name: 'Preview other-photo.png' })).toBeVisible();
  await expect(page.locator('.asset-preview img')).toHaveCount(0);
  expect(originalReads).toBe(1);
});
