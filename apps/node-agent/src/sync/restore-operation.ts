import { SyncCausalityError } from './sync-repository.js';
import type { SyncService } from './sync-service.js';
import type { TombstoneRestoreResult } from './restore-coordinator.js';

export interface RestorableTombstone { eventId: string; assetId: string }

/** Restores an active tombstone, or returns its persisted result for safe client retries. */
export async function restoreTombstoneOperation(
  libraryId: string,
  eventId: string,
  syncService: SyncService | undefined,
  listActiveTombstones: (libraryId: string) => readonly RestorableTombstone[]
): Promise<TombstoneRestoreResult> {
  if (!syncService) return 'unavailable';
  const alreadyRestored = () => {
    const restoreEventId = syncService.repository.getTombstoneRestoreEventId(libraryId, eventId);
    return restoreEventId ? { status: 'restored' as const, restoreEventId } : 'inactive' as const;
  };
  const state = syncService.repository.getTombstoneState(libraryId, eventId);
  if (state === 'not_found') return 'not_found';
  if (state === 'inactive') return alreadyRestored();
  const tombstone = listActiveTombstones(libraryId).find((item) => item.eventId === eventId);
  if (!tombstone) {
    const currentState = syncService.repository.getTombstoneState(libraryId, eventId);
    if (currentState === 'inactive') return alreadyRestored();
    if (currentState === 'not_found') return 'not_found';
    return 'inactive';
  }
  // Multiple delete generations may remain active in the event log; only the
  // projection's current generation may be restored.
  if (syncService.repository.getActiveTombstoneEventId(libraryId, tombstone.assetId) !== eventId) return 'conflict';
  try {
    const event = await syncService.createLocalEvent({
      libraryId, eventType: 'asset.restored', causalParents: [eventId],
      payload: { assetId: tombstone.assetId, tombstoneEventId: eventId }
    }, eventId);
    return { status: 'restored', restoreEventId: event.eventId };
  } catch (error) {
    if (error instanceof SyncCausalityError) {
      const currentState = syncService.repository.getTombstoneState(libraryId, eventId);
      if (currentState === 'active') return 'conflict';
      if (currentState === 'inactive') return alreadyRestored();
      return 'not_found';
    }
    throw error;
  }
}
