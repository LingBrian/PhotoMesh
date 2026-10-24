import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../src/db/repository.js';
import { MediaVersionError, MediaVersionService, type CreateMediaVersionRequest, type MediaVersionFileSystem } from '../src/media/media-version-service.js';
import { ImageTransformError, type MediaImageTransformer } from '../src/media/image-transformer.js';

const transform = {
  crop: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 },
  rotation: 90 as const
};
const sourceBytes = Buffer.from('immutable-source-image');
const sourceSha256 = hash(sourceBytes);
const openedDatabases: Database.Database[] = [];
const services: MediaVersionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const database of openedDatabases.splice(0)) database.close();
});

describe('MediaVersionService', () => {
  it('creates an immutable ready sibling and leaves source bytes untouched', async () => {
    const harness = await createHarness();
    const operation = await harness.service.createVersion('library', 'asset', request('first-key-012345'), 'local-admin');
    expect(operation.status).toBe('staging');
    await harness.service.waitForIdle();

    const version = harness.repository.getMediaVersion('library', 'asset', operation.versionId);
    expect(version).toMatchObject({
      status: 'ready', sourceVersionId: null, sourceSha256, outputSha256: hash(harness.outputBytes),
      mimeType: 'image/jpeg', byteSize: harness.outputBytes.byteLength, width: 2, height: 3,
      storageRef: `derived/${operation.versionId}/output.jpg`
    });
    expect(await harness.files.hashFile(version!.storageRef)).toEqual({
      byteLength: harness.outputBytes.byteLength, sha256: hash(harness.outputBytes)
    });
    expect(harness.originalBytes).toEqual(sourceBytes);
    expect(harness.repository.getMediaVersionSource('library', 'asset', null)?.sha256).toBe(sourceSha256);
  });

  it('preserves supported source MIME types and uses matching server-generated keys', async () => {
    for (const format of ['png', 'webp'] as const) {
      const harness = await createHarness({ format });
      const operation = await harness.service.createVersion('library', 'asset', request(`${format}-format-key-0123`), 'local-admin');
      await harness.service.waitForIdle();
      expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)).toMatchObject({
        status: 'ready', mimeType: harness.outputMime, storageRef: `derived/${operation.versionId}/output.${format}`
      });
    }
  });

  it('verifies stored size and SHA-256 before serving derived content', async () => {
    const harness = await createHarness();
    const operation = await harness.service.createVersion('library', 'asset', request('integrity-key-012345'), 'local-admin');
    await harness.service.waitForIdle();
    const version = harness.repository.getMediaVersion('library', 'asset', operation.versionId)!;
    const content = await harness.service.readVersionContent('library', 'asset', operation.versionId);
    expect(content).toMatchObject({ bytes: harness.outputBytes, sha256: hash(harness.outputBytes), byteSize: harness.outputBytes.byteLength });
    const uint8Stream = vi.spyOn(harness.files, 'openReadStream').mockImplementation(async () => Readable.from([new Uint8Array(harness.outputBytes)]));
    expect(await harness.service.readVersionContent('library', 'asset', operation.versionId)).toMatchObject({ bytes: harness.outputBytes });
    uint8Stream.mockRestore();
    const limitedReader = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: harness.openOriginal, maxOutputBytes: 1
    });
    services.push(limitedReader);
    await expect(limitedReader.readVersionContent('library', 'asset', operation.versionId))
      .rejects.toMatchObject({ code: 'VERSION_UNAVAILABLE' });

    harness.files.files.set(version.storageRef, Buffer.alloc(harness.outputBytes.byteLength + 2));
    const boundedReader = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: harness.openOriginal, maxOutputBytes: harness.outputBytes.byteLength + 1
    });
    services.push(boundedReader);
    await expect(boundedReader.readVersionContent('library', 'asset', operation.versionId))
      .rejects.toMatchObject({ code: 'VERSION_UNAVAILABLE' });

    const corrupted = Buffer.from(harness.outputBytes);
    corrupted[0] = corrupted[0]! ^ 1;
    harness.files.files.set(version.storageRef, corrupted);
    await expect(harness.service.readVersionContent('library', 'asset', operation.versionId))
      .rejects.toMatchObject({ code: 'VERSION_UNAVAILABLE' });
    harness.files.files.delete(version.storageRef);
    await expect(harness.service.readVersionContent('library', 'asset', operation.versionId))
      .rejects.toMatchObject({ code: 'VERSION_UNAVAILABLE' });
  });

  it('replays identical idempotency keys and rejects a different fingerprint', async () => {
    const harness = await createHarness();
    const input = request('same-key-01234567');
    const first = await harness.service.createVersion('library', 'asset', input, 'local-admin');
    await harness.service.waitForIdle();
    const replay = await harness.service.createVersion('library', 'asset', input, 'local-admin');
    expect(replay.versionId).toBe(first.versionId);
    await expect(harness.service.createVersion('library', 'asset', {
      ...input, transform: { ...transform, rotation: 180 }
    }, 'local-admin')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(1);
    expect(harness.transformer.transform).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent reuse of one idempotency key with a different transform', async () => {
    const harness = await createHarness();
    const left = request('conflicting-race-key-0123');
    const right = { ...left, transform: { ...transform, rotation: 180 as const } };
    const results = await Promise.allSettled([
      harness.service.createVersion('library', 'asset', left, 'local-admin'),
      harness.service.createVersion('library', 'asset', right, 'local-admin')
    ]);
    await harness.service.waitForIdle();
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(1);
  });

  it('keeps concurrent same-source edits as independent siblings without a head', async () => {
    const harness = await createHarness();
    const [left, right] = await Promise.all([
      harness.service.createVersion('library', 'asset', request('left-key-0123456'), 'local-admin'),
      harness.service.createVersion('library', 'asset', request('right-key-012345'), 'local-admin')
    ]);
    await harness.service.waitForIdle();
    expect(left.versionId).not.toBe(right.versionId);
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(2);
    expect(harness.repository.getMediaVersion('library', 'asset', left.versionId)?.sourceVersionId).toBeNull();
    expect(harness.repository.getMediaVersion('library', 'asset', right.versionId)?.sourceVersionId).toBeNull();
  });

  it('replays a staging key without queuing a duplicate active worker', async () => {
    const harness = await createHarness();
    let finish: ((value: Awaited<ReturnType<MediaImageTransformer['transform']>>) => void) | undefined;
    const transformSpy = vi.spyOn(harness.transformer, 'transform').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const input = request('active-replay-key-012345');
    const first = await harness.service.createVersion('library', 'asset', input, 'local-admin');
    await vi.waitFor(() => { if (!finish) throw new Error('worker has not reached transform'); });
    const replay = await harness.service.createVersion('library', 'asset', input, 'local-admin');
    expect(replay.versionId).toBe(first.versionId);
    finish!({ bytes: harness.outputBytes, mimeType: 'image/jpeg', width: 2, height: 3 });
    await harness.service.waitForIdle();
    expect(transformSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the same operation for concurrent retries using one idempotency key', async () => {
    const harness = await createHarness();
    const input = request('race-key-0123456789');
    const [left, right] = await Promise.all([
      harness.service.createVersion('library', 'asset', input, 'local-admin'),
      harness.service.createVersion('library', 'asset', input, 'local-admin')
    ]);
    expect(left.versionId).toBe(right.versionId);
    await harness.service.waitForIdle();
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(1);
  });

  it('binds every edit to the exact source hash and rejects offline or oversized sources', async () => {
    const changed = await createHarness({ openedBytes: Buffer.from('different-bytes') });
    await expect(changed.service.createVersion('library', 'asset', request('source-hash-012345'), 'local-admin'))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    const offline = await createHarness({ availability: 'offline' });
    await expect(offline.service.createVersion('library', 'asset', request('offline-key-012345'), 'local-admin'))
      .rejects.toMatchObject({ code: 'SOURCE_OFFLINE' });

    const staleHash = await createHarness();
    await expect(staleHash.service.createVersion('library', 'asset', {
      ...request('stale-hash-key-012345'), sourceSha256: 'c'.repeat(64)
    }, 'local-admin')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    const streamedTooLarge = await createHarness({
      maxInputBytes: sourceBytes.byteLength + 1, openedBytes: Buffer.alloc(sourceBytes.byteLength + 2)
    });
    await expect(streamedTooLarge.service.createVersion('library', 'asset', request('stream-limit-key-0123'), 'local-admin'))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });

    const smallLimit = await createHarness({ maxInputBytes: 4 });
    await expect(smallLimit.service.createVersion('library', 'asset', request('large-key-0123456'), 'local-admin'))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(smallLimit.transformer.inspect).not.toHaveBeenCalled();
  });

  it('rejects malformed hashes, source IDs, idempotency keys, rotations, and no-op edits', async () => {
    const harness = await createHarness();
    const valid = request('validation-key-012345');
    const invalidInputs: CreateMediaVersionRequest[] = [
      { ...valid, sourceSha256: 'bad' },
      { ...valid, sourceVersionId: '' },
      { ...valid, idempotencyKey: 'short' },
      { ...valid, transform: { ...transform, rotation: 45 as unknown as 0 } },
      { ...valid, transform: { crop: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 }, rotation: 0 } }
    ];
    for (const invalid of invalidInputs) {
      await expect(harness.service.createVersion('library', 'asset', invalid, 'local-admin'))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(harness.service.createVersion('', 'asset', valid, 'local-admin')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(harness.service.createVersion('library', '', valid, 'local-admin')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(harness.service.createVersion('library', 'asset', valid, '')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(harness.service.createVersion('library', 'asset', null as unknown as CreateMediaVersionRequest, 'local-admin'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(0);
  });

  it('rejects invalid crops and unsupported formats before staging an operation', async () => {
    const harness = await createHarness();
    await expect(harness.service.createVersion('library', 'asset', {
      ...request('invalid-crop-012345'), transform: { ...transform, crop: { ...transform.crop, x: 900_000, width: 200_000 } }
    }, 'local-admin')).rejects.toBeInstanceOf(MediaVersionError);
    vi.mocked(harness.transformer.inspect).mockResolvedValue({ format: 'gif', width: 2, height: 3, pages: 1 });
    await expect(harness.service.createVersion('library', 'asset', request('unsupported-0123456'), 'local-admin'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    expect(harness.repository.listMediaVersions('library', 'asset')).toHaveLength(0);
  });

  it('requires an existing ready parent version and an available original stream', async () => {
    const harness = await createHarness();
    const childRequest = { ...request('child-source-key-0123'), sourceVersionId: 'missing-parent' };
    await expect(harness.service.createVersion('library', 'asset', childRequest, 'local-admin'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    harness.repository.createMediaVersion({
      versionId: 'staging-parent', assetId: 'asset', libraryId: 'library', sourceVersionId: null,
      sourceSha256, transform, idempotencyScope: 'local-admin', idempotencyKey: 'parent-key-0123456789',
      requestFingerprint: 'c'.repeat(64), storageRef: 'derived/staging-parent/output.jpg',
      createdBy: 'local-admin', createdAt: '2026-10-24T00:00:00.000Z'
    });
    await expect(harness.service.createVersion('library', 'asset', {
      ...childRequest, sourceVersionId: 'staging-parent', sourceSha256
    }, 'local-admin')).rejects.toMatchObject({ code: 'VERSION_NOT_READY' });
    await expect(harness.service.readVersionContent('library', 'asset', 'absent-version'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(harness.service.readVersionContent('library', 'asset', 'staging-parent'))
      .rejects.toMatchObject({ code: 'VERSION_NOT_READY' });
    harness.repository.markMediaVersionFailed('staging-parent', 'processing_failed', '2026-10-24T00:00:01.000Z');
    await expect(harness.service.readVersionContent('library', 'asset', 'staging-parent'))
      .rejects.toMatchObject({ code: 'VERSION_FAILED' });
    await expect(harness.service.createVersion('library', 'asset', {
      ...childRequest, sourceVersionId: 'staging-parent', sourceSha256
    }, 'local-admin')).rejects.toMatchObject({ code: 'VERSION_FAILED' });

    const unavailable = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: async () => undefined
    });
    services.push(unavailable);
    await expect(unavailable.createVersion('library', 'asset', request('missing-stream-012345'), 'local-admin'))
      .rejects.toMatchObject({ code: 'SOURCE_OFFLINE' });
  });

  it('fails the accepted operation if source bytes change before the worker reads them', async () => {
    const harness = await createHarness();
    let reads = 0;
    const service = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: async () => Readable.from([reads++ === 0 ? sourceBytes : Buffer.from('changed-original')])
    });
    services.push(service);
    const operation = await service.createVersion('library', 'asset', request('worker-source-change-0123'), 'local-admin');
    await service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)).toMatchObject({
      status: 'failed', errorCode: 'source_changed'
    });
    expect(harness.files.files.size).toBe(0);
  });

  it('retains transiently offline operations for same-key retry', async () => {
    const harness = await createHarness();
    let reads = 0;
    const service = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: async () => reads++ === 1 ? undefined : Readable.from([sourceBytes])
    });
    services.push(service);
    const input = request('transient-source-key-0123');
    const operation = await service.createVersion('library', 'asset', input, 'local-admin');
    await service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)?.status).toBe('staging');
    const replay = await service.createVersion('library', 'asset', input, 'local-admin');
    expect(replay.versionId).toBe(operation.versionId);
    await service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)?.status).toBe('ready');
  });

  it('rejects animated, over-pixel-limit, and decoder-rejected inputs before staging', async () => {
    const animated = await createHarness();
    vi.mocked(animated.transformer.inspect).mockResolvedValue({ format: 'webp', width: 2, height: 3, pages: 2 });
    await expect(animated.service.createVersion('library', 'asset', request('animated-input-key-0123'), 'local-admin'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });

    const pixelLimit = await createHarness({ maxPixels: 5 });
    await expect(pixelLimit.service.createVersion('library', 'asset', request('pixel-limit-key-012345'), 'local-admin'))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });

    const decoderFailure = await createHarness();
    vi.mocked(decoderFailure.transformer.inspect).mockRejectedValue(new ImageTransformError('TOO_LARGE'));
    await expect(decoderFailure.service.createVersion('library', 'asset', request('decoder-limit-key-0123'), 'local-admin'))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(animated.repository.listMediaVersions('library', 'asset')).toHaveLength(0);
  });

  it('supports a ready derived version as an explicit source and retains the parent link', async () => {
    const harness = await createHarness();
    const first = await harness.service.createVersion('library', 'asset', request('parent-key-012345'), 'local-admin');
    await harness.service.waitForIdle();
    const parent = harness.repository.getMediaVersion('library', 'asset', first.versionId)!;
    const child = await harness.service.createVersion('library', 'asset', {
      ...request('child-key-0123456'), sourceVersionId: first.versionId, sourceSha256: parent.outputSha256!
    }, 'local-admin');
    await harness.service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', child.versionId)).toMatchObject({
      status: 'ready', sourceVersionId: first.versionId, sourceSha256: parent.outputSha256
    });
  });

  it('keeps transient storage failures staging and resumes them after restart', async () => {
    const harness = await createHarness();
    const write = vi.spyOn(harness.files, 'writeExclusive').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const operation = await harness.service.createVersion('library', 'asset', request('recovery-key-012345'), 'local-admin');
    await harness.service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)?.status).toBe('staging');
    write.mockRestore();
    await harness.service.stop();

    const recovered = new MediaVersionService({
      repository: harness.repository, fileSystem: harness.files, transformer: harness.transformer,
      openOriginal: harness.openOriginal, now: () => '2026-10-24T00:00:02.000Z'
    });
    services.push(recovered);
    await recovered.resumePending();
    await recovered.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)?.status).toBe('ready');
    expect(harness.originalBytes).toEqual(sourceBytes);
  });

  it('marks oversized and invalid transform outputs failed without publishing bytes', async () => {
    const oversized = await createHarness({ maxOutputBytes: 4 });
    const tooLarge = await oversized.service.createVersion('library', 'asset', request('output-limit-key-01234'), 'local-admin');
    await oversized.service.waitForIdle();
    expect(oversized.repository.getMediaVersion('library', 'asset', tooLarge.versionId)).toMatchObject({
      status: 'failed', errorCode: 'too_large'
    });
    expect(oversized.files.files.size).toBe(0);

    const wrongMime = await createHarness();
    vi.mocked(wrongMime.transformer.transform).mockResolvedValue({
      bytes: wrongMime.outputBytes, mimeType: 'image/png', width: 2, height: 3
    });
    const wrongFormat = await wrongMime.service.createVersion('library', 'asset', request('format-mismatch-key-0123'), 'local-admin');
    await wrongMime.service.waitForIdle();
    expect(wrongMime.repository.getMediaVersion('library', 'asset', wrongFormat.versionId)).toMatchObject({
      status: 'failed', errorCode: 'processing_failed'
    });
    expect(wrongMime.files.files.size).toBe(0);

    const invalidDimensions = await createHarness();
    vi.mocked(invalidDimensions.transformer.transform).mockResolvedValue({
      bytes: invalidDimensions.outputBytes, mimeType: 'image/jpeg', width: 0, height: 3
    });
    const invalidOutput = await invalidDimensions.service.createVersion('library', 'asset', request('dimension-limit-key-012'), 'local-admin');
    await invalidDimensions.service.waitForIdle();
    expect(invalidDimensions.repository.getMediaVersion('library', 'asset', invalidOutput.versionId)).toMatchObject({
      status: 'failed', errorCode: 'processing_failed'
    });
  });

  it('recovers a final object published before the ready database commit', async () => {
    const harness = await createHarness();
    const markReady = vi.spyOn(harness.repository, 'markMediaVersionReady').mockImplementationOnce(() => {
      throw new Error('simulated database interruption');
    });
    const operation = await harness.service.createVersion('library', 'asset', request('commit-recovery-key-0123'), 'local-admin');
    await harness.service.waitForIdle();
    const pending = harness.repository.getMediaVersion('library', 'asset', operation.versionId)!;
    expect(pending.status).toBe('staging');
    expect(harness.files.files.get(pending.storageRef)).toEqual(harness.outputBytes);

    markReady.mockRestore();
    await harness.service.resumePending();
    await harness.service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)?.status).toBe('ready');
    expect(harness.files.files.get(pending.storageRef)).toEqual(harness.outputBytes);
  });

  it('refuses to replace a corrupt or conflicting final object during recovery', async () => {
    const harness = await createHarness();
    const markReady = vi.spyOn(harness.repository, 'markMediaVersionReady').mockImplementationOnce(() => {
      throw new Error('simulated database interruption');
    });
    const operation = await harness.service.createVersion('library', 'asset', request('object-conflict-key-0123'), 'local-admin');
    await harness.service.waitForIdle();
    const version = harness.repository.getMediaVersion('library', 'asset', operation.versionId)!;
    markReady.mockRestore();
    vi.mocked(harness.transformer.transform).mockResolvedValue({
      bytes: Buffer.from('changed-version-output'), mimeType: 'image/jpeg', width: 2, height: 3
    });
    await harness.service.resumePending();
    await harness.service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)).toMatchObject({
      status: 'failed', errorCode: 'storage_corrupt'
    });
    expect(harness.files.files.get(version.storageRef)).toEqual(harness.outputBytes);
  });

  it('persists processing failures without publishing or deleting the original', async () => {
    const harness = await createHarness();
    vi.mocked(harness.transformer.transform).mockRejectedValue(new Error('decoder detail must not escape'));
    const operation = await harness.service.createVersion('library', 'asset', request('failure-key-012345'), 'local-admin');
    await harness.service.waitForIdle();
    expect(harness.repository.getMediaVersion('library', 'asset', operation.versionId)).toMatchObject({
      status: 'failed', errorCode: 'processing_failed', outputSha256: null
    });
    expect(harness.files.files.size).toBe(0);
    expect(harness.originalBytes).toEqual(sourceBytes);
  });
});

