import type Database from 'better-sqlite3';
import { appendMetadataAudit, type AuditRepository } from '../audit/audit-repository.js';
import { eventDigest, isTagSyncEventType, parseEventEnvelope, type EventContext, type EventEnvelope, type JsonValue, type TagSyncEventType, type UnsignedEventEnvelope } from './event-envelope.js';
import { maxObservedTagAdds, validateTagOperationPayload } from './tag-orset.js';

export const maxTagAuthorsPerLibrary = 64;
export const maxActiveTagsPerWriterPerAsset = 64;

export type TagMutationResult = 'added' | 'already_present' | 'removed' | 'unchanged' | 'not_found' | 'limit_reached';

export interface TagEventDraftInput {
  context: EventContext;
  libraryId: string;
  authorPeerId: string;
  eventType: TagSyncEventType;
  payload: JsonValue;
  createdAt: string;
}

export type TagEventDraftFactory = (input: TagEventDraftInput) => UnsignedEventEnvelope;

export interface TagSyncCursor { libraryId: string; authorPeerId: string; sequence: number }

export interface TagIngestResult {
  status: 'applied' | 'pending' | 'duplicate' | 'unsupported' | 'conflict';
  appliedEventIds: string[];
}

export class TagSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagSyncConflictError';
  }
}

export class TagSyncAuthorizationError extends Error {
  constructor(message = 'tag-write authority is required for the event author') {
    super(message);
    this.name = 'TagSyncAuthorizationError';
  }
}

interface TagEventRow { event_id: string; library_id: string; author_peer_id: string; author_sequence: number; envelope_json: string; state: string }
interface TagInboxRow { event_id: string; library_id: string; author_peer_id: string; author_sequence: number; envelope_json: string; state: string }
interface TagSeedRow { library_id: string; asset_id: string; tag: string; created_at: string; state: string; seed_event_id: string | null }

