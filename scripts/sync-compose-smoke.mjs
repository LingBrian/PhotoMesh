import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const composeFile = 'deploy/compose/docker-compose.sync.yml';
const composeProject = `photomesh-sync-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
const token = 'photomesh-compose-fixture-token';
const libraryId = 'compose-library';
function ipv4ToInt(value) { return value.split('.').reduce((sum, part) => (sum * 256) + Number(part), 0); }
function subnetRange(cidr) {
  const [ip, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = ipv4ToInt(ip) & mask;
  return [start, start + (0xffffffff ^ mask)];
}
function chooseSubnet() {
  const ids = execFileSync('docker', ['network', 'ls', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  const networks = ids.length ? JSON.parse(execFileSync('docker', ['network', 'inspect', ...ids], { encoding: 'utf8' })) : [];
  const occupied = networks.flatMap((network) => (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter(Boolean).map(subnetRange));
  const start = Math.floor(Math.random() * (16 * 256));
  for (let offset = 0; offset < 16 * 256; offset += 1) {
    const n = (start + offset) % (16 * 256);
    const base = `172.${16 + Math.floor(n / 256)}.${n % 256}.0`;
    const [candidateStart, candidateEnd] = subnetRange(`${base}/24`);
    if (!occupied.some(([a, b]) => candidateStart <= b && candidateEnd >= a)) return base;
  }
  throw new Error('No unused Docker /24 subnet available in 172.16.0.0/12');
}
const networkBase = chooseSubnet();
process.env.PHOTOMESH_SYNC_SUBNET = `${networkBase}/24`;
process.env.PHOTOMESH_WINDOWS_SIM_IP = `${networkBase.replace(/\.0$/, '')}.2`;
process.env.PHOTOMESH_NAS_SIM_IP = `${networkBase.replace(/\.0$/, '')}.3`;
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
const windowsPort = await freePort();
let nasPort = await freePort();
while (nasPort === windowsPort) nasPort = await freePort();
process.env.PHOTOMESH_WINDOWS_SIM_PORT = String(windowsPort);
process.env.PHOTOMESH_NAS_SIM_PORT = String(nasPort);
const nodes = [
  { service: 'windows-sim', base: `http://127.0.0.1:${windowsPort}`, peerAddress: { host: process.env.PHOTOMESH_WINDOWS_SIM_IP, port: 4001 } },
  { service: 'nas-sim', base: `http://127.0.0.1:${nasPort}`, peerAddress: { host: process.env.PHOTOMESH_NAS_SIM_IP, port: 4001 } }
];

function compose(args) {
  return execFileSync('docker', ['compose', '--project-name', composeProject, '-f', composeFile, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024
  }).trim();
}

// Every smoke run owns a unique compose project and removes only its own
// containers, network, and volumes even when an assertion or request fails.
process.on('exit', () => {
  try {
    execFileSync('docker', ['compose', '--project-name', composeProject, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], {
      stdio: 'ignore', timeout: 120_000, windowsHide: true
    });
  } catch { /* preserve the original test result; a failed cleanup remains visible in Docker */ }
});

async function request(node, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${node.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${node.service} ${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitForHealth(node) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { await request(node, '/v1/health', { headers: {} }); return; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  throw new Error(`${node.service} did not become healthy`);
}

async function pairAndGrant(host, joiner) {
  const invite = await request(host, '/v1/pairing/invitations', { method: 'POST', body: {} });
  const joinPromise = request(joiner, '/v1/pairing/join', {
    method: 'POST', body: { invite, label: `compose-${joiner.service}`, manualIp: host.peerAddress }
  });
  let pendingPeer;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !pendingPeer) {
    const state = await request(host, '/v1/pairing/peers');
    pendingPeer = state.pending.find((peer) => peer.proposedLabel === `compose-${joiner.service}`);
    if (!pendingPeer) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!pendingPeer) throw new Error(`${host.service} did not receive the pairing request`);
  await request(host, `/v1/pairing/peers/${encodeURIComponent(pendingPeer.peerId)}/approval`, {
    method: 'POST', body: { approved: true, libraryIds: [libraryId] }
  });
  await joinPromise;
}

async function upload(node, filename, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const session = await request(node, '/v1/uploads', {
    method: 'POST', headers: { 'idempotency-key': randomUUID() },
    body: { libraryId, filename, originalPath: `/fixture/${filename}`, sourceKind: 'upload', totalBytes: bytes.length, sha256 }
  });
  const chunkResponse = await fetch(`${node.base}/v1/uploads/${session.sessionId}/chunks/0`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'upload-offset': '0', 'upload-chunk-sha256': sha256 }, body: bytes
  });
  if (!chunkResponse.ok) throw new Error(`upload chunk failed (${chunkResponse.status}): ${await chunkResponse.text()}`);
  const completed = await request(node, `/v1/uploads/${session.sessionId}/complete`, { method: 'POST', body: {} });
  return { ...completed, sha256 };
}

