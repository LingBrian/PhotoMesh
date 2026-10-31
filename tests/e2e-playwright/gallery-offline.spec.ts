import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const previewPng = readFileSync(new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url));
const fixtureAsset = {
  assetId: 'offline-fixture', libraryId: 'offline-library', originNodeId: 'node-offline-fixture', kind: 'photo',
  sha256: 'b'.repeat(64), availability: 'online', filename: 'offline-fixture.png', capturedAt: '2024-02-03T04:05:06.000Z',
  sourcePath: null, sourceKind: 'import', byteSize: previewPng.byteLength, version: 'v1'
};

async function connectFixture(
  page: Page,
  original = { body: previewPng, contentType: 'application/octet-stream', filename: fixtureAsset.filename }
): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'offline-library', title: 'Offline fixture' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({
    status: 200,
    json: { items: [{ ...fixtureAsset, filename: original.filename, byteSize: original.body.byteLength }], nextCursor: null }
  }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/assets/offline-fixture/original', (route) => route.fulfill({
    status: 200, contentType: original.contentType, body: original.body
  }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Preview ${original.filename}` })).toBeVisible();
}

const largeOriginals = [
  { orientation: 'portrait', width: 4000, height: 6000 },
  { orientation: 'landscape', width: 6000, height: 4000 }
];
const previewViewports = [
  { width: 1920, height: 1032 },
  { width: 390, height: 844 },
  { width: 760, height: 844 },
  { width: 761, height: 844 },
  { width: 760, height: 320 },
  { width: 761, height: 320 }
];

for (const original of largeOriginals) {
  for (const viewport of previewViewports) {
    test(`contains decoded large ${original.orientation} preview at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const filename = `synthetic-${original.orientation}.png`;
      // Rasterize synthetic SVG only: Chromium createImageBitmap cannot decode SVG blobs.
      // Keep the native production decoder and full original dimensions under test.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${original.width}" height="${original.height}" viewBox="0 0 ${original.width} ${original.height}"><rect width="100%" height="100%" fill="#46785d"/><path d="M0 0L${original.width} ${original.height}M${original.width} 0L0 ${original.height}" stroke="#fff" stroke-width="40"/></svg>`;
      const png = await page.evaluate(async (source) => {
        const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Synthetic fixture canvas unavailable');
          context.drawImage(image, 0, 0);
          return canvas.toDataURL('image/png').split(',')[1]!;
        } finally {
          URL.revokeObjectURL(url);
        }
      }, svg);
      const body = Buffer.from(png, 'base64');
      await page.setViewportSize(viewport);
      await connectFixture(page, { body, contentType: 'image/png', filename });
      await page.getByRole('button', { name: `Preview ${filename}` }).click();
      const dialog = page.getByRole('dialog', { name: `Preview ${filename}` });
      const image = dialog.locator('.preview-content img');
      await expect(image).toBeVisible();
      const decoded = await image.evaluate(async (element: HTMLImageElement) => {
        await element.decode();
        return { complete: element.complete, width: element.naturalWidth, height: element.naturalHeight };
      });
      const previewScale = Math.min(1600 / original.width, 1200 / original.height, 1);
      expect(decoded).toEqual({
        complete: true,
        width: Math.round(original.width * previewScale),
        height: Math.round(original.height * previewScale)
      });

      // Retry geometry after decode so an unloaded/reflowing image cannot pass.
      await expect(async () => {
        const dialogBox = await dialog.boundingBox();
        const contentBox = await dialog.locator('.preview-content').boundingBox();
        const imageBox = await image.boundingBox();
        const mainBox = await dialog.locator('.preview-main').boundingBox();
        const sidebarBox = await dialog.locator('.preview-sidebar').boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(contentBox).not.toBeNull();
        expect(imageBox).not.toBeNull();
        expect(mainBox).not.toBeNull();
        expect(sidebarBox).not.toBeNull();
        const tolerance = 1; // Allow fractional CSS pixel rounding, not clipping.
        for (const box of [dialogBox!, contentBox!, imageBox!, mainBox!, sidebarBox!]) {
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
          expect(box.x).toBeGreaterThanOrEqual(-tolerance);
          expect(box.y).toBeGreaterThanOrEqual(-tolerance);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + tolerance);
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + tolerance);
        }
        expect(imageBox!.x).toBeGreaterThanOrEqual(contentBox!.x - tolerance);
        expect(imageBox!.y).toBeGreaterThanOrEqual(contentBox!.y - tolerance);
        expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + tolerance);
        expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(contentBox!.y + contentBox!.height + tolerance);
        expect(Math.abs(imageBox!.width - imageBox!.height * original.width / original.height)).toBeLessThanOrEqual(tolerance);
        if (viewport.width <= 760) {
          expect(sidebarBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height - tolerance);
          expect(Math.abs(sidebarBox!.x - mainBox!.x)).toBeLessThanOrEqual(tolerance);
        } else {
          expect(sidebarBox!.x).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width - tolerance);
          expect(Math.abs(sidebarBox!.y - mainBox!.y)).toBeLessThanOrEqual(tolerance);
        }
      }).toPass({ timeout: 10_000 });

      if (viewport.width <= 760) {
        const sidebar = dialog.locator('.preview-sidebar');
        await sidebar.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        const close = sidebar.getByRole('button', { name: 'Close', exact: true });
        await expect(close).toBeInViewport({ ratio: 1 });
        await close.click();
        await expect(dialog).toHaveCount(0);
      }
    });
  }
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
  const stage = dialog.locator('.preview-stage');
  const image = stage.locator('img');
  const mainBox = await main.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  const stageBox = await stage.boundingBox();
  const imageBox = await image.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(sidebarBox!.x).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width - 1);
  expect(imageBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
  expect(imageBox!.y).toBeGreaterThanOrEqual(stageBox!.y);
  expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1);
  expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height + 1);

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