function request(idempotencyKey: string) {
  return { sourceVersionId: null, sourceSha256, transform, idempotencyKey };
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createHarness(options: {
  availability?: 'online' | 'cached' | 'offline' | 'missing';
  openedBytes?: Buffer;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxPixels?: number;
  format?: 'jpeg' | 'png' | 'webp';
} = {}) {
  const database = new Database(':memory:');
  openedDatabases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate();
  database.prepare('INSERT INTO assets (asset_id, library_id, origin_node_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('asset', 'library', 'node', 'photo', '2026-10-24T00:00:00.000Z');
  database.prepare(`INSERT INTO asset_files (file_id, asset_id, sha256, byte_size, media_role, storage_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('original-file', 'asset', sourceSha256, sourceBytes.byteLength, 'original', 'objects/asset/original.blob', '2026-10-24T00:00:00.000Z');
  database.prepare(`INSERT INTO file_locations (location_id, file_id, node_id, original_filename, original_path, source_kind,
    source_node_id, path_ref, storage_class, availability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('location', 'original-file', 'node', 'source.jpg', null, 'upload', null, 'objects/asset/original.blob',
      'managed', options.availability ?? 'online', '2026-10-24T00:00:00.000Z');

  const originalBytes = Buffer.from(options.openedBytes ?? sourceBytes);
  const outputBytes = Buffer.from('derived-version-bytes');
  const files = new MemoryMediaVersionFileSystem();
  const format = options.format ?? 'jpeg';
  const outputMime: 'image/jpeg' | 'image/png' | 'image/webp' = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
  const transformer: MediaImageTransformer = {
    inspect: vi.fn(async () => ({ format, width: 2, height: 3, pages: 1 })),
    transform: vi.fn(async () => ({ bytes: outputBytes, mimeType: outputMime, width: 2, height: 3 }))
  };
  const openOriginal = async () => Readable.from([originalBytes]);
  const service = new MediaVersionService({
    repository, fileSystem: files, transformer, openOriginal,
    now: () => '2026-10-24T00:00:01.000Z',
    ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.maxPixels === undefined ? {} : { maxPixels: options.maxPixels })
  });
  services.push(service);
  return { repository, service, files, transformer, originalBytes, outputBytes, outputMime, openOriginal };
}

class MemoryMediaVersionFileSystem implements MediaVersionFileSystem {
  readonly files = new Map<string, Buffer>();

  async openReadStream(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error('ENOENT');
    return Readable.from([Buffer.from(bytes)]);
  }

  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(path)) throw new Error('EEXIST');
    this.files.set(path, Buffer.from(bytes));
  }

  async flush(): Promise<void> {}

  async publishNoReplace(temporaryPath: string, finalPath: string): Promise<'created' | 'exists'> {
    if (this.files.has(finalPath)) return 'exists';
    const temporary = this.files.get(temporaryPath);
    if (!temporary) throw new Error('ENOENT');
    this.files.set(finalPath, temporary);
    this.files.delete(temporaryPath);
    return 'created';
  }

  async hashFile(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error('ENOENT');
    return { byteLength: bytes.byteLength, sha256: hash(bytes) };
  }

  async exists(path: string): Promise<boolean> { return this.files.has(path); }
}
