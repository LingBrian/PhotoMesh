import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const previewPng = readFileSync(
  new URL('../../docs/diagrams/assets/ER_元数据模型.png', import.meta.url),
);
const asset = {
  assetId: 'asset-1',
  libraryId: 'fixture-library',
  originNodeId: 'node-fixture',
  kind: 'photo',
  sha256: 'a'.repeat(64),
  availability: 'online',
  filename: 'fixture-photo.png',
  capturedAt: '2024-01-02T03:04:05.000Z',
  sourcePath: null,
  sourceKind: 'import',
  byteSize: previewPng.byteLength,
  version: 'v1',
};
const libraries = {
  items: [{ libraryId: 'fixture-library', title: 'Fixture library' }],
};

async function connectFixture(page: Page, capabilities: string[]): Promise<void> {
  await page.route('**/v1/health', (route) =>
    route.fulfill({
      status: 200,
      json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities },
    }),
  );
  await page.route('**/v1/libraries', (route) =>
    route.fulfill({ status: 200, json: libraries }),
  );
  await page.route('**/v1/assets?*', (route) =>
    route.fulfill({
      status: 200,
      json: { items: [asset], nextCursor: null },
    }),
  );
  await page.route('**/v1/pairing/peers', (route) =>
    route.fulfill({ status: 200, json: { peers: [] } }),
  );
  await page.route('**/v1/assets/asset-1/original', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: previewPng,
    }),
  );

  await page.goto('/');
  await page.getByLabel('Node address').fill('https://node.example');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
}

test('Windows editor gates on capability and creates/previews a derived version', async ({ page }, testInfo) => {
  await connectFixture(page, ['mediaVersions']);
  const createBodies: Record<string, unknown>[] = [];
  let originalReads = 0;
  let versionContentReads = 0;

  await page.unroute('**/v1/assets/asset-1/original');
  await page.route('**/v1/assets/asset-1/original', async (route) => {
    originalReads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: previewPng,
    });
  });
  await page.route(
    '**/v1/libraries/fixture-library/assets/asset-1/versions',
    async (route) => {
      if (route.request().method() === 'POST') {
        createBodies.push(
          route.request().postDataJSON() as Record<string, unknown>,
        );
        const versionId = `version-${createBodies.length}`;
        await route.fulfill({
          status: 202,
          json: {
            operationId: `operation-${createBodies.length}`,
            versionId,
            status: 'staging',
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          original: {
            sourceVersionId: null,
            sha256: 'a'.repeat(64),
            mimeType: 'image/png',
            byteSize: previewPng.byteLength,
            filename: asset.filename,
            availability: 'online',
          },
          items: [],
        },
      });
    },
  );
  await page.route(
    '**/v1/libraries/fixture-library/assets/asset-1/versions/version-*',
    (route) => {
      const versionId = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const secondVersion = versionId === 'version-2';
      return route.fulfill({
        status: 200,
        json: {
          versionId,
          assetId: 'asset-1',
          sourceVersionId: secondVersion ? 'version-1' : null,
          sourceSha256: secondVersion ? 'b'.repeat(64) : 'a'.repeat(64),
          outputSha256: secondVersion ? 'c'.repeat(64) : 'b'.repeat(64),
          mimeType: 'image/png',
          byteSize: previewPng.byteLength,
          width: 1,
          height: 1,
          transform: {
            crop: {
              x: 250000,
              y: 100000,
              width: 500000,
              height: 750000,
            },
            rotation: secondVersion ? 180 : 90,
          },
          status: 'ready',
          createdAt: '2026-10-24T12:00:00.000Z',
          errorCode: null,
        },
      });
    },
  );
  await page.route(
    '**/v1/libraries/fixture-library/assets/asset-1/versions/version-*/content',
    async (route) => {
      versionContentReads += 1;
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: previewPng,
      });
    },
  );

  await page.getByRole('button', { name: 'Preview fixture-photo.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview fixture-photo.png' });
  await expect(dialog.getByText('Create a media version')).toBeVisible();
  await expect(
    dialog.getByText(
      'The original is read-only; edits create a separate library version.',
    ),
  ).toBeVisible();
  await dialog.getByLabel('Crop left (0–1)').fill('0.25');
  await dialog.getByLabel('Crop top (0–1)').fill('0.1');
  await dialog.getByLabel('Crop width (0–1)').fill('0.5');
  await dialog.getByLabel('Crop height (0–1)').fill('0.75');
  await dialog.getByLabel('Rotation').selectOption('90');
  await dialog.screenshot({
    path: testInfo.outputPath('media-version-editor.png'),
  });
  await dialog.getByRole('button', { name: 'Save as new version' }).click();
  await expect(
    dialog.getByRole('img', { name: 'Derived media version preview' }),
  ).toBeVisible();

  await dialog.getByLabel('Edit from').selectOption('version-1');
  await expect.poll(() => versionContentReads).toBe(2);
  await dialog.getByLabel('Rotation').selectOption('180');
  await dialog.getByRole('button', { name: 'Save as new version' }).click();
  await expect(dialog.locator('.version-list li')).toHaveCount(2);
  await expect.poll(() => versionContentReads).toBe(3);
  await expect(
    dialog.getByRole('img', { name: 'Derived media version preview' }),
  ).toBeVisible();

  expect(createBodies).toHaveLength(2);
  expect(createBodies[0]).toMatchObject({
    sourceVersionId: null,
    sourceSha256: 'a'.repeat(64),
    transform: {
      crop: {
        x: 250000,
        y: 100000,
        width: 500000,
        height: 750000,
      },
      rotation: 90,
    },
  });
  expect(createBodies[1]).toMatchObject({
    sourceVersionId: 'version-1',
    sourceSha256: 'b'.repeat(64),
    transform: { rotation: 180 },
  });
  expect(versionContentReads).toBe(3);
  expect(originalReads).toBe(1);
});

test('Windows editor explains when the Node lacks media-version capability', async ({ page }) => {
  await connectFixture(page, []);
  await page.getByRole('button', { name: 'Preview fixture-photo.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview fixture-photo.png' });
  await expect(
    dialog.getByText('Media version editing is unavailable on this node.'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Save as new version' }),
  ).toHaveCount(0);
});
