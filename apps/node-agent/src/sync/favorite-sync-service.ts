import type { LocalIdentity } from '../auth/local-identity.js';
import type { PairingService } from '../auth/pairing-service.js';
import { isSyncHello, negotiateProtocol, SYNC_BATCH_LIMIT, type SyncHello } from './sync-service.js';
import {
  isFavoriteSyncEventType, parseEventEnvelope, signEvent, verifyEnvelopeSignature,
  type EventEnvelope
} from './event-envelope.js';
import {
  FavoriteSyncAuthorizationError, FavoriteSyncRepository,
  type FavoriteIngestResult, type FavoriteSyncCursor, type FavoriteSetResult
} from './favorite-sync-repository.js';

export const FAVORITE_SYNC_PROTOCOL = '/photomesh/asset-favorites/1.0.0';
export const FAVORITE_SYNC_CAPABILITY = 'asset-favorites-v1';
const MAX_LIBRARY_IDS = 256;
const MAX_FAVORITE_CURSORS = 16_384;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface FavoriteSyncExchangeRequest {
  hello: SyncHello;
  grantedLibraryIds: string[];
  cursors: FavoriteSyncCursor[];
  events: EventEnvelope[];
}

export type FavoriteSyncResultStatus = FavoriteIngestResult['status'] | 'unauthorized';

export interface FavoriteSyncExchangeResponse {
  hello: SyncHello;
  agreedProtocol: number;
  schemaVersion: number;
  grantedLibraryIds: string[];
  cursors: FavoriteSyncCursor[];
  events: EventEnvelope[];
  results: Array<{ eventId: string; status: FavoriteSyncResultStatus }>;
}

export interface FavoriteSyncTransport {
  exchangeFavorites(peerId: string, request: FavoriteSyncExchangeRequest): Promise<FavoriteSyncExchangeResponse>;
}

export interface FavoriteSyncRunResult { rounds: number; received: number; sent: number; pending: number }

export class FavoriteSyncProtocolConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'FavoriteSyncProtocolConflictError'; }
}

export class FavoriteSyncService {
  constructor(
    readonly repository: FavoriteSyncRepository,
    private readonly identity: LocalIdentity,
    private readonly pairing: PairingService,
    private readonly helloProvider: () => SyncHello,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  hello(): SyncHello { return this.helloProvider(); }

  async setAssetFavorite(input: {
    operationId: string; principalId: string; libraryId: string; assetId: string; favorite: boolean; requestFingerprint: string; createdAt?: string; requestId?: string;
  }): Promise<FavoriteSetResult> {
    const result = this.repository.setFavorite({
      ...input, authorPeerId: this.identity.peerId, createdAt: input.createdAt ?? this.now()
    });
    if (result === 'not_found' || result === 'author_limit') return result;
    if (result.status === 'changed') await this.signPendingLocalEvents();
    return result;
  }

  markPeerUnsupported(peerId: string): void {
    const events = this.repository.eventsMissingForPeer(peerId, this.repository.getAcknowledgedCursors(peerId), SYNC_BATCH_LIMIT, false);
    this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'peer_missing_asset_favorites_v1');
  }

  async signPendingLocalEvents(): Promise<void> {
    for (const draft of this.repository.getUnsignedLocalDrafts(this.identity.peerId)) {
      await this.repository.completeLocalDraft(await signEvent(draft, this.identity));
    }
  }

  reconcilePendingEvents(libraryId?: string): string[] {
    return this.repository.reconcilePendingEvents(libraryId);
  }

