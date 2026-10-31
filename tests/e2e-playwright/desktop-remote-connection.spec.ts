import { expect, test } from '@playwright/test';

const remoteOrigin = 'https://node.example:8443';
const insecureRemoteOrigin = 'http://node.example:8443';
const appOrigin = 'http://127.0.0.1:4173';
const corsHeaders = {
  'access-control-allow-origin': appOrigin,
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, Upload-Offset, Upload-Chunk-SHA256, X-Request-ID',
  vary: 'Origin'
};

test('desktop requires explicit trust before sending credentials to a remote HTTPS node', async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });
  let remoteRequests = 0;
  let insecureRequests = 0;
  await page.route(`${insecureRemoteOrigin}/**`, async (route) => {
    insecureRequests += 1;
    await route.fulfill({ status: 200, json: { status: 'unexpected' } });
  });
  await page.route(`${remoteOrigin}/**`, async (route) => {
    remoteRequests += 1;
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const { pathname } = new URL(request.url());
    if (pathname === '/v1/health') {
      await route.fulfill({ status: 200, headers: corsHeaders, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: [] } });
    } else if (pathname === '/v1/libraries') {
      await route.fulfill({ status: 200, headers: corsHeaders, json: { items: [{ libraryId: 'remote-library', title: 'Remote fixture' }] } });
    } else if (pathname === '/v1/pairing/peers') {
      await route.fulfill({ status: 200, headers: corsHeaders, json: { peers: [], pending: [] } });
    } else if (pathname === '/v1/assets') {
      await route.fulfill({ status: 200, headers: corsHeaders, json: { items: [], nextCursor: null } });
    } else {
      await route.fulfill({ status: 404, headers: corsHeaders, json: { error: 'not_found' } });
    }
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill(insecureRemoteOrigin);
  await page.getByLabel('Admin access token').fill('fixture-token');
  await expect(page.locator('.remote-node-trust')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Remote nodes must use HTTPS');
  expect(remoteRequests).toBe(0);
  expect(insecureRequests).toBe(0);

  await page.getByLabel('Node address').fill(remoteOrigin);
  await page.getByLabel('Admin access token').fill('fixture-token');
  const trustCheckbox = page.locator('.remote-node-trust input');
  await expect(trustCheckbox).toBeVisible();
  await expect(trustCheckbox).not.toBeChecked();
  await trustCheckbox.check();
  await page.getByLabel('Node address').fill('https://other.example:8443');
  await expect(trustCheckbox).not.toBeChecked();
  await page.getByLabel('Node address').fill(remoteOrigin);
  await expect(trustCheckbox).not.toBeChecked();
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Confirm that you trust this remote HTTPS node');
  expect(remoteRequests).toBe(0);

  await page.locator('.remote-node-trust input').check();
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('main').getByText('Online', { exact: true })).toBeVisible();
  expect(remoteRequests).toBeGreaterThan(0);
});
