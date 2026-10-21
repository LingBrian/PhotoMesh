import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository } from './db/repository.js';
import { createNodeAgentServer } from './server.js';
import { NodeUploadFileSystem } from './uploads/file-system.js';
import { UploadService } from './uploads/service.js';
import { ExternalScanService, type AuthorizedExternalRoot } from './media/external-scan.js';
import { NodeExternalFileSystem, NodeExternalWatcher } from './media/node-external-adapters.js';
import { SystemSecretStore } from './auth/key-store.js';
import { loadOrCreateLocalIdentity } from './auth/local-identity.js';
import { PairingService } from './auth/pairing-service.js';
import { PairingApprovalQueue } from './auth/pairing-approval-queue.js';
import { LanPairingNode } from './auth/lan-node.js';
import type { PairingServerControl } from './server.js';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT ?? 8443);
const dataDirectory = resolve(process.env.PHOTOMESH_DATA_DIR ?? './data');
await mkdir(dataDirectory, { recursive: true });
const databasePath = join(dataDirectory, 'photomesh.sqlite');
const database = new Database(databasePath);
const repository = new SqliteRepository(database, {
  backupBeforeMigration: async () => {
    await database.backup(`${databasePath}.backup-${new Date().toISOString().replaceAll(':', '-')}`);
  }
});
await repository.migrate();
const uploadService = new UploadService({
  repository,
  fileSystem: new NodeUploadFileSystem(join(dataDirectory, 'managed')),
  nodeId: process.env.PHOTOMESH_NODE_ID ?? 'local-node'
});
const pairingApprovals = new PairingApprovalQueue();
let pairing: PairingService | undefined;
let lanNode: LanPairingNode | undefined;
try {
  const identity = await loadOrCreateLocalIdentity(repository, new SystemSecretStore());
  pairing = new PairingService(repository, identity.peerId, pairingApprovals.request);
  const listenAddresses = (process.env.PHOTOMESH_LAN_BIND_ADDRESSES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (listenAddresses.length > 0) {
    lanNode = await LanPairingNode.start({
      identity, pairing, listenAddresses,
      listenPort: Number(process.env.PHOTOMESH_P2P_PORT ?? 0)
    });
    process.stdout.write(`PhotoMesh LAN pairing enabled on ${listenAddresses.length} configured interface(s)\n`);
  }
} catch {
  // Do not expose native key-store or identity errors, which may include platform details.
  process.stderr.write('PhotoMesh LAN pairing unavailable; secure identity storage or bind configuration is unavailable\n');
}

const pairingControl: PairingServerControl | undefined = pairing ? {
  createInvite: () => {
    if (!lanNode) throw new Error('LAN pairing is not listening on a configured private interface');
    return lanNode.createInvite();
  },
  pairWithInvite: async (invite, label, manualIp) => {
    if (!lanNode) throw new Error('LAN pairing is not listening on a configured private interface');
    return lanNode.pairWithInvite(invite, label, manualIp);
  },
  listPeers: () => pairing!.listPeers(),
  listPending: () => pairingApprovals.list(),
  decide: (peerId, approval) => pairingApprovals.decide(peerId, approval),
  revokePeer: async (peerId) => lanNode ? lanNode.revokePeer(peerId) : pairing!.revokePeer(peerId),
  grantLibraryRead: (peerId, libraryId) => pairing!.grantLibraryRead(peerId, libraryId),
  readLibraryIndex: (peerId, libraryId) => pairing!.readLibraryIndex(peerId, libraryId),
  listDiscoveredPeers: () => lanNode?.listDiscoveredPeers() ?? [],
  dialManualIp: async (host, port, peerId) => {
    if (!lanNode) throw new Error('LAN pairing is not listening on a configured private interface');
    return lanNode.dialManualIp(host, port, peerId);
  }
} : undefined;

const configuredAdminToken = process.env.PHOTOMESH_ADMIN_TOKEN;
const authorizePairingAdmin = (token: string | undefined): boolean => {
  if (!configuredAdminToken || !token) return false;
  const expected = Buffer.from(configuredAdminToken);
  const provided = Buffer.from(token);
  return expected.byteLength === provided.byteLength && timingSafeEqual(expected, provided);
};
const server = createNodeAgentServer({ uploadService, authorizePairingAdmin, ...(pairingControl ? { pairingControl } : {}) });
server.listen(port, '127.0.0.1', () => process.stdout.write(`PhotoMesh node-agent listening on 127.0.0.1:${port}\n`));

const rootsJson = process.env.PHOTOMESH_EXTERNAL_ROOTS;
let externalScan: ExternalScanService | undefined;
if (rootsJson) {
  const roots = JSON.parse(rootsJson) as AuthorizedExternalRoot[];
  if (!Array.isArray(roots) || roots.some((root) => !root || typeof root.rootId !== 'string' || typeof root.libraryId !== 'string' ||
    typeof root.path !== 'string' || !['posix', 'win32'].includes(root.pathStyle))) {
    throw new Error('PHOTOMESH_EXTERNAL_ROOTS must be an array of explicitly authorized root objects');
  }
  externalScan = new ExternalScanService({
    nodeId: process.env.PHOTOMESH_NODE_ID ?? 'local-node', roots,
    fileSystem: new NodeExternalFileSystem(), repository, watcher: new NodeExternalWatcher()
  });
  void externalScan.start().then((results) => {
    const indexed = results.reduce((total, result) => total + result.indexed, 0);
    process.stdout.write(`External directory scan initialized (${results.length} roots, ${indexed} indexed paths)\n`);
  }).catch(() => process.stderr.write('External directory scan initialization failed; configured roots remain read-only\n'));
}

const shutdown = (): void => {
  externalScan?.stop();
  void lanNode?.stop();
  server.close(() => database.close());
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