  async handleExchange(remotePeerId: string, request: FavoriteSyncExchangeRequest): Promise<FavoriteSyncExchangeResponse> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === remotePeerId && peer.trustState === 'trusted')) {
      throw new FavoriteSyncAuthorizationError('relay is not a trusted peer');
    }
    if (!isFavoriteSyncExchangeRequest(request)) throw new FavoriteSyncProtocolConflictError('invalid favorite sync batch');
    if (request.hello.nodeId !== remotePeerId) throw new FavoriteSyncProtocolConflictError('hello identity does not match authenticated peer');
    const negotiation = negotiateProtocol(this.hello(), request.hello);
    if (!negotiation.capabilities.includes(FAVORITE_SYNC_CAPABILITY)) {
      throw new FavoriteSyncProtocolConflictError('no common asset favorite sync capability');
    }

    await this.signPendingLocalEvents();
    this.repository.requeueSupportedUnsupportedEvents();
    this.repository.setRemoteLibraries(remotePeerId, request.grantedLibraryIds);
    this.repository.acknowledgeCursors(remotePeerId, request.cursors);
    this.repository.reconcilePendingEvents();

    const results: FavoriteSyncExchangeResponse['results'] = [];
    const trustedPeers = this.pairing.listPeers();
    for (const rawEvent of request.events) {
      const event = await this.verifyIncomingEvent(remotePeerId, rawEvent, request.grantedLibraryIds, trustedPeers);
      try {
        const result = this.repository.ingest(remotePeerId, event);
        results.push({ eventId: event.eventId, status: result.status });
      } catch (error) {
        if (error instanceof FavoriteSyncAuthorizationError) {
          results.push({ eventId: event.eventId, status: 'unauthorized' });
          continue;
        }
        throw error;
      }
    }

    this.repository.reconcilePendingEvents();
    const grantedLibraryIds = this.repository.listGrantedLibraries(remotePeerId);
    const libraries = [...new Set([...grantedLibraryIds, ...request.grantedLibraryIds])];
    const events = this.repository.eventsMissingForPeer(remotePeerId, this.repository.getAcknowledgedCursors(remotePeerId), SYNC_BATCH_LIMIT);
    this.repository.recordOfferedEvents(remotePeerId, events);
    return {
      hello: this.hello(), agreedProtocol: negotiation.protocol, schemaVersion: negotiation.schemaVersion,
      grantedLibraryIds, cursors: this.repository.getCursors(libraries), events, results
    };
  }

  async syncWithPeer(peerId: string, transport: FavoriteSyncTransport, maxRounds = 32): Promise<FavoriteSyncRunResult> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) {
      throw new FavoriteSyncAuthorizationError('peer is not trusted');
    }
    await this.signPendingLocalEvents();
    this.repository.requeueSupportedUnsupportedEvents();
    this.repository.reconcilePendingEvents();
    let rounds = 0;
    let received = 0;
    let sent = 0;
    for (; rounds < maxRounds; rounds += 1) {
      const grantedLibraryIds = this.repository.listGrantedLibraries(peerId);
      const remoteLibraryIds = this.repository.getRemoteLibraries(peerId);
      const libraries = [...new Set([...grantedLibraryIds, ...remoteLibraryIds])];
      const cursors = this.repository.getCursors(libraries);
      const acknowledgedBefore = this.repository.getAcknowledgedCursors(peerId);
      const events = this.repository.eventsMissingForPeer(peerId, acknowledgedBefore, SYNC_BATCH_LIMIT);
      this.repository.recordOfferedEvents(peerId, events);
      let response: FavoriteSyncExchangeResponse;
      try {
        response = await transport.exchangeFavorites(peerId, { hello: this.hello(), grantedLibraryIds, cursors, events });
      } catch (error) {
        this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'transport_error');
        throw error;
      }
      if (!isFavoriteSyncExchangeResponse(response)) throw new FavoriteSyncProtocolConflictError('invalid favorite sync response');
      if (response.hello.nodeId !== peerId) throw new FavoriteSyncProtocolConflictError('hello identity does not match authenticated peer');
      const negotiation = negotiateProtocol(this.hello(), response.hello);
      if (response.agreedProtocol !== negotiation.protocol || response.schemaVersion !== negotiation.schemaVersion ||
          !negotiation.capabilities.includes(FAVORITE_SYNC_CAPABILITY)) {
        throw new FavoriteSyncProtocolConflictError('peer returned inconsistent favorite protocol negotiation');
      }
      this.repository.setRemoteLibraries(peerId, response.grantedLibraryIds);
      for (const result of response.results) this.repository.recordOfferResult(peerId, result.eventId, result.status);
      this.repository.acknowledgeCursors(peerId, response.cursors);
      const trustedPeers = this.pairing.listPeers();
      for (const rawEvent of response.events) {
        const event = await this.verifyIncomingEvent(peerId, rawEvent, response.grantedLibraryIds, trustedPeers);
        try { this.repository.ingest(peerId, event); }
        catch (error) { if (!(error instanceof FavoriteSyncAuthorizationError)) throw error; }
        received += 1;
      }
      this.repository.reconcilePendingEvents();
      this.repository.acknowledgeCursors(peerId, response.cursors);
      sent += events.length;

      const afterLibraries = [...new Set([...grantedLibraryIds, ...this.repository.getRemoteLibraries(peerId)])];
      const acknowledgedAfter = this.repository.getAcknowledgedCursors(peerId);
      const remaining = this.repository.eventsMissingForPeer(peerId, acknowledgedAfter, SYNC_BATCH_LIMIT);
      const lastSentIds = new Set(events.map((event) => event.eventId));
      const hasMoreOutgoing = remaining.some((event) => !lastSentIds.has(event.eventId));
      const moreIncoming = response.events.length === SYNC_BATCH_LIMIT;
      const cursorProgress = JSON.stringify(this.repository.getCursors(afterLibraries)) !== JSON.stringify(cursors) ||
        JSON.stringify(acknowledgedBefore) !== JSON.stringify(acknowledgedAfter);
      const madeProgress = cursorProgress || response.results.some((result) => ['applied', 'duplicate'].includes(result.status));
      const pending = this.repository.getPendingCount(peerId);
      if ((!moreIncoming && !hasMoreOutgoing) || !madeProgress) return { rounds: rounds + 1, received, sent, pending };
    }
    return { rounds, received, sent, pending: this.repository.getPendingCount(peerId) };
  }

  private async verifyIncomingEvent(relayPeerId: string, rawEvent: unknown, grantedLibraryIds: readonly string[],
    trustedPeers: ReturnType<PairingService['listPeers']>): Promise<EventEnvelope> {
    if (!isRecord(rawEvent) || typeof rawEvent.authorPeerId !== 'string') {
      throw new FavoriteSyncProtocolConflictError('favorite event author identity is invalid');
    }
    const author = trustedPeers.find((peer) => peer.peerId === rawEvent.authorPeerId && peer.trustState === 'trusted');
    if (!author || !(await verifyEnvelopeSignature(rawEvent, author.publicKey))) {
      throw new FavoriteSyncProtocolConflictError('favorite event signature or author identity is invalid');
    }
    let event: EventEnvelope;
    try { event = parseEventEnvelope(rawEvent); }
    catch {
      this.repository.recordProtocolConflict(relayPeerId, rawEvent, 'invalid_event_envelope');
      throw new FavoriteSyncProtocolConflictError('signed favorite event envelope is invalid');
    }
    if (!grantedLibraryIds.includes(event.libraryId)) throw new FavoriteSyncAuthorizationError('peer did not grant this favorite library');
    if (event.protocolVersion === 1 && event.schemaVersion === 1 && !isFavoriteSyncEventType(event.eventType)) {
      throw new FavoriteSyncProtocolConflictError('event type is outside the favorite stream');
    }
    return event;
  }
}

