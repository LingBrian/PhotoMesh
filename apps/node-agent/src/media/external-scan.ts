import { createHash, randomUUID } from 'node:crypto';
import { basename as posixBasename, isAbsolute as posixIsAbsolute, join as posixJoin, relative as posixRelative, resolve as posixResolve, sep as posixSep } from 'node:path/posix';
import { basename as winBasename, isAbsolute as winIsAbsolute, join as winJoin, relative as winRelative, resolve as winResolve, sep as winSep } from 'node:path/win32';
import type { AssetKind, ExternalLocationRecord, IndexedExternalLocation } from '../db/repository.js';
import type { EventDraftFactory } from '../sync/event-envelope.js';
import { maxCaptureDatePrefixBytes, parseCaptureDatePrefix, unknownCaptureDateMetadata } from '../metadata/capture-date.js';

export type ExternalEntryKind = 'file' | 'directory' | 'symlink' | 'other';
export type ExternalPathStyle = 'posix' | 'win32';
export type ExternalAvailability = IndexedExternalLocation['availability'];

export interface ExternalStat {
  kind: ExternalEntryKind;
  size: number;
  modifiedAt: number;
  identity: string;
}

export interface ExternalFileSystem {
  lstat(path: string): Promise<ExternalStat>;
  stat(path: string): Promise<ExternalStat>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readChunks(path: string): AsyncIterable<Uint8Array>;
}

export interface ExternalScanRepository {
  listExternalLocations(nodeId: string): IndexedExternalLocation[];
  recordExternalFile(record: ExternalLocationRecord, eventFactory?: EventDraftFactory): string;
  setExternalAvailability(locationId: string, availability: ExternalAvailability): void;
}

/** Roots are the explicit authorization allowlist. A caller must not populate this from discovery. */
export interface AuthorizedExternalRoot {
  rootId: string;
  libraryId: string;
  path: string;
  pathStyle: ExternalPathStyle;
  caseSensitive?: boolean;
}

export interface ExternalScanIssue {
  code: 'invalid_root' | 'path_traversal' | 'case_conflict' | 'symlink_escape' | 'symlink_cycle' |
    'permission_denied' | 'missing' | 'unstable_file' | 'io_error';
}

export interface ExternalScanResult {
  rootId: string;
  complete: boolean;
  indexed: number;
  missing: number;
  offline: number;
  directories: string[];
  issues: ExternalScanIssue[];
}

export interface ExternalScanReview {
  rootId: string;
  libraryId: string;
  complete: boolean;
  indexed: number;
  missing: number;
  offline: number;
  directories: string[];
  issues: ExternalScanIssue[];
  locations: Array<{ locationId: string; originalPath: string; availability: ExternalAvailability }>;
}

export interface ExternalWatcher {
  watch(path: string, onChange: () => void, onError?: () => void): { close(): void };
}

export interface ExternalScanOptions {
  nodeId: string;
  roots: readonly AuthorizedExternalRoot[];
  fileSystem: ExternalFileSystem;
  repository: ExternalScanRepository;
  watcher?: ExternalWatcher;
  intervalMs?: number;
  debounceMs?: number;
  now?: () => string;
  id?: () => string;
  createEventDraft?: (record: ExternalLocationRecord) => EventDraftFactory;
  signPendingEvents?: () => Promise<void>;
}

interface PathOps {
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  join(base: string, part: string): string;
  relative(base: string, target: string): string;
  resolve(path: string): string;
  separator: string;
}

function pathOps(style: ExternalPathStyle): PathOps {
  return style === 'win32'
    ? { basename: winBasename, isAbsolute: winIsAbsolute, join: winJoin, relative: winRelative, resolve: winResolve, separator: winSep }
    : { basename: posixBasename, isAbsolute: posixIsAbsolute, join: posixJoin, relative: posixRelative, resolve: posixResolve, separator: posixSep };
}

