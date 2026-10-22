import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExternalFileSystem, NodeExternalWatcher } from '../src/media/node-external-adapters.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Node external filesystem adapters', () => {
  it('reads metadata and file bytes without a write capability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'photomesh-external-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'photo.jpg'), 'read-only-source');
    const fs = new NodeExternalFileSystem();
    const path = join(directory, 'nested', 'photo.jpg');

    expect((await fs.lstat(path)).kind).toBe('file');
    expect((await fs.stat(path)).size).toBe(16);
    expect(await fs.realpath(path)).toBe(path);
    expect(await fs.readdir(join(directory, 'nested'))).toEqual(['photo.jpg']);
    const chunks: Uint8Array[] = [];
    for await (const chunk of fs.readChunks(path)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('read-only-source');
  });

  it('opens and closes a directory watcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'photomesh-watch-'));
    temporaryDirectories.push(directory);
    let notifications = 0;
    const watcher = new NodeExternalWatcher().watch(directory, () => { notifications += 1; });
    watcher.close();
    expect(notifications).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
