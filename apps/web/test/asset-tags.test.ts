import { describe, expect, it } from 'vitest';
import { assetTagPath, mergeAssetTags, normalizeAssetTag } from '../src/asset-tags.js';

describe('asset tag helpers', () => {
  it('trims tags while preserving case and enforces the UTF-8 byte limit', () => {
    expect(normalizeAssetTag('  Summer  ')).toBe('Summer');
    expect(normalizeAssetTag('summer')).toBe('summer');
    expect(normalizeAssetTag('   ')).toBeUndefined();
    expect(normalizeAssetTag('a'.repeat(128))).toBe('a'.repeat(128));
    expect(normalizeAssetTag('a'.repeat(129))).toBeUndefined();
    expect(normalizeAssetTag('界'.repeat(43))).toBeUndefined();
  });

  it('merges server and legacy tags without overwriting or case-folding', () => {
    expect(mergeAssetTags(['Server', 'shared'], ['Legacy', 'shared', 'server']))
      .toEqual(['Legacy', 'Server', 'server', 'shared']);
  });

  it('encodes each tag route segment, including UTF-8 and slash characters', () => {
    expect(assetTagPath('library 1', 'asset/a', '家/庭 tag'))
      .toBe('/v1/libraries/library%201/assets/asset%2Fa/tags/%E5%AE%B6%2F%E5%BA%AD%20tag');
  });
});
