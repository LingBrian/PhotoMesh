import { describe, expect, it } from 'vitest';
import { createPairingApprovalDecision, reconcilePendingLibrarySelections } from '../src/pairing-approval';

describe('pairing approval helpers', () => {
  it('defaults new pending peers to no library permissions and preserves only available selected grants', () => {
    expect(reconcilePendingLibrarySelections(['peer-new'], {}, new Set(['library-a']))).toEqual({ 'peer-new': [] });
    expect(reconcilePendingLibrarySelections(
      ['peer-kept', 'peer-new'],
      { 'peer-kept': ['library-a', 'deleted-library', 'library-a'], 'peer-removed': ['library-a'] },
      new Set(['library-a', 'library-b'])
    )).toEqual({ 'peer-kept': ['library-a'], 'peer-new': [] });
  });

  it('includes selected library IDs only for approved devices', () => {
    expect(createPairingApprovalDecision(true, [])).toEqual({ approved: true, libraryIds: [] });
    expect(createPairingApprovalDecision(true, ['library-a', 'library-a', 'library-b'])).toEqual({
      approved: true,
      libraryIds: ['library-a', 'library-b']
    });
    expect(createPairingApprovalDecision(false, ['library-a'])).toEqual({ approved: false, libraryIds: [] });
  });
});
