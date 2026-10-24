import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const composeFile = path.resolve(
  process.env.PHOTOMESH_COMPOSE_FILE ?? 'deploy/compose/docker-compose.sync.yml'
);
const composeProject = process.env.PHOTOMESH_COMPOSE_PROJECT ?? 'photomesh-sync-final';
const token = 'photomesh-compose-fixture-token';
const node = {
  service: 'windows-sim',
  baseUrl: process.env.PHOTOMESH_TEST_BASE_URL ?? 'http://127.0.0.1:18443'
};
const libraryId = `mobile-smoke-${randomUUID()}`;
const chunkBytes = 4 * 1024 * 1024;
let useWslDocker = false;
if (process.platform === 'win32') {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' });
  } catch {
    useWslDocker = true;
  }
}

function compose(args) {
  const dockerArgs = ['compose', '-p', composeProject, '-f', composeFile, ...args];
  if (!useWslDocker) {
    return execFileSync('docker', dockerArgs, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
    }).trim();
  }
  const wslComposeFile = composeFile.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/');
  const distro = process.env.PHOTOMESH_DOCKER_WSL_DISTRO ?? 'Debian';
  const composeEnvironment = [
    'PHOTOMESH_WINDOWS_SIM_PORT',
    'PHOTOMESH_NAS_SIM_PORT',
    'PHOTOMESH_WINDOWS_SIM_IP',
    'PHOTOMESH_NAS_SIM_IP',
    'PHOTOMESH_SYNC_SUBNET'
  ].flatMap((name) => process.env[name] === undefined ? [] : [`${name}=${process.env[name]}`]);
  return execFileSync('wsl.exe', ['-d', distro, '--', 'env', ...composeEnvironment, 'docker', 'compose', '-p', composeProject, '-f', wslComposeFile, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
  }).trim();
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${node.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${node.baseUrl}/v1/health`);
      if (response.ok) return;
    } catch { /* The node can be unavailable while Compose starts or restarts it. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${node.service} did not become healthy`);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function putChunk(sessionId, index, offset, bytes) {
  const response = await fetch(`${node.baseUrl}/v1/uploads/${sessionId}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'upload-offset': String(offset),
      'upload-chunk-sha256': hash(bytes)
    },
    body: bytes
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`chunk ${index} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

function storedOriginal(service, targetLibraryId) {
  const query = `import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const db = new Database('/data/photomesh.sqlite');
const row = db.prepare("select f.sha256, f.storage_ref from asset_files f join assets a on a.asset_id=f.asset_id where a.library_id=? and f.media_role='original'").get('${targetLibraryId}');
if (!row) throw new Error('original file record was not committed');
const bytes = readFileSync('/data/managed/' + row.storage_ref);
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({expectedSha256: row.sha256, actualSha256, byteLength: bytes.length}));
db.close();`;
  const output = compose(['exec', '-T', '-w', '/workspace/apps/node-agent', service, 'node', '--input-type=module', '-e', query]);
  return JSON.parse(output);
}

try {
  await waitForHealth();
  if (!compose(['ps', '-q', node.service])) throw new Error(`Compose project ${composeProject} has no ${node.service} service`);
} catch {
  process.stdout.write('Starting the existing two-node Compose fixture...\n');
  compose(['up', '-d', '--build']);
  await waitForHealth();
}

const bytes = Buffer.alloc(chunkBytes * 2 + 31);
for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) % 251;
const expectedSha256 = hash(bytes);
const create = await request('/v1/uploads', {
  method: 'POST',
  headers: { 'idempotency-key': `mobile-${randomUUID()}` },
  body: {
    libraryId,
    filename: 'phone-original.bin',
    originalPath: 'DCIM/PhotoMesh/phone-original.bin',
    sourceKind: 'upload',
    sourceNodeId: 'android-smoke-device',
    totalBytes: bytes.length,
    sha256: expectedSha256
  }
});

const firstChunk = bytes.subarray(0, chunkBytes);
const afterFirstChunk = await putChunk(create.sessionId, 0, 0, firstChunk);
if (afterFirstChunk.offset !== firstChunk.length) throw new Error('first chunk offset did not advance durably');

compose(['restart', node.service]);
await waitForHealth();
const afterRestart = await request(`/v1/uploads/${create.sessionId}`);
if (afterRestart.offset !== firstChunk.length) throw new Error('server restart lost the durable upload offset');

const duplicate = await putChunk(create.sessionId, 0, 0, firstChunk);
if (duplicate.offset !== firstChunk.length) throw new Error('identical chunk replay was not idempotent');

let offset = firstChunk.length;
let chunkIndex = 1;
while (offset < bytes.length) {
  const end = Math.min(offset + chunkBytes, bytes.length);
  const accepted = await putChunk(create.sessionId, chunkIndex, offset, bytes.subarray(offset, end));
  if (accepted.offset !== end) throw new Error(`chunk ${chunkIndex} offset mismatch`);
  offset = end;
  chunkIndex += 1;
}

const complete = await request(`/v1/uploads/${create.sessionId}/complete`, { method: 'POST', body: {} });
if (complete.sha256 !== expectedSha256 || complete.byteLength !== bytes.length) {
  throw new Error('server completion receipt did not match the source SHA-256 and length');
}
const stored = storedOriginal(node.service, libraryId);
if (stored.expectedSha256 !== expectedSha256 || stored.actualSha256 !== expectedSha256 || stored.byteLength !== bytes.length) {
  throw new Error('committed original on managed storage did not match the source');
}

process.stdout.write(JSON.stringify({
  status: 'passed',
  sessionId: create.sessionId,
  libraryId,
  chunkCount: chunkIndex,
  resumedOffsetAfterRestart: afterRestart.offset,
  duplicateChunkAccepted: true,
  completeSha256: complete.sha256,
  storedOriginal: stored,
  fixtureDataOnly: true,
  composeServicesLeftRunning: true
}, null, 2) + '\n');
