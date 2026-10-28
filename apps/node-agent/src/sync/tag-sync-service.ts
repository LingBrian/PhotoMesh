import type { LocalIdentity } from '../auth/local-identity.js';
import type { PairingService } from '../auth/pairing-service.js';
import { makeUnsignedEvent, parseEventEnvelope, signEvent, verifyEvent, MAX_EVENT_BYTES, type EventEnvelope, type JsonValue, type UnsignedEventEnvelope } from './event-envelope.js';
import { isSyncHello, negotiateProtocol, SYNC_BATCH_LIMIT, type SyncHello } from './sync-service.js';
import { TagSyncAuthorizationError, TagSyncRepository, type TagEventDraftFactory, type TagIngestResult, type TagMutationResult, type TagSyncCursor } from './tag-sync-repository.js';

export const TAG_SYNC_PROTOCOL = '/photomesh/asset-tags/1.0.0';
export const TAG_SYNC_CAPABILITY = 'asset-tags-v1';
const MAX_LIBRARY_IDS = 256;
const MAX_TAG_CURSORS = 16_384;

export interface TagSyncExchangeRequest {
  hello: SyncHello;
  grantedLibraryIds: string[];
  cursors: TagSyncCursor[];
  events: EventEnvelope[];
}

export type TagSyncResultStatus = TagIngestResult['status'] | 'unauthorized';

export interface TagSyncExchangeResponse {
  hello: SyncHello;
  agreedProtocol: number;
  schemaVersion: number;
  grantedLibraryIds: string[];
  cursors: TagSyncCursor[];
  events: EventEnvelope[];
  results: Array<{ eventId: string; status: TagSyncResultStatus }>;
}

export interface TagSyncTransport {
  exchangeTags(peerId: string, request: TagSyncExchangeRequest): Promise<TagSyncExchangeResponse>;
}

export interface TagSyncRunResult { rounds: number; received: number; sent: number; pending: number }

export class TagSyncProtocolConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'TagSyncProtocolConflictError'; }
}

export class TagSyncService {
  constructor(
    readonly repository: TagSyncRepository,
    private readonly identity: LocalIdentity,
    private readonly pairing: PairingService,
    private readonly helloProvider: () => SyncHello,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  hello(): SyncHello { return this.helloProvider(); }

  markPeerUnsupported(peerId: string): void {
    const events = this.repository.eventsMissingForPeer(peerId, this.repository.getAcknowledgedCursors(peerId), SYNC_BATCH_LIMIT);
    this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'peer_missing_asset_tags_v1');
  }

  async addAssetTag(libraryId: string, assetId: string, tag: string, createdAt = this.now()): Promise<TagMutationResult> {
    const result = this.repository.addLocalTag({
      libraryId, assetId, tag, authorPeerId: this.identity.peerId, createdAt, draftFactory: this.eventDraftFactory()
    });
    await this.signPendingLocalEvents();
    return result;
  }

  async removeAssetTag(libraryId: string, assetId: string, tag: string): Promise<TagMutationResult> {
    const result = this.repository.removeLocalTag({
      libraryId, assetId, tag, authorPeerId: this.identity.peerId, createdAt: this.now(), draftFactory: this.eventDraftFactory()
    });
    await this.signPendingLocalEvents();
    return result;
  }

  async reconcileLegacyTagSeeds(): Promise<number> {
    const queued = this.repository.reconcileLegacyTagSeeds({
      authorPeerId: this.identity.peerId, createdAt: this.now(), draftFactory: this.eventDraftFactory()
    });
    await this.signPendingLocalEvents();
    return queued;
  }

  async signPendingLocalEvents(): Promise<void> {
    for (const draft of this.repository.getUnsignedLocalDrafts(this.identity.peerId)) {
      await this.repository.completeLocalDraft(await signEvent(draft, this.identity));
    }
  }

  async handleExchange(remotePeerId: string, request: TagSyncExchangeRequest): Promise<TagSyncExchangeResponse> {
    const remote = this.pairing.listPeers().find((peer) => peer.peerId === remotePeerId && peer.trustState === 'trusted');
    if (!remote) throw new TagSyncAuthorizationError('relay is not a trusted peer');
    if (!isTagSyncExchangeRequest(request)) throw new TagSyncProtocolConflictError('invalid tag sync batch');
    if (request.hello.nodeId !== remotePeerId) throw new TagSyncProtocolConflictError('hello identity does not match authenticated peer');
    const negotiation = negotiateProtocol(this.hello(), request.hello);
    if (!negotiation.capabilities.includes(TAG_SYNC_CAPABILITY)) throw new TagSyncProtocolConflictError('no common asset tag sync capability');
    await this.reconcileLegacyTagSeeds();
    this.repository.reconcilePendingEvents();

    this.repository.setRemoteLibraries(remotePeerId, request.grantedLibraryIds);
    this.repository.acknowledgeCursors(remotePeerId, request.cursors);
    const results: TagSyncExchangeResponse['results'] = [];
    for (const rawEvent of request.events) {
      const event = parseEventEnvelope(rawEvent);
      if (!request.grantedLibraryIds.includes(event.libraryId)) throw new TagSyncAuthorizationError('peer did not grant this tag library');
      const author = this.pairing.listPeers().find((peer) => peer.peerId === event.authorPeerId && peer.trustState === 'trusted');
      if (!author || !(await verifyEvent(event, author.publicKey))) {
        throw new TagSyncProtocolConflictError('tag event signature or author identity is invalid');
      }
      try {
        const result = this.repository.ingest(remotePeerId, event);
        results.push({ eventId: event.eventId, status: result.status });
      } catch (error) {
        if (error instanceof TagSyncAuthorizationError) {
          results.push({ eventId: event.eventId, status: 'unauthorized' });
          continue;
        }
        throw error;
      }
    }

    const grantedLibraryIds = this.repository.listGrantedLibraries(remotePeerId);
    const libraries = [...new Set([...grantedLibraryIds, ...request.grantedLibraryIds])];
    const events = this.repository.eventsMissingForPeer(remotePeerId, this.repository.getAcknowledgedCursors(remotePeerId), SYNC_BATCH_LIMIT);
    this.repository.recordOfferedEvents(remotePeerId, events);
    return {
      hello: this.hello(), agreedProtocol: negotiation.protocol, schemaVersion: negotiation.schemaVersion,
      grantedLibraryIds, cursors: this.repository.getCursors(libraries), events, results
    };
  }

