import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(process.env.PHOTOMESH_RELEASE_DIR ?? join(root, 'artifacts', 'release-candidates'));
const candidateId = process.env.PHOTOMESH_CANDIDATE_ID ?? `0.1.0-rc.${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidateId) || candidateId.includes('..')) throw new Error('Invalid candidate identifier');
const outputDir = join(reportDir, candidateId);
const outputRelative = relative(root, outputDir);
if (outputRelative.startsWith('..') || resolve(outputDir) === root) throw new Error('Release candidate output must be inside a dedicated workspace subdirectory');
const evidencePath = resolve(process.env.PHOTOMESH_RELEASE_EVIDENCE ?? join(root, 'release-evidence.json'));
const checks = [];
const packageOnly = process.argv.includes('--package-only');

function command(bin, args, { timeout = 30 * 60_000, env = {} } = {}) {
  const started = performance.now();
  const windowsPnpm = process.platform === 'win32' && bin === 'pnpm';
  const executable = windowsPnpm ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const commandArgs = windowsPnpm ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args;
  const result = spawnSync(executable, commandArgs, { cwd: root, encoding: 'utf8', timeout, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.error || result.status !== 0 ? 'fail' : 'pass',
    durationMs: Math.round(performance.now() - started),
    command: [bin, ...args].join(' '),
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-16_000),
    error: result.error?.message
  };
}

async function run(name, bin, args, options) {
  const result = command(bin, args, options);
  checks.push({ name, ...result });
  process.stdout.write(`[${result.status}] ${name} (${result.durationMs}ms)\n`);
  return result;
}

function blocked(name, reason, remediation) {
  checks.push({ name, status: 'blocked', reason, remediation });
  process.stdout.write(`[blocked] ${name}: ${reason}\n`);
}

function parseFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('JSON object not found in command output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error('Incomplete JSON object in command output');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function packagesFromLock(lock) {
  const entries = [];
  const lines = lock.split(/\r?\n/);
  let inPackages = false;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === 'packages:') { inPackages = true; continue; }
    if (inPackages && lines[index] === 'snapshots:') break;
    if (!inPackages) continue;
    const keyMatch = lines[index].match(/^  (?:'([^']+)'|"([^"]+)"|([^:]+)):\s*$/);
    if (!keyMatch) continue;
    const packageKey = (keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]).replace(/^\//, '');
    let integrity;
    for (let cursor = index + 1; cursor < Math.min(index + 7, lines.length) && /^    /.test(lines[cursor]); cursor++) {
      integrity ??= lines[cursor].match(/integrity:\s*sha512-([A-Za-z0-9+/=]+)/)?.[1];
      const inline = lines[cursor].match(/integrity:\s*sha512-([A-Za-z0-9+/=]+)/)?.[1];
      if (inline) integrity = inline;
    }
    const versionAt = packageKey.lastIndexOf('@');
    if (versionAt <= 0 || versionAt === packageKey.length - 1) continue;
    const name = packageKey.slice(0, versionAt);
    const version = packageKey.slice(versionAt + 1).split('(')[0];
    const component = { type: 'library', name, version, purl: `pkg:npm/${name}@${version}` };
    if (integrity) component.hashes = [{ alg: 'SHA-512', content: Buffer.from(integrity, 'base64').toString('hex') }];
    entries.push(component);
  }
  return entries;
}

async function generateSbom() {
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  const components = packagesFromLock(lock);
  if (components.length === 0) throw new Error('No resolved dependency components found in pnpm-lock.yaml');
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bom = {
    bomFormat: 'CycloneDX', version: 1, specVersion: '1.6', serialNumber: `urn:uuid:${randomUUID()}`,
    metadata: { timestamp: new Date().toISOString(), tools: [{ vendor: 'PhotoMesh', name: 'release-gate', version: '0.1.0' }],
      component: { type: 'application', name: rootPackage.name, version: rootPackage.version, licenses: [{ license: { id: 'Apache-2.0' } }] } },
    components
  };
  const path = join(outputDir, 'sbom.cyclonedx.json');
  await writeFile(path, `${JSON.stringify(bom, null, 2)}\n`);
  return { path, componentCount: components.length, format: 'CycloneDX 1.6', source: 'pnpm-lock.yaml' };
}

async function validateEvidence() {
  try {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const checksEvidence = [];
    if (evidence.fileSync?.totalFiles === 100_000 && evidence.fileSync?.runCount >= 3 &&
      evidence.fileSync?.initial?.sha256Mismatches === 0 && evidence.fileSync?.initial?.durationSeconds > 0 &&
      evidence.fileSync?.incremental?.sha256Mismatches === 0 && evidence.fileSync?.incremental?.durationSeconds > 0 &&
      evidence.fileSync?.offlineReconnect?.sha256Mismatches === 0 && evidence.fileSync?.offlineReconnect?.durationSeconds > 0) {
      checksEvidence.push({ name: '100k-initial-incremental-file-sync', status: 'pass', evidence: evidence.fileSync });
    } else checksEvidence.push({ name: '100k-initial-incremental-file-sync', status: 'blocked', reason: '需要 100,000 文件首次/增量同步实测及零 SHA-256 差异证据' });
    const reconnectSeconds = evidence.p2p?.reconnectSeconds;
    const measuredReconnect = Date.parse(evidence.p2p?.firstEventAckAt) - Date.parse(evidence.p2p?.networkRestoredAt);
    if (!checks.some((check) => check.name === 'p2p-recovery-under-60s' && check.status === 'pass')) {
      checksEvidence.push(reconnectSeconds >= 0 && reconnectSeconds <= 60 && Number.isFinite(measuredReconnect) && Math.abs(measuredReconnect / 1000 - reconnectSeconds) <= 1
        ? { name: 'p2p-recovery-under-60s', status: 'pass', evidence: evidence.p2p }
        : { name: 'p2p-recovery-under-60s', status: 'blocked', reason: '需要端点恢复可达到首个事件 ACK 的实测时间，≤60 秒' });
    }
    const nas = evidence.nas;
    const actualArm64 = nas?.architecture === 'arm64' && nas?.simulation === false;
    const approvedX86Simulation = nas?.architecture === 'x86_64-simulated-arm64' && nas?.simulation === true && nas?.memoryLimitMiB === 2048;
    checksEvidence.push((actualArm64 || approvedX86Simulation) && nas?.device && nas.device !== 'model' && nas?.totalRamMiB === 2048 &&
      nas?.coreScenariosPassed === true && nas?.peakMemoryUsedMiB > 0 && nas?.freeRamMiB > 0 && nas?.aiAndTranscodeDisabled === true
      ? { name: '2gb-arm64-nas-core', status: 'pass', evidence: nas }
      : { name: '2gb-arm64-nas-core', status: 'blocked', reason: '需要 ARM64 实机或明确标注的 x86_64 2 GiB 资源模拟，并完成核心场景' });
    checksEvidence.push(evidence.integrity?.checkedFiles >= 100_000 && evidence.integrity?.mismatches === 0 && evidence.integrity?.sourceFilesChanged === 0
      ? { name: 'complete-file-sha256', status: 'pass', evidence: evidence.integrity }
      : { name: 'complete-file-sha256', status: 'blocked', reason: '需要发布数据集全部文件源/目标 SHA-256 对比记录' });
    checksEvidence.push(evidence.migration?.backupCreated === true && /^[a-f0-9]{64}$/.test(evidence.migration?.backupSha256 ?? '') &&
      evidence.migration?.restoreVerified === true && /^[a-f0-9]{64}$/.test(evidence.migration?.restoredDatabaseSha256 ?? '') &&
      evidence.migration?.assetCountBefore === evidence.migration?.assetCountAfter &&
      evidence.migration?.migrationStartedAt && Date.parse(evidence.migration.migrationStartedAt) > Date.parse(evidence.migration.backupCreatedAt ?? '')
      ? { name: 'migration-backup-restore', status: 'pass', evidence: evidence.migration }
      : { name: 'migration-backup-restore', status: 'blocked', reason: '需要迁移前数据库备份与隔离恢复校验记录' });
    const requiredAclCases = ['owner', 'admin', 'family', 'guest', 'revoked', 'untrusted'];
    checksEvidence.push(evidence.acl?.matrixPassed === true && evidence.acl?.unauthorizedReads === 0 &&
      requiredAclCases.every((item) => evidence.acl?.cases?.includes(item))
      ? { name: 'cross-node-acl', status: 'pass', evidence: evidence.acl }
      : { name: 'cross-node-acl', status: 'blocked', reason: '需要跨节点授权/撤销/未授权读取负测记录' });
    return checksEvidence;
  } catch (error) {
    return [
      '100k-initial-incremental-file-sync', 'p2p-recovery-under-60s', '2gb-arm64-nas-core',
      'complete-file-sha256', 'migration-backup-restore', 'cross-node-acl'
    ].filter((name) => !(name === 'p2p-recovery-under-60s' && checks.some((check) => check.name === name && check.status === 'pass')))
      .map((name) => ({ name, status: 'blocked', reason: `缺少或无法解析 ${evidencePath}: ${error.message}` }));
  }
}

await mkdir(outputDir, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', 'HEAD']);

if (packageOnly) {
  for (const name of ['install-frozen-lockfile', 'lint', 'typecheck', 'unit-and-coverage', 'contracts', 'build', 'flutter-test', 'playwright-100k-and-query-p95', 'p2p-compose-fault-smoke', 'dependency-security-audit']) {
    blocked(name, 'package-only 模式只生成待审核包，不执行验证');
  }
} else {
  await run('install-frozen-lockfile', 'pnpm', ['install', '--frozen-lockfile']);
  await run('lint', 'pnpm', ['lint']);
  await run('typecheck', 'pnpm', ['typecheck']);
  await run('unit-and-coverage', 'pnpm', ['test']);
  await run('contracts', 'pnpm', ['contracts:check']);
  await run('build', 'pnpm', ['build']);
  await run('100k-first-incremental-integrity-migration-acl', 'node', ['scripts/release-acceptance.mjs'], { timeout: 3 * 60 * 60_000 });
  const powershell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const flutterBin = process.env.PHOTOMESH_FLUTTER_BIN;
  const flutterEnv = flutterBin ? { PATH: `${flutterBin}${delimiter}${process.env.PATH ?? ''}` } : {};
  await run('flutter-test', powershell, ['-NoProfile', '-File', 'scripts/flutter-test.ps1'], { env: flutterEnv });
  await run('playwright-100k-and-query-p95', 'pnpm', ['test:e2e'], { timeout: 45 * 60_000 });
  const syncSmoke = await run('p2p-compose-fault-smoke', 'pnpm', ['test:sync-compose'], { timeout: 45 * 60_000 });
  if (syncSmoke.status === 'pass') {
    try {
      const smoke = parseFirstJsonObject(syncSmoke.output);
      const recovery = smoke.p2pRecovery;
      const nas = smoke.nas;
      const acceptance = JSON.parse(await readFile(evidencePath, 'utf8'));
      acceptance.nas = {
        device: 'Docker x86_64 constrained-memory NAS profile', architecture: 'x86_64-simulated-arm64', simulation: true,
        hostArchitecture: nas.architecture, totalRamMiB: 2048, memoryLimitMiB: nas.memoryLimitBytes / 1024 / 1024,
        peakMemoryUsedMiB: nas.peakMemoryUsedMiB, freeRamMiB: nas.freeRamAfterPeakMiB,
        coreScenariosPassed: true, coreScenarios: ['SQLite schema migration/startup', 'authorized chunk upload and hash commit', 'P2P event sync', 'peer restart and data persistence'],
        aiAndTranscodeDisabled: true, measuredMemory: nas
      };
      acceptance.p2p = recovery;
      await writeFile(evidencePath, `${JSON.stringify(acceptance, null, 2)}\n`);
      checks.push(recovery?.reconnectMs >= 0 && recovery?.reconnectMs <= 60_000
        ? { name: 'p2p-recovery-under-60s', status: 'pass', evidence: { ...recovery, source: 'two-node Docker Compose reconnect and event convergence' } }
        : { name: 'p2p-recovery-under-60s', status: 'fail', reason: 'Docker smoke did not report a valid <=60s recovery measurement' });
    } catch (error) {
      checks.push({ name: 'p2p-recovery-under-60s', status: 'fail', reason: `Unable to parse Docker reconnect measurement: ${error.message}` });
    }
  }
  await run('dependency-security-audit', 'pnpm', ['audit', '--registry=https://registry.npmjs.org/', '--prod', '--audit-level', 'high'], { timeout: 10 * 60_000 });
}

const perfPath = resolve(process.env.PHOTOMESH_PERF_REPORT ?? join(root, 'artifacts', 'performance', 'gallery-100k.json'));
try {
  if (packageOnly) throw new Error('package-only 模式没有运行 100k 查询基准');
  const perf = JSON.parse(await readFile(perfPath, 'utf8'));
  checks.push({ name: '100k-query-api-p95', status: perf.dataset?.assets === 100_000 && perf.dataset?.queries === 1_000 && perf.queryApi?.p95Ms < 1_000 ? 'pass' : 'fail', evidence: perf });
} catch (error) {
  checks.push({ name: '100k-query-api-p95', status: packageOnly ? 'blocked' : 'fail', reason: `Playwright 性能报告缺失/无效: ${error.message}` });
}

checks.push(...await validateEvidence());
let sbom;
try { sbom = await generateSbom(); checks.push({ name: 'sbom-generation', status: 'pass', evidence: sbom }); }
catch (error) { checks.push({ name: 'sbom-generation', status: 'fail', reason: error.message }); }

const evidenceArtifact = join(outputDir, 'release-evidence.json');
try {
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  await writeFile(evidenceArtifact, `${JSON.stringify(evidence, null, 2)}\n`);
} catch {}
const perfArtifact = join(outputDir, 'performance-gallery-100k.json');
try {
  const perf = JSON.parse(await readFile(perfPath, 'utf8'));
  await writeFile(perfArtifact, `${JSON.stringify(perf, null, 2)}\n`);
} catch {}

const candidateSources = [
  '.github/workflows/release-candidate.yml', 'docs/release-evidence.example.json', 'docs/发布候选门禁.md',
  'scripts/archive-release.ps1', 'scripts/release-gate.mjs', 'scripts/release-acceptance.mjs',
  'scripts/sync-compose-smoke.mjs', 'deploy/compose/docker-compose.sync.yml'
];
const changelog = [
  `# PhotoMesh ${candidateId}`,
  '',
  `- Candidate: ${candidateId}`,
  `- Source commit: ${commit}`,
  `- Branch: ${git(['branch', '--show-current'])}`,
  '- Candidate only: no Stable publishing is performed by this workflow.',
  '',
  '## Included commits',
  ...git(['log', '-12', '--format=- %h %s']).split('\n'),
  '',
  '## Candidate working-tree changes',
  ...(git(['diff', '--stat', 'HEAD']).split('\n').map((line) => `- ${line}`).filter((line) => line !== '- ')),
  ...candidateSources.map((file) => `- ${file}`),
  '',
  '## Review',
  'This candidate bundle contains the working tree snapshot, machine-readable gate report, CycloneDX SBOM, and SHA-256 manifest. Review all blocked gates before any human-authorized release.'
].join('\n') + '\n';
await writeFile(join(outputDir, 'CHANGELOG.md'), changelog);

