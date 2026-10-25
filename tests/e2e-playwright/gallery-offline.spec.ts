import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const previewPng = readFileSync(new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url));
const fixtureAsset = {
  assetId: 'offline-fixture', libraryId: 'offline-library', originNodeId: 'node-offline-fixture', kind: 'photo',
  sha256: 'b'.repeat(64), availability: 'online', filename: 'offline-fixture.png', capturedAt: '2024-02-03T04:05:06.000Z',
  sourcePath: null, sourceKind: 'import', byteSize: previewPng.byteLength, version: 'v1'
};

async function connectFixture(page: Page): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'offline-library', title: 'Offline fixture' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [fixtureAsset], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/assets/offline-fixture/original', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream', body: previewPng
  }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview offline-fixture.png' })).toBeVisible();
}

test('keeps the authorized session timeline available offline and previews only cached thumbnails', async ({ page }) => {
  let nodeOnline = true;
  let originalReads = 0;
  await page.route('**/v1/health', (route) => nodeOnline
    ? route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } })
    : route.abort('failed'));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'offline-library', title: 'Offline fixture' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [fixtureAsset], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/assets/offline-fixture/original', async (route) => {
    originalReads += 1;
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: previewPng });
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview offline-fixture.png' }).click();
  await expect(page.getByRole('dialog', { name: 'Preview offline-fixture.png' }).locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.asset-preview img')).toHaveCount(1);
  expect(originalReads).toBe(1);

  nodeOnline = false;
  await page.getByRole('button', { name: 'Check node status' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Node is offline' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.locator('.asset-preview img')).toHaveCount(1);

  await page.getByRole('button', { name: 'Preview offline-fixture.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview offline-fixture.png' });
  await expect(dialog.getByText('Showing the cached thumbnail only; the original is unavailable while this node is offline.')).toBeVisible();
  await expect(dialog.locator('img')).toBeVisible();
  expect(originalReads).toBe(1);
  await page.keyboard.press('Escape');

  nodeOnline = true;
  await page.getByRole('button', { name: 'Check node status' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Node is offline' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  expect(originalReads).toBe(1);
  if (process.env.PHOTOMESH_GALLERY_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.PHOTOMESH_GALLERY_SCREENSHOT_PATH, fullPage: true });
  }
});

test('does not fail a valid preview when browser thumbnail storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      configurable: true,
      value: () => { throw new DOMException('IndexedDB unavailable', 'SecurityError'); }
    });
  });
  await connectFixture(page);
  await page.getByRole('button', { name: 'Preview offline-fixture.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview offline-fixture.png' });
  await expect(dialog.locator('img')).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