function isWithin(ops: PathOps, root: string, candidate: string, caseSensitive: boolean): boolean {
  const rootKey = caseSensitive ? root : root.toLocaleLowerCase('en-US');
  const candidateKey = caseSensitive ? candidate : candidate.toLocaleLowerCase('en-US');
  const relative = ops.relative(rootKey, candidateKey);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${ops.separator}`) && !ops.isAbsolute(relative));
}

function isPermissionError(error: unknown): boolean {
  return hasCode(error, 'EACCES') || hasCode(error, 'EPERM');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function safeName(name: string, style: ExternalPathStyle): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') &&
    (style === 'posix' || !name.includes('\\')) && !name.includes('\0');
}

function kindFromPath(path: string): AssetKind {
  const lower = path.toLocaleLowerCase('en-US');
  if (/\.(mp4|mov|mkv|avi|webm|m4v)$/.test(lower)) return 'video';
  if (/\.(heic|heif|jpg|jpeg|png|gif|webp|tif|tiff|avif|bmp|dng|raw|cr2|cr3|nef|arw|orf|rw2)$/.test(lower)) return 'photo';
  return 'photo';
}

/** Read-only external-directory indexer. It never creates, renames, or deletes source files. */
export class ExternalScanService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<ExternalScanResult[]> | undefined;
  private rerun = false;
  private stopping = false;
  private readonly watches = new Map<string, { close(): void }>();
  private readonly latestResults = new Map<string, ExternalScanResult>();

  constructor(private readonly options: ExternalScanOptions) {}

  /** Returns the latest read-only report; it never starts a scan or mutates indexed state. */
  getReview(libraryId: string): ExternalScanReview[] {
    return this.options.roots.filter((root) => root.libraryId === libraryId).flatMap((root) => {
      const result = this.latestResults.get(root.rootId);
      if (!result) return [];
      const ops = pathOps(root.pathStyle);
      const caseSensitive = root.caseSensitive ?? root.pathStyle !== 'win32';
      const locations = this.options.repository.listExternalLocations(this.options.nodeId)
        .filter((location) => isWithin(ops, ops.resolve(root.path), location.originalPath, caseSensitive))
        .filter((location) => location.availability === 'missing' || location.availability === 'offline');
      return [{ ...result, libraryId: root.libraryId, locations }];
    });
  }

  async scanAll(): Promise<ExternalScanResult[]> {
    if (this.stopping) return [];
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let results: ExternalScanResult[];
      do {
        this.rerun = false;
        results = [];
        const overlappingRoots = await this.findOverlappingRoots();
        for (const root of this.options.roots) {
          const result = overlappingRoots.has(root) ? {
            rootId: root.rootId, complete: false, indexed: 0, missing: 0, offline: 0, directories: [], issues: [{ code: 'invalid_root' as const }]
          } : await this.scanRoot(root);
          this.latestResults.set(root.rootId, result);
          results.push(result);
        }
        if (!this.stopping) this.refreshWatches(results.flatMap((result) => result.directories));
      } while (this.rerun && !this.stopping);
      await this.options.signPendingEvents?.();
      return results;
    })();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  async resolveAuthorizedReadPath(path: string): Promise<string | undefined> {
    for (const root of this.options.roots) {
      const ops = pathOps(root.pathStyle);
      const caseSensitive = root.caseSensitive ?? root.pathStyle !== 'win32';
      if (!ops.isAbsolute(path) || !ops.isAbsolute(root.path)) continue;
      const displayRoot = ops.resolve(root.path);
      const displayPath = ops.resolve(path);
      if (!isWithin(ops, displayRoot, displayPath, caseSensitive)) continue;
      try {
        const canonicalRoot = await this.options.fileSystem.realpath(displayRoot);
        const canonicalPath = await this.options.fileSystem.realpath(displayPath);
        if (!isWithin(ops, canonicalRoot, canonicalPath, caseSensitive)) return undefined;
        if ((await this.options.fileSystem.stat(canonicalPath)).kind !== 'file') return undefined;
        return canonicalPath;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async start(): Promise<ExternalScanResult[]> {
    if (this.stopping) throw new Error('external scan service has stopped');
    const results = await this.scanAll();
    if (!this.stopping && !this.timer) this.timer = setInterval(() => { void this.scanAll().catch(() => undefined); }, this.options.intervalMs ?? 15 * 60_000);
    return results;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = undefined;
    this.debounce = undefined;
    this.rerun = false;
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    await this.running?.catch(() => undefined);
  }

  private refreshWatches(directories: string[]): void {
    if (!this.options.watcher) return;
    const desired = new Set(directories);
    for (const [path, watch] of this.watches) {
      if (!desired.has(path)) {
        watch.close();
        this.watches.delete(path);
      }
    }
    for (const path of desired) {
      if (this.watches.has(path)) continue;
      try {
        this.watches.set(path, this.options.watcher.watch(path, () => this.scheduleScan(), () => {
          this.watches.get(path)?.close();
          this.watches.delete(path);
          this.scheduleScan();
        }));
      } catch {
        // Watchers are hints; the periodic scan remains the recovery path.
      }
    }
  }

  private scheduleScan(): void {
    if (this.stopping) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.scanAll().catch(() => undefined); }, this.options.debounceMs ?? 250);
  }

  private async findOverlappingRoots(): Promise<Set<AuthorizedExternalRoot>> {
    const canonical: Array<{ root: AuthorizedExternalRoot; path: string }> = [];
    for (const root of this.options.roots) {
      const ops = pathOps(root.pathStyle);
      if (!ops.isAbsolute(root.path)) continue;
      try { canonical.push({ root, path: await this.options.fileSystem.realpath(ops.resolve(root.path)) }); } catch { /* scanRoot reports the root error */ }
    }
    const overlapping = new Set<AuthorizedExternalRoot>();
    for (let left = 0; left < canonical.length; left += 1) {
      for (let right = left + 1; right < canonical.length; right += 1) {
        const a = canonical[left]!;
        const b = canonical[right]!;
        if (a.root.pathStyle !== b.root.pathStyle) continue;
        const ops = pathOps(a.root.pathStyle);
        const caseSensitive = (a.root.caseSensitive ?? a.root.pathStyle !== 'win32') &&
          (b.root.caseSensitive ?? b.root.pathStyle !== 'win32');
        if (isWithin(ops, a.path, b.path, caseSensitive) || isWithin(ops, b.path, a.path, caseSensitive)) {
          overlapping.add(a.root);
          overlapping.add(b.root);
        }
      }
    }
    return overlapping;
  }

  private async scanRoot(root: AuthorizedExternalRoot): Promise<ExternalScanResult> {
    const ops = pathOps(root.pathStyle);
    const result: ExternalScanResult = { rootId: root.rootId, complete: true, indexed: 0, missing: 0, offline: 0, directories: [], issues: [] };
    if (!ops.isAbsolute(root.path)) {
      result.complete = false;
      result.issues.push({ code: 'invalid_root' });
      return result;
    }
    const caseSensitive = root.caseSensitive ?? root.pathStyle !== 'win32';
    const previous = this.options.repository.listExternalLocations(this.options.nodeId);
    let canonicalRoot: string;
    const displayRoot = ops.resolve(root.path);
    let rootStat: ExternalStat;
    try {
      canonicalRoot = await this.options.fileSystem.realpath(displayRoot);
      rootStat = await this.options.fileSystem.stat(canonicalRoot);
    } catch (error) {
      result.complete = false;
      result.issues.push({ code: isPermissionError(error) ? 'permission_denied' : 'invalid_root' });
      result.offline += this.setKnownAvailabilityWithin(previous, displayRoot, 'offline', ops, caseSensitive);
      return result;
    }
    if (rootStat.kind !== 'directory') {
      result.complete = false;
      result.issues.push({ code: 'invalid_root' });
      result.offline += this.setKnownAvailabilityWithin(previous, displayRoot, 'offline', ops, caseSensitive);
      return result;
    }

    const seen = new Set<string>();
    const collisionKeys = new Map<string, string>();
    const allCanonicalRoots = await Promise.all(this.options.roots.filter((item) => pathOps(item.pathStyle).isAbsolute(item.path)).map(async (item) => {
      try {
        return { item, real: await this.options.fileSystem.realpath(pathOps(item.pathStyle).resolve(item.path)) };
      } catch {
        return undefined;
      }
    }));
    const authorizedRoots = allCanonicalRoots.filter((item): item is { item: AuthorizedExternalRoot; real: string } => item !== undefined);
    const visitFile = async (displayPath: string): Promise<void> => {
      let before: ExternalStat;
      try {
        before = await this.options.fileSystem.stat(displayPath);
        if (before.kind !== 'file') return;
        const hash = createHash('sha256');
        let byteSize = 0;
        let capturePrefixSize = 0;
        const capturePrefixChunks: Uint8Array[] = [];
        for await (const chunk of this.options.fileSystem.readChunks(displayPath)) {
          hash.update(chunk);
          byteSize += chunk.byteLength;
          const captureBytes = Math.min(chunk.byteLength, maxCaptureDatePrefixBytes - capturePrefixSize);
          if (captureBytes > 0) {
            capturePrefixChunks.push(Uint8Array.from(chunk.subarray(0, captureBytes)));
            capturePrefixSize += captureBytes;
          }
        }
        const after = await this.options.fileSystem.stat(displayPath);
        if (before.identity !== after.identity || before.size !== after.size || before.modifiedAt !== after.modifiedAt || byteSize !== after.size) {
          result.issues.push({ code: 'unstable_file' });
          result.complete = false;
          return;
        }
        const filename = ops.basename(displayPath);
        const kind = kindFromPath(filename);
        const capturePrefix = new Uint8Array(capturePrefixSize);
        let captureOffset = 0;
        for (const chunk of capturePrefixChunks) { capturePrefix.set(chunk, captureOffset); captureOffset += chunk.byteLength; }
        const captureDate = kind === 'video' ? { ...unknownCaptureDateMetadata } : parseCaptureDatePrefix(capturePrefix);
        const record: ExternalLocationRecord = {
          locationId: this.id(), fileId: this.id(), assetId: this.id(), nodeId: this.options.nodeId,
          libraryId: root.libraryId, kind, filename, originalPath: displayPath, captureDate,
          byteSize, sha256: hash.digest('hex'), storageRef: `external:${this.id()}`, now: this.now()
        };
        this.options.repository.recordExternalFile(record, this.options.createEventDraft?.(record));
        seen.add(displayPath);
        result.indexed += 1;
      } catch (error) {
        if (isPermissionError(error)) {
          result.issues.push({ code: 'permission_denied' });
          this.setKnownAvailability(previous, displayPath, 'offline', ops, displayRoot, caseSensitive);
          result.offline += 1;
          result.complete = false;
        } else if (hasCode(error, 'ENOENT')) {
          result.issues.push({ code: 'missing' });
          this.setKnownAvailability(previous, displayPath, 'missing', ops, displayRoot, caseSensitive);
          result.missing += 1;
        } else {
          result.issues.push({ code: 'io_error' });
          result.complete = false;
        }
      }
    };

    const visitDirectory = async (displayPath: string, ancestors: ReadonlySet<string>): Promise<void> => {
      result.directories.push(displayPath);
      let names: string[];
      try {
        names = await this.options.fileSystem.readdir(displayPath);
      } catch (error) {
        result.issues.push({ code: isPermissionError(error) ? 'permission_denied' : 'io_error' });
        result.complete = false;
        if (isPermissionError(error)) result.offline += this.setKnownAvailabilityWithin(previous, displayPath, 'offline', ops, caseSensitive);
        return;
      }
      for (const name of names) {
        if (!safeName(name, root.pathStyle)) {
          result.issues.push({ code: 'path_traversal' });
          result.complete = false;
          continue;
        }
        const candidate = ops.join(displayPath, name);
        if (!isWithin(ops, displayRoot, candidate, caseSensitive)) {
          result.issues.push({ code: 'path_traversal' });
          result.complete = false;
          continue;
        }
        const collisionKey = caseSensitive ? candidate : candidate.toLocaleLowerCase('en-US');
        const priorPath = collisionKeys.get(collisionKey);
        if (priorPath && priorPath !== candidate) {
          result.issues.push({ code: 'case_conflict' });
          result.complete = false;
          continue;
        }
        collisionKeys.set(collisionKey, candidate);
        let stat: ExternalStat;
        try {
          stat = await this.options.fileSystem.lstat(candidate);
        } catch (error) {
          if (isPermissionError(error)) {
            result.issues.push({ code: 'permission_denied' });
            result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
            result.complete = false;
          } else if (hasCode(error, 'ENOENT')) {
            result.issues.push({ code: 'missing' });
            this.setKnownAvailability(previous, candidate, 'missing', ops, displayRoot, caseSensitive);
            result.missing += 1;
          } else {
            result.issues.push({ code: 'io_error' });
            result.complete = false;
          }
          continue;
        }
        if (stat.kind === 'symlink') {
          let target: string;
          try {
            target = await this.options.fileSystem.realpath(candidate);
          } catch (error) {
            if (isPermissionError(error)) {
              result.issues.push({ code: 'permission_denied' });
              result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
              result.complete = false;
            } else if (hasCode(error, 'ELOOP')) {
              result.issues.push({ code: 'symlink_cycle' });
              result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
              result.complete = false;
            } else if (hasCode(error, 'ENOENT')) {
              result.issues.push({ code: 'missing' });
              this.setKnownAvailability(previous, candidate, 'missing', ops, displayRoot, caseSensitive);
              result.missing += 1;
            } else {
              result.issues.push({ code: 'io_error' });
              result.complete = false;
            }
            continue;
          }
          const authorized = authorizedRoots.some(({ item, real }) => isWithin(pathOps(item.pathStyle), real, target, item.caseSensitive ?? item.pathStyle !== 'win32'));
          if (!authorized) {
            result.issues.push({ code: 'symlink_escape' });
            result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
            result.complete = false;
            continue;
          }
          let targetStat: ExternalStat;
          try {
            targetStat = await this.options.fileSystem.stat(target);
          } catch (error) {
            if (isPermissionError(error)) {
              result.issues.push({ code: 'permission_denied' });
              this.setKnownAvailability(previous, candidate, 'offline', ops, displayRoot, caseSensitive);
              result.offline += 1;
              result.complete = false;
            } else if (hasCode(error, 'ENOENT')) {
              result.issues.push({ code: 'missing' });
              this.setKnownAvailability(previous, candidate, 'missing', ops, displayRoot, caseSensitive);
              result.missing += 1;
            } else {
              result.issues.push({ code: 'io_error' });
              result.complete = false;
            }
            continue;
          }
          if (targetStat.kind === 'directory') {
            if (ancestors.has(target)) {
              result.issues.push({ code: 'symlink_cycle' });
              result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
              result.complete = false;
              continue;
            }
            await visitDirectory(candidate, new Set([...ancestors, target]));
          } else if (targetStat.kind === 'file') await visitFile(candidate);
        } else if (stat.kind === 'directory') {
          const target = await this.options.fileSystem.realpath(candidate).catch(() => candidate);
          if (ancestors.has(target)) {
            result.issues.push({ code: 'symlink_cycle' });
            result.offline += this.setKnownAvailabilityWithin(previous, candidate, 'offline', ops, caseSensitive);
            result.complete = false;
            continue;
          }
          await visitDirectory(candidate, new Set([...ancestors, target]));
        } else if (stat.kind === 'file') await visitFile(candidate);
      }
    };

    await visitDirectory(displayRoot, new Set([canonicalRoot]));
    if (result.complete) {
      for (const location of previous) {
        if (isWithin(ops, displayRoot, location.originalPath, caseSensitive) && !seen.has(location.originalPath) && location.availability !== 'missing') {
          this.options.repository.setExternalAvailability(location.locationId, 'missing');
          result.missing += 1;
        }
      }
    }
    return result;
  }

  private setKnownAvailability(
    locations: readonly IndexedExternalLocation[], path: string, availability: ExternalAvailability,
    ops: PathOps, root: string, caseSensitive: boolean
  ): void {
    if (!isWithin(ops, root, path, caseSensitive)) return;
    const location = locations.find((item) => item.originalPath === path);
    if (location) this.options.repository.setExternalAvailability(location.locationId, availability);
  }

  private setKnownAvailabilityWithin(
    locations: readonly IndexedExternalLocation[], path: string, availability: ExternalAvailability,
    ops: PathOps, caseSensitive: boolean
  ): number {
    let changed = 0;
    for (const location of locations) {
      if (isWithin(ops, path, location.originalPath, caseSensitive)) {
        this.options.repository.setExternalAvailability(location.locationId, availability);
        changed += 1;
      }
    }
    return changed;
  }

  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private id(): string { return (this.options.id ?? randomUUID)(); }
}
