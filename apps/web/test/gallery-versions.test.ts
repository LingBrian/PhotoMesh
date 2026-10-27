import { describe, expect, it, vi } from 'vitest';
import { createMediaVersion, getMediaVersion, isTerminalVersionStatus, loadMediaVersions, loadVersionContent, normalizeCrop } from '../src/gallery-versions.js';

const base = 'https://node.example';
const ids = ['lib/1', 'asset 2'] as const;

describe('media versions API', () => {
  it('converts normalized crop controls to integer millionths and rejects invalid rectangles', () => {
    expect(normalizeCrop({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 })).toEqual({ x: 100_000, y: 200_000, width: 500_000, height: 400_000 });
    expect(normalizeCrop({ x: 0.8, y: 0, width: 0.3, height: 1 })).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, width: 1, height: 1 }, 0)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, width: 1, height: 1 }, 90)).not.toBeNull();
  });
  it('loads originals and versions with bearer auth', async () => {
    const body = { original: { sourceVersionId: null, sha256: 'hash', mimeType: 'image/jpeg', byteSize: 10, filename: 'a.jpg', availability: 'online' }, items: [] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(loadMediaVersions(base, 'secret', ...ids, fetcher)).resolves.toEqual(body);
    expect(fetcher).toHaveBeenCalledWith(`${base}/v1/libraries/lib%2F1/assets/asset%202/versions`, expect.objectContaining({ headers: { authorization: 'Bearer secret' } }));
  });
  it('passes session cancellation signals through and preserves authorization status', async () => {
    const body = { original: { sourceVersionId: null, sha256: 'hash', mimeType: 'image/jpeg', byteSize: 10, filename: 'a.jpg', availability: 'online' }, items: [] };
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
    await loadMediaVersions(base, 'secret', ...ids, fetcher, controller.signal);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(loadMediaVersions(base, 'secret', ...ids, fetcher, controller.signal))
      .rejects.toMatchObject({ operation: 'versions', status: 403, message: 'versions:403' });
  });
  it('creates a version, polls, and reads exact response bytes', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ operationId: 'op', versionId: 'v1', status: 'queued' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ versionId: 'v1', status: 'processing' }))
      .mockResolvedValueOnce(Response.json({ versionId: 'v1', status: 'ready' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 4]), { status: 200 }));
    const input = { sourceVersionId: null, sourceSha256: 'hash', transform: { crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 90 as const }, idempotencyKey: 'idem' };
    await createMediaVersion(base, 'secret', ...ids, input, fetcher);
    const pending = await getMediaVersion(base, 'secret', ...ids, 'v1', fetcher);
    expect(isTerminalVersionStatus(pending.status)).toBe(false);
    const state = await getMediaVersion(base, 'secret', ...ids, 'v1', fetcher);
    expect(isTerminalVersionStatus(state.status)).toBe(true);
    const content = await loadVersionContent(base, 'secret', ...ids, 'v1', fetcher);
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([0, 255, 4]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify(input) });
  });
  it('fails closed on create and derived-content errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
    await expect(createMediaVersion(base, 'secret', ...ids, { sourceVersionId: null, sourceSha256: 'h', transform: { crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0 }, idempotencyKey: 'i' }, fetcher)).rejects.toThrow('create-version:500');
    await expect(loadVersionContent(base, 'secret', ...ids, 'v1', fetcher)).rejects.toThrow('version-content:500');
    expect(isTerminalVersionStatus('failed')).toBe(true);
    expect(isTerminalVersionStatus('processing')).toBe(false);
  });
});
