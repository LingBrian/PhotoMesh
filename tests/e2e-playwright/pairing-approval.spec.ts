import { expect, test } from '@playwright/test';
import { PairingApprovalQueue } from '../../apps/node-agent/src/auth/pairing-approval-queue.js';
import { createNodeAgentServer, type PairingServerControl } from '../../apps/node-agent/src/server.js';

const libraries = [{ libraryId: 'family-library', title: 'Family photos' }];
const pending = [
  { peerId: 'peer-no-grant-123456789', publicKey: 'cHVibGljLWtleS1vbmU=', proposedLabel: 'New NAS one' },
  { peerId: 'peer-explicit-grant-123456789', publicKey: 'cHVibGljLWtleS10d28=', proposedLabel: 'New NAS two' },
  { peerId: 'peer-decline-1234567890', publicKey: 'cHVibGljLWtleS10aHJlZQ==', proposedLabel: 'Unrecognized device' },
];
const adminToken = 'pairing-approval-e2e-admin';
const approvals = new PairingApprovalQueue();
const decisions = pending.map(({ peerId, publicKey, proposedLabel }) => approvals.request({ peerId, publicKey, proposedLabel }));
const pairingControl: PairingServerControl = {
  createInvite: () => ({
    protocol: 'photomesh-pairing', version: 1, hostPeerId: 'host-peer-123456', addresses: [],
    inviteId: 'e2e-invite', secret: 'a'.repeat(43), expiresAt: new Date(Date.now() + 120_000).toISOString()
  }),
  pairWithInvite: async () => ({ hostPeerId: 'host-peer-123456' }),
  listPeers: () => [],
  listPending: () => approvals.list(),
  decide: (peerId, approval) => approvals.decide(peerId, approval),
  revokePeer: async () => false,
  grantLibraryRead: () => undefined,
  readLibraryIndex: () => undefined,
  listDiscoveredPeers: () => [],
  dialManualIp: async (host, port, peerId) => ({ peerId, addresses: [`${host}:${port}`] })
};
const api = createNodeAgentServer({
  authorizePairingAdmin: (token) => token === adminToken,
  authorizeLibraryList: (token) => token === adminToken,
  authorizeLibraryRead: (token, libraryId) => token === adminToken && libraryId === 'family-library' ? 'e2e-admin' : undefined,
  gallery: {
    listLibraries: () => libraries,
    listAssets: () => ({ items: [], nextCursor: null }),
    getOriginal: async () => undefined,
    openOriginal: () => undefined,
    listTombstones: () => []
  },
  pairingControl
});
let endpoint = '';

test.beforeAll(async () => {
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral API port');
  endpoint = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
});

test('admin approval reaches the real node API and defaults to no library access', async ({ page }) => {
  const unauthenticated = await fetch(`${endpoint}/v1/pairing/peers`);
  expect(unauthenticated.status).toBe(403);

  await page.goto('/');
  await page.getByLabel('Node address').fill(endpoint);
  await page.getByLabel('Admin access token').fill(adminToken);
  await page.getByRole('button', { name: 'Connect node' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Node settings' }).click();

  await expect(page.getByText('New NAS one')).toBeVisible();
  await expect(page.getByText('peer-no-grant-123456789')).toBeVisible();
  await expect(page.getByText('cHVibGljLWtleS1vbmU=')).toBeVisible();
  await page.getByRole('button', { name: 'Approve device' }).first().click();
  await expect.poll(() => approvals.list().length).toBe(2);
  await expect(decisions[0]).resolves.toEqual({ approved: true, libraryIds: [] });

  const explicitGrantRow = page.locator('.pending-peer-row').filter({ hasText: 'New NAS two' });
  await explicitGrantRow.getByLabel('Family photos').check();
  await explicitGrantRow.getByRole('button', { name: 'Approve device' }).click();
  await expect.poll(() => approvals.list().length).toBe(1);
  await expect(decisions[1]).resolves.toEqual({ approved: true, libraryIds: ['family-library'] });

  const rejectRow = page.locator('.pending-peer-row').filter({ hasText: 'Unrecognized device' });
  await rejectRow.getByRole('button', { name: 'Decline device' }).click();
  await expect.poll(() => approvals.list().length).toBe(0);
  await expect(decisions[2]).resolves.toEqual({ approved: false, libraryIds: [] });
});
