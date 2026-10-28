import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository, verifySqliteIntegrity, RepositoryConflictError } from './db/repository.js';
import { createNodeAgentServer } from './server.js';
import { createShutdownHandler } from './lifecycle.js';
import { NodeUploadFileSystem } from './uploads/file-system.js';
import { UploadService } from './uploads/service.js';
import { ExternalScanService, type AuthorizedExternalRoot } from './media/external-scan.js';
import { NodeExternalFileSystem, NodeExternalWatcher } from './media/node-external-adapters.js';
import { FixtureFileSecretStore, SystemSecretStore } from './auth/key-store.js';
import { loadOrCreateLocalIdentity } from './auth/local-identity.js';
import type { DiagnosticCapability } from './health.js';
import { PairingService } from './auth/pairing-service.js';
import { PairingApprovalQueue } from './auth/pairing-approval-queue.js';
import { LanPairingNode } from './auth/lan-node.js';
import type { PairingServerControl } from './server.js';
import type { MediaVersionService } from './media/media-version-service.js';
import type { MediaThumbnailService } from './media/thumbnail-service.js';
import type { MediaVersionSourceRecord } from './db/repository.js';
import { createAdminTokenAuthorizer } from './auth/admin-token.js';
import { isIP } from 'node:net';
import { SyncRepository } from './sync/sync-repository.js';
import { SyncService } from './sync/sync-service.js';
import { TagSyncRepository } from './sync/tag-sync-repository.js';
import { TagSyncService } from './sync/tag-sync-service.js';
import { AlbumSyncRepository } from './sync/album-sync-repository.js';
import { AlbumSyncService } from './sync/album-sync-service.js';
import { FavoriteSyncRepository } from './sync/favorite-sync-repository.js';
import { FavoriteSyncService } from './sync/favorite-sync-service.js';
import { TombstoneRestoreCoordinator } from './sync/restore-coordinator.js';
import { restoreTombstoneOperation } from './sync/restore-operation.js';

