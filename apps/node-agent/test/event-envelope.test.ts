import { describe, expect, it } from 'vitest';
import { makeUnsignedEvent, parseEventEnvelope, signEvent, signingBytes, verifyEnvelopeSignature, verifyEvent, type JsonValue } from '../src/sync/event-envelope.js';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { SqliteRepository } from '../src/db/repository.js';
import Database from 'better-sqlite3';

const publicKeyText = (identity: { publicKey: Uint8Array }): string => Buffer.from(identity.publicKey).toString('base64');

describe('signed EventEnvelope', () => {
  it('signs canonical RFC 8785 bytes and verifies against the trusted Ed25519 identity', async () => {
    const identity = await makeIdentity();
    const draft = makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', payload: { assetId: 'asset-1', originNodeId: identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 },
      createdAt: '2026-10-21T00:00:00.000Z'
    });
    const permuted = { ...draft, payload: { byteLength: 10, sha256: 'a'.repeat(64), kind: 'photo', originNodeId: identity.peerId, assetId: 'asset-1' } };
    expect(Buffer.from(signingBytes(draft))).toEqual(Buffer.from(signingBytes(permuted)));
    const signed = await signEvent(draft, identity);
    expect(await verifyEvent(signed, publicKeyText(identity))).toBe(true);
    expect(await verifyEvent({ ...signed, payload: { ...(signed.payload as Record<string, JsonValue>), byteLength: 11 } }, publicKeyText(identity))).toBe(false);
    const stranger = await makeIdentity();
    expect(await verifyEvent(signed, publicKeyText(stranger))).toBe(false);
  });

  it('can verify the author signature of a schema-invalid envelope before quarantining it', async () => {
    const identity = await makeIdentity();
    const valid = makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'album.created', payload: { albumId: '123e4567-e89b-42d3-a456-426614174000', title: 'Trip', createdAt: '2026-10-21T00:00:00.000Z' },
      createdAt: '2026-10-21T00:00:00.000Z'
    });
    const signedInvalid = await signEvent({ ...valid, payload: { albumId: 'invalid', title: '', createdAt: 'not-a-date' } }, identity);
    expect(await verifyEvent(signedInvalid, publicKeyText(identity))).toBe(false);
    expect(await verifyEnvelopeSignature(signedInvalid, publicKeyText(identity))).toBe(true);
    const oversizedUnsigned = { ...valid, eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { description: 'x'.repeat(300_000) } } };
    const oversized = { ...oversizedUnsigned, signature: Buffer.from(await identity.privateKey.sign(signingBytes(oversizedUnsigned))).toString('base64url') };
    expect(await verifyEvent(oversized as never, publicKeyText(identity))).toBe(false);
    expect(await verifyEnvelopeSignature(oversized, publicKeyText(identity))).toBe(true);
    expect(() => parseEventEnvelope(oversized)).toThrow('event exceeds maximum size');
  });

  it('rejects malformed, oversized, duplicate-parent and unsupported local events', async () => {
    const identity = await makeIdentity();
    const base = {
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed' as const, payload: { assetId: 'asset-1', originNodeId: identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 },
      createdAt: '2026-10-21T00:00:00.000Z'
    };
    expect(() => makeUnsignedEvent({ ...base, authorSequence: 0 })).toThrow('invalid event envelope');
    expect(makeUnsignedEvent({ ...base, causalParents: ['123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174000'] }).causalParents)
      .toEqual(['123e4567-e89b-42d3-a456-426614174000']);
    expect(() => makeUnsignedEvent({ ...base, eventType: 'unknown' as never })).toThrow('unsupported local event type');
    const signed = await signEvent(makeUnsignedEvent(base), identity);
    expect(() => parseEventEnvelope({ ...signed, signature: 'bad' })).toThrow('invalid event signature');
    expect(() => parseEventEnvelope({ ...signed, eventType: 'asset.metadata.updated', payload: { assetId: 'asset-1', fields: { description: 'x'.repeat(300_000) } } }))
      .toThrow('event exceeds maximum size');
  });

  it('signs and validates tag OR-Set events as first-class envelopes', async () => {
    const identity = await makeIdentity();
    const add = makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.tag.added', payload: { assetId: 'asset-1', tag: 'Summer' }, createdAt: '2026-10-27T00:00:00.000Z'
    });
    const signed = await signEvent(add, identity);
    expect(await verifyEvent(signed, publicKeyText(identity))).toBe(true);
    expect(parseEventEnvelope(signed)).toEqual(signed);
    expect(() => makeUnsignedEvent({ ...add, eventType: 'asset.tag.added', payload: { assetId: 'asset-1', tag: ' Summer ' } })).toThrow();
    expect(() => makeUnsignedEvent({ ...add, eventType: 'asset.tag.removed', payload: { assetId: 'asset-1', tag: 'Summer', observedAddEventIds: [] } })).toThrow();
  });

  it('signs and validates library-favorite OR-Set envelopes', async () => {
    const identity = await makeIdentity();
    const assetIndexId = '123e4567-e89b-42d3-a456-426614174000';
    const add = makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1,
      causalParents: [assetIndexId], eventType: 'asset.favorite.added', payload: { assetId: 'asset-1' },
      createdAt: '2026-10-28T00:00:00.000Z' });
    const signedAdd = await signEvent(add, identity);
    expect(await verifyEvent(signedAdd, publicKeyText(identity))).toBe(true);
    expect(parseEventEnvelope(signedAdd)).toEqual(signedAdd);
    const observed = ['123e4567-e89b-42d3-a456-426614174001', '123e4567-e89b-42d3-a456-426614174002'];
    const remove = makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 2,
      causalParents: observed, eventType: 'asset.favorite.removed',
      payload: { assetId: 'asset-1', observedAddEventIds: observed }, createdAt: '2026-10-28T00:00:01.000Z' });
    expect(parseEventEnvelope(await signEvent(remove, identity))).toEqual({ ...remove, signature: expect.any(String) });
    expect(() => makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 3,
      causalParents: [], eventType: 'asset.favorite.added', payload: { assetId: 'asset-1' }, createdAt: '2026-10-28T00:00:02.000Z' })).toThrow();
    expect(() => makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 3,
      causalParents: [observed[0]!], eventType: 'asset.favorite.removed',
      payload: { assetId: 'asset-1', observedAddEventIds: observed }, createdAt: '2026-10-28T00:00:02.000Z' })).toThrow();
    expect(() => makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 3,
      causalParents: [], eventType: 'asset.favorite.removed', payload: { assetId: 'asset-1', observedAddEventIds: [] },
      createdAt: '2026-10-28T00:00:02.000Z' })).toThrow();
    const tooMany = Array.from({ length: 65 }, (_, index) => `123e4567-e89b-42d3-a456-${(index + 10).toString(16).padStart(12, '0')}`);
    expect(() => makeUnsignedEvent({ libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 3,
      causalParents: tooMany, eventType: 'asset.favorite.removed', payload: { assetId: 'asset-1', observedAddEventIds: tooMany },
      createdAt: '2026-10-28T00:00:02.000Z' })).toThrow();
  });

  it('validates rating MV-register events and observed causal context', async () => {
    const identity = await makeIdentity();
    const assetIndexId = '123e4567-e89b-42d3-a456-426614174000';
    const ratingId = '123e4567-e89b-42d3-a456-426614174001';
    const set = makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [assetIndexId],
      eventType: 'asset.rating.set', payload: { assetId: 'asset-1', rating: 4, observedRatingEventIds: [] },
      createdAt: '2026-10-29T00:00:00.000Z'
    });
    const signed = await signEvent(set, identity);
    expect(await verifyEvent(signed, publicKeyText(identity))).toBe(true);
    expect(parseEventEnvelope(signed)).toEqual(signed);
    const invalid = (rating: JsonValue, observed: string[] = [ratingId], parents: string[] = [ratingId]) => makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 2, causalParents: parents,
      eventType: 'asset.rating.set', payload: { assetId: 'asset-1', rating, observedRatingEventIds: observed },
      createdAt: '2026-10-29T00:00:01.000Z'
    });
    expect(() => invalid(0)).toThrow();
    expect(() => invalid(6)).toThrow();
    expect(() => invalid(2.5)).toThrow();
    expect(() => invalid(true)).toThrow();
    expect(() => invalid(null, [])).toThrow();
    expect(() => invalid(null, [ratingId], [])).toThrow();
    expect(() => makeUnsignedEvent({
      eventId: ratingId, libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 2, causalParents: [ratingId],
      eventType: 'asset.rating.set', payload: { assetId: 'asset-1', rating: 3, observedRatingEventIds: [ratingId] },
      createdAt: '2026-10-29T00:00:01.000Z'
    })).toThrow();
    const tooMany = Array.from({ length: 65 }, (_, index) => `123e4567-e89b-42d3-a456-${(index + 10).toString(16).padStart(12, '0')}`);
    expect(() => invalid(3, tooMany, tooMany)).toThrow();
  });

  it('accepts legacy asset indexes and validates optional capture provenance', async () => {
    const identity = await makeIdentity();
    const common = {
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed' as const,
      createdAt: '2026-10-21T00:00:00.000Z'
    };
    const payload = { assetId: 'asset-1', originNodeId: identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 };
    expect(() => makeUnsignedEvent({ ...common, payload })).not.toThrow();
    expect(() => makeUnsignedEvent({ ...common, payload: { ...payload, capture: {
      capturedAt: '2024-04-02T09:04:05.000Z', localTime: '2024-04-02T12:04:05.000', offsetMinutes: 180,
      source: 'exif_offset', confidence: 'high'
    } } })).not.toThrow();
    expect(() => makeUnsignedEvent({ ...common, payload: { ...payload, capture: {
      capturedAt: '2024-04-02T12:04:05.000Z', localTime: '2024-04-02T12:04:05.000', offsetMinutes: 180,
      source: 'exif_offset', confidence: 'high'
    } } })).toThrow(/asset index payload/i);
    expect(() => makeUnsignedEvent({ ...common, payload: { ...payload, capture: {
      capturedAt: null, localTime: '2023-02-29T12:04:05.000', offsetMinutes: null,
      source: 'exif_floating', confidence: 'medium'
    } } })).toThrow(/asset index payload/i);
  });

  it('preserves a well-formed unknown event version for safe non-application', async () => {
    const identity = await makeIdentity();
    const known = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.indexed', payload: { assetId: 'asset-1', originNodeId: identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 },
      createdAt: '2026-10-21T00:00:00.000Z'
    }), identity);
    const { signature: _signature, ...unsigned } = known;
    void _signature;
    const unknownSigned = await signEvent({ ...unsigned, schemaVersion: 2, eventType: 'asset.annotation.v2', payload: { assetId: 'asset-1', annotation: 'future' } }, identity);
    expect(() => parseEventEnvelope(unknownSigned)).not.toThrow();
  });
});

async function makeIdentity() {
  const database = new Database(':memory:');
  const repository = new SqliteRepository(database);
  await repository.migrate();
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (name) => secrets.get(name), set: (name, value) => { secrets.set(name, value); }
  });
  database.close();
  return identity;
}
