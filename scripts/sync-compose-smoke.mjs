import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const composeFile = 'deploy/compose/docker-compose.sync.yml';
const token = 'photomesh-compose-fixture-token';
const libraryId = 'compose-library';
const nodes = [
  { service: 'windows-sim', base: 'http://127.0.0.1:18443', peerAddress: { host: '172.29.0.2', port: 4001 } },
  { service: 'nas-sim', base: 'http://127.0.0.1:18444', peerAddress: { host: '172.29.0.3', port: 4001 } }
];

function compose(args) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

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
const afterReconnect = await waitForBoth([first.sha256, second.sha256, offline.sha256]);
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
  afterReconnect, afterRestart, originalsRemainNodeLocal: true }, null, 2) + '\n');
