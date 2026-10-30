import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface LocalBackupSource { relativePath: string; sourcePath: string; kind: 'database' | 'event-log' | 'object' | 'config-reference' }
export interface LocalBackupEntry { relativePath: string; kind: LocalBackupSource['kind']; byteSize: number; sha256: string }
export interface LocalBackupManifest { formatVersion: 1; createdAt: string; entries: LocalBackupEntry[]; digest: string }

function isWithin(parent: string, child: string): boolean {
  const result = relative(parent, child);
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}

function canonicalEntries(entries: readonly LocalBackupEntry[]): string { return JSON.stringify(entries); }
function digest(entries: readonly LocalBackupEntry[]): string { return createHash('sha256').update(canonicalEntries(entries)).digest('hex'); }

export async function createLocalBackup(sources: readonly LocalBackupSource[], destination: string, createdAt: string): Promise<LocalBackupManifest> {
  if (!isAbsolute(destination)) throw new Error('backup destination must be absolute');
  const target = resolve(destination);
  await mkdir(target, { recursive: true });
  const targetReal = await realpath(target);
  const entries: LocalBackupEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.relativePath || isAbsolute(source.relativePath) || source.relativePath.includes('..') || seen.has(source.relativePath)) throw new Error('invalid or duplicate backup path');
    seen.add(source.relativePath);
    const sourceReal = await realpath(source.sourcePath);
    if (isWithin(sourceReal, targetReal) || isWithin(targetReal, sourceReal)) throw new Error('backup destination overlaps source');
    const sourceStat = await stat(sourceReal);
    if (!sourceStat.isFile()) throw new Error('backup source must be a file');
    const bytes = await readFile(sourceReal);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const output = join(targetReal, source.relativePath);
    if (!isWithin(targetReal, resolve(output))) throw new Error('invalid backup path');
    await mkdir(dirname(output), { recursive: true });
    await cp(sourceReal, output, { errorOnExist: true, force: false });
    const copied = await readFile(output);
    const copiedHash = createHash('sha256').update(copied).digest('hex');
    if (copiedHash !== sha256) throw new Error('backup hash verification failed');
    entries.push({ relativePath: source.relativePath, kind: source.kind, byteSize: bytes.byteLength, sha256 });
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest: LocalBackupManifest = { formatVersion: 1, createdAt, entries, digest: digest(entries) };
  await writeFile(join(targetReal, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return manifest;
}
