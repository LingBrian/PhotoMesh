import type { FileDigest, UploadFileSystem, StorageFailureCode } from '../../src/uploads/file-system.js';
import { createHash } from 'node:crypto';

export class VirtualFileSystem implements UploadFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly failures = new Map<string, StorageFailureCode[]>();
  private readonly capacityBytes: number;

  constructor(options: { capacityBytes?: number } = {}) {
    this.capacityBytes = options.capacityBytes ?? Number.POSITIVE_INFINITY;
  }

  seed(path: string, bytes: Uint8Array): void {
    this.files.set(path, Uint8Array.from(bytes));
  }

  failNext(operation: string, code: StorageFailureCode): void {
    this.failures.set(operation, [...(this.failures.get(operation) ?? []), code]);
  }

  read(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error(`missing virtual file: ${path}`), { code: 'ENOENT' });
    return Uint8Array.from(bytes);
  }

  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    this.raise('write');
    if (this.files.has(path)) throw Object.assign(new Error('file already exists'), { code: 'EEXIST' });
    this.ensureCapacity(bytes.byteLength, path);
    this.files.set(path, Uint8Array.from(bytes));
  }

  async flush(path: string): Promise<void> {
    this.raise('flush');
    if (!this.files.has(path)) throw Object.assign(new Error('file missing during flush'), { code: 'ENOENT' });
  }

  async publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'> {
    this.raise('publishNoReplace');
    const bytes = this.files.get(temporaryPath);
    if (!bytes) throw Object.assign(new Error('temporary file missing'), { code: 'ENOENT' });
    if (this.files.has(finalPath)) return 'exists';
    this.ensureCapacity(0, finalPath);
    this.files.set(finalPath, Uint8Array.from(bytes));
    this.files.delete(temporaryPath);
    return 'created';
  }

  async remove(path: string): Promise<void> {
    this.raise('remove');
    this.files.delete(path);
  }

  async removeTree(path: string): Promise<void> {
    this.raise('removeTree');
    const prefix = `${path.replace(/\/$/, '')}/`;
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async exists(path: string): Promise<boolean> {
    this.raise('exists');
    return this.files.has(path);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.raise('read');
    return this.read(path);
  }

  async hashFile(path: string, maxPrefixBytes = 0): Promise<FileDigest> {
    this.raise('hash');
    validatePrefixLimit(maxPrefixBytes);
    const bytes = this.read(path);
    return {
      byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(maxPrefixBytes > 0 ? { prefix: bytes.slice(0, maxPrefixBytes) } : {})
    };
  }

  async assembleAndHash(sourcePaths: readonly string[], destinationPath: string, maxPrefixBytes = 0): Promise<FileDigest> {
    this.raise('assemble');
    validatePrefixLimit(maxPrefixBytes);
    const parts = sourcePaths.map((path) => this.read(path));
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    this.ensureCapacity(total, destinationPath);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    this.files.set(destinationPath, result);
    return {
      byteLength: result.byteLength, sha256: createHash('sha256').update(result).digest('hex'),
      ...(maxPrefixBytes > 0 ? { prefix: result.slice(0, maxPrefixBytes) } : {})
    };
  }

  private raise(operation: string): void {
    const queued = this.failures.get(operation);
    const code = queued?.shift();
    if (queued && queued.length === 0) this.failures.delete(operation);
    if (code) throw Object.assign(new Error(`injected ${code} during ${operation}`), { code });
  }

  private ensureCapacity(additionalBytes: number, replacePath: string): void {
    const existing = this.files.get(replacePath)?.byteLength ?? 0;
    const usedBytes = [...this.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
    if (usedBytes - existing + additionalBytes > this.capacityBytes) {
      throw Object.assign(new Error('virtual filesystem is full'), { code: 'ENOSPC' });
    }
  }
}

function validatePrefixLimit(maxPrefixBytes: number): void {
  if (!Number.isSafeInteger(maxPrefixBytes) || maxPrefixBytes < 0 || maxPrefixBytes > 1024 * 1024) throw new Error('invalid bounded prefix size');
}
