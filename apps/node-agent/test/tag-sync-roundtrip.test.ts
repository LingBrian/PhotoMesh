import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalIdentity } from '../src/auth/local-identity.js';
import { SqliteRepository } from '../src/db/repository.js';
import { migrations } from '../src/db/migrations.js';
import { makeUnsignedEvent, signEvent, type EventEnvelope } from '../src/sync/event-envelope.js';
import { SyncRepository } from '../src/sync/sync-repository.js';
import { TagSyncRepository, type TagEventDraftFactory } from '../src/sync/tag-sync-repository.js';

const databases: Database.Database[] = [];
const now = '2026-10-27T00:00:00.000Z';

async function createNode(name: string) {
  const database = new Database(':memory:');
  databases.push(database);
  const repository = new SqliteRepository(database);
  await repository.migrate(migrations);
  const secrets = new Map<string, string>();
  const identity = await loadOrCreateLocalIdentity(repository, {
    get: (key) => secrets.get(`${name}:${key}`),
    set: (key, value) => { secrets.set(`${name}:${key}`, value); }
  });
  database.prepare(`INSERT INTO assets (asset_id, library_id, origin_node_id, kind, capture_ts, created_at)
    VALUES ('shared-asset', 'family', ?, 'photo', NULL, ?)`).run(identity.peerId, now);
  const syncRepository = new SyncRepository(database, () => now);
  return { database, identity, repository, syncRepository, tags: new TagSyncRepository(database, () => now) };
}

async function seedSharedAssetIndex(...nodes: Array<Awaited<ReturnType<typeof createNode>>>) {
  const owner = nodes[0]!;
  const event = await signEvent(makeUnsignedEvent({
    libraryId: 'family', authorPeerId: owner.identity.peerId, authorSequence: 1, causalParents: [],
    eventType: 'asset.indexed', createdAt: now,
    payload: { assetId: 'shared-asset', originNodeId: owner.identity.peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 }
  }), owner.identity);
  for (const node of nodes) node.syncRepository.appendLocalEvent(event);
  return event;
}

function authorize(receiver: Awaited<ReturnType<typeof createNode>>, peer: Awaited<ReturnType<typeof createNode>>): void {
  receiver.database.prepare(`INSERT INTO trusted_peers (peer_id, public_key, label, trust_state, created_at, revoked_at)
    VALUES (?, ?, ?, 'trusted', ?, NULL)`).run(peer.identity.peerId, Buffer.from(peer.identity.publicKey).toString('base64'), peer.identity.peerId, now);
  receiver.database.prepare(`INSERT INTO sync_remote_library_grants (peer_id, library_id, observed_at) VALUES (?, 'family', ?)`)
    .run(peer.identity.peerId, now);
  receiver.tags.grantTagWriter('family', peer.identity.peerId, receiver.identity.peerId, now);
}

function factory(libraryId: string, authorPeerId: string): TagEventDraftFactory {
  return ({ context, eventType, payload, createdAt }) => makeUnsignedEvent({
    libraryId, authorPeerId, authorSequence: context.authorSequence, causalParents: context.causalParents,
    eventType, payload, createdAt
  });
}

async function createSignedLocalTagEvent(node: Awaited<ReturnType<typeof createNode>>, tag: string): Promise<EventEnvelope> {
  expect(node.tags.addLocalTag({ libraryId: 'family', assetId: 'shared-asset', tag, authorPeerId: node.identity.peerId,
    createdAt: now, draftFactory: factory('family', node.identity.peerId) })).toBe('added');
  const draft = node.tags.getUnsignedLocalDrafts(node.identity.peerId)[0]!;
  const signed = await signEvent(draft, node.identity);
  node.tags.completeLocalDraft(signed);
  return signed;
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('signed tag OR-Set replication', () => {
  it('merges concurrent same-tag adds, removes only observed adds, and preserves a concurrent unseen add', async () => {
    const a = await createNode('a');
    const b = await createNode('b');
    const c = await createNode('c');
    authorize(a, b); authorize(a, c);
    authorize(b, a); authorize(b, c);
    authorize(c, a); authorize(c, b);
    await seedSharedAssetIndex(a, b, c);

    const addA = await createSignedLocalTagEvent(a, 'Summer');
    const addB = await createSignedLocalTagEvent(b, 'Summer');
    const concurrentAddC = await createSignedLocalTagEvent(c, 'Summer');

    expect(a.tags.ingest(b.identity.peerId, addB)).toMatchObject({ status: 'applied', appliedEventIds: [addB.eventId] });
    expect(b.tags.ingest(a.identity.peerId, addA)).toMatchObject({ status: 'applied', appliedEventIds: [addA.eventId] });
    expect(a.tags.ingest(b.identity.peerId, addB)).toMatchObject({ status: 'duplicate' });
    expect(a.tags.getAssetTags('family', 'shared-asset')).toEqual(['Summer']);
    expect(b.tags.getAssetTags('family', 'shared-asset')).toEqual(['Summer']);

    expect(a.tags.removeLocalTag({ libraryId: 'family', assetId: 'shared-asset', tag: 'Summer', authorPeerId: a.identity.peerId,
      createdAt: now, draftFactory: factory('family', a.identity.peerId) })).toBe('removed');
    const removeDraft = a.tags.getUnsignedLocalDrafts(a.identity.peerId)[0]!;
    expect(removeDraft.payload).toMatchObject({ observedAddEventIds: [addA.eventId, addB.eventId].sort() });
    const removeA = await signEvent(removeDraft, a.identity);
    a.tags.completeLocalDraft(removeA);

    expect(b.tags.ingest(a.identity.peerId, removeA)).toMatchObject({ status: 'applied', appliedEventIds: [removeA.eventId] });
    expect(a.tags.getAssetTags('family', 'shared-asset')).toEqual([]);
    expect(b.tags.getAssetTags('family', 'shared-asset')).toEqual([]);

    expect(a.tags.ingest(c.identity.peerId, concurrentAddC)).toMatchObject({ status: 'applied' });
    expect(b.tags.ingest(c.identity.peerId, concurrentAddC)).toMatchObject({ status: 'applied' });
    expect(a.tags.getAssetTags('family', 'shared-asset')).toEqual(['Summer']);
    expect(b.tags.getAssetTags('family', 'shared-asset')).toEqual(['Summer']);
  });

  it('retains a remove with an unseen observed add until that add arrives', async () => {
    const receiver = await createNode('observed-receiver');
    const remover = await createNode('observed-remover');
    const adder = await createNode('observed-adder');
    authorize(receiver, remover); authorize(remover, receiver);
    authorize(receiver, adder); authorize(adder, receiver);
    const sharedIndex = await seedSharedAssetIndex(receiver, remover, adder);
    const addEventId = '550e8400-e29b-41d4-a716-446655440000';
    const remove = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: remover.identity.peerId, authorSequence: 1,
      causalParents: [addEventId], eventType: 'asset.tag.removed',
      payload: { assetId: 'shared-asset', tag: 'delayed', observedAddEventIds: [addEventId] }, createdAt: now
    }), remover.identity);
    const add = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: adder.identity.peerId, authorSequence: 1,
      causalParents: [sharedIndex.eventId], eventType: 'asset.tag.added', payload: { assetId: 'shared-asset', tag: 'delayed' },
      createdAt: now, eventId: addEventId
    }), adder.identity);

    expect(receiver.tags.ingest(remover.identity.peerId, remove)).toMatchObject({ status: 'pending' });
    expect(receiver.tags.getAssetTags('family', 'shared-asset')).toEqual([]);
    const applied = receiver.tags.ingest(adder.identity.peerId, add);
    expect(applied.appliedEventIds).toEqual([addEventId, remove.eventId]);
    expect(receiver.tags.getAssetTags('family', 'shared-asset')).toEqual([]);
    expect(receiver.database.prepare('SELECT state FROM tag_sync_inbox WHERE event_id = ?').get(remove.eventId))
      .toEqual({ state: 'applied' });
  });

  it('rejects a remove that names a known add outside its causal past', async () => {
    const receiver = await createNode('causal-receiver');
    const remover = await createNode('causal-remover');
    const adder = await createNode('causal-adder');
    authorize(receiver, remover); authorize(remover, receiver);
    authorize(receiver, adder); authorize(adder, receiver);
    const sharedIndex = await seedSharedAssetIndex(receiver, remover, adder);
    const addEventId = '550e8400-e29b-41d4-a716-446655440001';
    const add = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: adder.identity.peerId, authorSequence: 1, causalParents: [sharedIndex.eventId],
      eventType: 'asset.tag.added', payload: { assetId: 'shared-asset', tag: 'concurrent' }, createdAt: now,
      eventId: addEventId
    }), adder.identity);
    expect(receiver.tags.ingest(adder.identity.peerId, add)).toMatchObject({ status: 'applied' });

    const remove = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: remover.identity.peerId, authorSequence: 1, causalParents: [],
      eventType: 'asset.tag.removed',
      payload: { assetId: 'shared-asset', tag: 'concurrent', observedAddEventIds: [addEventId] }, createdAt: now
    }), remover.identity);
    expect(receiver.tags.ingest(remover.identity.peerId, remove)).toMatchObject({ status: 'conflict' });
    expect(receiver.database.prepare('SELECT error_code FROM tag_sync_inbox WHERE event_id = ?').get(remove.eventId))
      .toEqual({ error_code: 'unobserved_add_reference' });
    expect(receiver.tags.getAssetTags('family', 'shared-asset')).toEqual(['concurrent']);
  });

  it('retains out-of-order tag events until the author predecessor and observed add arrive', async () => {
    const a = await createNode('order-a');
    const b = await createNode('order-b');
    authorize(a, b);
    authorize(b, a);
    await seedSharedAssetIndex(a, b);

    const add = await createSignedLocalTagEvent(a, 'ordered');
    expect(a.tags.removeLocalTag({ libraryId: 'family', assetId: 'shared-asset', tag: 'ordered', authorPeerId: a.identity.peerId,
      createdAt: now, draftFactory: factory('family', a.identity.peerId) })).toBe('removed');
    const removeDraft = a.tags.getUnsignedLocalDrafts(a.identity.peerId)[0]!;
    const remove = await signEvent(removeDraft, a.identity);
    a.tags.completeLocalDraft(remove);

    expect(b.tags.ingest(a.identity.peerId, remove)).toMatchObject({ status: 'pending', appliedEventIds: [] });
    expect(b.tags.ingest(a.identity.peerId, add)).toMatchObject({ status: 'applied', appliedEventIds: [add.eventId, remove.eventId] });
    expect(b.tags.getAssetTags('family', 'shared-asset')).toEqual([]);
  });

  it('rejects repeated active add IDs from one writer so removal stays within its bound', async () => {
    const receiver = await createNode('duplicate-add-receiver');
    const writer = await createNode('duplicate-add-writer');
    authorize(receiver, writer); authorize(writer, receiver);
    const sharedIndex = await seedSharedAssetIndex(receiver, writer);
    const first = await createSignedLocalTagEvent(writer, 'same-tag');
    expect(receiver.tags.ingest(writer.identity.peerId, first)).toMatchObject({ status: 'applied' });
    const duplicate = await signEvent(makeUnsignedEvent({
      libraryId: 'family', authorPeerId: writer.identity.peerId, authorSequence: 2,
      causalParents: [first.eventId, sharedIndex.eventId].sort(), eventType: 'asset.tag.added',
      payload: { assetId: 'shared-asset', tag: 'same-tag' }, createdAt: now
    }), writer.identity);
    expect(receiver.tags.ingest(writer.identity.peerId, duplicate)).toMatchObject({ status: 'conflict' });
    expect(receiver.database.prepare('SELECT error_code FROM tag_sync_inbox WHERE event_id = ?').get(duplicate.eventId))
      .toEqual({ error_code: 'duplicate_active_tag_add' });
    expect(receiver.tags.getAssetTags('family', 'shared-asset')).toEqual(['same-tag']);
    expect(receiver.database.prepare('SELECT count(*) AS count FROM asset_tag_adds WHERE asset_id = ?').get('shared-asset'))
      .toEqual({ count: 1 });
  });

  it('marks already-pending author events conflicted when tag-write authority is revoked', async () => {
    const receiver = await createNode('revoke-receiver');
    const writer = await createNode('revoke-writer');
    authorize(receiver, writer);
    authorize(writer, receiver);
    await seedSharedAssetIndex(receiver, writer);

    const predecessor = await createSignedLocalTagEvent(writer, 'predecessor');
    const pending = await createSignedLocalTagEvent(writer, 'pending');
    expect(receiver.tags.ingest(writer.identity.peerId, pending)).toMatchObject({ status: 'pending' });
    expect(receiver.database.prepare('SELECT state FROM tag_sync_inbox WHERE event_id = ?').get(pending.eventId))
      .toEqual({ state: 'pending' });

    expect(receiver.tags.revokeTagWriter('family', writer.identity.peerId, now)).toBe(true);
    expect(receiver.database.prepare('SELECT state, error_code FROM tag_sync_inbox WHERE event_id = ?').get(pending.eventId))
      .toEqual({ state: 'conflict', error_code: 'tag_writer_revoked' });
    expect(receiver.tags.getAssetTags('family', 'shared-asset')).toEqual([]);
    expect(() => receiver.tags.ingest(writer.identity.peerId, predecessor)).toThrow('tag-write authority');
  });

  it('rejects a read-only author and a trusted relay cannot impersonate an ungranted author', async () => {
    const receiver = await createNode('receiver');
    const relay = await createNode('relay');
    const author = await createNode('author');
    authorize(receiver, relay);
    authorize(relay, receiver);
    authorize(receiver, author);
    authorize(author, receiver);
    await seedSharedAssetIndex(receiver, relay, author);
    receiver.tags.revokeTagWriter('family', author.identity.peerId, now);

    const event = await createSignedLocalTagEvent(author, 'private');
    expect(() => receiver.tags.ingest(relay.identity.peerId, event)).toThrow('tag-write authority');
  });
});
