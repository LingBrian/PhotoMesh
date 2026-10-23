import { expect, test } from '@playwright/test';

test('refuses remote plaintext HTTP before sending the bearer token', async ({ page }) => {
  const interceptedRequests: string[] = [];
  await page.route('http://192.0.2.10/**', async (route) => {
    interceptedRequests.push(route.request().headers().authorization ?? '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill('http://192.0.2.10:8443');
  await page.getByLabel('Admin access token').fill('must-not-leak');
  await page.getByRole('button', { name: 'Connect node' }).click();

  await expect(page.getByRole('alert')).toContainText('Remote node connections require HTTPS');
  expect(interceptedRequests).toEqual([]);
});
