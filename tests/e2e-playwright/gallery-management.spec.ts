import { expect, test, type Page, type Route } from '@playwright/test';

async function setUpNode(page: Page, options: { capabilities?: string[]; assets?: () => unknown[] } = {}): Promise<void> {
  await page.route('**/v1/health', (route) => route.fulfill({ status: 200, json: { status: 'ok', protocolMin: 1, protocolMax: 1, capabilities: options.capabilities ?? [] } }));
  await page.route('**/v1/libraries', (route) => route.fulfill({ status: 200, json: { items: [{ libraryId: 'library-1', title: 'Family library' }] } }));
  await page.route('**/v1/assets?*', (route) => route.fulfill({ status: 200, json: { items: options.assets?.() ?? [], nextCursor: null } }));
  await page.goto('/');
  await reconnectNode(page);
}

async function reconnectNode(page: Page): Promise<void> {
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
}

async function seedLegacyTags(page: Page, tagsByAsset: Record<string, string[]>): Promise<void> {
  await page.goto('/');
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onupgradeneeded = () => {
      for (const store of ['thumbnails', 'tags', 'albums']) {
        if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store, { keyPath: 'key' });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      tx.objectStore('tags').put({ key: JSON.stringify(['http://127.0.0.1:8443', 'library-1']), value });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), tagsByAsset);
}

