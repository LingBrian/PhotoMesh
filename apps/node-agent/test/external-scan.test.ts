import { normalize as normalizePosix } from 'node:path/posix';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalLocationRecord, IndexedExternalLocation } from '../src/db/repository.js';
import { ExternalScanService, type AuthorizedExternalRoot, type ExternalFileSystem, type ExternalStat, type ExternalWatcher } from '../src/media/external-scan.js';

type NodeValue = { kind: ExternalStat['kind']; bytes?: Uint8Array; target?: string; denied?: boolean; modifiedAt?: number };

class VirtualExternalFileSystem implements ExternalFileSystem {
  readonly nodes = new Map<string, NodeValue>();
  readonly invalidNames = new Map<string, string[]>();
  addDirectory(path: string): void { this.nodes.set(this.key(path), { kind: 'directory' }); }
  addFile(path: string, bytes: string): void { this.nodes.set(this.key(path), { kind: 'file', bytes: new TextEncoder().encode(bytes) }); }
  addSymlink(path: string, target: string): void { this.nodes.set(this.key(path), { kind: 'symlink', target }); }
  setDenied(path: string, denied: boolean): void { const value = this.nodes.get(this.key(path)); if (value) value.denied = denied; }
  setModified(path: string, modifiedAt: number): void { const value = this.nodes.get(this.key(path)); if (value) value.modifiedAt = modifiedAt; }
  remove(path: string): void { this.nodes.delete(this.key(path)); }