export function isFavoriteSyncExchangeRequest(value: unknown): value is FavoriteSyncExchangeRequest {
  if (!isRecord(value) || !isSyncHello(value.hello) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_FAVORITE_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT) return false;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) return false; } catch { return false; }
  return value.cursors.every(isCursor) && value.events.every(isRecord);
}

export function isFavoriteSyncExchangeResponse(value: unknown): value is FavoriteSyncExchangeResponse {
  if (!isRecord(value) || !isSyncHello(value.hello) || !Number.isSafeInteger(value.agreedProtocol) ||
      !Number.isSafeInteger(value.schemaVersion) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_FAVORITE_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT || !Array.isArray(value.results) || value.results.length > SYNC_BATCH_LIMIT) return false;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) return false; } catch { return false; }
  return value.cursors.every(isCursor) && value.events.every(isRecord) && value.results.every((result) => isRecord(result) &&
    typeof result.eventId === 'string' && ['applied', 'pending', 'duplicate', 'unsupported', 'conflict', 'unauthorized'].includes(String(result.status)));
}

function isCursor(value: unknown): value is FavoriteSyncCursor {
  return isRecord(value) && typeof value.libraryId === 'string' && value.libraryId.length > 0 && value.libraryId.length <= 128 &&
    typeof value.authorPeerId === 'string' && /^[A-Za-z0-9]{10,128}$/.test(value.authorPeerId) &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0;
}

function isStringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
