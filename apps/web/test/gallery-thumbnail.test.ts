import { describe, expect, it } from 'vitest';
import { maxGalleryThumbnailBytes, readGalleryThumbnail } from '../src/gallery-thumbnail.js';

describe('readGalleryThumbnail', () => {
  it('reads a bounded non-empty response as WebP bytes', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
    const blob = await readGalleryThumbnail(response, 4);
    expect(blob?.type).toBe('image/webp');
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('cancels an oversized stream and rejects empty or unbounded responses', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
      cancel() { cancelled = true; }
    }));
    await expect(readGalleryThumbnail(response, 3)).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
    await expect(readGalleryThumbnail(new Response(null))).resolves.toBeUndefined();
    await expect(readGalleryThumbnail(new Response(new Uint8Array([1])), 0)).resolves.toBeUndefined();
    expect(maxGalleryThumbnailBytes).toBe(256 * 1024);
  });
});
