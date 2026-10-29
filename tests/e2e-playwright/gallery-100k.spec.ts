import Database from '../../apps/node-agent/node_modules/better-sqlite3/lib/index.js';
import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { SqliteRepository } from '../../apps/node-agent/src/db/repository.js';
import { createNodeAgentServer } from '../../apps/node-agent/src/server.js';

const total = 100_000;
const limit = 100;
const pageCounts: number[] = [];
const performanceSamplesMs: number[] = [];
const datePerformanceSamplesMs: number[] = [];
let database!: Database.Database;
let repository!: SqliteRepository;
let api!: ReturnType<typeof createNodeAgentServer>;
let benchmarkRoot = '';
let databasePath = '';
let endpoint = '';

test.beforeAll(async () => {
  benchmarkRoot = await mkdtemp(join(os.tmpdir(), `photomesh-gallery-100k-${process.pid}-`));
  databasePath = join(benchmarkRoot, 'gallery.sqlite');
  database = new Database(databasePath);
  database.pragma('cache_size = -8192');
  repository = new SqliteRepository(database);
  api = createNodeAgentServer({
    authorizeLibraryList: (token) => token === 'e2e-token',
    authorizeLibraryRead: (token, id) => token === 'e2e-token' && id === 'fixture-library' ? 'e2e-admin' : undefined,
    gallery: {
      listLibraries: () => repository.listGalleryLibraries(),
      listAssets: (id, cursor, pageLimit, filters) => repository.listGalleryAssets(id, cursor, pageLimit, filters),
      getOriginal: async () => undefined,
      openOriginal: () => undefined,
      listTombstones: (id) => repository.listActiveTombstones(id)
    }
  });
  await repository.migrate();
  const origins = ['nas-node-01', 'nas-node-02', 'nas-node-03', 'nas-node-04'];
  const kinds = ['photo', 'video', 'live_photo'] as const;
  const availability = ['online', 'cached', 'offline', 'missing'] as const;
  const insertAsset = database.prepare(`INSERT INTO assets
    (asset_id,library_id,origin_node_id,kind,capture_ts,created_at) VALUES (?,'fixture-library',?,?,?,?)`);
  const insertFile = database.prepare(`INSERT INTO asset_files
    (file_id,asset_id,sha256,byte_size,media_role,storage_ref,created_at) VALUES (?,?,?,?,?,?,?)`);
  const insertLocation = database.prepare(`INSERT INTO file_locations
    (location_id,file_id,node_id,original_filename,original_path,source_kind,source_node_id,path_ref,storage_class,availability,created_at)
    VALUES (?,?,?, ?,?,'import',NULL,?,'external',?,?)`);
  const seed = database.transaction(() => {
    for (let index = 0; index < total; index++) {
      const assetId = `asset-${String(index).padStart(6, '0')}`;
      const origin = origins[index % origins.length]!;
      const capturedAt = index % 37 === 0 ? null : new Date(Date.UTC(2024, 0, 1) + index * 60_000).toISOString();
      const createdAt = capturedAt ?? '2024-01-01T00:00:00.000Z';
      insertAsset.run(assetId, origin, kinds[index % kinds.length], capturedAt, createdAt);
      if (index % 20 !== 0 && index !== total - 1) continue;
      const fileId = `file-${index}`;
      const filename = index === total - 1 ? 'target-photo.jpg' : index % 2 === 0
        ? `photo-trip-${Math.floor(index / 1000)}-${index}.jpg` : `IMG-trip-${Math.floor(index / 1000)}-${index}.jpg`;
      const sourcePath = `E:/PhotoMesh/fixture-library/album-${Math.floor(index / 1000)}/${filename}`;
      insertFile.run(fileId, assetId, index.toString(16).padStart(64, '0'), 128 + index % 8192,
        'original', `external:e2e:${index}`, createdAt);
      insertLocation.run(`loc-${index}`, fileId, origin, filename, sourcePath, `path-ref:${index}`,
        availability[index % availability.length], createdAt);
      if (index % 1000 === 0) {
        insertLocation.run(`loc-alt-${index}`, fileId, origin, `alternate-${filename}`,
          `E:/PhotoMesh/fixture-library/alternate/${filename}`, `path-alt:${index}`, 'online', createdAt);
      }
    }
  });
  seed();
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral API address');
  endpoint = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  try {
    if (api?.listening) await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  } finally {
    if (database?.open) database.close();
    if (benchmarkRoot) await rm(benchmarkRoot, { recursive: true, force: true });
  }
});

