import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test('places preview metadata and version controls in a responsive sidebar', async ({ page }) => {
  await connectFixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Preview offline-fixture.png' }).click();

  const dialog = page.getByRole('dialog', { name: 'Preview offline-fixture.png' });
  const main = dialog.locator('.preview-main');
  const sidebar = dialog.locator('.preview-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(dialog.locator('.preview-stage img')).toBeVisible();
  await expect(sidebar.getByText('Captured')).toBeVisible();
  await expect(sidebar.locator('.version-editor')).toBeVisible();
  const mainBox = await main.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(sidebarBox!.x).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width - 1);

  if (process.env.PHOTOMESH_PREVIEW_SIDEBAR_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.PHOTOMESH_PREVIEW_SIDEBAR_SCREENSHOT_PATH, fullPage: false });
  }

  await page.setViewportSize({ width: 680, height: 800 });
  const narrowMain = await main.boundingBox();
  const narrowSidebar = await sidebar.boundingBox();
  expect(narrowMain).not.toBeNull();
  expect(narrowSidebar).not.toBeNull();
  expect(narrowSidebar!.y).toBeGreaterThanOrEqual(narrowMain!.y + narrowMain!.height - 1);
});

test('keeps preview media inside its stage and the close action reachable at every size', async ({ page }) => {
  await connectFixture(page);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 760, height: 844 }, { width: 390, height: 844 }, { width: 760, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Preview offline-fixture.png' }).click();
    const dialog = page.getByRole('dialog', { name: 'Preview offline-fixture.png' });
    const image = dialog.locator('img.preview-image');
    await expect(image).toBeVisible();

    const dialogBox = await boxOf(dialog);
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);

    const contentBox = await boxOf(dialog.locator('.preview-content'));
    const imageBox = await boxOf(image);
    expect(imageBox.width).toBeGreaterThan(0);
    expect(imageBox.height).toBeGreaterThan(0);
    expect(imageBox.x).toBeGreaterThanOrEqual(contentBox.x - 1);
    expect(imageBox.y).toBeGreaterThanOrEqual(contentBox.y - 1);
    expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(contentBox.x + contentBox.width + 1);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1);

    const natural = await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }));
    expect(natural.width).toBeGreaterThan(0);
    expect(natural.height).toBeGreaterThan(0);
    expect(Math.abs(imageBox.width / imageBox.height - natural.width / natural.height)).toBeLessThan(0.02);

    const sidebar = dialog.locator('.preview-sidebar');
    await sidebar.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    const closeButton = dialog.getByRole('button', { name: 'Close' });
    await expect(closeButton).toBeInViewport({ ratio: 1 });
    await closeButton.click();
    await expect(dialog).toHaveCount(0);
  }
});

test('restores the node session after a reload and forgets it on disconnect', async ({ page }) => {
  await connectFixture(page);
  await expect(page.getByLabel('Admin access token')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByLabel('Admin access token')).toHaveCount(0);

  await page.getByRole('button', { name: 'Node settings' }).click();
  await page.getByRole('button', { name: 'Disconnect and clear session memory' }).click();
  await expect(page.getByLabel('Admin access token')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Admin access token')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Timeline' })).toHaveCount(0);
});

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
  // Cached/offline notices float over the stage so they never shrink the image.
  const noticePosition = await dialog.locator('.preview-notices').evaluate((element) => getComputedStyle(element).position);
  expect(noticePosition).toBe('absolute');
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
