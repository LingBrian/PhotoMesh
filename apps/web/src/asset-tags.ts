export const maxAssetTagUtf8Bytes = 128;
export const maxLegacyTagsPerAsset = 64;

export function normalizeAssetTag(value: string): string | undefined {
  const tag = value.trim();
  if (!tag || new TextEncoder().encode(tag).byteLength > maxAssetTagUtf8Bytes) return undefined;
  return tag;
}

export function mergeAssetTags(...groups: readonly (readonly string[])[]): string[] {
  const values = new Set<string>();
  for (const group of groups) for (const tag of group) if (tag) values.add(tag);
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function assetTagPath(libraryId: string, assetId: string, tag: string): string {
  return `/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/tags/${encodeURIComponent(tag)}`;
}
