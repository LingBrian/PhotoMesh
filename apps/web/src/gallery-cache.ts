export interface GalleryCacheSettings {
  maxBytes: number;
  maxEntries: number;
}

export const defaultGalleryCacheSettings: GalleryCacheSettings = { maxBytes: 8 * 1024 * 1024, maxEntries: 128 };
export const galleryCacheBounds = { minBytes: 1 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, minEntries: 16, maxEntries: 512 } as const;

export function normalizeGalleryCacheSettings(value: Partial<GalleryCacheSettings> | null | undefined): GalleryCacheSettings {
  const maxBytes = value && typeof value.maxBytes === 'number' && Number.isSafeInteger(value.maxBytes) ? value.maxBytes : defaultGalleryCacheSettings.maxBytes;
  const maxEntries = value && typeof value.maxEntries === 'number' && Number.isSafeInteger(value.maxEntries) ? value.maxEntries : defaultGalleryCacheSettings.maxEntries;
  return {
    maxBytes: Math.min(galleryCacheBounds.maxBytes, Math.max(galleryCacheBounds.minBytes, maxBytes)),
    maxEntries: Math.min(galleryCacheBounds.maxEntries, Math.max(galleryCacheBounds.minEntries, maxEntries))
  };
}

export interface PersistentCacheEntry { key: string; byteSize: number; lastUsed: number }

/** Returns oldest keys that must be removed; input order is not mutated. */
export function persistentCacheEvictions(entries: readonly PersistentCacheEntry[], settings: GalleryCacheSettings): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.byteSize, 0);
  const ordered = [...entries].sort((left, right) => left.lastUsed - right.lastUsed || left.key.localeCompare(right.key));
  const evicted: string[] = [];
  while (ordered.length > settings.maxEntries || total > settings.maxBytes) {
    const entry = ordered.shift();
    if (!entry) break;
    total -= entry.byteSize;
    evicted.push(entry.key);
  }
  return evicted;
}
