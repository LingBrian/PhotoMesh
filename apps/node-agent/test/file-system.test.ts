import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeUploadFileSystem } from '../src/uploads/file-system.js';

const roots: string[] = [];

afterEach(async () => {
  const base = resolve(tmpdir());
  await Promise.all(roots.splice(0).map(async (root) => {
    const resolved = resolve(root);
    const rel = relative(base, resolved);
    if (!rel.startsWith(`photomesh-managed-test-${process.pid}-`) || rel.includes(sep)) throw new Error('refusing cleanup outside the test-managed temp directory');
    await rm(resolved, { recursive: true, force: true });
  }));
});

async function createStore(): Promise<NodeUploadFileSystem> {
  const root = await mkdtemp(join(tmpdir(), `photomesh-managed-test-${process.pid}-`));
  roots.push(root);
  return new NodeUploadFileSystem(root);
}

describe('managed upload filesystem', () => {
  it('requires an absolute data root', () => {
    expect(() => new NodeUploadFileSystem('relative-data-root')).toThrow('must be absolute');
  });

  it('writes, flushes, streams, and atomically publishes without replacing an existing object', async () => {
    const store = await createStore();
    await store.writeExclusive('staging/session/chunk.bin', new TextEncoder().encode('part-'));
    await store.writeExclusive('staging/session/chunk-2.bin', new TextEncoder().encode('bytes'));
    await store.flush('staging/session/chunk.bin');
    const assembled = await store.assembleAndHash(['staging/session/chunk.bin', 'staging/session/chunk-2.bin'], 'staging/session/assembled.tmp');
    expect(assembled.byteLength).toBe(10);
    expect((await store.hashFile('staging/session/assembled.tmp')).sha256).toBe(assembled.sha256);
    await store.flush('staging/session/assembled.tmp');
    expect(await store.publishNoReplace('staging/session/assembled.tmp', 'objects/session/original.blob')).toBe('created');
    expect(await store.exists('objects/session/original.blob')).toBe(true);

    await store.writeExclusive('staging/other/assembled.tmp', new TextEncoder().encode('different'));
    expect(await store.publishNoReplace('staging/other/assembled.tmp', 'objects/session/original.blob')).toBe('exists');
    const root = roots.at(-1)!;
    expect(await readFile(join(root, 'objects/session/original.blob'), 'utf8')).toBe('part-bytes');
  });

  it('rejects managed operations whose parent junction escapes the storage root', async () => {
    const store = await createStore();
    const root = roots.at(-1)!;
    const outside = await mkdtemp(join(tmpdir(), `photomesh-managed-test-${process.pid}-outside-`));
    roots.push(outside);
    await mkdir(join(root, 'staging'), { recursive: true });
    await mkdir(join(outside, 'subtree'));
    await symlink(outside, join(root, 'staging/redirect'), 'junction');
    await writeFile(join(outside, 'secret.bin'), 'protected');
    await writeFile(join(outside, 'flush.bin'), 'protected');
    await writeFile(join(outside, 'remove.bin'), 'protected');
    await writeFile(join(outside, 'subtree/secret.bin'), 'protected');
    await store.writeExclusive('staging/publish.tmp', new TextEncoder().encode('publish'));
    await store.writeExclusive('staging/assemble-source.tmp', new TextEncoder().encode('assemble'));

    const outcomes = await Promise.allSettled([
      store.writeExclusive('staging/redirect/created/nested.bin', new TextEncoder().encode('outside')),
      store.flush('staging/redirect/flush.bin'),
      store.publishNoReplace('staging/publish.tmp', 'staging/redirect/published.bin'),
      store.assembleAndHash(['staging/assemble-source.tmp'], 'staging/redirect/assembled.bin'),
      store.hashFile('staging/redirect/secret.bin'),
      store.openReadStream('staging/redirect/secret.bin'),
      store.exists('staging/redirect/secret.bin'),
      store.remove('staging/redirect/remove.bin'),
      store.removeTree('staging/redirect/subtree')
    ]);

    expect(outcomes.map(({ status }) => status)).toEqual(Array.from({ length: 9 }, () => 'rejected'));
    expect(await readFile(join(outside, 'flush.bin'), 'utf8')).toBe('protected');
    expect(await readFile(join(outside, 'remove.bin'), 'utf8')).toBe('protected');
    expect(await readFile(join(outside, 'subtree/secret.bin'), 'utf8')).toBe('protected');
    await expect(stat(join(outside, 'created'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'created/nested.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'published.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'assembled.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal and absolute storage references', async () => {
    const store = await createStore();
    await expect(store.exists('../outside')).rejects.toThrow('invalid managed storage reference');
    await expect(store.exists('staging/../outside')).rejects.toThrow('invalid managed storage reference');
    await expect(store.exists('C:/outside')).rejects.toThrow('invalid managed storage reference');
  });

  it('creates files exclusively and reports missing files as absent', async () => {
    const store = await createStore();
    const data = new TextEncoder().encode('immutable');
    await store.writeExclusive('staging/one.bin', data);
    await expect(store.writeExclusive('staging/one.bin', data)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await store.exists('staging/missing.bin')).toBe(false);
  });

  it('cleans a failed streamed assembly and propagates a missing source error', async () => {
    const store = await createStore();
    await expect(store.assembleAndHash(['staging/missing.bin'], 'staging/session/assembled.tmp'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.exists('staging/session/assembled.tmp')).toBe(false);
    await expect(store.publishNoReplace('staging/missing.tmp', 'objects/missing.blob'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await store.writeExclusive('staging/remove-me.bin', new TextEncoder().encode('temporary'));
    await store.remove('staging/remove-me.bin');
    expect(await store.exists('staging/remove-me.bin')).toBe(false);
  });

  it('removes only the generated managed staging subtree', async () => {
    const store = await createStore();
    await store.writeExclusive('staging/session/chunk.bin', new TextEncoder().encode('chunk'));
    await store.writeExclusive('staging/other/chunk.bin', new TextEncoder().encode('other'));
    await store.removeTree('staging/session');
    expect(await store.exists('staging/session/chunk.bin')).toBe(false);
    expect(await store.exists('staging/other/chunk.bin')).toBe(true);
  });
});
