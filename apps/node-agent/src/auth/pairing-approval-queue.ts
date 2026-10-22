import type { PairingApproval } from './pairing-service.js';

export interface PendingPeerApproval {
  peerId: string;
  publicKey: string;
  proposedLabel: string;
  requestedAt: string;
}

export class PairingApprovalQueue {
  private readonly pending = new Map<string, {
    request: PendingPeerApproval;
    resolve: (approval: PairingApproval) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly timeoutMs = 120_000, private readonly now: () => number = Date.now) {}

  request = (request: Omit<PendingPeerApproval, 'requestedAt'>): Promise<PairingApproval> => {
    if (this.pending.has(request.peerId)) return Promise.resolve({ approved: false });
    return new Promise((resolve) => {
      const entry = {
        request: { ...request, requestedAt: new Date(this.now()).toISOString() }, resolve,
        timer: setTimeout(() => this.decide(request.peerId, { approved: false }), this.timeoutMs)
      };
      entry.timer.unref?.();
      this.pending.set(request.peerId, entry);
    });
  };

  list(): PendingPeerApproval[] {
    return [...this.pending.values()].map(({ request }) => ({ ...request }));
  }

  decide(peerId: string, approval: PairingApproval): boolean {
    const entry = this.pending.get(peerId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(peerId);
    entry.resolve({
      approved: approval.approved,
      ...(approval.label === undefined ? {} : { label: approval.label }),
      ...(approval.libraryIds === undefined ? {} : { libraryIds: [...new Set(approval.libraryIds)] })
    });
    return true;
  }
}
