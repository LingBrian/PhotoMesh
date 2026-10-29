import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { LocalIdentity } from '../auth/local-identity.js';
import { validateTagOperationPayload } from './tag-orset.js';

export const EVENT_PROTOCOL_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const MAX_EVENT_BYTES = 256 * 1024;
const MAX_SIGNATURE_VERIFICATION_BYTES = 16 * 1024 * 1024;
const SIGNING_DOMAIN = 'PhotoMesh.EventEnvelope.v1\n';

export type SyncEventType = 'asset.indexed' | 'asset.metadata.updated' | 'asset.tombstoned' | 'asset.restored';
export type TagSyncEventType = 'asset.tag.added' | 'asset.tag.removed';
export type AlbumSyncEventType = 'album.created' | 'album.member.added' | 'album.member.removed' | 'album.deleted' | 'album.restored';
export type FavoriteSyncEventType = 'asset.favorite.added' | 'asset.favorite.removed';
export type RatingSyncEventType = 'asset.rating.set';
export type AnyEventType = SyncEventType | TagSyncEventType | AlbumSyncEventType | FavoriteSyncEventType | RatingSyncEventType;
export const MAX_ALBUM_OBSERVED_IDS = 64;
export const MAX_FAVORITE_OBSERVED_IDS = 64;
export const MAX_RATING_OBSERVED_IDS = 64;
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
  eventType: AnyEventType;
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
  if (!isSupportedEventType(input.eventType) && !isTagSyncEventType(input.eventType) && !isAlbumSyncEventType(input.eventType) &&
      !isFavoriteSyncEventType(input.eventType) && !isRatingSyncEventType(input.eventType)) throw new Error('unsupported local event type');
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

export async function verifyEnvelopeSignature(value: unknown, trustedPublicKey: string): Promise<boolean> {
  try {
    if (!isRecord(value) || typeof value.signature !== 'string' || typeof value.authorPeerId !== 'string' ||
        Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SIGNATURE_VERIFICATION_BYTES) return false;
    const { signature: signatureText, ...unsigned } = value;
    const publicKeyBytes = Buffer.from(trustedPublicKey, 'base64');
    if (publicKeyBytes.toString('base64') !== trustedPublicKey) return false;
    const publicKey = publicKeyFromProtobuf(publicKeyBytes);
    if (publicKey.type !== 'Ed25519' || peerIdFromPublicKey(publicKey).toString() !== value.authorPeerId) return false;
    const signature = Buffer.from(signatureText, 'base64url');
    if (signature.byteLength !== 64 || signature.toString('base64url') !== signatureText) return false;
    return await publicKey.verify(signingBytes(unsigned as UnsignedEventEnvelope), signature);
  } catch {
    return false;
  }
}

export async function verifyEvent(event: EventEnvelope, trustedPublicKey: string): Promise<boolean> {
  try {
    validateUnsignedEvent(omitSignature(event));
    return await verifyEnvelopeSignature(event, trustedPublicKey);
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
      event.causalParents.some((parent) => !isUuid(parent)) || event.causalParents.includes(event.eventId) ||
      new Set(event.causalParents).size !== event.causalParents.length ||
      typeof event.eventType !== 'string' || event.eventType.length === 0 || event.eventType.length > 128 ||
      !Number.isFinite(Date.parse(event.createdAt)) || !isRecord(event.payload)) {
    throw new Error('invalid event envelope');
  }
  if (isSupportedEventType(event.eventType)) validatePayload(event.eventType, event.payload);
  else if (isTagSyncEventType(event.eventType)) validateTagOperationPayload(event.eventType, event.payload);
  else if (isAlbumSyncEventType(event.eventType)) validateAlbumEventPayload(event.eventType, event.payload);
  else if (isFavoriteSyncEventType(event.eventType)) validateFavoriteEventPayload(event.eventType, event.payload, event.causalParents);
  else if (isRatingSyncEventType(event.eventType)) validateRatingEventPayload(event.payload, event.causalParents);
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

function validateAlbumEventPayload(type: AlbumSyncEventType, payload: Record<string, unknown>): void {
  const albumId = payload.albumId;
  if (!isUuid(albumId)) throw new Error('invalid album event payload');
  if (type === 'album.created') {
    if (!hasExactKeys(payload, ['albumId', 'title', 'createdAt']) || typeof payload.title !== 'string' ||
        payload.title.length === 0 || payload.title.trim() !== payload.title || Buffer.byteLength(payload.title, 'utf8') > 256 ||
        typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt))) {
      throw new Error('invalid album create payload');
    }
    return;
  }
  if (type === 'album.member.added') {
    if (!hasExactKeys(payload, ['albumId', 'assetId']) || !isSafeId(payload.assetId, 128)) throw new Error('invalid album member add payload');
    return;
  }
  if (type === 'album.member.removed' || type === 'album.restored') {
    const key = type === 'album.member.removed' ? 'observedAddEventIds' : 'observedDeleteEventIds';
    const expectedKeys = type === 'album.member.removed' ? ['albumId', 'assetId', key] : ['albumId', key];
    const ids = payload[key];
    if (!hasExactKeys(payload, expectedKeys) ||
        (type === 'album.member.removed' && !isSafeId(payload.assetId, 128)) ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ALBUM_OBSERVED_IDS ||
        !ids.every((id) => isUuid(id)) || ids.some((id, index) => index > 0 && String(ids[index - 1]) >= String(id))) {
      throw new Error('invalid album observed-event payload');
    }
    return;
  }
  if (!hasExactKeys(payload, ['albumId'])) throw new Error('invalid album delete payload');
}

