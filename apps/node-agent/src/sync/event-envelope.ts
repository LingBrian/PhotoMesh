import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { LocalIdentity } from '../auth/local-identity.js';

export const EVENT_PROTOCOL_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const MAX_EVENT_BYTES = 256 * 1024;
const SIGNING_DOMAIN = 'PhotoMesh.EventEnvelope.v1\n';

export type SyncEventType = 'asset.indexed' | 'asset.metadata.updated' | 'asset.tombstoned' | 'asset.restored';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface EventEnvelope {
  eventId: string;
  libraryId: string;
  protocolVersion: number;
  schemaVersion: number;
  authorPeerId: string;
  authorSequence: number;
  causalParents: string[];
  eventType: string;
  payload: JsonValue;
  createdAt: string;
  signature: string;
}

export type UnsignedEventEnvelope = Omit<EventEnvelope, 'signature'>;
export interface EventContext { authorSequence: number; causalParents: string[] }
export type EventDraftFactory = (context: EventContext) => UnsignedEventEnvelope;

export function makeUnsignedEvent(input: {
  libraryId: string;
  authorPeerId: string;
  authorSequence: number;
  causalParents: readonly string[];
  eventType: SyncEventType;
  payload: JsonValue;
  createdAt: string;
  eventId?: string;
}): UnsignedEventEnvelope {
  const event: UnsignedEventEnvelope = {
    eventId: input.eventId ?? randomUUID(), libraryId: input.libraryId,
    protocolVersion: EVENT_PROTOCOL_VERSION, schemaVersion: EVENT_SCHEMA_VERSION,
    authorPeerId: input.authorPeerId, authorSequence: input.authorSequence,
    causalParents: [...new Set(input.causalParents)].sort(), eventType: input.eventType,
    payload: input.payload, createdAt: input.createdAt
  };
  if (input.eventType !== 'asset.indexed' && input.eventType !== 'asset.metadata.updated' &&
      input.eventType !== 'asset.tombstoned' && input.eventType !== 'asset.restored') throw new Error('unsupported local event type');
  validateUnsignedEvent(event);
  return event;
}

export async function signEvent(event: UnsignedEventEnvelope, identity: LocalIdentity): Promise<EventEnvelope> {
  if (event.authorPeerId !== identity.peerId) throw new Error('event author does not match local identity');
  const bytes = signingBytes(event);
  if (bytes.byteLength > MAX_EVENT_BYTES) throw new Error('event exceeds maximum size');
  const signature = await identity.privateKey.sign(bytes);
  return { ...event, signature: Buffer.from(signature).toString('base64url') };
}

export async function verifyEvent(event: EventEnvelope, trustedPublicKey: string): Promise<boolean> {
  try {
    const unsigned = omitSignature(event);
    validateUnsignedEvent(unsigned);
    const publicKeyBytes = Buffer.from(trustedPublicKey, 'base64');
    if (publicKeyBytes.toString('base64') !== trustedPublicKey) return false;
    const publicKey = publicKeyFromProtobuf(publicKeyBytes);
    if (publicKey.type !== 'Ed25519' || peerIdFromPublicKey(publicKey).toString() !== event.authorPeerId) return false;
    const signature = Buffer.from(event.signature, 'base64url');
    if (signature.byteLength !== 64 || signature.toString('base64url') !== event.signature) return false;
    return await publicKey.verify(signingBytes(unsigned), signature);
  } catch {
    return false;
  }
}

export function eventDigest(event: EventEnvelope): string {
  return createHash('sha256').update(signingBytes(omitSignature(event))).update(event.signature, 'utf8').digest('hex');
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  if (!isRecord(value) || typeof value.signature !== 'string') throw new Error('invalid event envelope');
  const event = omitSignature(value as unknown as EventEnvelope) as UnsignedEventEnvelope;
  validateUnsignedEvent(event);
  if (!/^[A-Za-z0-9_-]{86}$/.test(value.signature)) throw new Error('invalid event signature');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES) throw new Error('event exceeds maximum size');
  return value as unknown as EventEnvelope;
}

export function signingBytes(event: UnsignedEventEnvelope): Uint8Array {
  const canonical = canonicalize(event);
  if (canonical === undefined) throw new Error('event is not valid JSON');
  return Buffer.from(`${SIGNING_DOMAIN}${canonical}`, 'utf8');
}

function validateUnsignedEvent(event: UnsignedEventEnvelope): void {
  if (!isUuid(event.eventId) || !isSafeId(event.libraryId, 128) || !isPeerId(event.authorPeerId) ||
      !Number.isSafeInteger(event.protocolVersion) || event.protocolVersion < 1 ||
      !Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1 ||
      !Number.isSafeInteger(event.authorSequence) || event.authorSequence < 1 ||
      !Array.isArray(event.causalParents) || event.causalParents.length > 64 ||
      event.causalParents.some((parent) => !isUuid(parent)) || new Set(event.causalParents).size !== event.causalParents.length ||
      typeof event.eventType !== 'string' || event.eventType.length === 0 || event.eventType.length > 128 ||
      !Number.isFinite(Date.parse(event.createdAt)) || !isRecord(event.payload)) {
    throw new Error('invalid event envelope');
  }
  if (isSupportedEventType(event.eventType)) validatePayload(event.eventType, event.payload);
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) throw new Error('event exceeds maximum size');
}

function validatePayload(type: SyncEventType, payload: Record<string, unknown>): void {
  if (type !== 'asset.indexed' && type !== 'asset.metadata.updated' && type !== 'asset.tombstoned' && type !== 'asset.restored') return;
  if (!isSafeId(payload.assetId, 128)) throw new Error('invalid asset event payload');
  if (type === 'asset.indexed') {
    if (!isPeerId(payload.originNodeId) || !['photo', 'video', 'live_photo'].includes(String(payload.kind)) ||
        typeof payload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sha256) ||
        !Number.isSafeInteger(payload.byteLength) || Number(payload.byteLength) < 0) throw new Error('invalid asset index payload');
    return;
  }
  if (type === 'asset.metadata.updated') {
    if (!isRecord(payload.fields) || Object.keys(payload.fields).length === 0 || Object.keys(payload.fields).length > 32) {
      throw new Error('invalid metadata update payload');
    }
    return;
  }
  if (type === 'asset.tombstoned') {
    if (typeof payload.reason !== 'string' || payload.reason.length > 256) throw new Error('invalid tombstone payload');
    return;
  }
  if (!isUuid(payload.tombstoneEventId)) throw new Error('restore must reference a tombstone event');
}

function omitSignature(event: EventEnvelope | Record<string, unknown>): UnsignedEventEnvelope {
  const { signature: _signature, ...unsigned } = event as EventEnvelope;
  void _signature;
  return unsigned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedEventType(value: string): value is SyncEventType {
  return value === 'asset.indexed' || value === 'asset.metadata.updated' || value === 'asset.tombstoned' || value === 'asset.restored';
}

function isSafeId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20);
}

function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{10,128}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