async function readLegacyTags(page: Page): Promise<Record<string, string[]> | undefined> {
  return page.evaluate(() => new Promise<Record<string, string[]> | undefined>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('tags').objectStore('tags').get(JSON.stringify(['http://127.0.0.1:8443', 'library-1']));
      req.onsuccess = () => { db.close(); resolve(req.result?.value as Record<string, string[]> | undefined); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

async function replaceLegacyTags(page: Page, assetId: string, tags: string[]): Promise<void> {
  await page.evaluate(({ assetId: id, tags: values }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      const store = tx.objectStore('tags');
      const key = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const req = store.get(key);
      req.onsuccess = () => {
        if (!req.result) { db.close(); reject(new Error('legacy tag record is missing')); return; }
        const stored = req.result.value as Record<string, string[]>;
        store.put({ ...req.result, value: { ...stored, [id]: values } });
      };
      req.onerror = () => { db.close(); reject(req.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { assetId, tags });
}

async function readLegacyImportMarker(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => new Promise<string[] | undefined>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const metadataKey = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const markerKey = JSON.stringify([metadataKey, 'asset-1']);
      const req = db.transaction('tag-imports').objectStore('tag-imports').get(markerKey);
      req.onsuccess = () => { db.close(); resolve(req.result?.value?.importedTags as string[] | undefined); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

async function appendLegacyTag(page: Page, assetId: string, tag: string): Promise<void> {
  await page.evaluate(({ assetId: id, tag: value }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('photomesh-gallery-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('tags', 'readwrite');
      const store = tx.objectStore('tags');
      const key = JSON.stringify(['http://127.0.0.1:8443', 'library-1']);
      const req = store.get(key);
      req.onsuccess = () => {
        if (!req.result) { db.close(); reject(new Error('legacy tag record is missing')); return; }
        const stored = req.result.value as Record<string, string[]>;
        store.put({ ...req.result, value: { ...stored, [id]: [...(stored[id] ?? []), value] } });
      };
      req.onerror = () => { db.close(); reject(req.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { assetId, tag });
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

test('merges legacy browser tags into Node storage and reloads server-authoritative tags', async ({ page }, testInfo) => {
  const serverTags = ['already-on-node'];
  const tagWrites: string[] = [];
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'tagged-photo.jpg', capturedAt: '2026-10-27T00:00:00.000Z',
    sourcePath: null, sourceKind: 'managed', byteSize: 128, version: 'v1', tags: [...serverTags]
  };
  await seedLegacyTags(page, { 'asset-1': ['legacy-tag', 'already-on-node'] });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    expect(route.request().method()).toBe('PUT');
    const encodedTag = new URL(route.request().url()).pathname.split('/').pop()!;
    const tag = decodeURIComponent(encodedTag);
    tagWrites.push(tag);
    if (!serverTags.includes(tag)) serverTags.push(tag);
    await route.fulfill({ status: 204 });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [{ ...asset, tags: [...serverTags] }] });
  await expect.poll(() => serverTags.includes('legacy-tag')).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Legacy tags for these assets were saved to the node' })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('already-on-node', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('legacy-tag', { exact: true })).toBeVisible();
  expect(tagWrites).toEqual(['already-on-node', 'legacy-tag']);
  await page.screenshot({ path: testInfo.outputPath('pm043-web-tag-editor.png') });

  await page.getByRole('article').filter({ hasText: 'tagged-photo.jpg' }).getByRole('button', { name: 'Add a tag or create a virtual album' }).click();
  await page.getByLabel('Tag name').fill('new-server-tag');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect.poll(() => serverTags.includes('new-server-tag')).toBe(true);
  await expect(page.locator('.tag-list').getByText('new-server-tag', { exact: true })).toBeVisible();
  await appendLegacyTag(page, 'asset-1', 'late-local-tag');

  await page.reload();
  await page.getByLabel('Node address').fill('http://127.0.0.1:8443');
  await page.getByLabel('Admin access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('legacy-tag', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('new-server-tag', { exact: true })).toBeVisible();
  await expect(page.locator('.tag-list').getByText('late-local-tag', { exact: true })).toBeVisible();
  expect(await readLegacyTags(page)).toEqual({ 'asset-1': ['legacy-tag', 'already-on-node', 'late-local-tag'] });
  expect(tagWrites).toEqual(['already-on-node', 'legacy-tag', 'new-server-tag', 'late-local-tag']);
});

test('merges marker updates from simultaneous legacy imports in two tabs', async ({ page, context }) => {
  const serverTags: string[] = [];
  const tagWrites: string[] = [];
  const started = new Set<string>();
  const release = new Map<string, () => void>();
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'shared-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1'
  };
  const handleTagWrite = async (route: Route): Promise<void> => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    const tag = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    tagWrites.push(tag);
    if (tag.startsWith('parallel-')) {
      started.add(tag);
      await new Promise<void>((resolve) => release.set(tag, resolve));
    }
    if (!serverTags.includes(tag)) serverTags.push(tag);
    await route.fulfill({ status: 204 });
  };
  const fixtureAssets = () => [{ ...asset, tags: [...serverTags] }];
  await seedLegacyTags(page, { 'asset-1': ['seed'] });
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', handleTagWrite);
  await setUpNode(page, { capabilities: ['assetTags'], assets: fixtureAssets });
  await expect.poll(() => serverTags.includes('seed')).toBe(true);

  const secondTab = await context.newPage();
  await secondTab.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await secondTab.route('**/v1/libraries/library-1/assets/asset-1/tags/**', handleTagWrite);
  await setUpNode(secondTab, { capabilities: ['assetTags'], assets: fixtureAssets });
  await expect(secondTab.getByRole('status').filter({ hasText: 'Legacy tags for these assets were saved to the node' })).toBeVisible();

  await appendLegacyTag(page, 'asset-1', 'parallel-a');
  await page.reload();
  await reconnectNode(page);
  await expect.poll(() => started.has('parallel-a')).toBe(true);

  await replaceLegacyTags(secondTab, 'asset-1', ['seed', 'parallel-b']);
  await secondTab.reload();
  await reconnectNode(secondTab);
  await expect.poll(() => started.has('parallel-b')).toBe(true);

  release.get('parallel-a')?.();
  release.get('parallel-b')?.();
  await expect.poll(() => serverTags.includes('parallel-a') && serverTags.includes('parallel-b')).toBe(true);
  await expect.poll(async () => await readLegacyImportMarker(page)).toEqual(['parallel-a', 'parallel-b', 'seed']);
  expect(tagWrites).toEqual(['seed', 'parallel-a', 'parallel-b']);
  await secondTab.close();
});

test('keeps the tag editor open and reports failure when Node rejects an edit', async ({ page }) => {
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'tagged-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  };
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/network-failure')) return route.abort('failed');
    await route.fulfill({ status: 400, json: { error: 'invalid_request' } });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [asset] });
  await page.getByRole('article').getByRole('button', { name: 'Add a tag or create a virtual album' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a tag or create a virtual album' });
  await page.getByLabel('Tag name').fill('over-limit');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'The node rejected this tag' })).toBeVisible();
  await expect(page.getByLabel('Tag name')).toHaveValue('over-limit');
  await expect(page.locator('.tag-list').getByText('over-limit', { exact: true })).toHaveCount(0);

  await page.getByLabel('Tag name').fill('network-failure');
  await page.getByRole('button', { name: 'Save tag' }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not connect to this node' })).toBeVisible();
  await expect(page.getByLabel('Tag name')).toHaveValue('network-failure');
  await expect(page.locator('.tag-list').getByText('network-failure', { exact: true })).toHaveCount(0);
});

test('retains legacy tags that exceed server limits instead of silently dropping them', async ({ page }) => {
  const oversizedTag = '界'.repeat(43);
  const legacy = { 'asset-1': [oversizedTag] };
  const asset = {
    assetId: 'asset-1', libraryId: 'library-1', originNodeId: 'node-1', kind: 'photo', sha256: 'a'.repeat(64),
    availability: 'online', filename: 'legacy-photo.jpg', capturedAt: null, sourcePath: null,
    sourceKind: 'managed', byteSize: 128, version: 'v1', tags: []
  };
  let putCount = 0;
  await seedLegacyTags(page, legacy);
  await page.route('**/v1/pairing/peers', (route) => route.fulfill({ status: 200, json: { peers: [], pending: [] } }));
  await page.route('**/v1/libraries/library-1/assets/asset-1/tags/**', async (route) => {
    putCount += 1;
    await route.fulfill({ status: 204 });
  });
  await setUpNode(page, { capabilities: ['assetTags'], assets: () => [asset] });
  await expect(page.getByRole('alert').filter({ hasText: 'legacy asset tag group(s) could not be saved' })).toBeVisible();
  await expect(page.locator('.tag-list').getByText(oversizedTag, { exact: true })).toBeVisible();
  expect(await readLegacyTags(page)).toEqual(legacy);
  expect(putCount).toBe(0);
});
