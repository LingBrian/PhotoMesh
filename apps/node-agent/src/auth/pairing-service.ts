import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { PairingInviteRecord, TrustedPeerRecord } from '../db/repository.js';

export const PAIRING_PROTOCOL_VERSION = 1;
export const PAIRING_INVITE_TTL_MS = 2 * 60 * 1000;
const MAX_LABEL_LENGTH = 80;

export interface PairingQrPayload {
  protocol: 'photomesh-pairing';
  version: typeof PAIRING_PROTOCOL_VERSION;
  hostPeerId: string;
  addresses: string[];
  inviteId: string;
  secret: string;
  expiresAt: string;
}

export interface PairingApproval {
  approved: boolean;
  label?: string;
  libraryIds?: string[];
}

export interface PairingRepository {
  createPairingInvite(record: PairingInviteRecord): void;
  consumePairingInvite(inviteId: string, secretSha256: string, now: string): boolean;
  trustPeer(record: TrustedPeerRecord): void;
  getTrustedPeer(peerId: string): TrustedPeerRecord | undefined;
  listTrustedPeers(): TrustedPeerRecord[];
  revokePeer(peerId: string, revokedAt: string): boolean;
  grantLibraryRead(peerId: string, libraryId: string, createdAt: string): void;
  canReadLibrary(peerId: string, libraryId: string): boolean;
  listLibraryIndex(peerId: string, libraryId: string): unknown[] | undefined;
}

export interface AuthenticatedRemoteIdentity {
  peerId: string;
  publicKey: Uint8Array;
}

export class PairingRejectedError extends Error {
  constructor(message = 'pairing invitation is invalid, expired, or already used') {
    super(message);
    this.name = 'PairingRejectedError';
  }
}

export class PairingService {
  constructor(
    private readonly repository: PairingRepository,
    private readonly localPeerId: string,
    private readonly approvePeer: (peer: { peerId: string; publicKey: string; proposedLabel: string }) => Promise<PairingApproval>,
    private readonly now: () => number = Date.now,
    private readonly onRevoke?: (peerId: string) => Promise<void> | void
  ) {}

  trustScannedHost(peerId: string, publicKey: Uint8Array, label: string): void {
    const encodedKey = Buffer.from(publicKey).toString('base64');
    if (!isValidPeerId(peerId) || !isValidKeyText(encodedKey) || !identityMatchesPeer(peerId, publicKey) || peerId === this.localPeerId) {
      throw new PairingRejectedError('host identity is invalid');
    }
    if (this.repository.getTrustedPeer(peerId)?.trustState === 'revoked') {
      throw new PairingRejectedError('revoked identities cannot be re-trusted');
    }
    const now = new Date(this.now()).toISOString();
    this.repository.trustPeer({ peerId, publicKey: encodedKey, label: normalizeLabel(label), trustState: 'trusted', createdAt: now, revokedAt: null });
  }

  createInvite(addresses: readonly string[]): PairingQrPayload {
    const now = this.now();
    const secret = randomBytes(32).toString('base64url');
    const inviteId = randomUUID();
    const expiresAt = new Date(now + PAIRING_INVITE_TTL_MS).toISOString();
    this.repository.createPairingInvite({
      inviteId,
      secretSha256: hashSecret(secret),
      createdAt: new Date(now).toISOString(),
      expiresAt
    });
    return {
      protocol: 'photomesh-pairing', version: PAIRING_PROTOCOL_VERSION,
      hostPeerId: this.localPeerId, addresses: [...new Set(addresses)], inviteId, secret, expiresAt
    };
  }

  async acceptInvite(input: {
    inviteId: string;
    secret: string;
    proposedLabel: string;
    authenticatedRemote: AuthenticatedRemoteIdentity;
  }): Promise<{ peerId: string; trustState: 'trusted'; grantedLibraryIds: string[] }> {
    const { authenticatedRemote } = input;
    const normalizedKey = Buffer.from(authenticatedRemote.publicKey).toString('base64');
    if (authenticatedRemote.peerId === this.localPeerId || !isValidPeerId(authenticatedRemote.peerId) ||
        !isValidInviteSecret(input.secret) || !isValidKeyText(normalizedKey) || !identityMatchesPeer(authenticatedRemote.peerId, authenticatedRemote.publicKey)) {
      throw new PairingRejectedError();
    }
    const consumed = this.repository.consumePairingInvite(input.inviteId, hashSecret(input.secret), new Date(this.now()).toISOString());
    if (!consumed) throw new PairingRejectedError();
    if (this.repository.getTrustedPeer(authenticatedRemote.peerId)?.trustState === 'revoked') {
      throw new PairingRejectedError('revoked identities cannot be paired again');
    }

    const approval = await this.approvePeer({
      peerId: authenticatedRemote.peerId,
      publicKey: normalizedKey,
      proposedLabel: normalizeLabel(input.proposedLabel)
    });
    if (!approval.approved) throw new PairingRejectedError('pairing was declined by the host');

    const now = new Date(this.now()).toISOString();
    this.repository.trustPeer({
      peerId: authenticatedRemote.peerId, publicKey: normalizedKey,
      label: normalizeLabel(approval.label ?? input.proposedLabel), trustState: 'trusted', createdAt: now, revokedAt: null
    });
    const libraryIds = [...new Set(approval.libraryIds ?? [])].filter((id) => id.length > 0 && id.length <= 128);
    for (const libraryId of libraryIds) this.repository.grantLibraryRead(authenticatedRemote.peerId, libraryId, now);
    return { peerId: authenticatedRemote.peerId, trustState: 'trusted', grantedLibraryIds: libraryIds };
  }

  listPeers(): TrustedPeerRecord[] {
    return this.repository.listTrustedPeers();
  }

  canReadLibrary(peerId: string, libraryId: string): boolean {
    return this.repository.canReadLibrary(peerId, libraryId);
  }

  grantLibraryRead(peerId: string, libraryId: string): void {
    this.repository.grantLibraryRead(peerId, libraryId, new Date(this.now()).toISOString());
  }

  readLibraryIndex(peerId: string, libraryId: string): unknown[] | undefined {
    return this.repository.listLibraryIndex(peerId, libraryId);
  }

  async revokePeer(peerId: string): Promise<boolean> {
    const revoked = this.repository.revokePeer(peerId, new Date(this.now()).toISOString());
    if (revoked) await this.onRevoke?.(peerId);
    return revoked;
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function isValidInviteSecret(secret: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  const bytes = Buffer.from(secret, 'base64url');
  return bytes.byteLength === 32 && Buffer.from(bytes).toString('base64url') === secret;
}

function isValidPeerId(peerId: string): boolean {
  return peerId.length >= 10 && peerId.length <= 128 && /^[A-Za-z0-9]+$/.test(peerId);
}

function isValidKeyText(publicKey: string): boolean {
  try {
    const bytes = Buffer.from(publicKey, 'base64');
    return bytes.byteLength >= 32 && bytes.byteLength <= 512 && bytes.toString('base64') === publicKey;
  } catch {
    return false;
  }
}

function identityMatchesPeer(peerId: string, serializedPublicKey: Uint8Array): boolean {
  try {
    const publicKey = publicKeyFromProtobuf(serializedPublicKey);
    return publicKey.type === 'Ed25519' && peerIdFromPublicKey(publicKey).toString() === peerId;
  } catch {
    return false;
  }
}

function normalizeLabel(value: string): string {
  const label = [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  }).join('').trim().slice(0, MAX_LABEL_LENGTH);
  return label || 'PhotoMesh device';
}