export class TagSyncRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly auditRepository?: AuditRepository
  ) {}

  addLocalTag(input: {
    libraryId: string; assetId: string; tag: string; authorPeerId: string; createdAt: string; draftFactory: TagEventDraftFactory; requestId?: string | undefined;
  }): TagMutationResult {
    const write = this.db.transaction((): TagMutationResult => {
      if (!this.hasKnownAsset(input.libraryId, input.assetId) || !this.hasAssetProjectionHead(input.libraryId, input.assetId) ||
          !this.isVisibleAsset(input.libraryId, input.assetId)) return 'not_found';
      if (this.db.prepare('SELECT 1 FROM asset_tags WHERE library_id = ? AND asset_id = ? AND tag = ?')
        .get(input.libraryId, input.assetId, input.tag)) {
        appendMetadataAudit(this.auditRepository, {
          action: 'asset.tag.add', resourceType: 'asset', libraryId: input.libraryId, resourceId: input.assetId,
          outcome: 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        return 'already_present';
      }

      const count = this.countActiveAddsByAuthor(input.libraryId, input.assetId, input.authorPeerId);
      if (count >= maxActiveTagsPerWriterPerAsset) return 'limit_reached';

      const draft = this.reserveLocalEventDraft(input.libraryId, input.authorPeerId, input.createdAt,
        input.draftFactory, 'asset.tag.added', { assetId: input.assetId, tag: input.tag });
      this.db.prepare(`INSERT INTO asset_tag_adds (library_id, asset_id, tag, add_event_id)
        VALUES (?, ?, ?, ?)`).run(input.libraryId, input.assetId, input.tag, draft.eventId);
      this.db.prepare(`INSERT INTO asset_tags (library_id, asset_id, tag, created_at)
        VALUES (?, ?, ?, ?)`).run(input.libraryId, input.assetId, input.tag, input.createdAt);
      appendMetadataAudit(this.auditRepository, {
        action: 'asset.tag.add', resourceType: 'asset', libraryId: input.libraryId, resourceId: input.assetId,
        outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      return 'added';
    });
    return write.immediate();
  }

  removeLocalTag(input: {
    libraryId: string; assetId: string; tag: string; authorPeerId: string; createdAt: string; draftFactory: TagEventDraftFactory; requestId?: string | undefined;
  }): TagMutationResult {
    const write = this.db.transaction((): TagMutationResult => {
      if (!this.hasKnownAsset(input.libraryId, input.assetId) || !this.hasAssetProjectionHead(input.libraryId, input.assetId) ||
          !this.isVisibleAsset(input.libraryId, input.assetId)) return 'not_found';
      if (!this.db.prepare('SELECT 1 FROM asset_tags WHERE library_id = ? AND asset_id = ? AND tag = ?')
        .get(input.libraryId, input.assetId, input.tag)) {
        appendMetadataAudit(this.auditRepository, {
          action: 'asset.tag.remove', resourceType: 'asset', libraryId: input.libraryId, resourceId: input.assetId,
          outcome: 'unchanged', requestId: input.requestId, createdAt: input.createdAt
        });
        return 'unchanged';
      }

      const observedAddEventIds = this.activeAddEventIds(input.libraryId, input.assetId, input.tag);
      if (observedAddEventIds.length === 0) throw new TagSyncConflictError('tag projection has no active OR-Set add operation');
      if (observedAddEventIds.length > maxObservedTagAdds) throw new TagSyncConflictError('observed tag add set exceeds the protocol limit');
      const draft = this.reserveLocalEventDraft(input.libraryId, input.authorPeerId, input.createdAt,
        input.draftFactory, 'asset.tag.removed', { assetId: input.assetId, tag: input.tag, observedAddEventIds });
      const remove = this.db.prepare(`INSERT OR IGNORE INTO asset_tag_remove_observations
        (library_id, asset_id, tag, add_event_id, remove_event_id) VALUES (?, ?, ?, ?, ?)`);
      for (const addEventId of observedAddEventIds) remove.run(input.libraryId, input.assetId, input.tag, addEventId, draft.eventId);
      this.refreshTagProjection(input.libraryId, input.assetId, input.tag, input.createdAt);
      appendMetadataAudit(this.auditRepository, {
        action: 'asset.tag.remove', resourceType: 'asset', libraryId: input.libraryId, resourceId: input.assetId,
        outcome: 'applied', requestId: input.requestId, createdAt: input.createdAt
      });
      return 'removed';
    });
    return write.immediate();
  }

  getAssetTags(libraryId: string, assetId: string): string[] {
    return (this.db.prepare(`SELECT tag FROM asset_tags WHERE library_id = ? AND asset_id = ? ORDER BY tag COLLATE BINARY`)
      .all(libraryId, assetId) as Array<{ tag: string }>).map((row) => row.tag);
  }

  grantTagWriter(libraryId: string, peerId: string, localPeerId: string, grantedAt: string): boolean {
    const write = this.db.transaction(() => {
      if (!this.db.prepare(`SELECT 1 FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`).get(peerId)) {
        throw new TagSyncConflictError('tag writer must be a trusted peer');
      }
      this.registerLocalAuthor(libraryId, localPeerId, grantedAt);
      const existing = this.db.prepare(`SELECT revoked_at FROM library_tag_write_grants WHERE library_id = ? AND peer_id = ?`)
        .get(libraryId, peerId) as { revoked_at: string | null } | undefined;
      if (existing?.revoked_at === null) return false;
      const registered = this.db.prepare(`SELECT 1 FROM tag_sync_author_registry WHERE library_id = ? AND author_peer_id = ?`)
        .get(libraryId, peerId);
      if (!registered) this.registerLocalAuthor(libraryId, peerId, grantedAt);
      this.db.prepare(`INSERT INTO library_tag_write_grants (peer_id, library_id, granted_at, revoked_at)
        VALUES (?, ?, ?, NULL) ON CONFLICT(peer_id, library_id) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`)
        .run(peerId, libraryId, grantedAt);
      return true;
    });
    return write.immediate();
  }

  revokeTagWriter(libraryId: string, peerId: string, revokedAt: string): boolean {
    const revoke = this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE library_tag_write_grants SET revoked_at = ?
        WHERE library_id = ? AND peer_id = ? AND revoked_at IS NULL`).run(revokedAt, libraryId, peerId);
      if (result.changes === 0) return false;
      this.db.prepare(`UPDATE tag_sync_inbox SET state = 'conflict', error_code = 'tag_writer_revoked'
        WHERE library_id = ? AND author_peer_id = ? AND state = 'pending'`).run(libraryId, peerId);
      return true;
    });
    return revoke.immediate();
  }

  isTagWriterAllowed(libraryId: string, authorPeerId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM library_tag_write_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.library_id = ? AND g.peer_id = ? AND g.revoked_at IS NULL AND p.trust_state = 'trusted'`)
      .get(libraryId, authorPeerId));
  }

  listTagWriters(libraryId: string): string[] {
    return (this.db.prepare(`SELECT g.peer_id FROM library_tag_write_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.library_id = ? AND g.revoked_at IS NULL AND p.trust_state = 'trusted'
      ORDER BY g.peer_id COLLATE BINARY`).all(libraryId) as Array<{ peer_id: string }>).map((row) => row.peer_id);
  }

  listGrantedLibraries(peerId: string): string[] {
    return (this.db.prepare(`SELECT g.library_id FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.peer_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted' ORDER BY g.library_id COLLATE BINARY`)
      .all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  setRemoteLibraries(peerId: string, libraryIds: readonly string[]): void {
    const update = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sync_remote_library_grants WHERE peer_id = ?').run(peerId);
      const insert = this.db.prepare('INSERT INTO sync_remote_library_grants (peer_id, library_id, observed_at) VALUES (?, ?, ?)');
      for (const libraryId of [...new Set(libraryIds)]) insert.run(peerId, libraryId, this.now());
    });
    update.immediate();
  }

  getRemoteLibraries(peerId: string): string[] {
    return (this.db.prepare(`SELECT library_id FROM sync_remote_library_grants WHERE peer_id = ? ORDER BY library_id COLLATE BINARY`)
      .all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  getCursors(libraryIds: readonly string[]): TagSyncCursor[] {
    if (libraryIds.length === 0) return [];
    const placeholders = libraryIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT library_id, author_peer_id, author_sequence FROM tag_sync_author_heads
      WHERE ready = 1 AND library_id IN (${placeholders}) ORDER BY library_id COLLATE BINARY, author_peer_id COLLATE BINARY`)
      .all(...libraryIds) as Array<{ library_id: string; author_peer_id: string; author_sequence: number }>).map((row) => ({
      libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.author_sequence
    }));
  }

  getAcknowledgedCursors(peerId: string): TagSyncCursor[] {
    return (this.db.prepare(`SELECT library_id, author_peer_id, contiguous_sequence FROM tag_sync_peer_cursors WHERE peer_id = ?
      ORDER BY library_id COLLATE BINARY, author_peer_id COLLATE BINARY`).all(peerId) as Array<{
        library_id: string; author_peer_id: string; contiguous_sequence: number;
      }>).map((row) => ({ libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.contiguous_sequence }));
  }

  eventsMissingForPeer(peerId: string, remoteCursors: readonly TagSyncCursor[], maximumEvents = 64): EventEnvelope[] {
    const libraries = this.listGrantedLibraries(peerId);
    if (libraries.length === 0 || maximumEvents <= 0) return [];
    const cursorMap = new Map(remoteCursors.map((cursor) => [`${cursor.libraryId}\0${cursor.authorPeerId}`, cursor.sequence]));
    const select = this.db.prepare(`SELECT e.envelope_json FROM tag_sync_event_log e
      JOIN library_grants g ON g.library_id = e.library_id AND g.peer_id = ? AND g.permission = 'read'
      JOIN trusted_peers p ON p.peer_id = g.peer_id AND p.trust_state = 'trusted'
      WHERE e.state = 'ready' AND e.library_id = ? AND e.author_peer_id = ? AND e.author_sequence > ?
      ORDER BY e.author_sequence LIMIT ?`);
    const events: EventEnvelope[] = [];
    for (const libraryId of libraries) {
      const authors = this.db.prepare(`SELECT author_peer_id FROM tag_sync_author_heads WHERE library_id = ? AND ready = 1
        ORDER BY author_peer_id COLLATE BINARY`).all(libraryId) as Array<{ author_peer_id: string }>;
      for (const { author_peer_id: authorPeerId } of authors) {
        if (authorPeerId === peerId) continue;
        const remaining = maximumEvents - events.length;
        if (remaining <= 0) return events;
        const after = cursorMap.get(`${libraryId}\0${authorPeerId}`) ?? 0;
        const rows = select.all(peerId, libraryId, authorPeerId, after, remaining) as Array<{ envelope_json: string }>;
        for (const row of rows) events.push(parseEventEnvelope(JSON.parse(row.envelope_json)));
      }
    }
    return events.slice(0, maximumEvents);
  }

  recordOfferedEvents(peerId: string, events: readonly EventEnvelope[]): void {
    if (events.length === 0) return;
    const update = this.db.prepare(`UPDATE tag_sync_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = NULL
      WHERE peer_id = ? AND event_id = ?`);
    const create = this.db.prepare(`INSERT OR IGNORE INTO tag_sync_outbox (peer_id, event_id, attempts, next_attempt_at)
      SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
        WHERE g.peer_id = ? AND g.library_id = (SELECT library_id FROM tag_sync_event_log WHERE event_id = ?)
          AND g.permission = 'read' AND p.trust_state = 'trusted')`);
    const record = this.db.transaction(() => {
      const nextAttemptAt = this.now();
      for (const event of events) {
        update.run(nextAttemptAt, peerId, event.eventId);
        create.run(peerId, event.eventId, nextAttemptAt, peerId, event.eventId);
      }
    });
    record.immediate();
  }

  recordOfferFailure(peerId: string, eventIds: readonly string[], errorCode: string): void {
    if (eventIds.length === 0) return;
    const update = this.db.prepare(`UPDATE tag_sync_outbox SET next_attempt_at = ?, last_error = ?
      WHERE peer_id = ? AND event_id = ?`);
    const record = this.db.transaction(() => {
      const retryAt = new Date(Date.parse(this.now()) + 1_000).toISOString();
      for (const eventId of eventIds) update.run(retryAt, errorCode, peerId, eventId);
    });
    record.immediate();
  }

  acknowledgeCursors(peerId: string, cursors: readonly TagSyncCursor[]): void {
    const update = this.db.transaction(() => {
      const put = this.db.prepare(`INSERT INTO tag_sync_peer_cursors
        (library_id, peer_id, author_peer_id, contiguous_sequence, event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(library_id, peer_id, author_peer_id) DO UPDATE SET
        contiguous_sequence = MAX(tag_sync_peer_cursors.contiguous_sequence, excluded.contiguous_sequence),
        event_id = CASE WHEN excluded.contiguous_sequence >= tag_sync_peer_cursors.contiguous_sequence
          THEN excluded.event_id ELSE tag_sync_peer_cursors.event_id END, updated_at = excluded.updated_at`);
      const remove = this.db.prepare(`DELETE FROM tag_sync_outbox WHERE peer_id = ? AND event_id IN
        (SELECT event_id FROM tag_sync_event_log WHERE library_id = ? AND author_peer_id = ? AND author_sequence <= ?)`);
      const hasActiveReadGrant = this.db.prepare(`SELECT 1 FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
        WHERE g.peer_id = ? AND g.library_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted'`);
      for (const cursor of cursors) {
        if (!hasActiveReadGrant.get(peerId, cursor.libraryId)) continue;
        const localHead = this.db.prepare(`SELECT author_sequence FROM tag_sync_author_heads
          WHERE library_id = ? AND author_peer_id = ? AND ready = 1`).get(cursor.libraryId, cursor.authorPeerId) as
          { author_sequence: number } | undefined;
        if (!localHead) continue;
        const storedCursor = this.db.prepare(`SELECT contiguous_sequence FROM tag_sync_peer_cursors
          WHERE peer_id = ? AND library_id = ? AND author_peer_id = ?`).get(peerId, cursor.libraryId, cursor.authorPeerId) as
          { contiguous_sequence: number } | undefined;
        const previousSequence = Math.min(storedCursor?.contiguous_sequence ?? 0, localHead.author_sequence);
        const requestedSequence = Math.min(cursor.sequence, localHead.author_sequence);
        if (requestedSequence <= previousSequence) continue;
        const firstUnoffered = this.db.prepare(`SELECT MIN(e.author_sequence) AS sequence FROM tag_sync_event_log e
          WHERE e.library_id = ? AND e.author_peer_id = ? AND e.author_sequence > ? AND e.author_sequence <= ?
            AND e.state = 'ready' AND NOT EXISTS (SELECT 1 FROM tag_sync_outbox o
              WHERE o.peer_id = ? AND o.event_id = e.event_id AND o.attempts > 0)`)
          .get(cursor.libraryId, cursor.authorPeerId, previousSequence, requestedSequence, peerId) as { sequence: number | null };
        const acknowledgedSequence = firstUnoffered.sequence === null
          ? requestedSequence : Math.min(requestedSequence, firstUnoffered.sequence - 1);
        if (acknowledgedSequence <= previousSequence) continue;
        const acknowledgedEvent = this.db.prepare(`SELECT event_id FROM tag_sync_event_log WHERE library_id = ? AND author_peer_id = ?
          AND author_sequence = ? AND state = 'ready'`).get(cursor.libraryId, cursor.authorPeerId, acknowledgedSequence) as
          { event_id: string } | undefined;
        if (!acknowledgedEvent) continue;
        put.run(cursor.libraryId, peerId, cursor.authorPeerId, acknowledgedSequence, acknowledgedEvent.event_id, this.now());
        remove.run(peerId, cursor.libraryId, cursor.authorPeerId, acknowledgedSequence);
      }
    });
    update.immediate();
  }

  getPendingCount(peerId: string): number {
    const outgoing = this.db.prepare('SELECT COUNT(*) AS count FROM tag_sync_outbox WHERE peer_id = ?').get(peerId) as { count: number };
    const incoming = this.db.prepare(`SELECT COUNT(*) AS count FROM tag_sync_inbox WHERE peer_id = ?
      AND state IN ('pending', 'unsupported', 'conflict')`).get(peerId) as { count: number };
    return outgoing.count + incoming.count;
  }

  getPeerSyncStatus(peerId: string): { pending: number; lastError: string | null } {
    const error = this.db.prepare(`SELECT last_error FROM tag_sync_outbox WHERE peer_id = ? AND last_error IS NOT NULL
      ORDER BY next_attempt_at DESC, event_id LIMIT 1`).get(peerId) as { last_error: string } | undefined;
    return { pending: this.getPendingCount(peerId), lastError: error?.last_error ?? null };
  }

  reconcilePendingEvents(libraryId?: string): string[] {
    const reconcile = this.db.transaction(() => {
      const libraries = libraryId ? [libraryId] : (this.db.prepare(`SELECT DISTINCT library_id FROM tag_sync_inbox
        WHERE state = 'pending' ORDER BY library_id`).all() as Array<{ library_id: string }>).map((row) => row.library_id);
      return libraries.flatMap((id) => this.applyReadyEvents(id));
    });
    return reconcile.immediate();
  }

  rebuildAssetTagProjection(libraryId: string, assetId: string): void {
    const rebuild = this.db.transaction(() => {
      const tags = this.db.prepare(`SELECT DISTINCT tag FROM asset_tag_adds WHERE library_id = ? AND asset_id = ? ORDER BY tag COLLATE BINARY`)
        .all(libraryId, assetId) as Array<{ tag: string }>;
      for (const { tag } of tags) this.refreshTagProjection(libraryId, assetId, tag, this.now());
    });
    rebuild.immediate();
  }

  ingest(relayPeerId: string, value: EventEnvelope): TagIngestResult {
    const event = parseEventEnvelope(value);
    const accept = this.db.transaction((): TagIngestResult => {
      const relayTrusted = this.db.prepare(`SELECT 1 FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`)
        .get(relayPeerId);
      const authorTrusted = this.db.prepare(`SELECT 1 FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`)
        .get(event.authorPeerId);
      const relayGrant = this.db.prepare(`SELECT 1 FROM sync_remote_library_grants WHERE peer_id = ? AND library_id = ?`)
        .get(relayPeerId, event.libraryId);
      if (!relayTrusted || !authorTrusted || !relayGrant) throw new TagSyncAuthorizationError('relay is not authorized for this tag library');
      if (!this.isTagWriterAllowed(event.libraryId, event.authorPeerId)) throw new TagSyncAuthorizationError();

      const existing = this.db.prepare(`SELECT event_id, library_id, author_peer_id, author_sequence, envelope_json, state
        FROM tag_sync_event_log WHERE event_id = ? UNION ALL
        SELECT event_id, library_id, author_peer_id, author_sequence, envelope_json, state
        FROM tag_sync_inbox WHERE event_id = ? LIMIT 1`).get(event.eventId, event.eventId) as TagInboxRow | undefined;
      if (existing) {
        if (eventDigest(parseEventEnvelope(JSON.parse(existing.envelope_json))) !== eventDigest(event)) {
          throw new TagSyncConflictError('tag event ID was reused with different content');
        }
        return { status: existing.state === 'applied' || existing.state === 'ready' ? 'duplicate'
          : existing.state === 'unsupported' ? 'unsupported' : existing.state === 'conflict' ? 'conflict' : 'pending', appliedEventIds: [] };
      }

      const sameSequence = this.db.prepare(`SELECT event_id, envelope_json, state FROM tag_sync_event_log
        WHERE library_id = ? AND author_peer_id = ? AND author_sequence = ? UNION ALL
        SELECT event_id, envelope_json, state FROM tag_sync_inbox
        WHERE library_id = ? AND author_peer_id = ? AND author_sequence = ? LIMIT 1`)
        .get(event.libraryId, event.authorPeerId, event.authorSequence, event.libraryId, event.authorPeerId, event.authorSequence) as
        { event_id: string; envelope_json: string; state: string } | undefined;
      if (sameSequence) {
        if (sameSequence.event_id === event.eventId && eventDigest(parseEventEnvelope(JSON.parse(sameSequence.envelope_json))) === eventDigest(event)) {
          return { status: sameSequence.state === 'applied' || sameSequence.state === 'ready' ? 'duplicate'
            : sameSequence.state === 'unsupported' ? 'unsupported' : sameSequence.state === 'conflict' ? 'conflict' : 'pending', appliedEventIds: [] };
        }
        throw new TagSyncConflictError('tag author sequence was reused');
      }

      const supported = event.protocolVersion === 1 && event.schemaVersion === 1 && isTagSyncEventType(event.eventType);
      if (supported) validateTagOperationPayload(event.eventType, event.payload);
      this.db.prepare(`INSERT INTO tag_sync_inbox
        (event_id, peer_id, library_id, author_peer_id, author_sequence, envelope_json, state, error_code, received_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(event.eventId, relayPeerId, event.libraryId, event.authorPeerId, event.authorSequence, JSON.stringify(event),
          supported ? 'pending' : 'unsupported', supported ? null : 'unsupported_event_version', this.now());
      if (!supported) return { status: 'unsupported', appliedEventIds: [] };

      const appliedEventIds = this.applyReadyEvents(event.libraryId);
      const status = this.db.prepare('SELECT state FROM tag_sync_inbox WHERE event_id = ?').get(event.eventId) as { state: string };
      return { status: status.state === 'applied' ? 'applied' : status.state === 'conflict' ? 'conflict' : 'pending', appliedEventIds };
    });
    return accept.immediate();
  }

  getUnsignedLocalDrafts(authorPeerId: string): UnsignedEventEnvelope[] {
    return (this.db.prepare(`SELECT envelope_json FROM tag_sync_event_log WHERE author_peer_id = ? AND state = 'signing'
      ORDER BY library_id, author_sequence`).all(authorPeerId) as Array<{ envelope_json: string }>)
      .map((row) => JSON.parse(row.envelope_json) as UnsignedEventEnvelope);
  }

  completeLocalDraft(event: EventEnvelope): void {
    const parsed = parseEventEnvelope(event);
    if (!isTagSyncEventType(parsed.eventType)) throw new TagSyncConflictError('not a tag sync event');
    const finish = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT event_id, library_id, author_peer_id, author_sequence, envelope_json, state
        FROM tag_sync_event_log WHERE event_id = ?`).get(event.eventId) as TagEventRow | undefined;
      if (!row || row.state !== 'signing' || row.author_peer_id !== event.authorPeerId || row.library_id !== event.libraryId ||
          row.author_sequence !== event.authorSequence) throw new TagSyncConflictError('tag event draft is missing or changed');
      const { signature: _signature, ...unsigned } = event;
      void _signature;
      if (JSON.stringify(unsigned) !== row.envelope_json) throw new TagSyncConflictError('signed tag event does not match its draft');
      this.db.prepare(`UPDATE tag_sync_event_log SET signature = ?, envelope_json = ?, state = 'ready' WHERE event_id = ? AND state = 'signing'`)
        .run(event.signature, JSON.stringify(event), event.eventId);
      this.db.prepare(`UPDATE tag_sync_author_heads SET ready = 1 WHERE library_id = ? AND author_peer_id = ? AND event_id = ?`)
        .run(event.libraryId, event.authorPeerId, event.eventId);
      this.db.prepare(`UPDATE asset_tag_legacy_seeds SET state = 'complete' WHERE seed_event_id = ? AND state = 'queued'`)
        .run(event.eventId);
      this.db.prepare(`INSERT OR IGNORE INTO tag_sync_outbox (peer_id, event_id, attempts, next_attempt_at)
        SELECT g.peer_id, ?, 0, ? FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
        WHERE g.library_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted'`)
        .run(event.eventId, this.now(), event.libraryId);
    });
    finish.immediate();
  }

  reconcileLegacyTagSeeds(input: { authorPeerId: string; createdAt: string; draftFactory: TagEventDraftFactory }): number {
    const seedRows = this.db.prepare(`SELECT library_id, asset_id, tag, created_at, state, seed_event_id
      FROM asset_tag_legacy_seeds WHERE state = 'pending' ORDER BY library_id COLLATE BINARY, asset_id COLLATE BINARY, tag COLLATE BINARY`)
      .all() as TagSeedRow[];
    let queued = 0;
    for (const seed of seedRows) {
      const reserve = this.db.transaction(() => {
        const current = this.db.prepare(`SELECT state, seed_event_id FROM asset_tag_legacy_seeds
          WHERE library_id = ? AND asset_id = ? AND tag = ?`).get(seed.library_id, seed.asset_id, seed.tag) as { state: string; seed_event_id: string | null } | undefined;
        if (!current || current.state !== 'pending' || !this.hasAssetProjectionHead(seed.library_id, seed.asset_id)) return false;
        const existing = this.db.prepare(`SELECT a.add_event_id, e.state FROM asset_tag_adds a
          JOIN tag_sync_event_log e ON e.event_id = a.add_event_id
          WHERE a.library_id = ? AND a.asset_id = ? AND a.tag = ?
            AND NOT EXISTS (SELECT 1 FROM asset_tag_remove_observations r WHERE r.library_id = a.library_id
              AND r.asset_id = a.asset_id AND r.tag = a.tag AND r.add_event_id = a.add_event_id)
          ORDER BY a.add_event_id COLLATE BINARY LIMIT 1`).get(seed.library_id, seed.asset_id, seed.tag) as { add_event_id: string; state: string } | undefined;
        if (existing) {
          this.db.prepare(`UPDATE asset_tag_legacy_seeds SET state = ?, seed_event_id = ?
            WHERE library_id = ? AND asset_id = ? AND tag = ?`)
            .run(existing.state === 'ready' ? 'complete' : 'queued', existing.add_event_id, seed.library_id, seed.asset_id, seed.tag);
          return false;
        }
        const draft = this.reserveLocalEventDraft(seed.library_id, input.authorPeerId, input.createdAt, input.draftFactory,
          'asset.tag.added', { assetId: seed.asset_id, tag: seed.tag });
        this.db.prepare(`INSERT INTO asset_tag_adds (library_id, asset_id, tag, add_event_id) VALUES (?, ?, ?, ?)`)
          .run(seed.library_id, seed.asset_id, seed.tag, draft.eventId);
        this.db.prepare(`UPDATE asset_tag_legacy_seeds SET state = 'queued', seed_event_id = ?
          WHERE library_id = ? AND asset_id = ? AND tag = ?`).run(draft.eventId, seed.library_id, seed.asset_id, seed.tag);
        return true;
      });
      if (reserve.immediate()) queued += 1;
    }
    return queued;
  }

  private applyReadyEvents(libraryId: string): string[] {
    const applied: string[] = [];
    for (let pass = 0; pass < 256; pass += 1) {
      const pending = this.db.prepare(`SELECT event_id, envelope_json FROM tag_sync_inbox
        WHERE library_id = ? AND state = 'pending' ORDER BY author_peer_id, author_sequence, event_id`)
        .all(libraryId) as Array<{ event_id: string; envelope_json: string }>;
      let progressed = false;
      for (const row of pending) {
        const event = parseEventEnvelope(JSON.parse(row.envelope_json));
        const head = this.db.prepare(`SELECT author_sequence FROM tag_sync_author_heads
          WHERE library_id = ? AND author_peer_id = ?`).get(libraryId, event.authorPeerId) as { author_sequence: number } | undefined;
        const nextSequence = (head?.author_sequence ?? 0) + 1;
        if (event.authorSequence < nextSequence) {
          this.markInboxConflict(event.eventId, 'author_sequence_conflict');
          progressed = true;
          continue;
        }
        if (event.authorSequence > nextSequence) continue;
        if (event.causalParents.some((parent) => this.hasForeignParent(libraryId, parent))) {
          this.markInboxConflict(event.eventId, 'cross_library_causal_parent');
          progressed = true;
          continue;
        }
        if (!event.causalParents.every((parent) => this.hasAppliedParent(libraryId, parent))) continue;
        if (!this.isTagWriterAllowed(libraryId, event.authorPeerId)) {
          this.markInboxConflict(event.eventId, 'tag_writer_revoked');
          progressed = true;
          continue;
        }
        const payload = validateTagOperationPayload(event.eventType, event.payload);
        if (!this.hasKnownAsset(libraryId, payload.assetId) ||
            (event.eventType === 'asset.tag.added' && !this.hasAssetIndexParent(libraryId, payload.assetId, event.causalParents))) {
          this.markInboxConflict(event.eventId, 'unknown_asset_dependency');
          progressed = true;
          continue;
        }

        if (event.eventType === 'asset.tag.added') {
          const ownTagAdd = this.db.prepare(`SELECT 1 FROM asset_tag_adds a
            JOIN tag_sync_event_log e ON e.event_id = a.add_event_id
            WHERE a.library_id = ? AND a.asset_id = ? AND a.tag = ? AND e.author_peer_id = ?
              AND NOT EXISTS (SELECT 1 FROM asset_tag_remove_observations r WHERE r.library_id = a.library_id
                AND r.asset_id = a.asset_id AND r.tag = a.tag AND r.add_event_id = a.add_event_id) LIMIT 1`)
            .get(libraryId, payload.assetId, payload.tag, event.authorPeerId);
          if (ownTagAdd) {
            this.markInboxConflict(event.eventId, 'duplicate_active_tag_add');
            progressed = true;
            continue;
          }
          if (this.countActiveAddsByAuthor(libraryId, payload.assetId, event.authorPeerId) >= maxActiveTagsPerWriterPerAsset) {
            this.markInboxConflict(event.eventId, 'writer_tag_limit_exceeded');
            progressed = true;
            continue;
          }
          this.insertAppliedEvent(event);
          this.db.prepare(`INSERT OR IGNORE INTO asset_tag_adds (library_id, asset_id, tag, add_event_id) VALUES (?, ?, ?, ?)`)
            .run(libraryId, payload.assetId, payload.tag, event.eventId);
          this.refreshTagProjection(libraryId, payload.assetId, payload.tag, event.createdAt);
        } else {
          if (!('observedAddEventIds' in payload)) {
            this.markInboxConflict(event.eventId, 'invalid_tag_payload');
            progressed = true;
            continue;
          }
          const observedAddEventIds = payload.observedAddEventIds;
          let missingObservedAdd = false;
          let invalidObservedAdd = false;
          let unobservedAdd = false;
          for (const addEventId of observedAddEventIds) {
            if (!event.causalParents.includes(addEventId)) { unobservedAdd = true; continue; }
            const add = this.db.prepare(`SELECT library_id, asset_id, tag FROM asset_tag_adds WHERE add_event_id = ?`)
              .get(addEventId) as { library_id: string; asset_id: string; tag: string } | undefined;
            if (!add) {
              const prior = this.db.prepare(`SELECT state, envelope_json FROM tag_sync_inbox WHERE event_id = ?`)
                .get(addEventId) as { state: string; envelope_json: string } | undefined;
              if (!prior || prior.state === 'pending') missingObservedAdd = true;
              else invalidObservedAdd = true;
              continue;
            }
            if (add.library_id !== libraryId || add.asset_id !== payload.assetId || add.tag !== payload.tag) invalidObservedAdd = true;
          }
          if (unobservedAdd) {
            this.markInboxConflict(event.eventId, 'unobserved_add_reference');
            progressed = true;
            continue;
          }
          if (invalidObservedAdd) {
            this.markInboxConflict(event.eventId, 'invalid_observed_add_id');
            progressed = true;
            continue;
          }
          if (missingObservedAdd) continue;
          this.insertAppliedEvent(event);
          const remove = this.db.prepare(`INSERT OR IGNORE INTO asset_tag_remove_observations
            (library_id, asset_id, tag, add_event_id, remove_event_id) VALUES (?, ?, ?, ?, ?)`);
          for (const addEventId of observedAddEventIds) remove.run(libraryId, payload.assetId, payload.tag, addEventId, event.eventId);
          this.refreshTagProjection(libraryId, payload.assetId, payload.tag, event.createdAt);
        }
        this.db.prepare(`UPDATE tag_sync_inbox SET state = 'applied', applied_at = ? WHERE event_id = ? AND state = 'pending'`)
          .run(this.now(), event.eventId);
        this.db.prepare(`INSERT INTO tag_sync_author_heads (library_id, author_peer_id, author_sequence, event_id, ready)
          VALUES (?, ?, ?, ?, 1) ON CONFLICT(library_id, author_peer_id) DO UPDATE SET
          author_sequence = excluded.author_sequence, event_id = excluded.event_id, ready = 1`)
          .run(libraryId, event.authorPeerId, event.authorSequence, event.eventId);
        this.enqueueForGrantedPeers(event);
        applied.push(event.eventId);
        progressed = true;
      }
      if (!progressed) break;
    }
    return applied;
  }

  private insertAppliedEvent(event: EventEnvelope): void {
    this.db.prepare(`INSERT INTO tag_sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`)
      .run(event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, event.protocolVersion, event.schemaVersion,
        event.eventType, JSON.stringify(event.causalParents), JSON.stringify(event.payload), event.createdAt, event.signature, JSON.stringify(event));
  }

  private enqueueForGrantedPeers(event: EventEnvelope): void {
    this.db.prepare(`INSERT OR IGNORE INTO tag_sync_outbox (peer_id, event_id, attempts, next_attempt_at)
      SELECT g.peer_id, ?, 0, ? FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.library_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted' AND g.peer_id <> ?`)
      .run(event.eventId, this.now(), event.libraryId, event.authorPeerId);
  }

  private hasForeignParent(libraryId: string, eventId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM tag_sync_event_log WHERE event_id = ? AND library_id <> ?
      UNION ALL SELECT 1 FROM sync_event_log WHERE event_id = ? AND library_id <> ? LIMIT 1`)
      .get(eventId, libraryId, eventId, libraryId));
  }

  private hasAppliedParent(libraryId: string, eventId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM tag_sync_event_log WHERE event_id = ? AND library_id = ? AND state = 'ready'
      UNION ALL SELECT 1 FROM sync_event_log e WHERE e.event_id = ? AND e.library_id = ? AND e.state = 'ready'
        AND (NOT EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = e.event_id)
          OR EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = e.event_id AND i.state = 'applied')) LIMIT 1`)
      .get(eventId, libraryId, eventId, libraryId));
  }

  private markInboxConflict(eventId: string, errorCode: string): void {
    this.db.prepare(`UPDATE tag_sync_inbox SET state = 'conflict', error_code = ? WHERE event_id = ? AND state = 'pending'`)
      .run(errorCode, eventId);
  }

  private reserveLocalEventDraft(
    libraryId: string,
    authorPeerId: string,
    createdAt: string,
    factory: TagEventDraftFactory,
    eventType: TagSyncEventType,
    payload: JsonValue
  ): UnsignedEventEnvelope {
    this.registerLocalAuthor(libraryId, authorPeerId, createdAt);
    const own = this.db.prepare(`SELECT author_sequence, event_id, ready FROM tag_sync_author_heads WHERE library_id = ? AND author_peer_id = ?`)
      .get(libraryId, authorPeerId) as { author_sequence: number; event_id: string; ready: number } | undefined;
    if (own?.ready === 0) throw new TagSyncConflictError('a previous local tag event signature is still pending recovery');
    const payloadRecord = payload as Record<string, JsonValue>;
    const assetId = typeof payloadRecord.assetId === 'string' ? payloadRecord.assetId : '';
    const assetHead = assetId ? this.db.prepare(`SELECT last_event_id FROM sync_asset_projection WHERE library_id = ? AND asset_id = ?`)
      .get(libraryId, assetId) as { last_event_id: string } | undefined : undefined;
    if (eventType === 'asset.tag.added' && !assetHead) throw new TagSyncConflictError('tag add requires an indexed asset projection');
    const causalParents = eventType === 'asset.tag.added'
      ? [own?.event_id, assetHead?.last_event_id].filter((eventId): eventId is string => Boolean(eventId))
      : Array.isArray(payloadRecord.observedAddEventIds)
        ? payloadRecord.observedAddEventIds.filter((eventId): eventId is string => typeof eventId === 'string')
        : [];
    const context: EventContext = {
      authorSequence: (own?.author_sequence ?? 0) + 1,
      causalParents: [...new Set(causalParents)].sort()
    };
    if (context.causalParents.length > maxTagAuthorsPerLibrary) throw new TagSyncConflictError('tag causal frontier exceeds the 64-parent limit');
    const draft = factory({ context, libraryId, authorPeerId, eventType, payload, createdAt });
    this.assertDraft(draft, libraryId, authorPeerId, context, eventType, payload);
    this.db.prepare(`INSERT INTO tag_sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'signing')`)
      .run(draft.eventId, draft.libraryId, draft.authorPeerId, draft.authorSequence, draft.protocolVersion, draft.schemaVersion,
        draft.eventType, JSON.stringify(draft.causalParents), JSON.stringify(draft.payload), draft.createdAt, JSON.stringify(draft));
    this.db.prepare(`INSERT INTO tag_sync_author_heads (library_id, author_peer_id, author_sequence, event_id, ready)
      VALUES (?, ?, ?, ?, 0) ON CONFLICT(library_id, author_peer_id) DO UPDATE SET
      author_sequence = excluded.author_sequence, event_id = excluded.event_id, ready = 0`)
      .run(libraryId, authorPeerId, context.authorSequence, draft.eventId);
    return draft;
  }

  private assertDraft(
    draft: UnsignedEventEnvelope,
    libraryId: string,
    authorPeerId: string,
    context: EventContext,
    eventType: TagSyncEventType,
    payload: JsonValue
  ): void {
    if (draft.libraryId !== libraryId || draft.authorPeerId !== authorPeerId || draft.authorSequence !== context.authorSequence ||
        draft.eventType !== eventType || JSON.stringify(draft.payload) !== JSON.stringify(payload) ||
        JSON.stringify(draft.causalParents) !== JSON.stringify(context.causalParents)) {
      throw new TagSyncConflictError('tag event draft does not match the reserved operation');
    }
  }

  private registerLocalAuthor(libraryId: string, authorPeerId: string, createdAt: string): void {
    const existing = this.db.prepare('SELECT 1 FROM tag_sync_author_registry WHERE library_id = ? AND author_peer_id = ?')
      .get(libraryId, authorPeerId);
    if (existing) return;
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM tag_sync_author_registry WHERE library_id = ?')
      .get(libraryId) as { count: number };
    if (count.count >= maxTagAuthorsPerLibrary) throw new TagSyncConflictError('tag author limit reached for library');
    this.db.prepare(`INSERT INTO tag_sync_author_registry (library_id, author_peer_id, first_seen_at) VALUES (?, ?, ?)`)
      .run(libraryId, authorPeerId, createdAt);
  }

  private activeAddEventIds(libraryId: string, assetId: string, tag: string): string[] {
    return (this.db.prepare(`SELECT a.add_event_id FROM asset_tag_adds a
      WHERE a.library_id = ? AND a.asset_id = ? AND a.tag = ?
        AND NOT EXISTS (SELECT 1 FROM asset_tag_remove_observations r WHERE r.library_id = a.library_id
          AND r.asset_id = a.asset_id AND r.tag = a.tag AND r.add_event_id = a.add_event_id)
      ORDER BY a.add_event_id COLLATE BINARY`).all(libraryId, assetId, tag) as Array<{ add_event_id: string }>)
      .map((row) => row.add_event_id);
  }

  private countActiveAddsByAuthor(libraryId: string, assetId: string, authorPeerId: string): number {
    return (this.db.prepare(`SELECT COUNT(DISTINCT a.tag) AS count FROM asset_tag_adds a
      JOIN tag_sync_event_log e ON e.event_id = a.add_event_id
      WHERE a.library_id = ? AND a.asset_id = ? AND e.author_peer_id = ?
        AND NOT EXISTS (SELECT 1 FROM asset_tag_remove_observations r WHERE r.library_id = a.library_id
          AND r.asset_id = a.asset_id AND r.tag = a.tag AND r.add_event_id = a.add_event_id)`)
      .get(libraryId, assetId, authorPeerId) as { count: number }).count;
  }

  private refreshTagProjection(libraryId: string, assetId: string, tag: string, createdAt: string): void {
    const active = this.db.prepare(`SELECT 1 FROM asset_tag_adds a WHERE a.library_id = ? AND a.asset_id = ? AND a.tag = ?
      AND NOT EXISTS (SELECT 1 FROM asset_tag_remove_observations r WHERE r.library_id = a.library_id
        AND r.asset_id = a.asset_id AND r.tag = a.tag AND r.add_event_id = a.add_event_id) LIMIT 1`)
      .get(libraryId, assetId, tag);
    if (active) {
      if (this.isVisibleAsset(libraryId, assetId)) {
        this.db.prepare(`INSERT OR IGNORE INTO asset_tags (library_id, asset_id, tag, created_at) VALUES (?, ?, ?, ?)`)
          .run(libraryId, assetId, tag, createdAt);
      }
    } else {
      this.db.prepare('DELETE FROM asset_tags WHERE library_id = ? AND asset_id = ? AND tag = ?').run(libraryId, assetId, tag);
    }
  }

  private hasKnownAsset(libraryId: string, assetId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM assets WHERE library_id = ? AND asset_id = ?
      UNION ALL SELECT 1 FROM sync_asset_projection WHERE library_id = ? AND asset_id = ? LIMIT 1`)
      .get(libraryId, assetId, libraryId, assetId));
  }

  private hasAssetProjectionHead(libraryId: string, assetId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sync_asset_projection WHERE library_id = ? AND asset_id = ? AND last_event_id IS NOT NULL`)
      .get(libraryId, assetId));
  }

  private hasAssetIndexParent(libraryId: string, assetId: string, causalParents: readonly string[]): boolean {
    if (causalParents.length === 0) return false;
    const statement = this.db.prepare(`SELECT 1 FROM sync_event_log e WHERE e.event_id = ? AND e.library_id = ? AND e.state = 'ready'
      AND e.event_type IN ('asset.indexed', 'asset.metadata.updated', 'asset.tombstoned', 'asset.restored')
      AND json_extract(e.payload_json, '$.assetId') = ?
      AND (NOT EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = e.event_id)
        OR EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = e.event_id AND i.state = 'applied')) LIMIT 1`);
    return causalParents.some((eventId) => Boolean(statement.get(eventId, libraryId, assetId)));
  }

  private isVisibleAsset(libraryId: string, assetId: string): boolean {
    const row = this.db.prepare(`SELECT EXISTS (
      SELECT 1 FROM assets a WHERE a.library_id = ? AND a.asset_id = ?
        AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id
          AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
      UNION ALL
      SELECT 1 FROM sync_asset_projection p WHERE p.library_id = ? AND p.asset_id = ? AND p.tombstone_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
    ) AS visible`).get(libraryId, assetId, libraryId, assetId) as { visible: number };
    return row.visible === 1;
  }
}
