import { describe, expect, it, vi } from 'vitest';
import { GalleryPreviewError, loadAssetPreview } from '../src/gallery-preview.js';

const baseAsset = {
  assetId: 'asset/with space',
  kind: 'photo',
  availability: 'online' as const,
  byteSize: 3,
};

describe('loadAssetPreview', () => {
  it('reads original bytes only when explicitly requested and sends the node bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Blob(['img']), { status: 200 }));

    const result = await loadAssetPreview({
      apiBase: 'https://node.example/',
      token: 'test-token',
      asset: baseAsset,
      fetcher,
    });

    expect(result.size).toBe(3);
    expect(fetcher).toHaveBeenCalledWith(
      'https://node.example/v1/assets/asset%2Fwith%20space/original',
      expect.objectContaining({ cache: 'no-store', headers: { authorization: 'Bearer test-token' } }),
    );
  });

  it('does not request offline, missing, or non-photo assets', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const input = { apiBase: 'https://node.example', token: 'test-token', fetcher };

    await expect(loadAssetPreview({ ...input, asset: { ...baseAsset, availability: 'offline' } }))
      .rejects.toMatchObject({ code: 'source-offline' });
    await expect(loadAssetPreview({ ...input, asset: { ...baseAsset, availability: 'missing' } }))
      .rejects.toMatchObject({ code: 'source-missing' });
    await expect(loadAssetPreview({ ...input, asset: { ...baseAsset, kind: 'video' } }))
      .rejects.toMatchObject({ code: 'unsupported-media' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects known or actual payload sizes above the preview budget', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Blob(['12345']), { status: 200 }));
    const input = { apiBase: 'https://node.example', token: 'test-token', fetcher, maxBytes: 4 };

    await expect(loadAssetPreview({ ...input, asset: { ...baseAsset, byteSize: 5 } }))
      .rejects.toMatchObject({ code: 'preview-too-large' });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(loadAssetPreview({ ...input, asset: baseAsset }))
      .rejects.toMatchObject({ code: 'preview-too-large' });
  });

  it('cancels an unbounded response stream when the in-memory limit is crossed', async () => {
    let cancelled = false;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
      },
      cancel() { cancelled = true; },
    }), { status: 200 }));

    await expect(loadAssetPreview({
      apiBase: 'https://node.example', token: 'test-token', asset: baseAsset, fetcher, maxBytes: 4,
    })).rejects.toMatchObject({ code: 'preview-too-large' });
    expect(cancelled).toBe(true);
  });

  it('cancels error response bodies without consuming them', async () => {
    let cancelled = false;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }), { status: 404 }));

    await expect(loadAssetPreview({
      apiBase: 'https://node.example', token: 'test-token', asset: baseAsset, fetcher,
    })).rejects.toMatchObject({ code: 'asset-unavailable' });
    expect(cancelled).toBe(true);
  });

  it('maps offline and missing responses without exposing resource details', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'source_offline', requestId: 'req' }), {
      status: 409, headers: { 'content-type': 'application/json' }
    }));
    const input = { apiBase: 'https://node.example', token: 'test-token', asset: baseAsset, fetcher };
    await expect(loadAssetPreview(input)).rejects.toBeInstanceOf(GalleryPreviewError);
    await expect(loadAssetPreview(input)).rejects.toMatchObject({ code: 'source-offline' });

    fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: 'source_missing', requestId: 'req' }), {
      status: 409, headers: { 'content-type': 'application/json' }
    }));
    await expect(loadAssetPreview(input)).rejects.toMatchObject({ code: 'source-missing' });

    fetcher.mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(loadAssetPreview(input)).rejects.toMatchObject({ code: 'asset-unavailable' });
  });

  it('treats both 401 and 403 as invalid authorization so the session can be cleared', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const input = { apiBase: 'https://node.example', token: 'test-token', asset: baseAsset, fetcher };
    await expect(loadAssetPreview(input)).rejects.toMatchObject({ code: 'unauthorized' });
    fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(loadAssetPreview(input)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