function databaseSnapshot(service) {
  const query = "import Database from 'better-sqlite3'; import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const db=new Database('/data/photomesh.sqlite'); const originals=db.prepare(\"select f.sha256,f.storage_ref from asset_files f join assets a on a.asset_id=f.asset_id where a.library_id=? and f.media_role='original'\").all('compose-library').map(r=>{try{const bytes=readFileSync('/data/managed/'+r.storage_ref); return {sha256:r.sha256,exists:true,matches:createHash('sha256').update(bytes).digest('hex')===r.sha256};}catch{return {sha256:r.sha256,exists:false,matches:false};}}); const x={assets:db.prepare('select count(*) n from assets where library_id=?').get('compose-library').n, projections:db.prepare('select count(*) n from sync_asset_projection where library_id=? and tombstone_event_id is null').get('compose-library').n, hashes:db.prepare('select sha256 from sync_asset_projection where library_id=?').all('compose-library').map(r=>r.sha256),originals}; console.log(JSON.stringify(x)); db.close();";
  return JSON.parse(compose(['exec', '-T', '-w', '/workspace/apps/node-agent', service, 'node', '--input-type=module', '-e', query]));
}

async function waitForBoth(hashes) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const snapshots = nodes.map((node) => databaseSnapshot(node.service));
    if (snapshots.every((snapshot) => hashes.every((hash) => snapshot.hashes.includes(hash)))) return snapshots;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('event projections did not converge on both nodes');
}

compose(['up', '-d', '--build']);
for (const node of nodes) await waitForHealth(node);
await pairAndGrant(nodes[0], nodes[1]);
await pairAndGrant(nodes[1], nodes[0]);

const firstBytes = Buffer.from(`windows-original-${randomUUID()}`);
const secondBytes = Buffer.from(`nas-original-${randomUUID()}`);
const baseline = nodes.map((node) => databaseSnapshot(node.service));
const first = await upload(nodes[0], 'windows-original.bin', firstBytes);
const second = await upload(nodes[1], 'nas-original.bin', secondBytes);
const initial = await waitForBoth([first.sha256, second.sha256]);
if (initial[0].assets !== baseline[0].assets + 1 || initial[1].assets !== baseline[1].assets + 1 ||
    initial.some((snapshot) => snapshot.originals.length !== snapshot.assets || snapshot.originals.some((original) => !original.exists || !original.matches))) {
  throw new Error('each node must retain only its own verified original file records');
}

compose(['pause', nodes[1].service]);
const offlineBytes = Buffer.from(`offline-retry-${randomUUID()}`);
const offline = await upload(nodes[0], 'offline-retry.bin', offlineBytes);
compose(['unpause', nodes[1].service]);
const networkRestoredAtMs = Date.now();
await waitForHealth(nodes[1]);
const afterReconnect = await waitForBoth([first.sha256, second.sha256, offline.sha256]);
const firstEventAckAtMs = Date.now();
const reconnectMs = firstEventAckAtMs - networkRestoredAtMs;
if (reconnectMs > 60_000) throw new Error(`P2P recovery took ${reconnectMs}ms; required <= 60000ms`);
if (afterReconnect[0].assets !== baseline[0].assets + 2 || afterReconnect[1].assets !== baseline[1].assets + 1 ||
    afterReconnect.some((snapshot) => snapshot.originals.length !== snapshot.assets || snapshot.originals.some((original) => !original.exists || !original.matches))) {
  throw new Error('offline retry copied or changed a node original');
}

compose(['restart', nodes[1].service]);
await waitForHealth(nodes[1]);
const afterRestart = await waitForBoth([first.sha256, second.sha256, offline.sha256]);
if (afterRestart[0].assets > afterRestart[0].projections || afterRestart[1].assets > afterRestart[1].projections) {
  throw new Error('fixture projections should include local assets without duplicating originals');
}
if (afterRestart.some((snapshot) => snapshot.originals.length !== snapshot.assets || snapshot.originals.some((original) => !original.exists || !original.matches))) {
  throw new Error('restarted node did not preserve its own original bytes');
}

process.stdout.write(JSON.stringify({ status: 'passed', hashes: [first.sha256, second.sha256, offline.sha256],
  p2pRecovery: { networkRestoredAt: new Date(networkRestoredAtMs).toISOString(),
    firstEventAckAt: new Date(firstEventAckAtMs).toISOString(), reconnectMs, reconnectSeconds: reconnectMs / 1000 },
  afterReconnect, afterRestart, originalsRemainNodeLocal: true }, null, 2) + '\n');
