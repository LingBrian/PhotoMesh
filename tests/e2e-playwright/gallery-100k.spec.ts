import Database from '../../apps/node-agent/node_modules/better-sqlite3/lib/index.js';
import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';
import { SqliteRepository } from '../../apps/node-agent/src/db/repository.js';
import { createNodeAgentServer } from '../../apps/node-agent/src/server.js';

const total = 100_000;
const limit = 100;
const pageCounts: number[] = [];
const performanceSamplesMs: number[] = [];
const database = new Database(':memory:');
const repository = new SqliteRepository(database);
const api = createNodeAgentServer({
  authorizeLibraryList: (token) => token === 'e2e-token',
  authorizeLibraryRead: (token, id) => token === 'e2e-token' && id === 'fixture-library' ? 'e2e-admin' : undefined,
  gallery: {
    listLibraries: () => repository.listGalleryLibraries(),
    listAssets: (id, cursor, pageLimit, query) => repository.listGalleryAssets(id, cursor, pageLimit, query),
    getOriginal: async () => undefined,
    openOriginal: () => undefined,
    listTombstones: (id) => repository.listActiveTombstones(id)
  }
});
let endpoint = '';

test.beforeAll(async () => {
  await repository.migrate();
  const insert = database.prepare(`INSERT INTO assets
    (asset_id, library_id, origin_node_id, kind, capture_ts, created_at) VALUES (?, 'fixture-library', 'nas-node', 'photo', ?, ?)`);
  const seed = database.transaction(() => {
    for (let index = 0; index < total; index++) {
      const capturedAt = new Date(Date.UTC(2024, 0, 1) + index * 1000).toISOString();
      insert.run(`asset-${String(index).padStart(6, '0')}`, capturedAt, capturedAt);
    }
    database.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
      VALUES ('file-target', 'asset-099999', ?, 1, 'original', 'external:e2e', '2024-01-02T00:00:00.000Z')`).run('a'.repeat(64));
    database.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path,
      source_kind, source_node_id, path_ref, storage_class, availability, created_at)
      VALUES ('location-target', 'file-target', 'nas-node', 'target-photo.jpg', '/fixture/target-photo.jpg',
        'import', NULL, '/fixture/target-photo.jpg', 'external', 'missing', '2024-01-02T00:00:00.000Z')`).run();
  });
  seed();
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral API port');
  endpoint = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  database.close();
});

test('virtual timeline pages through 100k records and search stays server paginated', async ({ page }) => {
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
  // Measure the real API + SQLite path, not the synthetic in-browser fixture.
  // Queries include both selective and common terms and always request the same
  // bounded page size, matching normal timeline/search use.
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
  const sortedSamples = [...performanceSamplesMs].sort((a, b) => a - b);
  const percentile = (p: number): number => sortedSamples[Math.ceil(p * sortedSamples.length) - 1] ?? 0;
  const report = {
    schemaVersion: 1,
    dataset: { assets: total, queries: performanceSamplesMs.length, pageSize: 50, terms: queryTerms },
    queryApi: {
      coldCache: { method: 'SQLite PRAGMA shrink_memory before first API query', samples: 1, latencyMs: coldCacheMs },
      warmCache: { p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sortedSamples.at(-1) ?? 0, samples: performanceSamplesMs.length },
      p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sortedSamples.at(-1) ?? 0
    },
    environment: {
      platform: process.platform, os: `${os.type()} ${os.release()}`, arch: process.arch, node: process.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown', cpuCount: process.availableParallelism?.() ?? null,
      totalRamMiB: Math.round(os.totalmem() / 1024 / 1024), peakRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    thresholdMs: 1_000,
    passed: percentile(0.95) < 1_000
  };
  const output = process.env.PHOTOMESH_PERF_REPORT ?? 'artifacts/performance/gallery-100k.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  expect(report.queryApi.p95Ms, `100k query API P95 ${report.queryApi.p95Ms.toFixed(2)}ms must be < 1000ms`).toBeLessThan(1_000);

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
  await expect(page.getByText('本机缩略图缓存')).toBeVisible();
  await page.getByRole('button', { name: '全局回收站' }).click();
  await expect(page.getByText('墓碑状态，不是原图删除')).toBeVisible();
  expect(destructiveRequests).toEqual([]);
});