  async lstat(path: string): Promise<ExternalStat> { return this.toStat(this.nodes.get(this.key(path)), false); }
  async stat(path: string): Promise<ExternalStat> { return this.toStat(this.nodes.get(this.key(path)), true); }
  async realpath(path: string): Promise<string> {
    let current = this.key(path);
    const visited = new Set<string>();
    for (;;) {
      const value = this.nodes.get(this.key(current));
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (value.kind !== 'symlink' || !value.target) return current;
      if (visited.has(this.key(current))) throw Object.assign(new Error('loop'), { code: 'ELOOP' });
      visited.add(this.key(current));
      current = this.key(value.target);
    }
  }
  async readdir(path: string): Promise<string[]> {
    const resolved = this.key(await this.realpath(path));
    const value = this.nodes.get(this.key(resolved));
    if (value?.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (!value || value.kind !== 'directory') throw Object.assign(new Error('not directory'), { code: 'ENOTDIR' });
    const prefix = resolved.endsWith('/') ? resolved : `${resolved}/`;
    const children = [...this.nodes.keys()].filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
    const names = [...new Set(children.filter((item) => item && !item.includes('/')))];
    return [...names, ...(this.invalidNames.get(this.key(resolved)) ?? [])];
  }
  async *readChunks(path: string): AsyncIterable<Uint8Array> {
    const value = this.nodes.get(this.key(await this.realpath(path)));
    if (value?.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (!value || value.kind !== 'file' || !value.bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    yield value.bytes.slice(0, 2);
    if (value.bytes.length > 2) yield value.bytes.slice(2);
  }
  private key(path: string): string { return normalizePosix(path.replaceAll('\\', '/')); }
  private toStat(value: NodeValue | undefined, follow: boolean): ExternalStat {
    if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (value.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (follow && value.kind === 'symlink' && value.target) return this.toStat(this.nodes.get(this.key(value.target)), true);
    return { kind: value.kind, size: value.bytes?.byteLength ?? 0, modifiedAt: value.modifiedAt ?? 1, identity: value.target ?? String([...this.nodes.values()].indexOf(value)) };
  }
}

class FakeRepository {
  readonly rows = new Map<string, { record: ExternalLocationRecord; availability: IndexedExternalLocation['availability'] }>();
  listExternalLocations(nodeId: string): IndexedExternalLocation[] {
    return [...this.rows.values()].filter(({ record }) => record.nodeId === nodeId).map(({ record, availability }) => ({ locationId: record.locationId, originalPath: record.originalPath, availability }));
  }
  recordExternalFile(record: ExternalLocationRecord): string {
    const existing = [...this.rows.values()].find(({ record: prior }) => prior.originalPath === record.originalPath && prior.nodeId === record.nodeId);
    if (existing?.record.sha256 === record.sha256) { existing.availability = 'online'; return existing.record.locationId; }
    if (existing) existing.availability = 'missing';
    this.rows.set(record.locationId, { record, availability: 'online' });
    return record.locationId;
  }
  setExternalAvailability(locationId: string, availability: IndexedExternalLocation['availability']): void {
    const value = this.rows.get(locationId); if (value) value.availability = availability;
  }
}

function setup(root: AuthorizedExternalRoot, fs: VirtualExternalFileSystem, repository = new FakeRepository(), watcher?: ExternalWatcher) {
  let nextId = 0;
  const service = new ExternalScanService({ nodeId: 'node-1', roots: [root], fileSystem: fs, repository, ...(watcher ? { watcher } : {}),
    id: () => `id-${++nextId}`, now: () => '2026-10-21T00:00:00.000Z', debounceMs: 5, intervalMs: 60_000 });
  return { service, repository };
}

function root(path = '/photos', pathStyle: 'posix' | 'win32' = 'posix'): AuthorizedExternalRoot {
  return { rootId: 'photos', libraryId: 'library-1', path, pathStyle };
}

describe('external read-only directory scanning', () => {
  it('rejects traversal and symlink escapes and detects symlink cycles', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/keep.jpg', 'original');
    fs.addSymlink('/photos/escape', '/secret'); fs.addDirectory('/secret'); fs.addFile('/secret/private.jpg', 'secret');
    fs.addSymlink('/photos/loop', '/photos');
    fs.addSymlink('/photos/self-loop', '/photos/self-loop');
    fs.invalidNames.set('/photos', ['..']);
    const { service, repository } = setup(root(), fs);

    const result = (await service.scanAll())[0]!;

    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['path_traversal', 'symlink_escape', 'symlink_cycle']));
    expect(result.complete).toBe(false);
    expect([...repository.rows.values()].map(({ record }) => record.originalPath)).toEqual(['/photos/keep.jpg']);
    expect(new TextDecoder().decode(fs.nodes.get('/photos/keep.jpg')?.bytes)).toBe('original');
  });

  it('retains distinct source records for identical content at different paths', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addDirectory('/photos/other');
    fs.addFile('/photos/a.jpg', 'same-bytes'); fs.addFile('/photos/other/b.jpg', 'same-bytes');
    const { service, repository } = setup(root(), fs);

    await service.scanAll();

    expect(repository.rows.size).toBe(2);
    expect(new Set([...repository.rows.values()].map(({ record }) => record.sha256)).size).toBe(1);
    expect([...repository.rows.values()].map(({ record }) => record.originalPath)).toEqual(expect.arrayContaining(['/photos/a.jpg', '/photos/other/b.jpg']));
  });

  it('reports Windows case collisions while allowing case-distinct Linux paths', async () => {
    const winFs = new VirtualExternalFileSystem();
    winFs.addDirectory('C:\\Photos'); winFs.addFile('C:\\Photos\\A.jpg', 'a'); winFs.addFile('C:\\Photos\\a.jpg', 'b');
    const winScan = setup(root('C:\\Photos', 'win32'), winFs);
    const winResult = (await winScan.service.scanAll())[0]!;
    expect(winResult.issues.map(({ code }) => code)).toContain('case_conflict');
    expect(winScan.repository.rows.size).toBe(1);

    const linuxFs = new VirtualExternalFileSystem();
    linuxFs.addDirectory('/photos'); linuxFs.addFile('/photos/A.jpg', 'a'); linuxFs.addFile('/photos/a.jpg', 'b');
    const linuxScan = setup(root(), linuxFs);
    const linuxResult = (await linuxScan.service.scanAll())[0]!;
    expect(linuxResult.issues.map(({ code }) => code)).not.toContain('case_conflict');
    expect(linuxScan.repository.rows.size).toBe(2);

    const sensitiveWinFs = new VirtualExternalFileSystem();
    sensitiveWinFs.addDirectory('C:\\Photos'); sensitiveWinFs.addFile('C:\\Photos\\A.jpg', 'a'); sensitiveWinFs.addFile('C:\\Photos\\a.jpg', 'b');
    const sensitiveWinScan = setup({ ...root('C:\\Photos', 'win32'), caseSensitive: true }, sensitiveWinFs);
    await sensitiveWinScan.service.scanAll();
    expect(sensitiveWinScan.repository.rows.size).toBe(2);
  });

  it('treats backslash as a valid POSIX filename character', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos');
    fs.addFile('/photos/literal/name.jpg', 'bytes');
    fs.invalidNames.set('/photos', ['literal\\name.jpg']);
    const { service, repository } = setup(root(), fs);

    const result = (await service.scanAll())[0]!;

    expect(result.issues.map(({ code }) => code)).not.toContain('path_traversal');
    expect([...repository.rows.values()].map(({ record }) => record.originalPath)).toContain('/photos/literal\\name.jpg');
  });

