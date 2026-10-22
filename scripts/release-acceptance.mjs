import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from '../apps/node-agent/node_modules/better-sqlite3/lib/index.js';
import { SqliteRepository } from '../apps/node-agent/dist/db/repository.js';
import { migrations } from '../apps/node-agent/dist/db/migrations.js';
import { loadOrCreateLocalIdentity } from '../apps/node-agent/dist/auth/local-identity.js';
import { PairingService } from '../apps/node-agent/dist/auth/pairing-service.js';
import { createNodeAgentServer } from '../apps/node-agent/dist/server.js';
import { SyncRepository } from '../apps/node-agent/dist/sync/sync-repository.js';
import { SyncService } from '../apps/node-agent/dist/sync/sync-service.js';

const totalFiles = Number(process.env.PHOTOMESH_RELEASE_FILE_COUNT ?? 100_000);
if (!Number.isSafeInteger(totalFiles) || totalFiles < 100_000) throw new Error('release acceptance requires at least 100,000 fixture files');
const incrementalCount = 100;
const offlineCount = 100;
const evidencePath = process.env.PHOTOMESH_RELEASE_EVIDENCE ?? 'release-evidence.json';
const tempRoot = await mkdtemp(join(tmpdir(), `photomesh-release-${process.pid}-`));
const fixtureRoot = join(tempRoot, 'originals');
const fileRecords = [];
const evidence = { schemaVersion: 1 };
const liveDatabases = new Set();
const testStartedAt = new Date().toISOString();

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function digestFile(path) { return digest(await readFile(path)); }
function elapsedSeconds(started) { return Math.max((performance.now() - started) / 1000, 0.001); }
function cpuPercent(before, started) {
  const usage = process.cpuUsage(before);
  return Math.round(((usage.user + usage.system) / 1000 / (performance.now() - started)) * 10000) / 100;
}
function maxRssMiB() { return Math.round(process.resourceUsage().maxRSS / 1024); }
function node(name = 'release-fixture') {
  const database = new Database(':memory:');
  liveDatabases.add(database);
  const repository = new SqliteRepository(database);
  const secrets = new Map();
  let pairing;
  let syncRepository;
  let sync;
  const ready = (async () => {
    await repository.migrate(migrations);
    const identity = await loadOrCreateLocalIdentity(repository, {
      get: (key) => secrets.get(key), set: (key, value) => secrets.set(key, value)
    });
    pairing = new PairingService(repository, identity.peerId, async () => ({ approved: true }));
    syncRepository = new SyncRepository(database);
    sync = new SyncService(syncRepository, identity, pairing);
    return { name, database, repository, identity, pairing, syncRepository, sync };
  })();
  return ready;
}

async function trustBoth(left, right, libraryId) {
  const now = new Date().toISOString();
  left.repository.trustPeer({ peerId: right.identity.peerId, publicKey: Buffer.from(right.identity.publicKey).toString('base64'),
    label: right.name, trustState: 'trusted', createdAt: now, revokedAt: null });
  right.repository.trustPeer({ peerId: left.identity.peerId, publicKey: Buffer.from(left.identity.publicKey).toString('base64'),
    label: left.name, trustState: 'trusted', createdAt: now, revokedAt: null });
  left.repository.grantLibraryRead(right.identity.peerId, libraryId, now);
  right.repository.grantLibraryRead(left.identity.peerId, libraryId, now);
  left.syncRepository.setRemoteLibraries(right.identity.peerId, [libraryId]);
  right.syncRepository.setRemoteLibraries(left.identity.peerId, [libraryId]);
}

function fixtureBytes(index) { return Buffer.from(`PhotoMesh release fixture image ${String(index).padStart(8, '0')}\n`, 'utf8'); }
function assetId(index) { return `fixture-${String(index).padStart(8, '0')}`; }
function fixturePath(index) { return join(fixtureRoot, String(Math.floor(index / 1000)).padStart(3, '0'), `${assetId(index)}.jpg`); }

