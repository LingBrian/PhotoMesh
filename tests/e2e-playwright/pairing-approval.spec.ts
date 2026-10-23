import { expect, test } from '@playwright/test';

const libraries = [{ libraryId: 'family-library', title: 'Family photos' }];
const requests = [
  { peerId: 'peer-no-grant-123456789', publicKey: 'cHVibGljLWtleS1vbmU=', proposedLabel: 'New NAS one', requestedAt: '2026-10-24T00:00:00.000Z' },
  { peerId: 'peer-explicit-grant-123456789', publicKey: 'cHVibGljLWtleS10d28=', proposedLabel: 'New NAS two', requestedAt: '2026-10-24T00:01:00.000Z' },
  { peerId: 'peer-decline-1234567890', publicKey: 'cHVibGljLWtleS10aHJlZQ==', proposedLabel: 'Unrecognized device', requestedAt: '2026-10-24T00:02:00.000Z' },
];

test('approval defaults to no library access and honors explicit grants or decline', async ({ page }) => {
  const pending = [...requests];
  const decisions: Array<{ peerId: string; body: { approved: boolean; libraryIds?: string[] } }> = [];
  await page.route('http://127.0.0.1:8443/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/health') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
    } else if (url.pathname === '/v1/libraries') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: libraries }) });
    } else if (url.pathname === '/v1/assets') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"nextCursor":null}' });
    } else if (url.pathname === '/v1/pairing/peers') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ peers: [], pending }) });
    } else if (url.pathname.endsWith('/approval') && request.method() === 'POST') {
      const peerId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      decisions.push({ peerId, body: request.postDataJSON() as { approved: boolean; libraryIds?: string[] } });
      const index = pending.findIndex((peer) => peer.peerId === peerId);
      if (index >= 0) pending.splice(index, 1);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"decided"}' });
    } else {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    }
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('test-admin-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Node settings' }).click();

  await expect(page.getByText('New NAS one')).toBeVisible();
  await expect(page.getByText('peer-no-grant-123456789')).toBeVisible();
  await expect(page.getByText('cHVibGljLWtleS1vbmU=')).toBeVisible();
  await page.getByRole('button', { name: 'Approve device' }).first().click();
  await expect.poll(() => decisions.length).toBe(1);

  const explicitGrantRow = page.locator('.pending-peer-row').filter({ hasText: 'New NAS two' });
  await explicitGrantRow.getByLabel('Family photos').check();
  await explicitGrantRow.getByRole('button', { name: 'Approve device' }).click();
  await expect.poll(() => decisions.length).toBe(2);

  const rejectRow = page.locator('.pending-peer-row').filter({ hasText: 'Unrecognized device' });
  await rejectRow.getByRole('button', { name: 'Decline device' }).click();
  await expect.poll(() => decisions.length).toBe(3);

  expect(decisions).toEqual([
    { peerId: requests[0]!.peerId, body: { approved: true, libraryIds: [] } },
    { peerId: requests[1]!.peerId, body: { approved: true, libraryIds: ['family-library'] } },
    { peerId: requests[2]!.peerId, body: { approved: false, libraryIds: [] } },
  ]);
});