  async syncWithPeer(peerId: string, transport: TagSyncTransport, maxRounds = 32): Promise<TagSyncRunResult> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) {
      throw new TagSyncAuthorizationError('peer is not trusted');
    }
    await this.reconcileLegacyTagSeeds();
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
      let response: TagSyncExchangeResponse;
      try {
        response = await transport.exchangeTags(peerId, { hello: this.hello(), grantedLibraryIds, cursors, events });
      } catch (error) {
        this.repository.recordOfferFailure(peerId, events.map((event) => event.eventId), 'transport_error');
        throw error;
      }
      if (!isTagSyncExchangeResponse(response)) throw new TagSyncProtocolConflictError('invalid tag sync response');
      if (response.hello.nodeId !== peerId) throw new TagSyncProtocolConflictError('hello identity does not match authenticated peer');
      const negotiation = negotiateProtocol(this.hello(), response.hello);
      if (response.agreedProtocol !== negotiation.protocol || response.schemaVersion !== negotiation.schemaVersion ||
          !negotiation.capabilities.includes(TAG_SYNC_CAPABILITY)) {
        throw new TagSyncProtocolConflictError('peer returned an inconsistent tag protocol negotiation');
      }
      this.repository.setRemoteLibraries(peerId, response.grantedLibraryIds);
      this.repository.acknowledgeCursors(peerId, response.cursors);
      for (const result of response.results) {
        if (result.status === 'unauthorized') this.repository.recordOfferFailure(peerId, [result.eventId], 'tag_write_denied');
        else if (result.status === 'conflict') this.repository.recordOfferFailure(peerId, [result.eventId], 'remote_conflict');
        else if (result.status === 'unsupported') this.repository.recordOfferFailure(peerId, [result.eventId], 'unsupported_event');
      }

      const localPeerRecords = this.pairing.listPeers();
      for (const rawEvent of response.events) {
        const event = parseEventEnvelope(rawEvent);
        if (!response.grantedLibraryIds.includes(event.libraryId)) throw new TagSyncAuthorizationError('peer did not grant this tag library');
        const author = localPeerRecords.find((peer) => peer.peerId === event.authorPeerId && peer.trustState === 'trusted');
        if (!author || !(await verifyEvent(event, author.publicKey))) {
          throw new TagSyncProtocolConflictError('tag event signature or author identity is invalid');
        }
        try { this.repository.ingest(peerId, event); }
        catch (error) {
          if (!(error instanceof TagSyncAuthorizationError)) throw error;
        }
        received += 1;
      }
      // A response cursor may cover an event included in that same response; clamp it again after ingest.
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

  private eventDraftFactory(): TagEventDraftFactory {
    return ({ context, libraryId, eventType, payload, createdAt }): UnsignedEventEnvelope => makeUnsignedEvent({
      libraryId, authorPeerId: this.identity.peerId, authorSequence: context.authorSequence,
      causalParents: context.causalParents, eventType, payload: payload as JsonValue, createdAt
    });
  }
}

export function isTagSyncExchangeRequest(value: unknown): value is TagSyncExchangeRequest {
  if (!isRecord(value) || !isSyncHello(value.hello) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_TAG_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT) return false;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES * SYNC_BATCH_LIMIT) return false;
  return value.cursors.every(isCursor) && value.events.every(isRecord);
}

function isTagSyncExchangeResponse(value: unknown): value is TagSyncExchangeResponse {
  if (!isRecord(value) || !isSyncHello(value.hello) || !Number.isSafeInteger(value.agreedProtocol) ||
      !Number.isSafeInteger(value.schemaVersion) || !isStringArray(value.grantedLibraryIds, MAX_LIBRARY_IDS) ||
      !Array.isArray(value.cursors) || value.cursors.length > MAX_TAG_CURSORS || !Array.isArray(value.events) ||
      value.events.length > SYNC_BATCH_LIMIT || !Array.isArray(value.results) || value.results.length > SYNC_BATCH_LIMIT) return false;
  return value.cursors.every(isCursor) && value.events.every(isRecord) && value.results.every((result) => isRecord(result) &&
    typeof result.eventId === 'string' && ['applied', 'pending', 'duplicate', 'unsupported', 'conflict', 'unauthorized'].includes(String(result.status)));
}

function isCursor(value: unknown): value is TagSyncCursor {
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
