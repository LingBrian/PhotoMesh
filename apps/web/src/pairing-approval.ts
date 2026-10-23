export interface PendingPeer {
  peerId: string;
  publicKey: string;
  proposedLabel: string;
  requestedAt: string;
}

export interface PairingApprovalDecision {
  approved: boolean;
  libraryIds: string[];
}

export function reconcilePendingLibrarySelections(
  pendingPeerIds: readonly string[],
  selectedByPeer: Readonly<Record<string, readonly string[]>>,
  availableLibraryIds: ReadonlySet<string>
): Record<string, string[]> {
  return Object.fromEntries(pendingPeerIds.map((peerId) => [
    peerId,
    [...new Set(selectedByPeer[peerId] ?? [])].filter((libraryId) => availableLibraryIds.has(libraryId))
  ]));
}

export function createPairingApprovalDecision(
  approved: boolean,
  selectedLibraryIds: readonly string[]
): PairingApprovalDecision {
  return {
    approved,
    libraryIds: approved ? [...new Set(selectedLibraryIds)] : []
  };
}