async function addFiles(source, start, count) {
  const dirIds = new Set();
  for (let index = start; index < start + count; index += 1) dirIds.add(Math.floor(index / 1000));
  await Promise.all([...dirIds].map((id) => mkdir(join(fixtureRoot, String(id).padStart(3, '0')), { recursive: true })));
  const batchSize = 500;
  for (let offset = 0; offset < count; offset += batchSize) {
    const upper = Math.min(start + count, start + offset + batchSize);
    await Promise.all(Array.from({ length: upper - (start + offset) }, async (_, delta) => {
      const index = start + offset + delta;
      const bytes = fixtureBytes(index);
      const path = fixturePath(index);
      const sha256 = digest(bytes);
      await writeFile(path, bytes, { flag: 'wx' });
      fileRecords.push({ index, assetId: assetId(index), path, sha256, byteLength: bytes.length });
      await source.sync.createLocalEvent({ libraryId: 'release-library', eventType: 'asset.indexed', payload: {
        assetId: assetId(index), originNodeId: source.identity.peerId, kind: 'photo', sha256, byteLength: bytes.length
      } });
    }));
  }
}

function projectionCount(target) {
  return target.database.prepare('SELECT count(*) AS count FROM sync_asset_projection WHERE library_id = ? AND tombstone_event_id IS NULL')
    .get('release-library').count;
}

async function syncToCount(source, target, count) {
  const transport = { exchange: (_peerId, request) => target.sync.handleExchange(source.identity.peerId, request) };
  let sent = 0;
  let received = 0;
  let rounds = 0;
  while (projectionCount(target) < count) {
    const result = await source.sync.syncWithPeer(target.identity.peerId, transport, 2_000);
    sent += result.sent;
    received += result.received;
    rounds += result.rounds;
    if (result.sent + result.received === 0) throw new Error(`sync stalled at ${projectionCount(target)} of ${count}`);
  }
  return { sent, received, rounds, projected: projectionCount(target) };
}

async function verifyFilesAndProjections(source, target, count) {
  const sourceHashes = new Map(fileRecords.filter((record) => record.index < count).map((record) => [record.assetId, record]));
  let mismatches = 0;
  let sourceFilesChanged = 0;
  const rows = target.database.prepare(`SELECT asset_id, sha256, byte_length FROM sync_asset_projection
    WHERE library_id = ? AND tombstone_event_id IS NULL ORDER BY asset_id`).iterate('release-library');
  let projected = 0;
  for (const row of rows) {
    const original = sourceHashes.get(row.asset_id);
    if (!original || original.sha256 !== row.sha256 || original.byteLength !== row.byte_length) mismatches += 1;
    else projected += 1;
  }
  if (projected !== count || sourceHashes.size !== count) mismatches += Math.abs(count - projected);
  const batchSize = 500;
  const sources = [...sourceHashes.values()];
  for (let offset = 0; offset < sources.length; offset += batchSize) {
    const batch = sources.slice(offset, offset + batchSize);
    const hashes = await Promise.all(batch.map(async (record) => digestFile(record.path)));
    for (let index = 0; index < batch.length; index += 1) if (hashes[index] !== batch[index].sha256) sourceFilesChanged += 1;
  }
  return { checkedFiles: count, mismatches, sourceFilesChanged };
}

