import { describe, expect, it } from 'vitest';
import { mergeTimelinePage, validNextCursor } from '../src/timeline-pagination.js';

describe('timeline pagination', () => {
  it('keeps cursor page order and removes overlapping assets without losing the first record', () => {
    const first = [{ assetId: 'a' }, { assetId: 'b' }];
    const second = [{ assetId: 'b' }, { assetId: 'c' }, { assetId: 'd' }];
    expect(mergeTimelinePage(first, second)).toEqual([{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }, { assetId: 'd' }]);
    expect(mergeTimelinePage(first, [{ assetId: 'x' }], true)).toEqual([{ assetId: 'x' }]);
  });
  it('handles a 10k-item synthetic traversal without duplicates or gaps', () => {
    let loaded: Array<{ assetId: string }> = [];
    for (let page = 0; page < 100; page += 1) {
      const items = Array.from({ length: 100 }, (_, index) => ({ assetId: `asset-${page * 100 + index}` }));
      loaded = mergeTimelinePage(loaded, items);
    }
    expect(loaded).toHaveLength(10_000);
    expect(new Set(loaded.map((item) => item.assetId)).size).toBe(10_000);
    expect(loaded[0]?.assetId).toBe('asset-0');
    expect(loaded.at(-1)?.assetId).toBe('asset-9999');
  });
  it('normalizes missing cursors to the exhausted state', () => {
    expect(validNextCursor(undefined)).toBe('');
    expect(validNextCursor(null)).toBe('');
    expect(validNextCursor('next-2')).toBe('next-2');
  });
});
