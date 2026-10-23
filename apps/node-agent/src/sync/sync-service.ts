import type { LocalIdentity } from '../auth/local-identity.js';
import type { PairingService } from '../auth/pairing-service.js';
import type { EventEnvelope, EventContext, EventDraftFactory, JsonValue, SyncEventType, UnsignedEventEnvelope } from './event-envelope.js';
import { makeUnsignedEvent, parseEventEnvelope, signEvent, verifyEvent, EVENT_SCHEMA_VERSION, MAX_EVENT_BYTES } from './event-envelope.js';
import { SyncAuthorizationError, SyncProtocolConflictError, SyncRepository, type IngestResult, type SyncCursor } from './sync-repository.js';

export const SYNC_PROTOCOL = '/photomesh/event-sync/1.0.0';
export const SYNC_BATCH_LIMIT = 64;
export const SYNC_PROTOCOL_MIN = 1;
export const SYNC_PROTOCOL_MAX = 1;

export interface SyncHello {
  nodeId: string;
  protocolMin: number;
  protocolMax: number;
  schemaVersions: number[];
  capabilities: string[];
}

export interface SyncExchangeRequest {
  hello: SyncHello;
  grantedLibraryIds: string[];
  cursors: SyncCursor[];
  events: EventEnvelope[];
}

export interface SyncExchangeResponse {
  hello: SyncHello;
  agreedProtocol: number;
  schemaVersion: number;
  grantedLibraryIds: string[];
  cursors: SyncCursor[];
  events: EventEnvelope[];
  results: Array<{ eventId: string; status: IngestResult['status'] }>;
}

export interface SyncTransport {
  exchange(peerId: string, request: SyncExchangeRequest): Promise<SyncExchangeResponse>;
}

const SUPPORTED_CAPABILITIES = ['asset.indexed', 'asset.metadata.updated', 'asset.tombstoned', 'asset.restored', 'causal-cursors'];

export function negotiateProtocol(local: SyncHello, remote: SyncHello): { protocol: number; schemaVersion: number; capabilities: string[] } {
  if (!isHello(local) || !isHello(remote)) throw new SyncProtocolConflictError('invalid protocol hello');
  const minimum = Math.max(local.protocolMin, remote.protocolMin);
  const maximum = Math.min(local.protocolMax, remote.protocolMax);
  if (minimum > maximum) throw new SyncProtocolConflictError('no common event sync protocol version');
  const schemaVersion = Math.max(...local.schemaVersions.filter((version) => remote.schemaVersions.includes(version)));
  if (!Number.isFinite(schemaVersion)) throw new SyncProtocolConflictError('no common event schema version');
  const capabilities = local.capabilities.filter((capability) => remote.capabilities.includes(capability));
  return { protocol: maximum, schemaVersion, capabilities };
}

