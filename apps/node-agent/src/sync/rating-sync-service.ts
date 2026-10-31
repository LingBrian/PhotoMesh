import type { LocalIdentity } from '../auth/local-identity.js';
import type { PairingService } from '../auth/pairing-service.js';
import { isSyncHello, negotiateProtocol, SYNC_BATCH_LIMIT, type SyncHello } from './sync-service.js';
import {
  isRatingSyncEventType, parseEventEnvelope, signEvent, verifyEnvelopeSignature,
  type EventEnvelope
} from './event-envelope.js';
import {
  RatingSyncAuthorizationError, RatingSyncRepository,
  type RatingIngestResult, type RatingSyncCursor, type RatingSetResult
} from './rating-sync-repository.js';

export const RATING_SYNC_PROTOCOL = '/photomesh/asset-ratings/1.0.0';
export const RATING_SYNC_CAPABILITY = 'asset-ratings-v1';
const MAX_LIBRARY_IDS = 256;
const MAX_RATING_CURSORS = 16_384;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface RatingSyncExchangeRequest {
  hello: SyncHello;
  grantedLibraryIds: string[];
  cursors: RatingSyncCursor[];
  events: EventEnvelope[];
}

export type RatingSyncResultStatus = RatingIngestResult['status'] | 'unauthorized';

export interface RatingSyncExchangeResponse {
  hello: SyncHello;
  agreedProtocol: number;
  schemaVersion: number;
  grantedLibraryIds: string[];
  cursors: RatingSyncCursor[];
  events: EventEnvelope[];
  results: Array<{ eventId: string; status: RatingSyncResultStatus }>;
}

export interface RatingSyncTransport {
  exchangeRatings(peerId: string, request: RatingSyncExchangeRequest): Promise<RatingSyncExchangeResponse>;
}

export interface RatingSyncRunResult { rounds: number; received: number; sent: number; pending: number }

export class RatingSyncProtocolConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'RatingSyncProtocolConflictError'; }
}

export class RatingSyncService {
  constructor(
    readonly repository: RatingSyncRepository,
    private readonly identity: LocalIdentity,
    private readonly pairing: PairingService,
    private readonly helloProvider: () => SyncHello,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  hello(): SyncHello { return this.helloProvider(); }

  async setAssetRating(input: {
    operationId: string; principalId: string; libraryId: string; assetId: string;
    rating: number | null; requestFingerprint: string; createdAt?: string; requestId?: string;
  }): Promise<RatingSetResult> {
    const result = this.repository.setRating({
      ...input, authorPeerId: this.identity.peerId, createdAt: input.createdAt ?? this.now()
    });
    if (result === 'not_found' || result === 'author_limit' || result === 'conflict_limit') return result;
    if (result.status === 'changed') await this.signPendingLocalEvents();
    return result;
  }

  markPeerUnsupported(peerId: string): void {
    const events = this.repository.eventsMissingForPeer(peerId, this.repository.getAcknowledgedCursors(peerId), SYNC_BATCH_LIMIT, false);
    this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'peer_missing_asset_ratings_v1');
  }

  async signPendingLocalEvents(): Promise<void> {
    for (const draft of this.repository.getUnsignedLocalDrafts(this.identity.peerId)) {
      await this.repository.completeLocalDraft(await signEvent(draft, this.identity));
    }
  }

  reconcilePendingEvents(libraryId?: string): string[] {
    return this.repository.reconcilePendingEvents(libraryId);
  }

