import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, link, mkdir, open, realpath, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type StorageFailureCode = 'ENOSPC' | 'EIO' | 'ENOENT' | 'EEXIST' | 'EPERM';

export interface FileDigest {
  byteLength: number;
  sha256: string;
  prefix?: Uint8Array;
}

export interface UploadFileSystem {
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  flush(path: string): Promise<void>;
  publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'>;
  assembleAndHash(sourcePaths: readonly string[], destinationPath: string, maxPrefixBytes?: number): Promise<FileDigest>;
  hashFile(path: string, maxPrefixBytes?: number): Promise<FileDigest>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
}

export class NodeUploadFileSystem implements UploadFileSystem {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) throw new Error('managed storage root must be absolute');
    this.root = resolve(rootDirectory);
  }

  async openReadStream(path: string, options?: { signal?: AbortSignal }) {
    const actual = await this.resolveExistingFile(path);
    return createReadStream(actual, options);
  }

  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    const absolutePath = this.resolveManagedPath(path);
    await this.ensureSafeParents(path, true);
    const handle = await open(absolutePath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(absolutePath, { force: true });
      throw error;
    }
    await handle.close();
  }

  async flush(path: string): Promise<void> {
    const safePath = await this.resolveExistingFile(path);
    const handle = await open(safePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'> {
    const temporaryAbsolute = await this.resolveExistingFile(temporaryPath);
    const finalAbsolute = this.resolveManagedPath(finalPath);
    await this.ensureSafeParents(finalPath, true);
    try {
      await link(temporaryAbsolute, finalAbsolute);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return 'exists';
      throw error;
    }
    try {
      await unlink(temporaryAbsolute);
    } catch {
      // The final name is already durably visible. A leftover staging link is safe to reconcile later.
    }
    return 'created';
  }

  async assembleAndHash(sourcePaths: readonly string[], destinationPath: string, maxPrefixBytes = 0): Promise<FileDigest> {
    const prefixLimit = validatePrefixLimit(maxPrefixBytes);
    const prefix = prefixLimit > 0 ? new Uint8Array(prefixLimit) : undefined;
    let prefixLength = 0;
    const destination = this.resolveManagedPath(destinationPath);
    await this.ensureSafeParents(destinationPath, true);
    const output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    let position = 0;
    try {
      for (const sourcePath of sourcePaths) {
        const source = await this.openReadStream(sourcePath);
        for await (const value of source) {
          const chunk = value as Buffer;
          hash.update(chunk);
          byteLength += chunk.byteLength;
          if (prefix && prefixLength < prefix.byteLength) {
            const count = Math.min(chunk.byteLength, prefix.byteLength - prefixLength);
            prefix.set(chunk.subarray(0, count), prefixLength);
            prefixLength += count;
          }
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await output.write(chunk, written, chunk.byteLength - written, position + written);
            written += result.bytesWritten;
          }
          position += chunk.byteLength;
        }
      }
      await output.sync();
    } catch (error) {
      await output.close();
      await rm(destination, { force: true });
      throw error;
    }
    await output.close();
    return {
      byteLength, sha256: hash.digest('hex'),
      ...(prefix ? { prefix: prefix.slice(0, prefixLength) } : {})
    };
  }

  async hashFile(path: string, maxPrefixBytes = 0): Promise<FileDigest> {
    const prefixLimit = validatePrefixLimit(maxPrefixBytes);
    const prefix = prefixLimit > 0 ? new Uint8Array(prefixLimit) : undefined;
    let prefixLength = 0;
    const hash = createHash('sha256');
    let byteLength = 0;
    const stream = await this.openReadStream(path);
    for await (const value of stream) {
      const chunk = value as Buffer;
      byteLength += chunk.byteLength;
      hash.update(chunk);
      if (prefix && prefixLength < prefix.byteLength) {
        const count = Math.min(chunk.byteLength, prefix.byteLength - prefixLength);
        prefix.set(chunk.subarray(0, count), prefixLength);
        prefixLength += count;
      }
    }
    return {
      byteLength, sha256: hash.digest('hex'),
      ...(prefix ? { prefix: prefix.slice(0, prefixLength) } : {})
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveExistingFile(path);
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    const absolute = this.resolveManagedPath(path);
    await this.ensureSafeParents(path, false);
    const entry = await lstat(absolute).catch((error: unknown) => {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error('managed storage symlinks are not allowed');
    await rm(absolute, { force: true });
  }

  async removeTree(path: string): Promise<void> {
    const absolute = this.resolveManagedPath(path);
    await this.ensureSafeParents(path, false);
    const entry = await lstat(absolute).catch((error: unknown) => {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error('managed storage symlinks are not allowed');
    await rm(absolute, { recursive: true, force: true });
  }

  private async ensureSafeParents(path: string, create: boolean): Promise<void> {
    const absolute = this.resolveManagedPath(path);
    await mkdir(this.root, { recursive: true });
    const rootReal = await realpath(this.root);
    const parent = dirname(absolute);
    const relativeParent = relative(this.root, parent);
    const segments = relativeParent ? relativeParent.split(sep) : [];
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      const entry = await lstat(current).catch(async (error: unknown) => {
        if (!create || !isCode(error, 'ENOENT')) throw error;
        await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
          if (!isCode(mkdirError, 'EEXIST')) throw mkdirError;
        });
        return lstat(current);
      });
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('managed storage parent must be a real directory');
      const actual = await realpath(current);
      assertUnderRoot(rootReal, actual);
    }
  }

  private async resolveExistingFile(path: string): Promise<string> {
    const absolute = this.resolveManagedPath(path);
    await this.ensureSafeParents(path, false);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('managed media is not a regular file');
    const actual = await realpath(absolute);
    assertUnderRoot(await realpath(this.root), actual);
    return actual;
  }

  private resolveManagedPath(path: string): string {
    const segments = path.split('/');
    if (!path || path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path) || isAbsolute(path) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('invalid managed storage reference');
    }
    const resolved = resolve(this.root, ...path.split('/'));
    const fromRoot = relative(this.root, resolved);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error('managed storage reference escapes storage root');
    return join(this.root, fromRoot);
  }
}

function validatePrefixLimit(maxPrefixBytes: number): number {
  if (!Number.isSafeInteger(maxPrefixBytes) || maxPrefixBytes < 0 || maxPrefixBytes > 1024 * 1024) {
    throw new Error('invalid bounded prefix size');
  }
  return maxPrefixBytes;
}

function assertUnderRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('managed storage symlink escapes storage root');
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
