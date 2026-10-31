export type TimelineAsset = { assetId: string };

/** Appends server pages in cursor order while keeping the first occurrence of each asset. */
export function mergeTimelinePage<T extends TimelineAsset>(existing: readonly T[], page: readonly T[], reset = false): T[] {
  const merged: T[] = reset ? [] : [...existing];
  const seen = new Set(merged.map((item) => item.assetId));
  for (const item of page) {
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    merged.push(item);
  }
  return merged;
}

export function validNextCursor(cursor: string | null | undefined): string {
  return typeof cursor === 'string' ? cursor : '';
}