  async handleExchange(remotePeerId: string, request: RatingSyncExchangeRequest): Promise<RatingSyncExchangeResponse> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === remotePeerId && peer.trustState === 'trusted')) {
      throw new RatingSyncAuthorizationError('relay is not a trusted peer');
    }
    if (!isRatingSyncExchangeRequest(request)) throw new RatingSyncProtocolConflictError('invalid rating sync batch');
    if (request.hello.nodeId !== remotePeerId) throw new RatingSyncProtocolConflictError('hello identity does not match authenticated peer');
    const negotiation = negotiateProtocol(this.hello(), request.hello);
    if (!negotiation.capabilities.includes(RATING_SYNC_CAPABILITY)) {
      throw new RatingSyncProtocolConflictError('no common asset rating sync capability');
    }

    await this.signPendingLocalEvents();
    this.repository.requeueSupportedUnsupportedEvents();
    this.repository.setRemoteLibraries(remotePeerId, request.grantedLibraryIds);
    this.repository.acknowledgeCursors(remotePeerId, request.cursors);
    this.repository.reconcilePendingEvents();

    const results: RatingSyncExchangeResponse['results'] = [];
    const trustedPeers = this.pairing.listPeers();
    for (const rawEvent of request.events) {
      const event = await this.verifyIncomingEvent(remotePeerId, rawEvent, request.grantedLibraryIds, trustedPeers);
      try {
        const result = this.repository.ingest(remotePeerId, event);
        results.push({ eventId: event.eventId, status: result.status });
      } catch (error) {
        if (error instanceof RatingSyncAuthorizationError) {
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

  async syncWithPeer(peerId: string, transport: RatingSyncTransport, maxRounds = 32): Promise<RatingSyncRunResult> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) {
      throw new RatingSyncAuthorizationError('peer is not trusted');
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
      let response: RatingSyncExchangeResponse;
      try {
        response = await transport.exchangeRatings(peerId, { hello: this.hello(), grantedLibraryIds, cursors, events });
      } catch (error) {
        this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'transport_error');
        throw error;
      }
      if (!isRatingSyncExchangeResponse(response)) throw new RatingSyncProtocolConflictError('invalid rating sync response');
      if (response.hello.nodeId !== peerId) throw new RatingSyncProtocolConflictError('hello identity does not match authenticated peer');
      const negotiation = negotiateProtocol(this.hello(), response.hello);
      if (response.agreedProtocol !== negotiation.protocol || response.schemaVersion !== negotiation.schemaVersion ||
          !negotiation.capabilities.includes(RATING_SYNC_CAPABILITY)) {
        throw new RatingSyncProtocolConflictError('peer returned inconsistent rating protocol negotiation');
      }
      this.repository.setRemoteLibraries(peerId, response.grantedLibraryIds);
      for (const result of response.results) this.repository.recordOfferResult(peerId, result.eventId, result.status);
      this.repository.acknowledgeCursors(peerId, response.cursors);
      const trustedPeers = this.pairing.listPeers();
      for (const rawEvent of response.events) {
        const event = await this.verifyIncomingEvent(peerId, rawEvent, response.grantedLibraryIds, trustedPeers);
        try { this.repository.ingest(peerId, event); }
        catch (error) { if (!(error instanceof RatingSyncAuthorizationError)) throw error; }
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
      throw new RatingSyncProtocolConflictError('rating event author identity is invalid');
    }
    const author = trustedPeers.find((peer) => peer.peerId === rawEvent.authorPeerId && peer.trustState === 'trusted');
    if (!author || !(await verifyEnvelopeSignature(rawEvent, author.publicKey))) {
      throw new RatingSyncProtocolConflictError('rating event signature or author identity is invalid');
    }
    let event: EventEnvelope;
    try { event = parseEventEnvelope(rawEvent); }
    catch {
      this.repository.recordProtocolConflict(relayPeerId, rawEvent, 'invalid_event_envelope');
      throw new RatingSyncProtocolConflictError('signed rating event envelope is invalid');
    }
    if (!grantedLibraryIds.includes(event.libraryId)) throw new RatingSyncAuthorizationError('peer did not grant this rating library');
    if (event.protocolVersion === 1 && event.schemaVersion === 1 && !isRatingSyncEventType(event.eventType)) {
      throw new RatingSyncProtocolConflictError('event type is outside the rating stream');
    }
    return event;
  }
}

export function isRatingSyncExchangeRequest(value: unknown): value is RatingSyncExchangeRequest {
  if (!isRecord(value) || !isSyncHello(value.hello) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_RATING_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT) return false;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) return false; } catch { return false; }
  return value.cursors.every(isCursor) && value.events.every(isRecord);
}

export function isRatingSyncExchangeResponse(value: unknown): value is RatingSyncExchangeResponse {
  if (!isRecord(value) || !isSyncHello(value.hello) || !Number.isSafeInteger(value.agreedProtocol) ||
      !Number.isSafeInteger(value.schemaVersion) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_RATING_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT || !Array.isArray(value.results) || value.results.length > SYNC_BATCH_LIMIT) return false;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) return false; } catch { return false; }
  return value.cursors.every(isCursor) && value.events.every(isRecord) && value.results.every((result) => isRecord(result) &&
    typeof result.eventId === 'string' && ['applied', 'pending', 'duplicate', 'unsupported', 'conflict', 'unauthorized'].includes(String(result.status)));
}

function isCursor(value: unknown): value is RatingSyncCursor {
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
