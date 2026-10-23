import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, realpath, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type StorageFailureCode = 'ENOSPC' | 'EIO' | 'ENOENT' | 'EEXIST' | 'EPERM';

export interface FileDigest {
  byteLength: number;
  sha256: string;
}

export interface UploadFileSystem {
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  flush(path: string): Promise<void>;
  publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'>;
  assembleAndHash(sourcePaths: readonly string[], destinationPath: string): Promise<FileDigest>;
  hashFile(path: string): Promise<FileDigest>;
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

  async openReadStream(path: string) {
    const actual = await this.resolveExistingManagedPath(path);
    if (!(await stat(actual)).isFile()) throw new Error('managed media is not a regular file');
    return createReadStream(actual);
  }

  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    const absolutePath = await this.resolveManagedParent(path, true);
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
    const handle = await open(await this.resolveExistingManagedPath(path), 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'> {
    const temporaryAbsolute = await this.resolveExistingManagedPath(temporaryPath);
    const temporaryAlias = await this.resolveManagedParent(temporaryPath, false);
    const finalAbsolute = await this.resolveManagedParent(finalPath, true);
    try {
      await link(temporaryAbsolute, finalAbsolute);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return 'exists';
      throw error;
    }
    try {
      await unlink(temporaryAlias);
    } catch {
      // The final name is already durably visible. A leftover staging link is safe to reconcile later.
    }
    return 'created';
  }

  async assembleAndHash(sourcePaths: readonly string[], destinationPath: string): Promise<FileDigest> {
    const destination = await this.resolveManagedParent(destinationPath, true);
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
    return { byteLength, sha256: hash.digest('hex') };
  }

  async hashFile(path: string): Promise<FileDigest> {
    const hash = createHash('sha256');
    let byteLength = 0;
    const stream = await this.openReadStream(path);
    for await (const value of stream) {
      const chunk = value as Buffer;
      byteLength += chunk.byteLength;
      hash.update(chunk);
    }
    return { byteLength, sha256: hash.digest('hex') };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(await this.resolveExistingManagedPath(path));
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    const safePath = await this.resolveManagedParent(path, false);
    await this.assertExistingPathInsideRoot(path);
    await rm(safePath, { force: true });
  }

  async removeTree(path: string): Promise<void> {
    const safePath = await this.resolveManagedParent(path, false);
    await this.assertExistingPathInsideRoot(path);
    await rm(safePath, { recursive: true, force: true });
  }

  private async resolveExistingManagedPath(path: string): Promise<string> {
    const candidate = this.resolveManagedPath(path);
    const [root, actual] = await Promise.all([realpath(this.root), realpath(candidate)]);
    this.assertManagedBoundary(root, actual);
    return actual;
  }

  private async assertExistingPathInsideRoot(path: string): Promise<void> {
    try {
      await this.resolveExistingManagedPath(path);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }

  private async resolveManagedParent(path: string, createParents: boolean): Promise<string> {
    const absolutePath = this.resolveManagedPath(path);
    let rootActual: string;
    try {
      if (createParents) await mkdir(this.root, { recursive: true });
      rootActual = await realpath(this.root);
    } catch (error) {
      if (!createParents && isCode(error, 'ENOENT')) return absolutePath;
      throw error;
    }

    const parentSegments = relative(this.root, dirname(absolutePath)).split(sep).filter(Boolean);
    let actualParent = rootActual;
    for (const [index, segment] of parentSegments.entries()) {
      const nextPath = join(actualParent, segment);
      if (createParents) {
        try {
          await mkdir(nextPath);
        } catch (error) {
          if (!isCode(error, 'EEXIST')) throw error;
        }
      }
      try {
        const nextActual = await realpath(nextPath);
        this.assertManagedBoundary(rootActual, nextActual);
        actualParent = nextActual;
      } catch (error) {
        if (!createParents && isCode(error, 'ENOENT')) {
          return join(nextPath, ...parentSegments.slice(index + 1), basename(absolutePath));
        }
        throw error;
      }
    }
    return join(actualParent, basename(absolutePath));
  }

  private assertManagedBoundary(root: string, actual: string): void {
    const fromRoot = relative(root, actual);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('managed storage symlink escapes storage root');
    }
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

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
