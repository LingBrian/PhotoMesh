import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalBackup } from '../src/backup/local-backup.js';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('local backup prototype', () => {
  it('copies explicit sources and verifies hashes in an independent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photomesh-backup-')); cleanup.push(root);
    const source = join(root, 'source'); const destination = join(root, 'backup');
    await writeFile(source, 'immutable database');
    const manifest = await createLocalBackup([{ relativePath: 'db/photo.sqlite', sourcePath: source, kind: 'database' }], destination, '2026-10-31T00:00:00.000Z');
    expect(manifest.entries[0]?.byteSize).toBe(18);
    expect(await readFile(join(destination, 'db/photo.sqlite'), 'utf8')).toBe('immutable database');
    expect(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')).digest).toBe(manifest.digest);
  });
  it('rejects a destination that overlaps a source and does not overwrite a target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photomesh-backup-')); cleanup.push(root);
    const source = join(root, 'source'); await writeFile(source, 'source');
    await expect(createLocalBackup([{ relativePath: 'source', sourcePath: source, kind: 'object' }], root, '2026-10-31T00:00:00.000Z')).rejects.toThrow('overlaps source');
    const destination = join(root, 'backup');
    await createLocalBackup([{ relativePath: 'file', sourcePath: source, kind: 'object' }], destination, '2026-10-31T00:00:00.000Z');
    await expect(createLocalBackup([{ relativePath: 'file', sourcePath: source, kind: 'object' }], destination, '2026-10-31T00:00:00.000Z')).rejects.toThrow();
  });
});
