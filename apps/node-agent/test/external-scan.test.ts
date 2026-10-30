import { normalize as normalizePosix } from 'node:path/posix';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalLocationRecord, IndexedExternalLocation } from '../src/db/repository.js';
import { ExternalScanService, type AuthorizedExternalRoot, type ExternalFileSystem, type ExternalStat, type ExternalWatcher } from '../src/media/external-scan.js';
import { makeUnsignedEvent } from '../src/sync/event-envelope.js';
import { jpegWithExifCaptureDate } from './support/capture-date-fixture.js';

type NodeValue = { kind: ExternalStat['kind']; bytes?: Uint8Array; target?: string; denied?: boolean; modifiedAt?: number };

class VirtualExternalFileSystem implements ExternalFileSystem {
  readonly nodes = new Map<string, NodeValue>();
  readonly invalidNames = new Map<string, string[]>();
  addDirectory(path: string): void { this.nodes.set(this.key(path), { kind: 'directory' }); }
  addFile(path: string, bytes: string): void { this.nodes.set(this.key(path), { kind: 'file', bytes: new TextEncoder().encode(bytes) }); }
  addFileBytes(path: string, bytes: Uint8Array): void { this.nodes.set(this.key(path), { kind: 'file', bytes: Uint8Array.from(bytes) }); }
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
  recordExternalFile(record: ExternalLocationRecord, eventFactory?: import('../src/sync/event-envelope.js').EventDraftFactory): string {
    const existing = [...this.rows.values()].find(({ record: prior }) => prior.originalPath === record.originalPath && prior.nodeId === record.nodeId);
    if (existing?.record.sha256 === record.sha256) { existing.availability = 'online'; return existing.record.locationId; }
    if (existing) existing.availability = 'missing';
    eventFactory?.({ authorSequence: this.rows.size + 1, causalParents: [] });
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
  it('exposes a read-only review for missing paths without requiring confirmation writes', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/gone.jpg', 'gone-original');
    const { service, repository } = setup(root(), fs);
    await service.scanAll();
    fs.remove('/photos/gone.jpg');
    const results = await service.scanAll();
    expect(results[0]?.complete).toBe(true);
    const review = service.getReview('library-1');
    expect(review[0]?.locations).toEqual([{ locationId: expect.any(String), originalPath: '/photos/gone.jpg', availability: 'missing' }]);
    expect(repository.rows.size).toBe(1);
  });

  it('does not infer unobserved paths as missing after an incomplete scan', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/kept.jpg', 'kept-original');
    const { service } = setup(root(), fs);
    await service.scanAll();
    fs.setDenied('/photos', true);
    const results = await service.scanAll();
    expect(results[0]?.complete).toBe(false);
    expect(service.getReview('library-1')[0]?.locations).toEqual([{ locationId: expect.any(String), originalPath: '/photos/kept.jpg', availability: 'offline' }]);
    expect(service.getReview('library-1')[0]?.missing).toBe(0);
  });

  it('resolves original reads only inside an explicitly authorized real root', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/visible.jpg', 'visible-original');
    fs.addDirectory('/private'); fs.addFile('/private/secret.jpg', 'private-original');
    fs.addSymlink('/photos/escape.jpg', '/private/secret.jpg');
    const { service } = setup(root(), fs);

    await expect(service.resolveAuthorizedReadPath('/photos/visible.jpg')).resolves.toBe('/photos/visible.jpg');
    await expect(service.resolveAuthorizedReadPath('/private/secret.jpg')).resolves.toBeUndefined();
    await expect(service.resolveAuthorizedReadPath('/photos/escape.jpg')).resolves.toBeUndefined();
  });

  it('reserves one asset index event per newly indexed source and signs after the scan batch', async () => {
    const fs = new VirtualExternalFileSystem();
    fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'original-a'); fs.addFile('/photos/b.jpg', 'original-b');
    const repository = new FakeRepository();
    let drafts = 0;
    let signed = 0;
    const service = new ExternalScanService({
      nodeId: 'QmTestPeerId123456789', roots: [root()], fileSystem: fs, repository,
      createEventDraft: (record) => (context) => {
        drafts += 1;
        return makeUnsignedEvent({ libraryId: record.libraryId, authorPeerId: 'QmTestPeerId123456789',
          authorSequence: context.authorSequence, causalParents: context.causalParents, eventType: 'asset.indexed',
          createdAt: '2026-10-21T00:00:00.000Z', payload: { assetId: record.assetId, originNodeId: record.nodeId,
            kind: record.kind, sha256: record.sha256, byteLength: record.byteSize } });
      },
      signPendingEvents: async () => { signed += 1; }
    });
    await service.scanAll();
    expect(drafts).toBe(2);
    expect(signed).toBe(1);
    expect(fs.nodes.get('/photos/a.jpg')?.bytes).toEqual(new TextEncoder().encode('original-a'));
  });

  it('extracts bounded EXIF capture provenance during a read-only external scan', async () => {
    const fs = new VirtualExternalFileSystem();
    const original = jpegWithExifCaptureDate();
    fs.addDirectory('/photos');
    fs.addFileBytes('/photos/camera.jpg', original);
    const { service, repository } = setup(root(), fs);

    await service.scanAll();

    const record = [...repository.rows.values()][0]?.record;
    expect(record?.captureDate).toEqual({
      capturedAt: '2024-04-02T09:04:05.000Z', localTime: '2024-04-02T12:04:05.000', offsetMinutes: 180,
      source: 'exif_offset', confidence: 'high'
    });
    expect(fs.nodes.get('/photos/camera.jpg')?.bytes).toEqual(original);
  });

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
    await service.stop();
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

  it('drains an in-flight scan and prevents watchers from reopening during shutdown', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'a');
    const originalReaddir = fs.readdir.bind(fs);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let blocked = false;
    fs.readdir = async (path: string) => {
      if (!blocked) { blocked = true; enter(); await gate; }
      return originalReaddir(path);
    };
    let watchCount = 0;
    const watcher: ExternalWatcher = { watch: () => { watchCount += 1; return { close: vi.fn() }; } };
    const { service } = setup(root(), fs, new FakeRepository(), watcher);
    const starting = service.start();
    await entered;
    const stopping = service.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    expect(stopped).toBe(false);
    release();
    await Promise.all([starting, stopping]);
    expect(stopped).toBe(true);
    expect(watchCount).toBe(0);
    await expect(service.scanAll()).resolves.toEqual([]);
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
      await service.stop();
      expect(closed).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects relative roots and marks an unreadable known path offline', async () => {
    const fs = new VirtualExternalFileSystem(); fs.addDirectory('/photos'); fs.addFile('/photos/a.jpg', 'a');
    const { service } = setup(root('photos'), fs);
    expect((await service.scanAll())[0]!.issues[0]?.code).toBe('invalid_root');
  });
});