async function fileSizeOrZero(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

test('virtual timeline pages through 100k records and search stays server paginated', async ({ page }) => {
  // 1000 serial HTTP samples are intentionally measured against the real API;
  // the end-to-end wall time can exceed Playwright's default two minute cap.
  test.setTimeout(10 * 60_000);
  page.on('response', async (response) => {
    if (!new URL(response.url()).pathname.endsWith('/v1/assets')) return;
    try { pageCounts.push(((await response.json()) as { items: unknown[] }).items.length); }
    catch { pageCounts.push(0); }
  });

  await page.goto('/');
  await page.getByLabel('Node address').fill(endpoint);
  await page.getByLabel('Admin access token').fill('e2e-token');
  await page.getByRole('button', { name: 'Connect node' }).click();
  const scroll = page.getByRole('region', { name: 'Timeline' });
  await expect(scroll).toBeVisible();
  let maxRenderedRows = await page.locator('.asset-row').count();
  for (let i = 0; i < 100 && pageCounts.reduce((sum, count) => sum + count, 0) < 10_000; i++) {
    const previousCount = pageCounts.reduce((sum, count) => sum + count, 0);
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => pageCounts.reduce((sum, count) => sum + count, 0), { timeout: 5_000 }).toBeGreaterThan(previousCount);
    maxRenderedRows = Math.max(maxRenderedRows, await page.locator('.asset-row').count());
  }
  await expect.poll(() => pageCounts.reduce((sum, count) => sum + count, 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(9_900);
  expect(maxRenderedRows).toBeLessThanOrEqual(30);
  expect(Math.max(...pageCounts)).toBeLessThanOrEqual(limit);

  const search = page.getByRole('searchbox', { name: 'Search gallery' });
  // Exercise the real HTTP + file-backed SQLite/WAL path on an isolated temp DB.
  // The fixture varies capture dates/nulls, kinds, origins, paths, locations, and names.
  const queryTerms = ['target', 'photo', 'nas-node', 'fixture', 'asset-09'];
  database.pragma('shrink_memory');
  const coldStarted = performance.now();
  const coldResponse = await page.request.get(`${endpoint}/v1/assets?libraryId=fixture-library&limit=50&q=target`, {
    headers: { authorization: 'Bearer e2e-token' }
  });
  expect(coldResponse.ok()).toBeTruthy();
  const coldCacheMs = performance.now() - coldStarted;
  for (let i = 0; i < 1_000; i++) {
    const started = performance.now();
    const response = await page.request.get(`${endpoint}/v1/assets?libraryId=fixture-library&limit=50&q=${queryTerms[i % queryTerms.length]}`, {
      headers: { authorization: 'Bearer e2e-token' }
    });
    expect(response.ok()).toBeTruthy();
    performanceSamplesMs.push(performance.now() - started);
  }
  for (let i = 0; i < 100; i++) {
    const started = performance.now();
    const response = await page.request.get(`${endpoint}/v1/assets?libraryId=fixture-library&limit=50&q=nas-node&dateFrom=2024-03-01&dateTo=2024-03-08`, {
      headers: { authorization: 'Bearer e2e-token' }
    });
    expect(response.ok()).toBeTruthy();
    const pageResult = await response.json() as { items: unknown[]; nextCursor: string | null };
    expect(pageResult.items).toHaveLength(50);
    expect(pageResult.nextCursor).toBeTruthy();
    datePerformanceSamplesMs.push(performance.now() - started);
  }
  const shortQueryResponse = await page.request.get(`${endpoint}/v1/assets?libraryId=fixture-library&limit=50&q=ab`, {
    headers: { authorization: 'Bearer e2e-token' }
  });
  expect(shortQueryResponse.status()).toBe(400);
  const sortedSamples = [...performanceSamplesMs].sort((a, b) => a - b);
  const sortedDateSamples = [...datePerformanceSamplesMs].sort((a, b) => a - b);
  const percentile = (samples: number[], p: number): number => samples[Math.ceil(p * samples.length) - 1] ?? 0;
  const sqliteVersion = (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
  const sqlitePageCount = database.pragma('page_count', { simple: true }) as number;
  const databaseFileBytes = await fileSizeOrZero(databasePath);
  const walFileBytes = await fileSizeOrZero(`${databasePath}-wal`);
  const report = {
    schemaVersion: 3,
    dataset: {
      assets: total, queries: performanceSamplesMs.length, dateFilteredQueries: datePerformanceSamplesMs.length, pageSize: 50,
      terms: queryTerms, libraryCount: 1, originNodeCount: 4, assetKinds: ['photo', 'video', 'live_photo'],
      nullableCaptureEvery: 37, fileLocationsEvery: 20, secondaryLocationEvery: 1000
    },
    storage: {
      sqliteMode: 'file-backed WAL', journalMode: database.pragma('journal_mode', { simple: true }),
      pageCacheKiB: 8192, pageCount: sqlitePageCount, databaseFileBytes, walFileBytes,
      osFileCacheFlushed: false
    },
    queryApi: {
      sqlitePageCacheReset: { method: 'SQLite PRAGMA shrink_memory; OS filesystem cache is uncontrolled', samples: 1, latencyMs: coldCacheMs },
      warmCache: { p50Ms: percentile(sortedSamples, 0.50), p95Ms: percentile(sortedSamples, 0.95), p99Ms: percentile(sortedSamples, 0.99), maxMs: sortedSamples.at(-1) ?? 0, samples: performanceSamplesMs.length },
      dateFilteredSearch: {
        term: 'nas-node', dateFrom: '2024-03-01', dateTo: '2024-03-08',
        p50Ms: percentile(sortedDateSamples, 0.50), p95Ms: percentile(sortedDateSamples, 0.95),
        p99Ms: percentile(sortedDateSamples, 0.99), maxMs: sortedDateSamples.at(-1) ?? 0, samples: datePerformanceSamplesMs.length
      },
      p50Ms: percentile(sortedSamples, 0.50), p95Ms: percentile(sortedSamples, 0.95), p99Ms: percentile(sortedSamples, 0.99), maxMs: sortedSamples.at(-1) ?? 0,
      rawLatencyMs: { warmSearch: performanceSamplesMs, dateFilteredSearch: datePerformanceSamplesMs, sqlitePageCacheReset: [coldCacheMs] }
    },
    validation: { twoCodePointQueryStatus: shortQueryResponse.status(), expectedStatus: 400 },
    environment: {
      platform: process.platform, os: `${os.type()} ${os.release()}`, arch: process.arch, node: process.version, sqlite: sqliteVersion,
      cpuModel: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.availableParallelism?.() ?? os.cpus().length,
      totalRamMiB: Math.round(os.totalmem() / 1024 / 1024), peakRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    thresholdMs: 1_000,
    passed: percentile(sortedSamples, 0.95) < 1_000 && percentile(sortedDateSamples, 0.95) < 1_000 && shortQueryResponse.status() === 400
  };
  const output = process.env.PHOTOMESH_PERF_REPORT ?? 'artifacts/performance/gallery-100k.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  expect(report.queryApi.p95Ms, `100k query API P95 ${report.queryApi.p95Ms.toFixed(2)}ms must be < 1000ms`).toBeLessThan(1_000);
  expect(report.queryApi.dateFilteredSearch.p95Ms, `100k date-filtered search P95 ${report.queryApi.dateFilteredSearch.p95Ms.toFixed(2)}ms must be < 1000ms`).toBeLessThan(1_000);
  expect(report.validation.twoCodePointQueryStatus).toBe(400);

  await search.fill('target');
  await expect(page.getByRole('heading', { name: 'target-photo.jpg' })).toBeVisible();
  expect(Math.max(...pageCounts)).toBeLessThanOrEqual(limit);

  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByRole('button', { name: '时间线' })).toBeVisible();
  await page.getByLabel('主题').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '节点设置' }).click();
  const destructiveRequests: string[] = [];
  page.on('request', (request) => { if (request.method() === 'DELETE') destructiveRequests.push(request.url()); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清理本机缓存' }).click();
  await expect(page.getByRole('heading', { name: '本机缩略图缓存' })).toBeVisible();
  await page.getByRole('button', { name: '全局回收站' }).click();
  await expect(page.getByText('墓碑状态，不是原图删除')).toBeVisible();
  expect(destructiveRequests).toEqual([]);
});
