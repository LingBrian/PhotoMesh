import { expect, test, type Page } from '@playwright/test';

async function setUpNode(page: Page, options: { capabilities?: string[] } = {}): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: options.capabilities ?? [] } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [], nextCursor: null } }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
}

test('restores a tombstone to the index without deleting original bytes', async ({ page }) => {
  let tombstones = [{ assetId: 'asset-deleted', libraryId: 'library-1', eventId: 'tombstone-1' }];
  let restoreRequest: { libraryId: string; eventId: string } | undefined;
  const destructiveRequests: string[] = [];
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/recycle-bin?*', (route) => route.fulfill({ status: 200, json: { items: tombstones } }));
  await page.route('**/v1/recycle-bin/restore', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    restoreRequest = route.request().postDataJSON() as { libraryId: string; eventId: string };
    tombstones = [];
    await route.fulfill({ status: 200, json: { tombstoneEventId: restoreRequest.eventId, restoreEventId: 'restore-event-1' } });
  });
  await page.route('**/v1/assets/*/original', async (route) => {
    destructiveRequests.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 404 });
  });
  await page.route('**/v1/**', (route) => {
    if (route.request().method() === 'DELETE') destructiveRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.fallback();
  });

  await setUpNode(page);
  await page.getByRole('button', { name: 'Recycle bin' }).click();
  await expect(page.getByText('asset-deleted', { exact: true })).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Original bytes will remain unchanged');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Restore to library' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Item restored to the library index' })).toBeVisible();
  expect(restoreRequest).toEqual({ libraryId: 'library-1', eventId: 'tombstone-1' });
  expect(destructiveRequests).toEqual([]);
});

test('requires explicit approval and separate library read grant', async ({ page }) => {
  const pending = [{ peerId: 'peer-verified-1', publicKey: 'public-key-fixture', proposedLabel: 'Phone', requestedAt: '2025-01-01T00:00:00.000Z' }];
  let peers: Array<{ peerId: string; label: string; trustState: string }> = [];
  let approvalBody: { approved: boolean; label?: string; libraryIds?: string[] } | undefined;
  let libraryGrantPath: string | undefined;
  await page.route('**/v1/pairing/peers', async (route) => {
    await route.fulfill({ status: 200, json: { peers, pending } });
  });
  await page.route('**/v1/pairing/peers/peer-verified-1/approval', async (route) => {
    approvalBody = route.request().postDataJSON() as { approved: boolean; label?: string; libraryIds?: string[] };
    peers = [{ peerId: 'peer-verified-1', label: 'Phone', trustState: 'trusted' }];
    pending.length = 0;
    await route.fulfill({ status: 200, json: { approved: true } });
  });
  await page.route('**/v1/pairing/peers/peer-verified-1/libraries/library-1', async (route) => {
    libraryGrantPath = route.request().url();
    await route.fulfill({ status: 204 });
  });

  await setUpNode(page);
  await page.getByRole('button', { name: 'Node settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Tag P2P sync is unavailable on this node' })).toBeVisible();
  await expect(page.getByText('Verified Peer ID: peer-verified-1')).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('No library access will be granted');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Approve device' }).click();
  await expect(page.getByText(/peer-verified-1/)).toBeVisible();
  expect(approvalBody).toEqual({ approved: true, label: 'Phone', libraryIds: [] });

  await page.getByRole('button', { name: 'Grant access' }).click();
  expect(libraryGrantPath).toContain('/v1/pairing/peers/peer-verified-1/libraries/library-1');
});

test('manages per-library tag-writer grants and explains revocation limits', async ({ page }, testInfo) => {
  const peerId = 'peer-verified-1';
  let writerEnabled = false;
  const grantMethods: string[] = [];
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: {
    peers: [{ peerId, label: 'Phone', trustState: 'trusted' }], pending: []
  } }));
  await page.route(`**/v1/pairing/peers/${peerId}/tag-sync-status`, (route) => route.fulfill({ status: 200, json: {
    pending: 2, lastError: 'peer_missing_asset_tags_v1'
  } }));
  await page.route('**/v1/pairing/libraries/library-1/tag-writers', (route) => route.fulfill({
    status: 200, json: { writers: writerEnabled ? [peerId] : [] }
  }));
  await page.route(`**/v1/pairing/peers/${peerId}/libraries/library-1/tag-write`, async (route) => {
    grantMethods.push(route.request().method());
    if (route.request().method() === 'PUT') {
      writerEnabled = true;
      await route.fulfill({ status: 204 });
    } else {
      writerEnabled = false;
      await route.fulfill({ status: 200, json: { status: 'revoked', replicatedEventsRemain: true } });
    }
  });

  const healthResponsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/health'));
  await setUpNode(page, { capabilities: ['tagSync'] });
  expect(await (await healthResponsePromise).json()).toMatchObject({ capabilities: ['tagSync'] });
  await page.getByRole('button', { name: 'Node settings' }).click();
  await expect(page.getByRole('button', { name: 'Grant tag writing' })).toBeVisible();
  await expect(page.locator('.peer-sync-status')).toContainText('2 tag events pending');
  await expect(page.locator('.peer-sync-status')).toContainText('Peer lacks asset-tags-v1');
  await page.getByRole('button', { name: 'Grant tag writing' }).click();
  await expect(page.getByRole('button', { name: 'Revoke tag writing' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke tag writing' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'already replicated to trusted peers cannot be retracted' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pm042-tag-writer-settings.png') });
  expect(grantMethods).toEqual(['PUT', 'DELETE']);
});

test('requires explicit trust before Tauri sends credentials to a remote HTTPS node', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} }); });
  let healthRequests = 0;
  await page.route('**/v1/health', async (route) => {
    healthRequests += 1;
    await route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } });
  });
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('https://remote.example.com');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Confirm that you trust this remote HTTPS node');
  expect(healthRequests).toBe(0);
  await page.locator('.remote-node-trust input').check();
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  expect(healthRequests).toBe(1);
});

test('requires HTTPS for remote Web node credentials', async ({ page }) => {
  let healthRequests = 0;
  await page.route('**/v1/health', async (route) => {
    healthRequests += 1;
    await route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1 } });
  });
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: [], nextCursor: null } }));
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.goto('/');
  await page.getByLabel('Node address').fill('http://192.168.1.20:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('alert')).toContainText('Remote nodes must use HTTPS');
  expect(healthRequests).toBe(0);

  await page.getByLabel('Node address').fill('https://remote.example.com');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('button', { name: 'Save and connect' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Online', { exact: true })).toBeVisible();
  expect(healthRequests).toBe(1);
});

test('clears in-memory credentials on explicit disconnect', async ({ page }) => {
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await setUpNode(page);
  await page.getByRole('button', { name: 'Node settings' }).click();
  await page.getByRole('button', { name: 'Disconnect and clear session memory' }).click();
  await expect(page.getByLabel('Admin access token')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Connect node' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.toLowerCase().includes('token')))).toBe(false);
});

test('persists Chinese locale preference without persisting credentials', async ({ page }) => {
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await setUpNode(page);
  await page.locator('#locale-choice').selectOption('zh-CN');
  await expect(page.getByRole('region', { name: '时间线' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photomesh-ui-locale'))).toBe('zh-CN');
  await page.reload();
  await expect(page.locator('#locale-choice')).toHaveValue('zh-CN');
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
  await expect(page.getByLabel('节点地址')).toBeVisible();
  await expect(page.getByLabel('管理员访问令牌')).toHaveValue('');
});
