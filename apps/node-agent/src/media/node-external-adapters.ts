import { createReadStream, watch as fsWatch, type FSWatcher } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { ExternalEntryKind, ExternalFileSystem, ExternalStat, ExternalWatcher } from './external-scan.js';

function toExternalStat(value: Awaited<ReturnType<typeof stat>>): ExternalStat {
  let kind: ExternalEntryKind = 'other';
  if (value.isFile()) kind = 'file';
  else if (value.isDirectory()) kind = 'directory';
  else if (value.isSymbolicLink()) kind = 'symlink';
  return { kind, size: Number(value.size), modifiedAt: Number(value.mtimeMs), identity: `${value.dev}:${value.ino}` };
}

export class NodeExternalFileSystem implements ExternalFileSystem {
  async lstat(path: string): Promise<ExternalStat> { return toExternalStat(await lstat(path)); }
  async stat(path: string): Promise<ExternalStat> { return toExternalStat(await stat(path)); }
  async realpath(path: string): Promise<string> { return realpath(path); }
  async readdir(path: string): Promise<string[]> { return readdir(path); }

  async *readChunks(path: string): AsyncIterable<Uint8Array> {
    for await (const chunk of createReadStream(path)) yield chunk as Uint8Array;
  }

  openReadStream(path: string) { return createReadStream(path); }
}

export class NodeExternalWatcher implements ExternalWatcher {
  watch(path: string, onChange: () => void, onError?: () => void): FSWatcher {
    const watcher = fsWatch(path, { persistent: true }, onChange);
    watcher.on('error', () => { watcher.close(); onError?.(); });
    return watcher;
  }
}
