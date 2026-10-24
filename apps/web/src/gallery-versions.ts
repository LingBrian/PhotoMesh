// API coordinates are normalized integers in millionths of the source dimensions.
export type Crop = { x: number; y: number; width: number; height: number };
export type MediaTransform = { crop: Crop; rotation: 0 | 90 | 180 | 270 };
export type OriginalVersion = { sourceVersionId: null; sha256: string; mimeType: string | null; byteSize: number | null; filename: string; availability: string };
export type MediaVersion = { versionId: string; assetId: string; sourceVersionId: string | null; sourceSha256: string; outputSha256: string | null; mimeType: string | null; byteSize: number | null; width: number | null; height: number | null; transform: MediaTransform; status: string; createdAt: string; errorCode: string | null };
export type VersionCollection = { original: OriginalVersion; items: MediaVersion[] };
export type VersionRequest = { sourceVersionId: string | null; sourceSha256: string; transform: MediaTransform; idempotencyKey: string };

export function normalizeCrop(crop: Crop, rotation: MediaTransform['rotation'] = 90): Crop | null {
  const normalized = Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, Math.round(value * 1_000_000)])) as Crop;
  if (Object.values(normalized).some((value) => !Number.isInteger(value) || value < 0 || value > 1_000_000) || normalized.width < 1 || normalized.height < 1 || normalized.x + normalized.width > 1_000_000 || normalized.y + normalized.height > 1_000_000) return null;
  if (rotation === 0 && normalized.x === 0 && normalized.y === 0 && normalized.width === 1_000_000 && normalized.height === 1_000_000) return null;
  return normalized;
}

export async function loadMediaVersions(apiBase: string, token: string, libraryId: string, assetId: string, fetcher: typeof fetch = fetch): Promise<VersionCollection> {
  const response = await fetcher(`${apiBase.replace(/\/+$/, '')}/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/versions`, { headers: { authorization: `Bearer ${token.trim()}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(`versions:${response.status}`);
  return await response.json() as VersionCollection;
}

export async function createMediaVersion(apiBase: string, token: string, libraryId: string, assetId: string, input: VersionRequest, fetcher: typeof fetch = fetch): Promise<{ operationId: string; versionId: string; status: string }> {
  const response = await fetcher(`${apiBase.replace(/\/+$/, '')}/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/versions`, { method: 'POST', headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (response.status !== 202) throw new Error(`create-version:${response.status}`);
  return await response.json() as { operationId: string; versionId: string; status: string };
}

export async function getMediaVersion(apiBase: string, token: string, libraryId: string, assetId: string, versionId: string, fetcher: typeof fetch = fetch): Promise<MediaVersion> {
  const response = await fetcher(`${apiBase.replace(/\/+$/, '')}/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}`, { headers: { authorization: `Bearer ${token.trim()}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(`version-status:${response.status}`);
  return await response.json() as MediaVersion;
}

export async function loadVersionContent(apiBase: string, token: string, libraryId: string, assetId: string, versionId: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  const response = await fetcher(`${apiBase.replace(/\/+$/, '')}/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/content`, { headers: { authorization: `Bearer ${token.trim()}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(`version-content:${response.status}`);
  return await response.blob();
}

export const isTerminalVersionStatus = (status: string): boolean => ['ready', 'failed', 'cancelled', 'error'].includes(status.toLowerCase());
