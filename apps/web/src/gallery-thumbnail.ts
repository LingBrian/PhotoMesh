export const maxGalleryThumbnailBytes = 256 * 1024;

export async function readGalleryThumbnail(response: Response, maxBytes = maxGalleryThumbnailBytes): Promise<Blob | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        try { await reader.cancel(); } catch { /* The size limit remains authoritative. */ }
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    try { await reader.cancel(); } catch { /* Best-effort cancellation on transport failure. */ }
    return undefined;
  } finally {
    reader.releaseLock();
  }
  if (byteLength < 1) return undefined;
  const parts = chunks.map((chunk) => {
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    return buffer;
  });
  return new Blob(parts, { type: 'image/webp' });
}