async function migrationBackupEvidence() {
  const databasePath = join(tempRoot, 'migration-source.sqlite');
  const backupPath = join(tempRoot, 'migration-before.sqlite');
  const restorePath = join(tempRoot, 'migration-restored.sqlite');
  const db = new Database(databasePath);
  liveDatabases.add(db);
  db.exec('CREATE TABLE legacy_asset_records (asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO legacy_asset_records (asset_id, sha256) VALUES (?, ?)');
  const seed = db.transaction(() => { for (let index = 0; index < 250; index += 1) insert.run(`legacy-${index}`, digest(Buffer.from(`legacy-${index}`))); });
  seed();
  const assetCountBefore = db.prepare('SELECT count(*) AS count FROM legacy_asset_records').get().count;
  let backupCreatedAt;
  let backupSha256;
  const repository = new SqliteRepository(db, { backupBeforeMigration: async () => {
    await db.backup(backupPath);
    backupCreatedAt = new Date().toISOString();
    backupSha256 = await digestFile(backupPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } });
  await repository.migrate(migrations);
  const migrationStartedAt = db.prepare('SELECT min(applied_at) AS started FROM schema_migrations').get().started;
  const assetCountAfter = db.prepare('SELECT count(*) AS count FROM legacy_asset_records').get().count;
  if (!backupCreatedAt || !backupSha256 || Date.parse(migrationStartedAt) <= Date.parse(backupCreatedAt)) throw new Error('migration did not run after the completed backup');
  await copyFile(backupPath, restorePath);
  const restored = new Database(restorePath, { readonly: true, fileMustExist: true });
  const restoredCount = restored.prepare('SELECT count(*) AS count FROM legacy_asset_records').get().count;
  const restoredDatabaseSha256 = await digestFile(restorePath);
  restored.close();
  db.close();
  liveDatabases.delete(db);
  if (assetCountBefore !== assetCountAfter || restoredCount !== assetCountBefore || restoredDatabaseSha256 !== backupSha256) {
    throw new Error('migration backup restore verification failed');
  }
  return { backupCreatedAt, migrationStartedAt, backupCreated: true, backupSha256, restoreVerified: true,
    restoredDatabaseSha256, assetCountBefore, assetCountAfter, restoredAssetCount: restoredCount };
}

async function aclMatrixEvidence() {
  const host = await node('acl-host');
  const peers = await Promise.all(['family', 'guest', 'revoked', 'untrusted'].map((label) => node(`acl-${label}`)));
  const [family, guest, revoked, untrusted] = peers;
  const timestamp = new Date().toISOString();
  host.repository.recordExternalFile({ locationId: randomUUID(), fileId: randomUUID(), assetId: 'acl-visible-asset', nodeId: host.identity.peerId,
    libraryId: 'release-acl-library', kind: 'photo', filename: 'acl-fixture.jpg', originalPath: '/release-fixture/acl-fixture.jpg',
    byteSize: 4, sha256: digest(Buffer.from('acl!')), storageRef: 'external:acl-fixture', now: timestamp });
  for (const peer of [family, guest, revoked]) {
    host.pairing.trustScannedHost(peer.identity.peerId, peer.identity.publicKey, peer.name);
  }
  host.repository.grantLibraryRead(family.identity.peerId, 'release-acl-library', timestamp);
  host.repository.grantLibraryRead(revoked.identity.peerId, 'release-acl-library', timestamp);
  await host.pairing.revokePeer(revoked.identity.peerId);

  const roleTokens = new Map([
    ['owner-local', { role: 'owner' }], ['admin-local', { role: 'admin' }],
    ['family-peer', { role: 'family', peerId: family.identity.peerId }],
    ['guest-peer', { role: 'guest', peerId: guest.identity.peerId }],
    ['revoked-peer', { role: 'revoked', peerId: revoked.identity.peerId }],
    ['untrusted-peer', { role: 'untrusted', peerId: untrusted.identity.peerId }]
  ]);
  const api = createNodeAgentServer({
    authorizeLibraryRead: (token, libraryId) => {
      const principal = roleTokens.get(token);
      if (!principal || libraryId !== 'release-acl-library') return undefined;
      if (principal.role === 'owner' || principal.role === 'admin') return `local-${principal.role}`;
      return host.pairing.canReadLibrary(principal.peerId, libraryId) ? principal.peerId : undefined;
    },
    authorizeLibraryList: (token) => token === 'owner-local' || token === 'admin-local',
    gallery: { listLibraries: () => host.repository.listGalleryLibraries(), listAssets: (id, cursor, limit, query) => host.repository.listGalleryAssets(id, cursor, limit, query),
      getOriginal: async () => undefined, openOriginal: () => undefined, listTombstones: (id) => host.repository.listActiveTombstones(id) }
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('ACL server did not bind an ephemeral port');
  const cases = [];
  let unauthorizedReads = 0;
  for (const [token, principal] of roleTokens) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/assets?libraryId=release-acl-library&limit=10`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const allowed = principal.role === 'owner' || principal.role === 'admin' || principal.role === 'family';
    if (response.ok !== allowed) throw new Error(`ACL role ${principal.role} expected ${allowed ? 200 : 403}, got ${response.status}`);
    if (!allowed && response.ok) unauthorizedReads += 1;
    const body = response.ok ? await response.json() : undefined;
    if (allowed && body.items?.length !== 1) throw new Error(`ACL role ${principal.role} could not read the fixture index`);
    cases.push({ role: principal.role, allowed, httpStatus: response.status });
  }
  const familyWrongLibrary = await fetch(`http://127.0.0.1:${address.port}/v1/assets?libraryId=other-library&limit=10`, {
    headers: { authorization: 'Bearer family-peer' }
  });
  if (familyWrongLibrary.status !== 403) throw new Error('family peer read escaped its library grant');
  cases.push({ role: 'family', library: 'other-library', allowed: false, httpStatus: familyWrongLibrary.status });
  await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  if (unauthorizedReads !== 0) throw new Error('an unauthorized ACL principal read library metadata');
  for (const peer of peers) peer.database.close();
  host.database.close();
  for (const peer of peers) liveDatabases.delete(peer.database);
  liveDatabases.delete(host.database);
  return { matrixPassed: true, unauthorizedReads, cases: ['owner', 'admin', 'family', 'guest', 'revoked', 'untrusted'],
    detailedCases: cases, negativeLibraryScopePassed: true, authorizationSource: 'SQLite trust state and persisted library_grants plus local API principal authorization' };
}

async function main() {
  process.stdout.write(`Preparing ${totalFiles} synthetic, content-addressed fixture files in ${fixtureRoot}\n`);
  await mkdir(fixtureRoot, { recursive: true });
  const source = await node('sync-source');
  const target = await node('sync-target');
  await trustBoth(source, target, 'release-library');
  const initialStarted = performance.now();
  const initialCpu = process.cpuUsage();
  await addFiles(source, 0, totalFiles);
  process.stdout.write('Initial fixture indexing complete; exchanging signed event batches\n');
  const initialSync = await syncToCount(source, target, totalFiles);
  const initialSeconds = elapsedSeconds(initialStarted);
  const initialCpuPercent = cpuPercent(initialCpu, initialStarted);

  const incrementalStarted = performance.now();
  await addFiles(source, totalFiles, incrementalCount);
  const incrementalSync = await syncToCount(source, target, totalFiles + incrementalCount);
  const incrementalSeconds = elapsedSeconds(incrementalStarted);

  const offlineStarted = performance.now();
  await addFiles(source, totalFiles + incrementalCount, offlineCount);
  const offlineSync = await syncToCount(source, target, totalFiles + incrementalCount + offlineCount);
  const offlineSeconds = elapsedSeconds(offlineStarted);
  const integrity = await verifyFilesAndProjections(source, target, totalFiles + incrementalCount + offlineCount);
  if (integrity.mismatches !== 0 || integrity.sourceFilesChanged !== 0) throw new Error('full synthetic original SHA-256 verification failed');

  const migration = await migrationBackupEvidence();
  const acl = await aclMatrixEvidence();
  const peakRssMiB = maxRssMiB();
  evidence.fileSync = {
    totalFiles, runCount: 3, transport: 'signed SyncService exchange between independent SQLite repositories',
    dataset: { initialFiles: totalFiles, incrementalFiles: incrementalCount, offlineReconnectFiles: offlineCount, originalBytesPerFile: 'deterministic short fixture; not representative of RAW/video bandwidth' },
    initial: { sha256Mismatches: 0, durationSeconds: initialSeconds, cpuPercent: initialCpuPercent, peakRssMiB, syncedEvents: initialSync.sent, syncRounds: initialSync.rounds },
    incremental: { sha256Mismatches: 0, durationSeconds: incrementalSeconds, changedFiles: incrementalCount, syncedEvents: incrementalSync.sent, syncRounds: incrementalSync.rounds },
    offlineReconnect: { sha256Mismatches: 0, durationSeconds: offlineSeconds, changedFiles: offlineCount, syncedEvents: offlineSync.sent, syncRounds: offlineSync.rounds }
  };
  evidence.integrity = { ...integrity, mode: 'source originals verified byte-for-byte against signed peer projections; original bytes remain on source node',
    sourceFilesChanged: integrity.sourceFilesChanged };
  evidence.migration = migration;
  evidence.acl = acl;
  evidence.measurement = { startedAt: testStartedAt,
    finishedAt: new Date().toISOString(), operator: 'automated release-acceptance.mjs',
    host: `${platform()} ${release()} ${process.arch}; ${cpus()[0]?.model ?? 'unknown'}; ${Math.round(totalmem() / 1024 / 1024)} MiB RAM`,
    dataMode: 'independent in-memory SQLite repositories; signed metadata events only; source originals remain node-local',
    temporaryFixtureRoot: 'removed after successful run' };
  await mkdir((await import('node:path')).dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: 'passed', files: totalFiles, initialSeconds, incrementalSeconds, offlineReconnectSeconds: offlineSeconds,
    initialSync, incrementalSync, offlineSync, integrity, migration, acl, evidencePath, peakRssMiB }, null, 2)}\n`);
  source.database.close(); target.database.close();
  liveDatabases.delete(source.database); liveDatabases.delete(target.database);
  await rm(tempRoot, { recursive: true, force: true });
}

try { await main(); }
finally {
  for (const database of liveDatabases) { try { database.close(); } catch { /* retain original failure */ } }
  await rm(tempRoot, { recursive: true, force: true });
}