  it('marks permission loss offline and deletion missing without deleting indexed metadata', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'original');
    const { service, repository } = setup(root(), fs);
    await service.scanAll();
    const locationId = [...repository.rows.keys()][0]!;

    fs.setDenied('/photos/a.jpg', true);
    const denied = (await service.scanAll())[0]!;
    expect(repository.rows.get(locationId)?.availability).toBe('offline');
    expect(denied.offline).toBe(1);

    fs.setDenied('/photos/a.jpg', false); fs.remove('/photos/a.jpg');
    const deleted = (await service.scanAll())[0]!;
    expect(repository.rows.get(locationId)?.availability).toBe('missing');
    expect(repository.rows.size).toBe(1);
    expect(deleted.missing).toBe(1);
  });

  it('does not infer deletions from an incomplete directory listing', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'original');
    const { service, repository } = setup(root(), fs);
    await service.scanAll();
    fs.remove('/photos/a.jpg'); fs.nodes.get('/photos')!.denied = true;

    const result = (await service.scanAll())[0]!;

    expect(result.complete).toBe(false);
    expect(repository.rows.values().next().value?.availability).toBe('offline');
  });

  it('preserves configured-root aliases and follows symlinks only into an allowlisted root', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addDirectory('/approved'); fs.addFile('/approved/linked.jpg', 'approved');
    fs.addSymlink('/photos/approved-link.jpg', '/approved/linked.jpg');
    const repository = new FakeRepository();
    const service = new ExternalScanService({ nodeId: 'node-1', roots: [root(), { ...root('/approved'), rootId: 'approved' }],
      fileSystem: fs, repository, id: (() => { let i = 0; return () => `alias-${++i}`; })() });

    await service.scanAll();

    expect([...repository.rows.values()].map(({ record }) => record.originalPath)).toEqual(expect.arrayContaining([
      '/photos/approved-link.jpg', '/approved/linked.jpg'
    ]));
  });

  it('marks a path missing when it vanishes between listing and stat', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'a');
    const { service, repository } = setup(root(), fs);
    await service.scanAll();
    const locationId = [...repository.rows.keys()][0]!;
    fs.remove('/photos/a.jpg');
    fs.invalidNames.set('/photos', ['a.jpg']);

    const result = (await service.scanAll())[0]!;

    expect(result.issues.map(({ code }) => code)).toContain('missing');
    expect(repository.rows.get(locationId)?.availability).toBe('missing');
  });

  it('marks symlink targets offline when their approved target loses read permission', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addDirectory('/approved'); fs.addFile('/approved/a.jpg', 'a');
    fs.addSymlink('/photos/alias.jpg', '/approved/a.jpg');
    const repository = new FakeRepository();
    const service = new ExternalScanService({ nodeId: 'node-1', roots: [root(), { ...root('/approved'), rootId: 'approved' }], fileSystem: fs, repository });
    await service.scanAll();
    const alias = [...repository.rows.values()].find(({ record }) => record.originalPath === '/photos/alias.jpg')!;
    fs.setDenied('/approved/a.jpg', true);

    const result = (await service.scanAll())[0]!;

    expect(result.issues.map(({ code }) => code)).toContain('permission_denied');
    expect(repository.rows.get(alias.record.locationId)?.availability).toBe('offline');
  });

  it('rejects overlapping canonical authorization roots without indexing their contents', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addDirectory('/photos/nested'); fs.addFile('/photos/nested/a.jpg', 'a');
    const repository = new FakeRepository();
    const service = new ExternalScanService({ nodeId: 'node-1', roots: [root(), { ...root('/photos/nested'), rootId: 'nested' }], fileSystem: fs, repository });

    const results = await service.scanAll();

    expect(results.map((result) => result.issues[0]?.code)).toEqual(['invalid_root', 'invalid_root']);
    expect(repository.rows.size).toBe(0);
  });

  it('does not index a file whose identity changes during hashing', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'bytes');
    const originalRead = fs.readChunks.bind(fs);
    fs.readChunks = async function* (path: string): AsyncIterable<Uint8Array> {
      for await (const chunk of originalRead(path)) {
        yield chunk;
        this.setModified(path, 2);
      }
    };
    const { service, repository } = setup(root(), fs);

    const result = (await service.scanAll())[0]!;

    expect(result.issues.map(({ code }) => code)).toContain('unstable_file');
    expect(result.complete).toBe(false);
    expect(repository.rows.size).toBe(0);
  });

  it('detects a directory cycle and tolerates a watcher that cannot be installed', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addDirectory('/photos/mount-loop');
    const originalRealpath = fs.realpath.bind(fs);
    fs.realpath = async (path: string) => path === '/photos/mount-loop' ? '/photos' : originalRealpath(path);
    const watcher: ExternalWatcher = { watch: () => { throw new Error('watch unavailable'); } };
    const { service } = setup(root(), fs, new FakeRepository(), watcher);

    const [result] = await service.start();

    expect(result!.issues.map(({ code }) => code)).toContain('symlink_cycle');
    service.stop();
  });

  it('coalesces concurrent requests and runs one follow-up scan', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'a');
    const originalReaddir = fs.readdir.bind(fs);
    let unblock!: () => void;
    let signalEntered!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let calls = 0;
    fs.readdir = async (path: string) => {
      calls += 1;
      if (calls === 1) { signalEntered(); await gate; }
      return originalReaddir(path);
    };
    const { service } = setup(root(), fs);

    const first = service.scanAll();
    await entered;
    const concurrent = service.scanAll();
    unblock();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);

    expect(calls).toBe(2);
    expect(concurrentResult).toEqual(firstResult);
  });

  it('refreshes scans from watcher hints and closes handles on stop', async () => {
    vi.useFakeTimers();
    try {
      const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'one');
      let changed: (() => void) | undefined;
      let failed: (() => void) | undefined;
      let closed = 0;
      let watchCount = 0;
      const watcher: ExternalWatcher = { watch: (_path, onChange, onError) => {
        watchCount += 1; changed = onChange; failed = onError; return { close: () => { closed += 1; } };
      } };
      const { service } = setup(root(), fs, new FakeRepository(), watcher);
      await service.start();
      failed?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(watchCount).toBe(2);
      fs.addFile('/photos/b.jpg', 'two'); changed?.();
      await vi.advanceTimersByTimeAsync(10);
      expect((await service.scanAll())[0]?.indexed).toBe(2);
      service.stop();
      expect(closed).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects relative roots and marks an unreadable known path offline', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'a');
    const { service } = setup(root('photos'), fs);
    expect((await service.scanAll())[0]!.issues[0]?.code).toBe('invalid_root');
  });
});
