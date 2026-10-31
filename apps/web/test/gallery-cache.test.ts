import { describe, expect, it } from 'vitest';
import { defaultGalleryCacheSettings, normalizeGalleryCacheSettings, persistentCacheEvictions } from '../src/gallery-cache.js';

describe('gallery cache policy', () => {
  it('clamps persisted settings to safe bounds', () => {
    expect(normalizeGalleryCacheSettings({ maxBytes: 1, maxEntries: 9999 })).toEqual({ maxBytes: 1_048_576, maxEntries: 512 });
    expect(normalizeGalleryCacheSettings(null)).toEqual(defaultGalleryCacheSettings);
  });
  it('evicts oldest entries until both count and byte limits hold', () => {
    expect(persistentCacheEvictions([
      { key: 'old', byteSize: 80, lastUsed: 1 },
      { key: 'middle', byteSize: 40, lastUsed: 2 },
      { key: 'new', byteSize: 40, lastUsed: 3 }
    ], { maxBytes: 80, maxEntries: 10 })).toEqual(['old']);
    expect(persistentCacheEvictions([
      { key: 'a', byteSize: 1, lastUsed: 1 }, { key: 'b', byteSize: 1, lastUsed: 2 }
    ], { maxBytes: 100, maxEntries: 1 })).toEqual(['a']);
  });
});
