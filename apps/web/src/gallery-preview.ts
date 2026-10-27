export type PreviewAvailability = 'online' | 'cached' | 'offline' | 'missing';

export type PreviewAsset = {
  assetId: string;
  kind: string;
  availability: PreviewAvailability;
  byteSize: number;
};

export type GalleryPreviewErrorCode =
  | 'unsupported-media'
  | 'source-offline'
  | 'preview-too-large'
  | 'unauthorized'
  | 'asset-unavailable'
  | 'request-failed';

export class GalleryPreviewError extends Error {
  constructor(readonly code: GalleryPreviewErrorCode) {
    super(code);
    this.name = 'GalleryPreviewError';
  }
}

export const maxGalleryPreviewBytes = 32 * 1024 * 1024;

async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Do not consume error payloads. */ }
}

type LoadAssetPreviewInput = {
  apiBase: string;
  token: string;
  asset: PreviewAsset;
  fetcher?: typeof fetch;
  maxBytes?: number;
  signal?: AbortSignal;
};

export async function loadAssetPreview({
  apiBase,
  token,
  asset,
  fetcher = fetch,
  maxBytes = maxGalleryPreviewBytes,
  signal,
}: LoadAssetPreviewInput): Promise<Blob> {
  if (asset.kind !== 'photo') throw new GalleryPreviewError('unsupported-media');
  if (asset.availability !== 'online' && asset.availability !== 'cached') {
    throw new GalleryPreviewError('source-offline');
  }
  if (!token.trim()) throw new GalleryPreviewError('unauthorized');
  if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0 || asset.byteSize > maxBytes) {
    throw new GalleryPreviewError('preview-too-large');
  }

  const base = apiBase.trim().replace(/\/+$/, '');
  const url = `${base}/v1/assets/${encodeURIComponent(asset.assetId)}/original`;
  let response: Response;
  const requestInit: RequestInit = {
    cache: 'no-store',
    headers: { authorization: `Bearer ${token.trim()}` },
  };
  if (signal) requestInit.signal = signal;
  try {
    response = await fetcher(url, requestInit);
  } catch {
    throw new GalleryPreviewError('request-failed');
  }

  if (response.status === 409) {
    await discardResponseBody(response);
    throw new GalleryPreviewError('source-offline');
  }
  if (response.status === 401 || response.status === 403) {
    await discardResponseBody(response);
    throw new GalleryPreviewError('unauthorized');
  }
  if (response.status === 404) {
    await discardResponseBody(response);
    throw new GalleryPreviewError('asset-unavailable');
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw new GalleryPreviewError('request-failed');
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* Stop consuming an over-budget response. */ }
    throw new GalleryPreviewError('preview-too-large');
  }
  if (!response.body) throw new GalleryPreviewError('unsupported-media');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* The size limit is still authoritative. */ }
        throw new GalleryPreviewError('preview-too-large');
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof GalleryPreviewError) throw cause;
    try { await reader.cancel(cause); } catch { /* Best-effort stream cleanup. */ }
    throw new GalleryPreviewError('request-failed');
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new GalleryPreviewError('unsupported-media');
  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([buffer], { type: response.headers.get('content-type') ?? 'application/octet-stream' });
}