const port = Number(process.env.PORT ?? 8443);
const dataDirectory = resolve(process.env.PHOTOMESH_DATA_DIR ?? './data');
await mkdir(dataDirectory, { recursive: true });
const databasePath = join(dataDirectory, 'photomesh.sqlite');
const database = new Database(databasePath);
try {
  verifySqliteIntegrity(database);
} catch {
  try { database.close(); } catch { /* The database may be too damaged to close cleanly. */ }
  throw new Error('database integrity check failed');
}
const repository = new SqliteRepository(database, {
  backupBeforeMigration: async () => {
    await database.backup(`${databasePath}.backup-${new Date().toISOString().replaceAll(':', '-')}`);
  }
});
await repository.migrate();
repository.recoverInterruptedJobs(new Date().toISOString());
const pairingApprovals = new PairingApprovalQueue();
let pairing: PairingService | undefined;
let lanNode: LanPairingNode | undefined;
let syncService: SyncService | undefined;
let tagSyncRepository: TagSyncRepository | undefined;
let tagSyncService: TagSyncService | undefined;
let albumSyncRepository: AlbumSyncRepository | undefined;
let albumSyncService: AlbumSyncService | undefined;
let favoriteSyncRepository: FavoriteSyncRepository | undefined;
let favoriteSyncService: FavoriteSyncService | undefined;
let nodeId = process.env.PHOTOMESH_NODE_ID ?? 'local-node';
let albumPeerId: string | undefined;
try {
  const fixtureMode = process.env.PHOTOMESH_FIXTURE_MODE === 'true';
  const secretStore = fixtureMode && process.env.PHOTOMESH_FIXTURE_SECRET_DIR
    ? new FixtureFileSecretStore(process.env.PHOTOMESH_FIXTURE_SECRET_DIR)
    : new SystemSecretStore();
  const identity = await loadOrCreateLocalIdentity(repository, secretStore);
  nodeId = identity.peerId;
  albumPeerId = identity.peerId;
  pairing = new PairingService(repository, identity.peerId, pairingApprovals.request);
  tagSyncRepository = new TagSyncRepository(database);
  albumSyncRepository = new AlbumSyncRepository(database);
  favoriteSyncRepository = new FavoriteSyncRepository(database);
  syncService = new SyncService(new SyncRepository(database), identity, pairing, undefined, (event) => {
    const payload = event.payload;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        ['asset.indexed', 'asset.tombstoned', 'asset.restored'].includes(event.eventType) &&
        typeof payload.assetId === 'string') {
      tagSyncRepository!.rebuildAssetTagProjection(event.libraryId, payload.assetId);
      albumSyncRepository!.rebuildMembershipsForAsset(event.libraryId, payload.assetId);
      favoriteSyncRepository!.rebuildFavoriteProjectionForAsset(event.libraryId, payload.assetId);
    }
    tagSyncRepository!.reconcilePendingEvents(event.libraryId);
    albumSyncRepository!.reconcilePendingEvents(event.libraryId);
    favoriteSyncRepository!.reconcilePendingEvents(event.libraryId);
  }, true, Boolean(albumPeerId), Boolean(albumPeerId));
  tagSyncService = new TagSyncService(tagSyncRepository, identity, pairing, () => syncService!.hello());
  albumSyncService = new AlbumSyncService(albumSyncRepository, identity, pairing, () => syncService!.hello());
  favoriteSyncService = new FavoriteSyncService(favoriteSyncRepository, identity, pairing, () => syncService!.hello());
  repository.setAlbumOperationEventDrafter((input) => { albumSyncService!.reserveLocalOperation(input); });
  repository.setAlbumLifecycleEventDrafter((input) => { albumSyncService!.reserveLocalLifecycleOperation(input); });
  await syncService.signPendingLocalEvents();
  await syncService.reconcileLocalAssets();
  await tagSyncService.reconcileLegacyTagSeeds();
  albumSyncService.reconcileLegacyOperations();
  await albumSyncService.signPendingLocalEvents();
  favoriteSyncService.reconcilePendingEvents();
  await favoriteSyncService.signPendingLocalEvents();
  const listenAddresses = (process.env.PHOTOMESH_LAN_BIND_ADDRESSES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (listenAddresses.length > 0) {
    lanNode = await LanPairingNode.start({
      identity, pairing, listenAddresses, syncService, tagSyncService, albumSyncService, favoriteSyncService,
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
const openOriginalMedia = async (media: Pick<MediaVersionSourceRecord, 'storageRef' | 'originalPath'>, signal?: AbortSignal) => {
  if (media.storageRef.startsWith('objects/')) {
    return signal ? managedFileSystem.openReadStream(media.storageRef, { signal }) : managedFileSystem.openReadStream(media.storageRef);
  }
  if (media.storageRef.startsWith('external:') && media.originalPath) {
    const authorizedPath = await externalScan?.resolveAuthorizedReadPath(media.originalPath);
    if (!authorizedPath || signal?.aborted) return undefined;
    return signal ? externalFileSystem.openReadStream(authorizedPath, { signal }) : externalFileSystem.openReadStream(authorizedPath);
  }
  return undefined;
};
let mediaVersionService: MediaVersionService | undefined;
let mediaThumbnailService: MediaThumbnailService | undefined;
try {
  const [{ MediaVersionService }, { MediaThumbnailService }, { SharpMediaImageTransformer }] = await Promise.all([
    import('./media/media-version-service.js'), import('./media/thumbnail-service.js'), import('./media/image-transformer.js')
  ]);
  const transformer = new SharpMediaImageTransformer();
  mediaVersionService = new MediaVersionService({
    repository, fileSystem: managedFileSystem, transformer, openOriginal: openOriginalMedia
  });
  mediaThumbnailService = new MediaThumbnailService({
    getSource: (libraryId, assetId) => repository.getMediaVersionSource(libraryId, assetId, null),
    openOriginal: openOriginalMedia,
    transformer
  });
} catch {
  process.stderr.write('PhotoMesh media processing unavailable; CPU image processing could not be loaded\n');
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

const pairingControl: PairingServerControl | undefined = pairing && tagSyncRepository && albumSyncRepository && favoriteSyncRepository ? {
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
  grantTagWrite: (peerId, libraryId) => tagSyncRepository!.grantTagWriter(libraryId, peerId, nodeId, new Date().toISOString()),
  revokeTagWrite: (peerId, libraryId) => tagSyncRepository!.revokeTagWriter(libraryId, peerId, new Date().toISOString()),
  listTagWriters: (libraryId) => tagSyncRepository!.listTagWriters(libraryId),
  getTagSyncStatus: (peerId) => tagSyncRepository!.getPeerSyncStatus(peerId),
  grantAlbumWrite: (peerId, libraryId, grantedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId)) return undefined;
    if (!pairing!.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) throw new RepositoryConflictError('peer is not trusted');
    albumSyncRepository!.setAlbumWriteGrant(libraryId, peerId, grantedAt);
    return { peerId, libraryId, permission: 'album-write' as const, granted: true };
  },
  revokeAlbumWrite: (peerId, libraryId, revokedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId) || !pairing!.listPeers().some((peer) => peer.peerId === peerId)) return undefined;
    albumSyncRepository!.revokeAlbumWriteGrant(libraryId, peerId, revokedAt);
    return { peerId, libraryId, permission: 'album-write' as const, granted: false };
  },
  grantAlbumDelete: (peerId, libraryId, grantedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId)) return undefined;
    if (!pairing!.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) throw new RepositoryConflictError('peer is not trusted');
    albumSyncRepository!.setAlbumDeleteGrant(libraryId, peerId, grantedAt);
    return { peerId, libraryId, permission: 'album-delete' as const, granted: true };
  },
  revokeAlbumDelete: (peerId, libraryId, revokedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId) || !pairing!.listPeers().some((peer) => peer.peerId === peerId)) return undefined;
    albumSyncRepository!.revokeAlbumDeleteGrant(libraryId, peerId, revokedAt);
    return { peerId, libraryId, permission: 'album-delete' as const, granted: false };
  },
  listAlbumSyncGrants: (libraryId) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId)) return undefined;
    const grants = albumSyncRepository!.listAlbumSyncGrants(libraryId).flatMap((grant) => [
      ...(grant.writeGranted ? [{ peerId: grant.peerId, libraryId, permission: 'album-write' as const, granted: true }] : []),
      ...(grant.deleteGranted ? [{ peerId: grant.peerId, libraryId, permission: 'album-delete' as const, granted: true }] : [])
    ]);
    return { grants };
  },
  getAlbumSyncStatus: (peerId) => {
    if (!pairing!.listPeers().some((peer) => peer.peerId === peerId)) return undefined;
    const status = albumSyncRepository!.getPeerSyncStatus(peerId);
    const lastErrorCode = status.lastError === null ? null : /denied|unauthori[sz]ed|write/i.test(status.lastError)
      ? 'unauthorized' as const : /conflict|invalid|sequence/i.test(status.lastError) ? 'conflict' as const : 'unavailable' as const;
    return { peerId, pendingEvents: status.pending, lastErrorCode };
  },
  grantFavoriteWrite: (peerId, libraryId, grantedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId)) return undefined;
    if (!pairing!.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) throw new RepositoryConflictError('peer is not trusted');
    favoriteSyncRepository!.grantFavoriteWriter(libraryId, peerId, nodeId, grantedAt);
    return { peerId, libraryId, permission: 'favorite-write' as const, granted: true };
  },
  revokeFavoriteWrite: (peerId, libraryId, revokedAt) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId) || !pairing!.listPeers().some((peer) => peer.peerId === peerId)) return undefined;
    favoriteSyncRepository!.revokeFavoriteWriter(libraryId, peerId, revokedAt);
    return { peerId, libraryId, permission: 'favorite-write' as const, granted: false };
  },
  listFavoriteSyncGrants: (libraryId) => {
    if (!repository.listGalleryLibraries().some((library) => library.libraryId === libraryId)) return undefined;
    return { grants: favoriteSyncRepository!.listFavoriteWriters(libraryId).map((peerId) => ({
      peerId, libraryId, permission: 'favorite-write' as const, granted: true
    })) };
  },
  getFavoriteSyncStatus: (peerId) => {
    if (!pairing!.listPeers().some((peer) => peer.peerId === peerId)) return undefined;
    return favoriteSyncRepository!.getPeerSyncStatus(peerId);
  },
  readLibraryIndex: (peerId, libraryId) => pairing!.readLibraryIndex(peerId, libraryId),
  listDiscoveredPeers: () => lanNode?.listDiscoveredPeers() ?? [],
  dialManualIp: async (host, port, peerId) => {
    if (!lanNode) throw new Error('LAN pairing is not listening on a configured private interface');
    return lanNode.dialManualIp(host, port, peerId);
  }
} : undefined;

