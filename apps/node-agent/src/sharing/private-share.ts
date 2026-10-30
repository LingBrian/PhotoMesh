import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PrivateShareScope { libraryId: string; albumId: string }
export interface PrivateShareInvitation { shareId: string; recipientId: string; scope: PrivateShareScope; expiresAt: string; token: string }
export interface PrivateShareGrant { shareId: string; recipientId: string; scope: PrivateShareScope; expiresAt: string; revokedAt: string | null }
export type PrivateShareAcceptResult = { status: 'accepted'; grant: PrivateShareGrant } | 'invalid' | 'expired' | 'revoked' | 'recipient_mismatch' | 'attempts_exhausted';

type StoredShare = Omit<PrivateShareGrant, 'revokedAt'> & { tokenHash: Buffer; revokedAt: string | null; acceptedAt: string | null; attempts: number };

export class PrivateShareService {
  private readonly shares = new Map<string, StoredShare>();
  constructor(private readonly now: () => string = () => new Date().toISOString(), private readonly maxAttempts = 5) {}

  createInvitation(recipientId: string, scope: PrivateShareScope, expiresAt: string): PrivateShareInvitation {
    if (!recipientId || !scope.libraryId || !scope.albumId || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(this.now())) throw new Error('invalid_share');
    const shareId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    this.shares.set(shareId, { shareId, recipientId, scope: { ...scope }, expiresAt, revokedAt: null, acceptedAt: null, tokenHash: hash(token), attempts: 0 });
    return { shareId, recipientId, scope: { ...scope }, expiresAt, token };
  }

  accept(shareId: string, recipientId: string, token: string): PrivateShareAcceptResult {
    const stored = this.shares.get(shareId);
    if (!stored) return 'invalid';
    if (stored.attempts >= this.maxAttempts) return 'attempts_exhausted';
    stored.attempts += 1;
    if (stored.revokedAt || stored.acceptedAt) return 'revoked';
    if (Date.parse(this.now()) >= Date.parse(stored.expiresAt)) return 'expired';
    if (recipientId !== stored.recipientId) return 'recipient_mismatch';
    const provided = hash(token);
    if (provided.byteLength !== stored.tokenHash.byteLength || !timingSafeEqual(provided, stored.tokenHash)) return 'invalid';
    const grant: PrivateShareGrant = { shareId: stored.shareId, recipientId: stored.recipientId, scope: { ...stored.scope }, expiresAt: stored.expiresAt, revokedAt: null };
    stored.acceptedAt = this.now();
    return { status: 'accepted', grant };
  }

  revoke(shareId: string, revokedAt = this.now()): boolean {
    const stored = this.shares.get(shareId);
    if (!stored || stored.revokedAt) return false;
    stored.revokedAt = revokedAt;
    return true;
  }

  isAuthorized(shareId: string, recipientId: string, libraryId: string, albumId: string): boolean {
    const stored = this.shares.get(shareId);
    return Boolean(stored && stored.acceptedAt && !stored.revokedAt && stored.recipientId === recipientId && stored.scope.libraryId === libraryId && stored.scope.albumId === albumId && Date.parse(this.now()) < Date.parse(stored.expiresAt));
  }
}

function hash(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }
