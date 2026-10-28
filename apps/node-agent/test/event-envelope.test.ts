import { describe, expect, it } from 'vitest';
import { makeUnsignedEvent, parseEventEnvelope, signEvent, signingBytes, verifyEvent, type JsonValue } from '../src/sync/event-envelope.js';
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
