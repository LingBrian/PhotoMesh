import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    const assembled = await store.assembleAndHash(['staging/session/chunk.bin', 'staging/session/chunk-2.bin'], 'staging/session/assembled.tmp', 5);
    expect(assembled.byteLength).toBe(10);
    expect(assembled.prefix).toEqual(new TextEncoder().encode('part-'));
    expect((await store.hashFile('staging/session/assembled.tmp')).sha256).toBe(assembled.sha256);
    await store.flush('staging/session/assembled.tmp');
    expect(await store.publishNoReplace('staging/session/assembled.tmp', 'objects/session/original.blob')).toBe('created');
    expect(await store.exists('objects/session/original.blob')).toBe(true);

    await store.writeExclusive('staging/other/assembled.tmp', new TextEncoder().encode('different'));
    expect(await store.publishNoReplace('staging/other/assembled.tmp', 'objects/session/original.blob')).toBe('exists');
    const root = roots.at(-1)!;
    expect(await readFile(join(root, 'objects/session/original.blob'), 'utf8')).toBe('part-bytes');
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

  it('rejects symlinked parent and leaf files when reading or hashing', async () => {
    const store = await createStore();
    const root = roots.at(-1)!;
    const outside = await mkdtemp(join(tmpdir(), `photomesh-managed-test-${process.pid}-read-outside-`));
    roots.push(outside);
    const outsideFile = join(outside, 'secret.bin');
    await writeFile(outsideFile, 'outside-secret');
    await symlink(outside, join(root, 'read-escape'), 'junction');
    await expect(store.openReadStream('read-escape/secret.bin')).rejects.toThrow('managed storage parent must be a real directory');
    await expect(store.hashFile('read-escape/secret.bin')).rejects.toThrow('managed storage parent must be a real directory');

    await mkdir(join(root, 'staging'), { recursive: true });
    await symlink(outsideFile, join(root, 'staging', 'alias.bin'), 'file');
    await expect(store.openReadStream('staging/alias.bin')).rejects.toThrow('managed media is not a regular file');
    await expect(store.hashFile('staging/alias.bin')).rejects.toThrow('managed media is not a regular file');
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-secret');
  });

  it('rejects symlinked derived and staging parents before writing outside the root', async () => {
    const store = await createStore();
    const root = roots.at(-1)!;
    const outside = await mkdtemp(join(tmpdir(), `photomesh-managed-test-${process.pid}-outside-`));
    roots.push(outside);
    await symlink(outside, join(root, 'derived'), 'junction');
    await expect(store.writeExclusive('derived/version/output.jpg', new TextEncoder().encode('escape')))
      .rejects.toThrow('managed storage parent must be a real directory');

    await mkdir(join(root, 'staging'), { recursive: true });
    await symlink(outside, join(root, 'staging', 'media-versions'), 'junction');
    await expect(store.writeExclusive('staging/media-versions/version.part', new TextEncoder().encode('escape')))
      .rejects.toThrow('managed storage parent must be a real directory');
    expect(await readdir(outside)).toEqual([]);
  });

  it('captures a bounded prefix in the same hash pass without changing the managed original', async () => {
    const store = await createStore();
    const bytes = new TextEncoder().encode('immutable-photo-data');
    await store.writeExclusive('objects/photo.bin', bytes);
    const digest = await store.hashFile('objects/photo.bin', 7);
    expect(digest.prefix).toEqual(new TextEncoder().encode('immutab'));
    expect(digest.byteLength).toBe(bytes.byteLength);
    expect(await readFile(join(roots.at(-1)!, 'objects/photo.bin'))).toEqual(Buffer.from(bytes));
    await expect(store.hashFile('objects/photo.bin', 1024 * 1024 + 1)).rejects.toThrow('invalid bounded prefix size');
  });
});