function validateFavoriteEventPayload(type: FavoriteSyncEventType, payload: Record<string, unknown>, causalParents: readonly string[]): void {
  if (!isSafeId(payload.assetId, 128)) throw new Error('invalid favorite asset payload');
  if (type === 'asset.favorite.added') {
    if (!hasExactKeys(payload, ['assetId']) || causalParents.length !== 1) throw new Error('favorite add must reference one asset index parent');
    return;
  }
  const ids = payload.observedAddEventIds;
  if (!hasExactKeys(payload, ['assetId', 'observedAddEventIds']) || !Array.isArray(ids) || ids.length < 1 ||
      ids.length > MAX_FAVORITE_OBSERVED_IDS || !ids.every(isUuid) ||
      ids.some((id, index) => index > 0 && String(ids[index - 1]) >= String(id)) ||
      causalParents.length !== ids.length || causalParents.some((id, index) => id !== ids[index])) {
    throw new Error('favorite remove must observe sorted unique add IDs as causal parents');
  }
}

function validateRatingEventPayload(payload: Record<string, unknown>, causalParents: readonly string[]): void {
  const rating = payload.rating;
  const observed = payload.observedRatingEventIds;
  if (!hasExactKeys(payload, ['assetId', 'rating', 'observedRatingEventIds']) || !isSafeId(payload.assetId, 128) ||
      !(rating === null || (typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5)) ||
      !Array.isArray(observed) || observed.length > MAX_RATING_OBSERVED_IDS || !observed.every(isUuid) ||
      observed.some((id, index) => index > 0 && String(observed[index - 1]) >= String(id))) {
    throw new Error('invalid rating payload');
  }
  if (observed.length === 0) {
    if (rating === null || causalParents.length !== 1 || !isUuid(causalParents[0])) {
      throw new Error('initial rating must reference one asset index parent');
    }
  } else if (causalParents.length !== observed.length || causalParents.some((id, index) => id !== observed[index])) {
    throw new Error('rating must observe sorted unique rating IDs as causal parents');
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function omitSignature(event: EventEnvelope | Record<string, unknown>): UnsignedEventEnvelope {
  const { signature: _signature, ...unsigned } = event as EventEnvelope;
  void _signature;
  return unsigned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSupportedEventType(value: string): value is SyncEventType {
  return value === 'asset.indexed' || value === 'asset.metadata.updated' || value === 'asset.tombstoned' || value === 'asset.restored';
}

export function isTagSyncEventType(value: string): value is TagSyncEventType {
  return value === 'asset.tag.added' || value === 'asset.tag.removed';
}

export function isAlbumSyncEventType(value: string): value is AlbumSyncEventType {
  return value === 'album.created' || value === 'album.member.added' || value === 'album.member.removed' ||
    value === 'album.deleted' || value === 'album.restored';
}

export function isFavoriteSyncEventType(value: string): value is FavoriteSyncEventType {
  return value === 'asset.favorite.added' || value === 'asset.favorite.removed';
}

export function isRatingSyncEventType(value: string): value is RatingSyncEventType {
  return value === 'asset.rating.set';
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
