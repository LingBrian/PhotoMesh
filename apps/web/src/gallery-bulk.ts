export const maxBulkSelection = 100;

export type AssetSelectionUpdate = { selected: Set<string>; limitReached: boolean };

export function updateAssetSelection(
  current: ReadonlySet<string>,
  assetId: string,
  selected: boolean,
  maximum = maxBulkSelection,
): AssetSelectionUpdate {
  const next = new Set(current);
  if (!assetId) return { selected: next, limitReached: false };
  if (!selected) {
    next.delete(assetId);
    return { selected: next, limitReached: false };
  }
  if (next.has(assetId)) return { selected: next, limitReached: false };
  if (!Number.isSafeInteger(maximum) || maximum < 0 || next.size >= maximum) {
    return { selected: next, limitReached: true };
  }
  next.add(assetId);
  return { selected: next, limitReached: false };
}