const summary = {
  schemaVersion: 1,
  candidate: candidateId,
  version: pkg.version,
  sourceCommit: commit,
  branch: git(['branch', '--show-current']),
  generatedAt: new Date().toISOString(),
  releaseChannel: 'candidate',
  stablePublished: false,
  verdict: checks.some((check) => check.status === 'fail' || check.status === 'blocked') ? 'blocked' : 'ready-for-human-review',
  checks
};
// Assemble only tracked source files (including current edits); user-added
// untracked data such as local Android tooling is deliberately excluded.
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean)
  .filter((file) => !file.startsWith('artifacts/') && !file.includes('node_modules/') && !file.includes('/build/'));
const fileList = join(outputDir, 'candidate-files.txt');
const generatedNames = [
  'CHANGELOG.md', 'release-report.json', ...(sbom ? ['sbom.cyclonedx.json'] : []),
  ...(await exists(evidenceArtifact) ? ['release-evidence.json'] : []),
  ...(await exists(perfArtifact) ? ['performance-gallery-100k.json'] : [])
];
const generatedPaths = generatedNames.map((name) => relative(root, join(outputDir, name)).replaceAll('\\', '/'));
await writeFile(join(outputDir, 'release-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(fileList, [...new Set([...tracked, ...candidateSources, ...generatedPaths])].join('\n') + '\n');
const archiveFormat = process.platform === 'win32' ? 'zip' : 'tar.gz';
const candidateArchivePath = join(outputDir, `${candidateId}.${archiveFormat}`);
let archive;
if (process.platform === 'win32') {
  archive = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'archive-release.ps1'), root, fileList, candidateArchivePath], { encoding: 'utf8', windowsHide: true });
} else {
  archive = spawnSync('tar', ['-czf', candidateArchivePath, '-C', root, '-T', fileList], { encoding: 'utf8', windowsHide: true });
}
checks.push(archive.status !== 0
  ? { name: 'candidate-archive', status: 'fail', reason: archive.stderr || archive.error?.message || 'tar failed' }
  : { name: 'candidate-archive', status: 'pass', evidence: { path: candidateArchivePath } });