export class SyncService {
  constructor(
    readonly repository: SyncRepository,
    private readonly identity: LocalIdentity,
    private readonly pairing: PairingService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  hello(): SyncHello {
    return {
      nodeId: this.identity.peerId, protocolMin: SYNC_PROTOCOL_MIN, protocolMax: SYNC_PROTOCOL_MAX,
      schemaVersions: [EVENT_SCHEMA_VERSION], capabilities: SUPPORTED_CAPABILITIES
    };
  }

  async createLocalEvent(input: { libraryId: string; eventType: SyncEventType; payload: JsonValue; createdAt?: string }): Promise<EventEnvelope> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const context = this.repository.getLocalEventContext(input.libraryId, this.identity.peerId);
      const unsigned = makeUnsignedEvent({
        ...input, authorPeerId: this.identity.peerId, authorSequence: context.authorSequence,
        causalParents: context.causalParents, createdAt: input.createdAt ?? this.now()
      });
      const signed = await signEvent(unsigned, this.identity);
      try {
        this.repository.appendLocalEvent(signed);
        return signed;
      } catch (error) {
        if (!(error instanceof SyncProtocolConflictError) || attempt === 3) throw error;
      }
    }
    throw new Error('unable to append local event');
  }

  createAssetIndexedDraft(input: { libraryId: string; assetId: string; originNodeId: string; kind: string; sha256: string; byteLength: number }): EventDraftFactory {
    return (context: EventContext): UnsignedEventEnvelope => makeUnsignedEvent({
      libraryId: input.libraryId, authorPeerId: this.identity.peerId, authorSequence: context.authorSequence,
      causalParents: context.causalParents, eventType: 'asset.indexed', createdAt: this.now(),
      payload: { assetId: input.assetId, originNodeId: input.originNodeId, kind: input.kind, sha256: input.sha256, byteLength: input.byteLength }
    });
  }

  async signPendingLocalEvents(): Promise<void> {
    for (const draft of this.repository.getUnsignedLocalDrafts(this.identity.peerId)) {
      await this.repository.completeLocalDraft(await signEvent(draft, this.identity));
    }
  }

  async reconcileLocalAssets(): Promise<number> {
    let reconciled = 0;
    while (this.repository.reserveNextMissingLocalAssetIndex(this.identity.peerId, (asset) => this.createAssetIndexedDraft({
      ...asset, originNodeId: this.identity.peerId
    }))) {
      await this.signPendingLocalEvents();
      reconciled += 1;
    }
    return reconciled;
  }

  async handleExchange(remotePeerId: string, request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
    const remote = this.pairing.listPeers().find((peer) => peer.peerId === remotePeerId && peer.trustState === 'trusted');
    if (!remote) throw new SyncAuthorizationError();
    if (request.hello.nodeId !== remotePeerId) throw new SyncProtocolConflictError('hello identity does not match authenticated peer');
    const negotiation = negotiateProtocol(this.hello(), request.hello);
    if (!isStringArray(request.grantedLibraryIds, 256) || !Array.isArray(request.cursors) || request.cursors.length > 4096 ||
        !Array.isArray(request.events) || request.events.length > SYNC_BATCH_LIMIT) throw new SyncProtocolConflictError('invalid sync batch');
    this.repository.setRemoteLibraries(remotePeerId, request.grantedLibraryIds);
    this.repository.acknowledgeCursors(remotePeerId, request.cursors);
    const results: SyncExchangeResponse['results'] = [];
    for (const rawEvent of request.events) {
      const event = parseEventEnvelope(rawEvent);
      if (!request.grantedLibraryIds.includes(event.libraryId)) throw new SyncAuthorizationError();
      const author = this.pairing.listPeers().find((peer) => peer.peerId === event.authorPeerId && peer.trustState === 'trusted');
      if (!author || !(await verifyEvent(event, author.publicKey))) throw new SyncProtocolConflictError('event signature or author identity is invalid');
      const result = this.repository.ingest(remotePeerId, event);
      results.push({ eventId: event.eventId, status: result.status });
    }
    const grantedLibraryIds = this.repository.listGrantedLibraries(remotePeerId);
    const libraries = [...new Set([...grantedLibraryIds, ...request.grantedLibraryIds])];
    const events = this.repository.eventsMissingForPeer(remotePeerId, request.cursors, SYNC_BATCH_LIMIT);
    this.repository.recordOfferedEvents(remotePeerId, events);
    return {
      hello: this.hello(), agreedProtocol: negotiation.protocol, schemaVersion: negotiation.schemaVersion,
      grantedLibraryIds, cursors: this.repository.getCursors(libraries), events, results
    };
  }

  async syncWithPeer(peerId: string, transport: SyncTransport, maxRounds = 32): Promise<{ rounds: number; received: number; sent: number }> {
    if (!this.pairing.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) throw new SyncAuthorizationError();
    let rounds = 0;
    let received = 0;
    let sent = 0;
    for (; rounds < maxRounds; rounds += 1) {
      const grantedLibraryIds = this.repository.listGrantedLibraries(peerId);
      const remoteLibraries = this.remoteLibraryIds(peerId);
      const cursors = this.repository.getCursors([...new Set([...grantedLibraryIds, ...remoteLibraries])]);
      const events = this.repository.eventsMissingForPeer(peerId, this.repository.getAcknowledgedCursors(peerId), SYNC_BATCH_LIMIT);
      this.repository.recordOfferedEvents(peerId, events);
      const response = await transport.exchange(peerId, { hello: this.hello(), grantedLibraryIds, cursors, events });
      if (response.hello.nodeId !== peerId) throw new SyncProtocolConflictError('hello identity does not match authenticated peer');
      const negotiation = negotiateProtocol(this.hello(), response.hello);
      if (response.agreedProtocol !== negotiation.protocol || response.schemaVersion !== negotiation.schemaVersion) {
        throw new SyncProtocolConflictError('peer returned an inconsistent protocol negotiation');
      }
      if (!isStringArray(response.grantedLibraryIds, 256) || !Array.isArray(response.cursors) || response.cursors.length > 4096 ||
          !response.cursors.every(isCursor) || !Array.isArray(response.events) || response.events.length > SYNC_BATCH_LIMIT) {
        throw new SyncProtocolConflictError('invalid sync response');
      }
      this.repository.setRemoteLibraries(peerId, response.grantedLibraryIds);
      this.repository.acknowledgeCursors(peerId, response.cursors);
      for (const rawEvent of response.events) {
        const event = parseEventEnvelope(rawEvent);
        if (!response.grantedLibraryIds.includes(event.libraryId)) throw new SyncAuthorizationError();
        const author = this.pairing.listPeers().find((peer) => peer.peerId === event.authorPeerId && peer.trustState === 'trusted');
        if (!author || !(await verifyEvent(event, author.publicKey))) throw new SyncProtocolConflictError('event signature or author identity is invalid');
        this.repository.ingest(peerId, event);
        received += 1;
      }
      sent += events.length;
      const moreIncoming = response.events.length === SYNC_BATCH_LIMIT;
      const moreOutgoing = this.repository.eventsMissingForPeer(
        peerId, this.repository.getAcknowledgedCursors(peerId), SYNC_BATCH_LIMIT
      ).length > 0;
      if (!moreIncoming && !moreOutgoing) return { rounds: rounds + 1, received, sent };
    }
    throw new SyncProtocolConflictError('sync did not converge within the round limit');
  }

  private remoteLibraryIds(peerId: string): string[] {
    return this.repository.getRemoteLibraries(peerId);
  }
}

export function isSyncExchangeRequest(value: unknown): value is SyncExchangeRequest {
  if (!isRecord(value) || !isHello(value.hello) || !isStringArray(value.grantedLibraryIds, 256) ||
      !Array.isArray(value.cursors) || value.cursors.length > 4096 || !Array.isArray(value.events) || value.events.length > SYNC_BATCH_LIMIT) return false;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES * SYNC_BATCH_LIMIT) return false;
  return value.cursors.every(isCursor) && value.events.every((event) => isRecord(event));
}

function isHello(value: unknown): value is SyncHello {
  return isRecord(value) && typeof value.nodeId === 'string' && value.nodeId.length <= 128 &&
    Number.isSafeInteger(value.protocolMin) && Number(value.protocolMin) > 0 &&
    Number.isSafeInteger(value.protocolMax) && Number(value.protocolMax) >= Number(value.protocolMin) &&
    Array.isArray(value.schemaVersions) && value.schemaVersions.length > 0 && value.schemaVersions.length <= 32 &&
    value.schemaVersions.every((version) => Number.isSafeInteger(version) && Number(version) > 0) &&
    isStringArray(value.capabilities, 128);
}

function isCursor(value: unknown): value is SyncCursor {
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
