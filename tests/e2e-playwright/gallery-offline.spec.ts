import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const previewPng = readFileSync(new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url));
const fixtureAsset = {
  assetId: 'offline-fixture', libraryId: 'offline-library', originNodeId: 'node-offline-fixture', kind: 'photo',
  sha256: 'b'.repeat(64), availability: 'online', filename: 'offline-fixture.png', capturedAt: '2024-02-03T04:05:06.000Z',
  sourcePath: null, sourceKind: 'import', byteSize: previewPng.byteLength, version: 'v1'
};

async function connectFixture(page: Page, capabilities: string[] = []): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities } }));
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

test('avoids redundant tab stops on timeline cards while keeping actions keyboard reachable', async ({ page }, testInfo) => {
  await connectFixture(page);
  const row = page.getByRole('article').filter({ hasText: 'offline-fixture.png' });
  await expect(row).toHaveJSProperty('tabIndex', -1);

  const preview = row.getByRole('button', { name: 'Preview offline-fixture.png' });
  const download = row.getByRole('button', { name: 'Download original' });
  await preview.focus();
  await page.screenshot({ path: testInfo.outputPath('timeline-card-action-focus.png') });
  await page.keyboard.press('Tab');
  await expect(download).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preview).toBeFocused();
});

test('traps keyboard focus in the preview modal and restores it on close', async ({ page }, testInfo) => {
  await connectFixture(page);
  const opener = page.getByRole('button', { name: 'Preview offline-fixture.png' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Preview offline-fixture.png' });
  const closeButton = dialog.getByRole('button', { name: 'Close' });
  const copyFilename = dialog.getByRole('button', { name: 'Copy filename' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.preview-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.locator('img.preview-image')).toBeVisible();

  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(copyFilename).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('preview-modal-focus-boundary.png') });
  await closeButton.click();
  await expect(opener).toBeFocused();
});

test.describe('touch-only timeline affordances', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('keeps the preview action label visible without hover', async ({ page }, testInfo) => {
    await connectFixture(page);
    await expect.poll(() => page.evaluate(() => window.matchMedia('(hover: none)').matches)).toBe(true);
    const label = page.locator('.preview-trigger-label');
    await page.getByRole('button', { name: 'Preview offline-fixture.png' }).scrollIntoViewIfNeeded();
    await expect(label).toHaveCSS('opacity', '1');
    await expect(label).toHaveText('Preview');
    await page.locator('#locale-choice').selectOption('zh-CN');
    await expect(label).toHaveText('预览');
    await expect(label).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: '收起筛选' }).click();
    await expect(label).toHaveCSS('opacity', '1');
    await page.locator('.asset-preview').screenshot({ path: testInfo.outputPath('touch-preview-label.png') });
  });

  test('keeps timeline selection and action controls at 44-pixel touch size', async ({ page }, testInfo) => {
    await connectFixture(page, ['assetTags', 'assetFavorites']);
    const row = page.locator('.asset-row').filter({ hasText: 'offline-fixture.png' });
    const selectionTarget = row.locator('.asset-selection');
    const tagButton = row.locator('.icon-button');
    const downloadButton = row.locator('.download-button');
    await expect(selectionTarget.locator('input')).toBeEnabled();
    await expect(tagButton).toBeEnabled();
    await expect(downloadButton).toBeEnabled();

    for (const target of [selectionTarget, tagButton, downloadButton]) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await row.screenshot({ path: testInfo.outputPath('mobile-timeline-action-targets.png') });
  });

  test('keeps language and theme controls at 44-pixel touch height', async ({ page }, testInfo) => {
    await connectFixture(page);
    const controls = page.locator('.top-actions .compact-select');
    await expect(controls).toHaveCount(2);
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath('mobile-header-touch-targets.png') });
  });
});
