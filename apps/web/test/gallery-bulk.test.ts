import { describe, expect, it } from 'vitest';
import { maxBulkSelection, updateAssetSelection } from '../src/gallery-bulk.js';

describe('bounded bulk selection', () => {
  it('adds and removes unique selected asset IDs', () => {
    const first = updateAssetSelection(new Set<string>(), 'asset-1', true);
    const duplicate = updateAssetSelection(first.selected, 'asset-1', true);
    const removed = updateAssetSelection(duplicate.selected, 'asset-1', false);

    expect(first.selected).toEqual(new Set(['asset-1']));
    expect(duplicate.selected.size).toBe(1);
    expect(removed.selected.size).toBe(0);
    expect(first.limitReached).toBe(false);
  });

  it('enforces the application default cap of 100 selected assets', () => {
    const full = new Set(Array.from({ length: maxBulkSelection }, (_, index) => `asset-${index}`));
    const rejected = updateAssetSelection(full, 'asset-over-cap', true);

    expect(full.size).toBe(100);
    expect(rejected.selected).toEqual(full);
    expect(rejected.limitReached).toBe(true);
  });

  it('does not exceed the configured maximum and allows a later removal', () => {
    const full = new Set(['asset-1', 'asset-2']);
    const rejected = updateAssetSelection(full, 'asset-3', true, 2);
    const afterRemoval = updateAssetSelection(full, 'asset-1', false, 2);
    const accepted = updateAssetSelection(afterRemoval.selected, 'asset-3', true, 2);

    expect(rejected.selected).toEqual(full);
    expect(rejected.limitReached).toBe(true);
    expect(accepted.selected).toEqual(new Set(['asset-2', 'asset-3']));
    expect(accepted.limitReached).toBe(false);
  });
});
