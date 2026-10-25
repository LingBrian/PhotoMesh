import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository } from './db/repository.js';
import { createNodeAgentServer } from './server.js';
import { NodeUploadFileSystem } from './uploads/file-system.js';
import { UploadService } from './uploads/service.js';
import { ExternalScanService, type AuthorizedExternalRoot } from './media/external-scan.js';
import { NodeExternalFileSystem, NodeExternalWatcher } from './media/node-external-adapters.js';
import { FixtureFileSecretStore, SystemSecretStore } from './auth/key-store.js';
import { loadOrCreateLocalIdentity } from './auth/local-identity.js';
import { PairingService } from './auth/pairing-service.js';
import { PairingApprovalQueue } from './auth/pairing-approval-queue.js';
import { LanPairingNode } from './auth/lan-node.js';
import type { PairingServerControl } from './server.js';
import type { MediaVersionService } from './media/media-version-service.js';
import type { MediaVersionSourceRecord } from './db/repository.js';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { SyncRepository } from './sync/sync-repository.js';
import { SyncService } from './sync/sync-service.js';
import { TombstoneRestoreCoordinator } from './sync/restore-coordinator.js';
import { restoreTombstoneOperation } from './sync/restore-operation.js';

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
const pairingApprovals = new PairingApprovalQueue();
let pairing: PairingService | undefined;
let lanNode: LanPairingNode | undefined;
let syncService: SyncService | undefined;
let nodeId = process.env.PHOTOMESH_NODE_ID ?? 'local-node';
try {
  const fixtureMode = process.env.PHOTOMESH_FIXTURE_MODE === 'true';
  const secretStore = fixtureMode && process.env.PHOTOMESH_FIXTURE_SECRET_DIR
    ? new FixtureFileSecretStore(process.env.PHOTOMESH_FIXTURE_SECRET_DIR)
    : new SystemSecretStore();
  const identity = await loadOrCreateLocalIdentity(repository, secretStore);
  nodeId = identity.peerId;
  pairing = new PairingService(repository, identity.peerId, pairingApprovals.request);
  syncService = new SyncService(new SyncRepository(database), identity, pairing);
  await syncService.signPendingLocalEvents();
  await syncService.reconcileLocalAssets();
  const listenAddresses = (process.env.PHOTOMESH_LAN_BIND_ADDRESSES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (listenAddresses.length > 0) {
    lanNode = await LanPairingNode.start({
      identity, pairing, listenAddresses, syncService,
      listenPort: Number(process.env.PHOTOMESH_P2P_PORT ?? 0)
    });
    process.stdout.write(`PhotoMesh LAN pairing enabled on ${listenAddresses.length} configured interface(s)\n`);
  }
} catch {
  // Do not expose native key-store or identity errors, which may include platform details.
  process.stderr.write('PhotoMesh LAN pairing unavailable; secure identity storage or bind configuration is unavailable\n');
}
const managedFileSystem = new NodeUploadFileSystem(join(dataDirectory, 'managed'));
const externalFileSystem = new NodeExternalFileSystem();
let externalScan: ExternalScanService | undefined;
const openOriginalMedia = async (media: Pick<MediaVersionSourceRecord, 'storageRef' | 'originalPath'>) => {
  if (media.storageRef.startsWith('objects/')) return managedFileSystem.openReadStream(media.storageRef);
  if (media.storageRef.startsWith('external:') && media.originalPath) {
    const authorizedPath = await externalScan?.resolveAuthorizedReadPath(media.originalPath);
    return authorizedPath ? externalFileSystem.openReadStream(authorizedPath) : undefined;
  }
  return undefined;
};
let mediaVersionService: MediaVersionService | undefined;
try {
  const [{ MediaVersionService }, { SharpMediaImageTransformer }] = await Promise.all([
    import('./media/media-version-service.js'), import('./media/image-transformer.js')
  ]);
  mediaVersionService = new MediaVersionService({
    repository, fileSystem: managedFileSystem, transformer: new SharpMediaImageTransformer(), openOriginal: openOriginalMedia
  });
} catch {
  process.stderr.write('PhotoMesh media versioning unavailable; CPU image processing could not be loaded\n');
}
const uploadService = new UploadService({
  repository,
  fileSystem: managedFileSystem,
  nodeId,
  ...(syncService ? {
    createEventDraft: (session: import('./db/repository.js').UploadSessionRecord, assetId: string) => syncService!.createAssetIndexedDraft({
      libraryId: session.libraryId, assetId, originNodeId: nodeId,
      kind: session.kind, sha256: session.expectedSha256, byteLength: session.totalBytes
    }),
    signPendingEvents: () => syncService!.signPendingLocalEvents()
  } : {})
});

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

const restoreCoordinator = new TombstoneRestoreCoordinator();
const configuredAdminToken = process.env.PHOTOMESH_ADMIN_TOKEN;
repository.markExternalLocationsOffline(nodeId);
const authorizePairingAdmin = (token: string | undefined): boolean => {
  if (!configuredAdminToken || !token) return false;
  const expected = Buffer.from(configuredAdminToken);
  const provided = Buffer.from(token);
  return expected.byteLength === provided.byteLength && timingSafeEqual(expected, provided);
};
const host = process.env.PHOTOMESH_API_BIND_ADDRESS ?? '127.0.0.1';
if (!isSafeServiceBind(host)) throw new Error('PHOTOMESH_API_BIND_ADDRESS must be loopback or an explicit private LAN IP');
const server = createNodeAgentServer({
  uploadService, authorizePairingAdmin,
  allowedWebOrigins: (process.env.PHOTOMESH_WEB_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  authorizeUpload: (request) => authorizePairingAdmin(request.token) ? { principalId: 'local-admin' } : undefined,
  authorizeLibraryList: (token) => authorizePairingAdmin(token),
  authorizeLibraryRead: (token) => authorizePairingAdmin(token) ? 'local-admin' : undefined,
  gallery: {
    listLibraries: () => repository.listGalleryLibraries(),
    listAssets: (libraryId, cursor, limit, query) => repository.listGalleryAssets(libraryId, cursor, limit, query),
    getOriginal: async (assetId) => repository.getGalleryMedia(assetId),
    openOriginal: openOriginalMedia,
    listTombstones: (libraryId) => repository.listActiveTombstones(libraryId),
    restoreTombstone: (libraryId, eventId) => restoreCoordinator.run(libraryId, eventId,
      () => restoreTombstoneOperation(libraryId, eventId, syncService, (id) => repository.listActiveTombstones(id)))
  },
  ...(mediaVersionService ? { mediaVersions: mediaVersionService } : {}),
  ...(pairingControl ? { pairingControl } : {})
});
server.listen(port, host, () => process.stdout.write(`PhotoMesh node-agent listening on ${host}:${port}\n`));
const resumeMediaVersions = (): void => {
  void mediaVersionService?.resumePending().catch(() => process.stderr.write('Media-version recovery could not be completed; pending records remain resumable\n'));
};

const rootsJson = process.env.PHOTOMESH_EXTERNAL_ROOTS;
if (rootsJson) {
  const roots = JSON.parse(rootsJson) as AuthorizedExternalRoot[];
  if (!Array.isArray(roots) || roots.some((root) => !root || typeof root.rootId !== 'string' || typeof root.libraryId !== 'string' ||
    typeof root.path !== 'string' || !['posix', 'win32'].includes(root.pathStyle))) {
    throw new Error('PHOTOMESH_EXTERNAL_ROOTS must be an array of explicitly authorized root objects');
  }
  externalScan = new ExternalScanService({
    nodeId, roots,
    fileSystem: externalFileSystem, repository, watcher: new NodeExternalWatcher(),
    ...(syncService ? {
      createEventDraft: (record) => syncService!.createAssetIndexedDraft({
        libraryId: record.libraryId, assetId: record.assetId, originNodeId: nodeId,
        kind: record.kind, sha256: record.sha256, byteLength: record.byteSize
      }),
      signPendingEvents: () => syncService!.signPendingLocalEvents()
    } : {})
  });
  void externalScan.start().then((results) => {
    const indexed = results.reduce((total, result) => total + result.indexed, 0);
    process.stdout.write(`External directory scan initialized (${results.length} roots, ${indexed} indexed paths)\n`);
  }).catch(() => process.stderr.write('External directory scan initialization failed; configured roots remain read-only\n'))
    .finally(resumeMediaVersions);
} else {
  resumeMediaVersions();
}

const shutdown = (): void => {
  externalScan?.stop();
  void lanNode?.stop();
  server.close(() => {
    if (mediaVersionService) void mediaVersionService.stop().finally(() => database.close());
    else database.close();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function isSafeServiceBind(host: string): boolean {
  const family = isIP(host);
  if (family === 0) return false;
  const normalized = host.toLowerCase().split('%')[0] ?? '';
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  if (family === 4) {
    const octets = normalized.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  return /^(fc|fd)/.test(normalized);
}
