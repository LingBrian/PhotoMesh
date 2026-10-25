export type TombstoneRestoreResult =
  | { status: 'restored'; restoreEventId: string }
  | 'not_found'
  | 'inactive'
  | 'conflict'
  | 'unavailable';

/** Coalesces identical in-flight restore requests; completed restores can be retried against repository state. */
export class TombstoneRestoreCoordinator {
  private readonly active = new Map<string, Promise<TombstoneRestoreResult>>();

  async run(libraryId: string, tombstoneEventId: string, work: () => Promise<TombstoneRestoreResult>): Promise<TombstoneRestoreResult> {
    const key = JSON.stringify([libraryId, tombstoneEventId]);
    const existing = this.active.get(key);
    if (existing) return existing;

    const pending = Promise.resolve().then(work);
    this.active.set(key, pending);
    try { return await pending; }
    finally { if (this.active.get(key) === pending) this.active.delete(key); }
  }
}
