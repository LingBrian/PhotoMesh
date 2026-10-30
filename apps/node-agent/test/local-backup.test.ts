import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalBackup, restoreLocalBackup } from '../src/backup/local-backup.js';

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
  it('restores only after validating the manifest and hashes into an empty isolated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photomesh-restore-')); cleanup.push(root);
    const source = join(root, 'source'); const backup = join(root, 'backup'); const restored = join(root, 'restored');
    await writeFile(source, 'restore me');
    const manifest = await createLocalBackup([{ relativePath: 'objects/photo.bin', sourcePath: source, kind: 'object' }], backup, '2026-10-31T00:00:00.000Z');
    const result = await restoreLocalBackup(backup, restored);
    expect(result).toEqual({ entries: 1, bytes: 10, digest: manifest.digest });
    expect(await readFile(join(restored, 'objects/photo.bin'), 'utf8')).toBe('restore me');
    await expect(restoreLocalBackup(backup, restored)).rejects.toThrow('must be empty');
  });

  it('rejects tampered backup bytes before restoring any files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photomesh-restore-')); cleanup.push(root);
    const source = join(root, 'source'); const backup = join(root, 'backup'); const restored = join(root, 'restored');
    await writeFile(source, 'original');
    await createLocalBackup([{ relativePath: 'db/photo.sqlite', sourcePath: source, kind: 'database' }], backup, '2026-10-31T00:00:00.000Z');
    await writeFile(join(backup, 'db/photo.sqlite'), 'tampered');
    await expect(restoreLocalBackup(backup, restored)).rejects.toThrow('hash mismatch');
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