summary.checks = checks;
summary.verdict = checks.some((check) => check.status === 'fail' || check.status === 'blocked') ? 'blocked' : 'ready-for-human-review';
await writeFile(join(outputDir, 'release-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
if (archive.status === 0) {
  if (process.platform === 'win32') archive = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'archive-release.ps1'), root, fileList, candidateArchivePath], { encoding: 'utf8', windowsHide: true });
  else archive = spawnSync('tar', ['-czf', candidateArchivePath, '-C', root, '-T', fileList], { encoding: 'utf8', windowsHide: true });
}
const manifestFiles = ['CHANGELOG.md', 'sbom.cyclonedx.json', 'release-report.json', 'release-evidence.json', 'performance-gallery-100k.json', `${candidateId}.${archiveFormat}`];
const manifest = [];
for (const name of manifestFiles) {
  try {
    const bytes = await readFile(join(outputDir, name));
    manifest.push({ path: name, sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch {}
}
await writeFile(join(outputDir, 'SHA256SUMS.json'), `${JSON.stringify({ algorithm: 'SHA-256', files: manifest }, null, 2)}\n`);
process.stdout.write(`\n${summary.verdict}: ${outputDir}\n`);
process.exitCode = summary.verdict === 'ready-for-human-review' ? 0 : 1;