const restoreCoordinator = new TombstoneRestoreCoordinator();
const authorizePairingAdmin = createAdminTokenAuthorizer(process.env.PHOTOMESH_ADMIN_TOKEN);
repository.markExternalLocationsOffline(nodeId);
const host = process.env.PHOTOMESH_API_BIND_ADDRESS ?? '127.0.0.1';
if (!isSafeServiceBind(host)) throw new Error('PHOTOMESH_API_BIND_ADDRESS must be loopback or an explicit private LAN IP');
const server = createNodeAgentServer({
  uploadService, authorizePairingAdmin,
  diagnostics: {
    checkDatabase: () => { database.prepare('SELECT 1').get(); },
    checkStorage: async () => { await access(dataDirectory, fsConstants.R_OK | fsConstants.W_OK); },
    apiCapabilities: (): DiagnosticCapability[] => [
      'rest',
      ...(mediaVersionService ? ['mediaVersions' as const] : []),
      ...(mediaThumbnailService ? ['thumbnails' as const] : []),
      ...(albumPeerId ? ['virtualAlbums' as const] : []),
      ...(tagSyncService ? ['assetTags' as const] : []),
      ...(favoriteSyncService ? ['assetFavorites' as const] : [])
    ],
    storageCapabilities: (): DiagnosticCapability[] => ['managedFiles'],
    identityCapabilities: (): DiagnosticCapability[] => [
      ...(pairing ? ['nodeIdentity' as const] : []),
      ...(syncService ? ['eventSigning' as const] : []),
      ...(tagSyncService ? ['tagSync' as const] : []),
      ...(favoriteSyncService ? ['favoriteSync' as const] : []),
      ...(lanNode ? ['lanPairing' as const] : [])
    ]
  },
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
  ...(albumPeerId ? { albums: {
    listAlbums: (libraryId: string, cursor: string | undefined, limit: number) => repository.listAlbums(libraryId, cursor, limit),
    createAlbum: async (input) => {
      const result = repository.createAlbum({ ...input, authorPeerId: albumPeerId! });
      await albumSyncService!.signPendingLocalEvents();
      return result;
    },
    listMembers: (libraryId: string, albumId: string, cursor: string | undefined, limit: number) =>
      repository.listAlbumMembers(libraryId, albumId, cursor, limit),
    deleteAlbum: async (input) => {
      const result = repository.deleteAlbum({ ...input, authorPeerId: albumPeerId! });
      await albumSyncService!.signPendingLocalEvents();
      return result;
    },
    listDeletedAlbums: (libraryId, scope, cursor, limit) => repository.listDeletedAlbums(libraryId, scope, cursor, limit),
    restoreAlbum: async (input) => {
      const result = repository.restoreAlbum({ ...input, authorPeerId: albumPeerId! });
      await albumSyncService!.signPendingLocalEvents();
      return result;
    },
    addMember: async (input) => {
      const result = repository.addAlbumMember({ ...input, authorPeerId: albumPeerId! });
      await albumSyncService!.signPendingLocalEvents();
      return result;
    },
    removeMember: async (input) => {
      const result = repository.removeAlbumMember({ ...input, authorPeerId: albumPeerId! });
      await albumSyncService!.signPendingLocalEvents();
      return result;
    }
  } } : {}),
  tagSync: Boolean(tagSyncService),
  ...(tagSyncService ? { assetTags: {
    addAssetTag: (libraryId: string, assetId: string, tag: string, createdAt: string) =>
      tagSyncService!.addAssetTag(libraryId, assetId, tag, createdAt),
    removeAssetTag: (libraryId: string, assetId: string, tag: string) => tagSyncService!.removeAssetTag(libraryId, assetId, tag)
  } } : {}),
  ...(favoriteSyncService ? { assetFavorites: {
    setAssetFavorite: (input: import('./server.js').AssetFavoriteMutationRequest) => favoriteSyncService!.setAssetFavorite(input)
  } } : {}),
  ...(mediaVersionService ? { mediaVersions: mediaVersionService } : {}),
  ...(mediaThumbnailService ? { thumbnails: {
    readThumbnail: (libraryId: string, assetId: string, profile: string) =>
      mediaThumbnailService!.getThumbnail(libraryId, assetId, profile)
  } } : {}),
  ...(pairingControl ? { pairingControl } : {})
});
server.listen(port, host, () => process.stdout.write(`PhotoMesh node-agent listening on ${host}:${port}\n`));
void uploadService.resumePending().catch(() => process.stderr.write('Upload recovery could not be completed; pending uploads remain resumable\n'));
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

const shutdownAgent = createShutdownHandler({
  server,
  ...(externalScan ? { externalScan } : {}),
  ...(lanNode ? { lanNode } : {}),
  ...(mediaVersionService ? { mediaVersionService } : {}),
  uploadService,
  closeDatabase: () => database.close()
});
const shutdown = (): void => {
  void shutdownAgent().catch(() => process.stderr.write('PhotoMesh shutdown encountered a resource cleanup failure\n'));
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
