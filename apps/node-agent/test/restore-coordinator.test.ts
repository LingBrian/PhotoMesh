import { describe, expect, it, vi } from 'vitest';
import { TombstoneRestoreCoordinator, type TombstoneRestoreResult } from '../src/sync/restore-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe('tombstone restore coordinator', () => {
  it('returns the same successful restore result to concurrent duplicate requests', async () => {
    const coordinator = new TombstoneRestoreCoordinator();
    const result = deferred<TombstoneRestoreResult>();
    const work = vi.fn(() => result.promise);
    const first = coordinator.run('library-a', 'tombstone-a', work);
    const second = coordinator.run('library-a', 'tombstone-a', vi.fn(async () => 'inactive' as const));

    result.resolve({ status: 'restored', restoreEventId: 'restore-a' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'restored', restoreEventId: 'restore-a' },
      { status: 'restored', restoreEventId: 'restore-a' }
    ]);
    expect(work).toHaveBeenCalledTimes(1);

    await expect(coordinator.run('library-a', 'tombstone-a', async () => 'inactive')).resolves.toBe('inactive');
  });
});
