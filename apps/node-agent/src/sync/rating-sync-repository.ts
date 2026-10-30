import type Database from 'better-sqlite3';
import { appendMetadataAudit, type AuditRepository } from '../audit/audit-repository.js';
import {
  eventDigest, isRatingSyncEventType, makeUnsignedEvent, parseEventEnvelope,
  type EventEnvelope, type UnsignedEventEnvelope
} from './event-envelope.js';

const MAX_RATING_AUTHORS_PER_LIBRARY = 64;
const MAX_OBSERVED_RATING_IDS = 64;
const MAX_EVENT_BATCH = 64;

export interface RatingSyncCursor { libraryId: string; authorPeerId: string; sequence: number }
export type RatingSetResult = {
  status: 'changed' | 'unchanged'; rating: number | null; conflict: boolean; ratingCandidates: Array<number | null>;
} | 'not_found' | 'author_limit' | 'conflict_limit';
export type RatingIngestResult = {
  status: 'applied' | 'pending' | 'duplicate' | 'unsupported' | 'conflict'; appliedEventIds: string[];
};

export class RatingSyncConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'RatingSyncConflictError'; }
}
export class RatingSyncAuthorizationError extends Error {
  constructor(message = 'rating-write authority is required') { super(message); this.name = 'RatingSyncAuthorizationError'; }
}

interface RatingView { rating: number | null; conflict: boolean; ratingCandidates: Array<number | null> }
interface EventRow { event_id: string; library_id: string; author_peer_id: string; author_sequence: number; envelope_json: string; state: string }
interface InboxRow extends EventRow { peer_id: string; accepted_at: string | null; next_attempt_at: string; attempts: number }
interface OperationRow { request_fingerprint: string; result_json: string }

export class RatingSyncRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly auditRepository?: AuditRepository
  ) {}

  setRating(input: {
    operationId: string; principalId: string; authorPeerId: string; libraryId: string; assetId: string;
    rating: number | null; requestFingerprint: string; createdAt: string; requestId?: string;
  }): RatingSetResult {
    if (!(input.rating === null || (Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5))) {
      throw new RatingSyncConflictError('rating must be an integer from 1 to 5 or null');
    }
    return this.db.transaction((): RatingSetResult => {
      const prior = this.db.prepare('SELECT request_fingerprint,result_json FROM rating_operations WHERE operation_id=?')
        .get(input.operationId) as OperationRow | undefined;
      if (prior) {
        if (prior.request_fingerprint !== input.requestFingerprint) throw new RatingSyncConflictError('rating operation ID reused with different request');
        appendMetadataAudit(this.auditRepository, {
          action: input.rating === null ? 'asset.rating.clear' : 'asset.rating.set', resourceType: 'asset',
          libraryId: input.libraryId, resourceId: input.assetId, outcome: 'replayed',
          requestId: input.requestId, createdAt: input.createdAt
        });
        return JSON.parse(prior.result_json) as RatingSetResult;
      }
      if (!this.visible(input.libraryId, input.assetId)) return 'not_found';
      if (this.db.prepare('SELECT 1 FROM sync_global_id_registry WHERE global_id=?').get(input.operationId)) {
        throw new RatingSyncConflictError('rating operation ID collides with an existing global identifier');
      }
      const current = this.getRating(input.libraryId, input.assetId);
      const noOp = !current.conflict && current.rating === input.rating;
      if (noOp) {
        const result: RatingView & { status: 'unchanged' } = { ...current, status: 'unchanged' };
        this.db.prepare(`INSERT INTO rating_operations(operation_id,principal_id,author_peer_id,library_id,asset_id,operation_type,request_fingerprint,result_json,created_at)
          VALUES(?,?,?,?,?,'rating.noop',?,?,?)`).run(input.operationId, input.principalId, input.authorPeerId, input.libraryId,
          input.assetId, input.requestFingerprint, JSON.stringify(result), input.createdAt);
        appendMetadataAudit(this.auditRepository, {
          action: input.rating === null ? 'asset.rating.clear' : 'asset.rating.set', resourceType: 'asset',
          libraryId: input.libraryId, resourceId: input.assetId, outcome: 'unchanged',
          requestId: input.requestId, createdAt: input.createdAt
        });
        return result;
      }
      const head = this.db.prepare('SELECT author_sequence,event_id,ready FROM rating_sync_author_heads WHERE library_id=? AND author_peer_id=?')
        .get(input.libraryId, input.authorPeerId) as { author_sequence: number; event_id: string; ready: number } | undefined;
      if (head?.ready === 0) throw new RatingSyncConflictError('previous rating draft requires signing recovery');

      const observed = this.activeRatingEventIds(input.libraryId, input.assetId);
      if (observed.length > MAX_OBSERVED_RATING_IDS) return 'conflict_limit';
      if (!this.registerAuthor(input.libraryId, input.authorPeerId, input.createdAt)) return 'author_limit';
      const parents = observed.length > 0 ? observed : [this.requireAssetIndex(input.libraryId, input.assetId)];
      const event = makeUnsignedEvent({
        eventId: input.operationId, libraryId: input.libraryId, authorPeerId: input.authorPeerId,
        authorSequence: (head?.author_sequence ?? 0) + 1, causalParents: parents, eventType: 'asset.rating.set',
        payload: { assetId: input.assetId, rating: input.rating, observedRatingEventIds: observed }, createdAt: input.createdAt
      });
      this.insertSigningEvent(event);
      this.db.prepare(`INSERT INTO rating_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready)
        VALUES(?,?,?,?,0) ON CONFLICT(library_id,author_peer_id) DO UPDATE SET author_sequence=excluded.author_sequence,event_id=excluded.event_id,ready=0`)
        .run(input.libraryId, input.authorPeerId, event.authorSequence, event.eventId);
      const result: RatingView & { status: 'changed' } = {
        rating: input.rating, conflict: false, ratingCandidates: [input.rating], status: 'changed'
      };
      this.db.prepare(`INSERT INTO rating_operations(operation_id,principal_id,author_peer_id,library_id,asset_id,operation_type,request_fingerprint,result_json,created_at)
        VALUES(?,?,?,?,?,'asset.rating.set',?,?,?)`).run(input.operationId, input.principalId, input.authorPeerId, input.libraryId,
        input.assetId, input.requestFingerprint, JSON.stringify(result), input.createdAt);
      this.insertRatingValue(event, input.assetId, input.rating, observed);
      this.refreshProjection(input.libraryId, input.assetId);
      appendMetadataAudit(this.auditRepository, {
        action: input.rating === null ? 'asset.rating.clear' : 'asset.rating.set', resourceType: 'asset',
        libraryId: input.libraryId, resourceId: input.assetId, outcome: 'applied',
        requestId: input.requestId, createdAt: input.createdAt
      });
      return { ...this.getRating(input.libraryId, input.assetId), status: 'changed' };
    }).immediate();
  }

  getRating(libraryId: string, assetId: string): RatingView {
    const row = this.db.prepare('SELECT rating,conflict,candidates_json FROM asset_rating_projection WHERE library_id=? AND asset_id=?')
      .get(libraryId, assetId) as { rating: number | null; conflict: number; candidates_json: string } | undefined;
    if (!row) return { rating: null, conflict: false, ratingCandidates: [] };
    return { rating: row.rating, conflict: row.conflict === 1, ratingCandidates: JSON.parse(row.candidates_json) as Array<number | null> };
  }

  getUnsignedLocalDrafts(authorPeerId: string): UnsignedEventEnvelope[] {
    return (this.db.prepare("SELECT envelope_json FROM rating_sync_event_log WHERE author_peer_id=? AND state='signing' ORDER BY library_id,author_sequence")
      .all(authorPeerId) as Array<{ envelope_json: string }>).map((row) => JSON.parse(row.envelope_json) as UnsignedEventEnvelope);
  }

  completeLocalDraft(value: EventEnvelope): void {
    const event = parseEventEnvelope(value);
    if (!isRatingSyncEventType(event.eventType)) throw new RatingSyncConflictError('not a rating event');
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT envelope_json FROM rating_sync_event_log WHERE event_id=? AND state='signing'")
        .get(event.eventId) as { envelope_json: string } | undefined;
      const { signature: _signature, ...unsigned } = event;
      void _signature;
      if (!row || row.envelope_json !== JSON.stringify(unsigned)) throw new RatingSyncConflictError('signed rating draft differs from persisted draft');
      this.db.prepare("UPDATE rating_sync_event_log SET signature=?,envelope_json=?,state='ready' WHERE event_id=?")
        .run(event.signature, JSON.stringify(event), event.eventId);
      this.db.prepare('UPDATE rating_sync_author_heads SET ready=1 WHERE library_id=? AND author_peer_id=? AND event_id=?')
        .run(event.libraryId, event.authorPeerId, event.eventId);
      this.db.prepare(`INSERT OR IGNORE INTO rating_sync_outbox(peer_id,event_id,attempts,next_attempt_at)
        SELECT g.peer_id,?,0,? FROM library_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id AND p.trust_state='trusted'
        WHERE g.library_id=? AND g.permission='read'`).run(event.eventId, this.now(), event.libraryId);
    }).immediate();
  }

  rebuildRatingProjectionForAsset(libraryId: string, assetId: string): void {
    this.db.transaction(() => this.refreshProjection(libraryId, assetId)).immediate();
  }

  grantRatingWriter(libraryId: string, peerId: string, localPeerId: string, grantedAt: string): boolean {
    return this.db.transaction(() => {
      if (!this.isTrusted(peerId)) throw new RatingSyncAuthorizationError('peer must be trusted');
      if (!this.hasLibraryRead(peerId, libraryId)) throw new RatingSyncConflictError('peer needs a library read grant before rating-write');
      if (!this.registerAuthor(libraryId, localPeerId, grantedAt) || !this.registerAuthor(libraryId, peerId, grantedAt)) {
        throw new RatingSyncConflictError('rating author limit reached');
      }
      const current = this.db.prepare('SELECT revoked_at FROM library_rating_write_grants WHERE library_id=? AND peer_id=?')
        .get(libraryId, peerId) as { revoked_at: string | null } | undefined;
      if (current?.revoked_at === null) return false;
      this.db.prepare(`INSERT INTO library_rating_write_grants(peer_id,library_id,granted_at,revoked_at) VALUES(?,?,?,NULL)
        ON CONFLICT(peer_id,library_id) DO UPDATE SET granted_at=excluded.granted_at,revoked_at=NULL`).run(peerId, libraryId, grantedAt);
      return true;
    }).immediate();
  }

  revokeRatingWriter(libraryId: string, peerId: string, revokedAt: string): boolean {
    return this.db.prepare('UPDATE library_rating_write_grants SET revoked_at=? WHERE library_id=? AND peer_id=? AND revoked_at IS NULL')
      .run(revokedAt, libraryId, peerId).changes > 0;
  }

  isRatingWriterAllowed(libraryId: string, peerId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM library_rating_write_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id
      WHERE g.library_id=? AND g.peer_id=? AND g.revoked_at IS NULL AND p.trust_state='trusted'`).get(libraryId, peerId));
  }

  listRatingWriters(libraryId: string): string[] {
    return (this.db.prepare(`SELECT g.peer_id FROM library_rating_write_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id
      WHERE g.library_id=? AND g.revoked_at IS NULL AND p.trust_state='trusted' ORDER BY g.peer_id`).all(libraryId) as Array<{ peer_id: string }>).map((row) => row.peer_id);
  }

  listGrantedLibraries(peerId: string): string[] {
    return (this.db.prepare(`SELECT g.library_id FROM library_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id
      WHERE g.peer_id=? AND g.permission='read' AND p.trust_state='trusted' ORDER BY g.library_id`).all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  setRemoteLibraries(peerId: string, libraryIds: readonly string[]): void {
    this.db.transaction(() => {
      if (!this.isTrusted(peerId)) throw new RatingSyncAuthorizationError('relay is not trusted');
      this.db.prepare('DELETE FROM sync_remote_library_grants WHERE peer_id=?').run(peerId);
      for (const libraryId of [...new Set(libraryIds)].sort()) {
        this.db.prepare('INSERT INTO sync_remote_library_grants(peer_id,library_id,observed_at) VALUES(?,?,?)').run(peerId, libraryId, this.now());
      }
    }).immediate();
  }

  getRemoteLibraries(peerId: string): string[] {
    return (this.db.prepare('SELECT library_id FROM sync_remote_library_grants WHERE peer_id=? ORDER BY library_id').all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  getCursors(libraryIds: readonly string[]): RatingSyncCursor[] {
    if (libraryIds.length === 0) return [];
    const placeholders = libraryIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT library_id,author_peer_id,author_sequence FROM rating_sync_author_heads
      WHERE ready=1 AND library_id IN (${placeholders}) ORDER BY library_id,author_peer_id`).all(...libraryIds) as Array<{
      library_id: string; author_peer_id: string; author_sequence: number;
    }>).map((row) => ({ libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.author_sequence }));
  }

  getAcknowledgedCursors(peerId: string): RatingSyncCursor[] {
    return (this.db.prepare('SELECT library_id,author_peer_id,contiguous_sequence FROM rating_sync_peer_cursors WHERE peer_id=? ORDER BY library_id,author_peer_id')
      .all(peerId) as Array<{ library_id: string; author_peer_id: string; contiguous_sequence: number }>).map((row) => ({
      libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.contiguous_sequence
    }));
  }

  eventsMissingForPeer(peerId: string, cursors: readonly RatingSyncCursor[], maximumEvents = MAX_EVENT_BATCH, respectBackoff = true): EventEnvelope[] {
    if (maximumEvents < 1 || !this.isTrusted(peerId)) return [];
    const cursorMap = new Map(cursors.map((cursor) => [`${cursor.libraryId}\0${cursor.authorPeerId}`, cursor.sequence]));
    const events: EventEnvelope[] = [];
    for (const libraryId of this.listGrantedLibraries(peerId)) {
      const authors = this.db.prepare("SELECT author_peer_id FROM rating_sync_author_heads WHERE library_id=? AND ready=1 ORDER BY author_peer_id")
        .all(libraryId) as Array<{ author_peer_id: string }>;
      for (const author of authors) {
        if (author.author_peer_id === peerId) continue;
        const sequence = cursorMap.get(`${libraryId}\0${author.author_peer_id}`) ?? 0;
        const dueFilter = respectBackoff ? 'AND (o.event_id IS NULL OR (o.accepted_at IS NULL AND o.next_attempt_at<=?))' : '';
        const args: unknown[] = [peerId, libraryId, author.author_peer_id, sequence];
        if (respectBackoff) args.push(this.now());
        args.push(Math.max(0, maximumEvents - events.length));
        const rows = this.db.prepare(`SELECT e.envelope_json FROM rating_sync_event_log e
          LEFT JOIN rating_sync_outbox o ON o.peer_id=? AND o.event_id=e.event_id
          WHERE e.library_id=? AND e.author_peer_id=? AND e.state='ready' AND e.author_sequence>? ${dueFilter}
          ORDER BY e.author_sequence LIMIT ?`).all(...args) as Array<{ envelope_json: string }>;
        for (const row of rows) events.push(parseEventEnvelope(JSON.parse(row.envelope_json)));
        if (events.length >= maximumEvents) return events;
      }
    }
    return events;
  }

  recordOfferedEvents(peerId: string, events: readonly EventEnvelope[]): void {
    this.db.transaction(() => {
      for (const event of events) {
        this.db.prepare('INSERT OR IGNORE INTO rating_sync_outbox(peer_id,event_id,attempts,next_attempt_at) VALUES(?,?,0,?)')
          .run(peerId, event.eventId, this.now());
        const row = this.db.prepare('SELECT attempts FROM rating_sync_outbox WHERE peer_id=? AND event_id=?')
          .get(peerId, event.eventId) as { attempts: number } | undefined;
        if (!row) continue;
        const attempts = row.attempts + 1;
        this.db.prepare('UPDATE rating_sync_outbox SET attempts=?,next_attempt_at=?,last_error=NULL WHERE peer_id=? AND event_id=?')
          .run(attempts, this.nextAttemptAt(attempts), peerId, event.eventId);
      }
    }).immediate();
  }

  recordOfferResult(peerId: string, eventId: string, status: RatingIngestResult['status'] | 'unauthorized'): void {
    const accepted = status === 'applied' || status === 'duplicate' || status === 'pending';
    const errorCode = status === 'unauthorized' ? 'rating_write_denied' : status === 'conflict' ? 'remote_conflict' :
      status === 'unsupported' ? 'unsupported_event' : status === 'pending' ? 'remote_pending' : null;
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT attempts FROM rating_sync_outbox WHERE peer_id=? AND event_id=?')
        .get(peerId, eventId) as { attempts: number } | undefined;
      if (!row) return;
      this.db.prepare('UPDATE rating_sync_outbox SET accepted_at=?,next_attempt_at=?,last_error=? WHERE peer_id=? AND event_id=?')
        .run(accepted ? this.now() : null, errorCode ? this.nextAttemptAt(row.attempts) : this.now(), errorCode, peerId, eventId);
    }).immediate();
  }

  recordOfferFailure(peerId: string, eventIds: readonly string[], errorCode: string): void {
    const safeCode = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'transport_error';
    this.db.transaction(() => {
      for (const eventId of eventIds) {
        const row = this.db.prepare('SELECT attempts FROM rating_sync_outbox WHERE peer_id=? AND event_id=?')
          .get(peerId, eventId) as { attempts: number } | undefined;
        if (!row) continue;
        this.db.prepare('UPDATE rating_sync_outbox SET accepted_at=NULL,next_attempt_at=?,last_error=? WHERE peer_id=? AND event_id=?')
          .run(this.nextAttemptAt(row.attempts), safeCode, peerId, eventId);
      }
    }).immediate();
  }

  acknowledgeCursors(peerId: string, cursors: readonly RatingSyncCursor[]): void {
    this.db.transaction(() => {
      if (!this.isTrusted(peerId)) return;
      for (const cursor of cursors) {
        if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) continue;
        const head = this.db.prepare("SELECT author_sequence FROM rating_sync_author_heads WHERE library_id=? AND author_peer_id=? AND ready=1")
          .get(cursor.libraryId, cursor.authorPeerId) as { author_sequence: number } | undefined;
        if (!head) continue;
        const previous = this.db.prepare('SELECT contiguous_sequence FROM rating_sync_peer_cursors WHERE library_id=? AND peer_id=? AND author_peer_id=?')
          .get(cursor.libraryId, peerId, cursor.authorPeerId) as { contiguous_sequence: number } | undefined;
        const oldSequence = previous?.contiguous_sequence ?? 0;
        const target = Math.min(cursor.sequence, head.author_sequence);
        if (target <= oldSequence) continue;
        const gapOrRejected = this.db.prepare(`SELECT 1 FROM rating_sync_event_log e
          WHERE e.library_id=? AND e.author_peer_id=? AND e.author_sequence>? AND e.author_sequence<=? AND e.state='ready'
            AND NOT EXISTS(SELECT 1 FROM rating_sync_outbox o WHERE o.peer_id=? AND o.event_id=e.event_id AND o.accepted_at IS NOT NULL)
          LIMIT 1`).get(cursor.libraryId, cursor.authorPeerId, oldSequence, target, peerId);
        if (gapOrRejected) continue;
        const end = this.db.prepare("SELECT event_id FROM rating_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence=? AND state='ready'")
          .get(cursor.libraryId, cursor.authorPeerId, target) as { event_id: string } | undefined;
        if (!end) continue;
        this.db.prepare(`INSERT INTO rating_sync_peer_cursors(library_id,peer_id,author_peer_id,contiguous_sequence,event_id,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(library_id,peer_id,author_peer_id) DO UPDATE SET contiguous_sequence=excluded.contiguous_sequence,event_id=excluded.event_id,updated_at=excluded.updated_at`)
          .run(cursor.libraryId, peerId, cursor.authorPeerId, target, end.event_id, this.now());
        this.db.prepare(`DELETE FROM rating_sync_outbox WHERE peer_id=? AND event_id IN
          (SELECT event_id FROM rating_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence<=?)`)
          .run(peerId, cursor.libraryId, cursor.authorPeerId, target);
      }
    }).immediate();
  }

  ingest(relayPeerId: string, value: EventEnvelope): RatingIngestResult {
    const event = parseEventEnvelope(value);
    return this.db.transaction((): RatingIngestResult => {
      this.assertPeerMayRelay(relayPeerId, event);
      if (!this.isRatingWriterAllowed(event.libraryId, event.authorPeerId)) throw new RatingSyncAuthorizationError();
      if (event.protocolVersion !== 1 || event.schemaVersion !== 1 || !isRatingSyncEventType(event.eventType)) {
        return this.persistUnsupported(relayPeerId, event);
      }
      if (!this.registerAuthor(event.libraryId, event.authorPeerId, this.now())) {
        this.recordProtocolConflict(relayPeerId, event, 'rating_author_limit');
        return { status: 'conflict', appliedEventIds: [] };
      }
      const prior = this.db.prepare(`SELECT envelope_json,state FROM rating_sync_event_log WHERE event_id=?
        UNION ALL SELECT envelope_json,state FROM rating_sync_inbox WHERE event_id=? LIMIT 1`).get(event.eventId, event.eventId) as
        { envelope_json: string; state: string } | undefined;
      if (prior) {
        if (eventDigest(parseEventEnvelope(JSON.parse(prior.envelope_json))) !== eventDigest(event)) {
          this.recordProtocolConflict(relayPeerId, event, 'event_id_digest_conflict');
          return { status: 'conflict', appliedEventIds: [] };
        }
        return { status: this.stateStatus(prior.state), appliedEventIds: [] };
      }
      if (this.db.prepare('SELECT 1 FROM sync_global_id_registry WHERE global_id=?').get(event.eventId)) {
        this.recordProtocolConflict(relayPeerId, event, 'global_event_id_collision');
        return { status: 'conflict', appliedEventIds: [] };
      }
      const sameSequence = this.db.prepare(`SELECT event_id FROM rating_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence=?
        UNION ALL SELECT event_id FROM rating_sync_inbox WHERE library_id=? AND author_peer_id=? AND author_sequence=? LIMIT 1`)
        .get(event.libraryId, event.authorPeerId, event.authorSequence, event.libraryId, event.authorPeerId, event.authorSequence) as { event_id: string } | undefined;
      if (sameSequence) {
        this.recordProtocolConflict(relayPeerId, event, 'author_sequence_conflict');
        return { status: 'conflict', appliedEventIds: [] };
      }
      if (this.isAuthorFrozen(event.libraryId, event.authorPeerId)) return { status: 'conflict', appliedEventIds: [] };
      this.db.prepare(`INSERT INTO rating_sync_inbox(event_id,peer_id,library_id,author_peer_id,author_sequence,envelope_json,state,error_code,received_at,accepted_at,applied_at,attempts,next_attempt_at)
        VALUES(?,?,?,?,?,?,'pending',NULL,?,?,NULL,0,?)`).run(event.eventId, relayPeerId, event.libraryId, event.authorPeerId,
        event.authorSequence, JSON.stringify(event), this.now(), this.now(), this.now());
      const appliedEventIds = this.applyPending(event.libraryId);
      const row = this.db.prepare('SELECT state FROM rating_sync_inbox WHERE event_id=?').get(event.eventId) as { state: string };
      return { status: row.state === 'applied' ? 'applied' : row.state === 'conflict' ? 'conflict' : 'pending', appliedEventIds };
    }).immediate();
  }

  reconcilePendingEvents(libraryId?: string): string[] {
    const libraries = libraryId ? [libraryId] : (this.db.prepare("SELECT DISTINCT library_id FROM rating_sync_inbox WHERE state='pending' ORDER BY library_id")
      .all() as Array<{ library_id: string }>).map((row) => row.library_id);
    return this.db.transaction(() => libraries.flatMap((library) => this.applyPending(library))).immediate();
  }

  requeueSupportedUnsupportedEvents(libraryId?: string): string[] {
    const rows = this.db.prepare(`SELECT event_id,peer_id,envelope_json FROM rating_sync_inbox WHERE state='unsupported' ${libraryId ? 'AND library_id=?' : ''}
      ORDER BY library_id,author_peer_id,author_sequence`).all(...(libraryId ? [libraryId] : [])) as Array<{ event_id: string; peer_id: string; envelope_json: string }>;
    const requeued: string[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        try {
          const event = parseEventEnvelope(JSON.parse(row.envelope_json));
          if (event.protocolVersion !== 1 || event.schemaVersion !== 1 || !isRatingSyncEventType(event.eventType)) continue;
          if (!this.isRatingWriterAllowed(event.libraryId, event.authorPeerId) || !this.hasLibraryRead(event.authorPeerId, event.libraryId) ||
              !this.isTrusted(row.peer_id)) continue;
          this.db.prepare("UPDATE rating_sync_inbox SET state='pending',error_code=NULL,accepted_at=?,next_attempt_at=? WHERE event_id=? AND state='unsupported'")
            .run(this.now(), this.now(), row.event_id);
          requeued.push(row.event_id);
        } catch { /* malformed rows remain quarantined */ }
      }
    }).immediate();
    this.reconcilePendingEvents(libraryId);
    return requeued;
  }

  recordProtocolConflict(relayPeerId: string, rawEvent: unknown, errorCode = 'invalid_event_envelope'): boolean {
    if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) return false;
    const raw = rawEvent as Record<string, unknown>;
    if (typeof raw.eventId !== 'string' || typeof raw.libraryId !== 'string' || typeof raw.authorPeerId !== 'string' ||
        !Number.isSafeInteger(raw.authorSequence) || Number(raw.authorSequence) < 1) return false;
    const safeCode = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'invalid_event_envelope';
    const eventId = raw.eventId as string;
    const libraryId = raw.libraryId as string;
    const authorPeerId = raw.authorPeerId as string;
    const authorSequence = Number(raw.authorSequence);
    return this.db.transaction(() => {
      if (!this.isTrusted(relayPeerId) || !this.isTrusted(authorPeerId) ||
          !this.db.prepare('SELECT 1 FROM sync_remote_library_grants WHERE peer_id=? AND library_id=?').get(relayPeerId, libraryId) ||
          !this.hasLibraryRead(authorPeerId, libraryId) || !this.isRatingWriterAllowed(libraryId, authorPeerId)) return false;
      const summary = JSON.stringify({ eventId, libraryId, authorPeerId, authorSequence, errorCode: safeCode });
      this.db.prepare(`INSERT OR IGNORE INTO rating_sync_conflicts(relay_peer_id,event_id,library_id,author_peer_id,author_sequence,envelope_json,error_code,received_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(relayPeerId, eventId, libraryId, authorPeerId, authorSequence, summary, safeCode, this.now());
      this.db.prepare("UPDATE rating_sync_inbox SET state='conflict',error_code=?,accepted_at=NULL,next_attempt_at=? WHERE event_id=? AND state IN ('pending','unsupported')")
        .run(safeCode, this.nextAttemptAt(1), eventId);
      this.db.prepare('UPDATE rating_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=? AND author_sequence>=?')
        .run(libraryId, authorPeerId, authorSequence);
      return true;
    }).immediate();
  }

  getPendingCount(peerId: string): number {
    return (this.db.prepare(`SELECT
      (SELECT count(*) FROM rating_sync_outbox WHERE peer_id=?)+
      (SELECT count(*) FROM rating_sync_inbox WHERE peer_id=? AND state IN ('pending','unsupported','conflict')) AS total`).get(peerId, peerId) as { total: number }).total;
  }

  getPeerSyncStatus(peerId: string): { pending: number; lastError: string | null } {
    const row = this.db.prepare('SELECT last_error FROM rating_sync_outbox WHERE peer_id=? AND last_error IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1')
      .get(peerId) as { last_error: string } | undefined;
    return { pending: this.getPendingCount(peerId), lastError: row?.last_error ?? null };
  }

  private applyPending(libraryId: string): string[] {
    const applied: string[] = [];
    for (let round = 0; round < 256; round += 1) {
      let progress = false;
      const rows = this.db.prepare("SELECT * FROM rating_sync_inbox WHERE library_id=? AND state='pending' ORDER BY author_peer_id,author_sequence")
        .all(libraryId) as InboxRow[];
      for (const row of rows) {
        const event = parseEventEnvelope(JSON.parse(row.envelope_json));
        if (!isRatingSyncEventType(event.eventType) || event.protocolVersion !== 1 || event.schemaVersion !== 1) continue;
        if (this.isAuthorFrozen(libraryId, event.authorPeerId)) continue;
        const head = this.db.prepare('SELECT author_sequence,ready FROM rating_sync_author_heads WHERE library_id=? AND author_peer_id=?')
          .get(libraryId, event.authorPeerId) as { author_sequence: number; ready: number } | undefined;
        if (head?.ready === 0 || event.authorSequence !== (head?.author_sequence ?? 0) + 1) continue;
        const causal = this.validateCausalContext(event);
        if (causal === 'unknown') continue;
        if (causal === 'invalid') {
          this.freezeInboxEvent(row, event, 'invalid_causal_parent');
          progress = true;
          continue;
        }
        this.db.transaction(() => {
          this.db.prepare("UPDATE rating_sync_inbox SET state='applying' WHERE event_id=? AND state='pending'").run(event.eventId);
          this.insertReadyEvent(event);
          const payload = event.payload as { assetId: string; rating: number | null; observedRatingEventIds: string[] };
          this.db.prepare(`INSERT INTO rating_operations(operation_id,principal_id,author_peer_id,library_id,asset_id,operation_type,request_fingerprint,result_json,created_at)
            VALUES(?,?,?,?,?,'asset.rating.set',?,?,?)`).run(event.eventId, `peer:${event.authorPeerId}`, event.authorPeerId, event.libraryId,
            payload.assetId, eventDigest(event), JSON.stringify({ status: 'changed' }), event.createdAt);
          this.insertRatingValue(event, payload.assetId, payload.rating, payload.observedRatingEventIds);
          this.refreshProjection(event.libraryId, payload.assetId);
          this.db.prepare("UPDATE rating_sync_inbox SET state='applied',applied_at=?,error_code=NULL WHERE event_id=? AND state='applying'")
            .run(this.now(), event.eventId);
          this.db.prepare(`INSERT INTO rating_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready) VALUES(?,?,?,?,1)
            ON CONFLICT(library_id,author_peer_id) DO UPDATE SET author_sequence=excluded.author_sequence,event_id=excluded.event_id,ready=1`)
            .run(event.libraryId, event.authorPeerId, event.authorSequence, event.eventId);
        }).immediate();
        applied.push(event.eventId);
        progress = true;
      }
      if (!progress) break;
    }
    return applied;
  }

  private validateCausalContext(event: EventEnvelope): 'valid' | 'unknown' | 'invalid' {
    const payload = event.payload as { assetId: string; rating: number | null; observedRatingEventIds: string[] };
    if (payload.observedRatingEventIds.length === 0) {
      const parentId = event.causalParents[0];
      if (!parentId) return 'invalid';
      const index = this.db.prepare("SELECT payload_json FROM sync_event_log WHERE event_id=? AND library_id=? AND event_type='asset.indexed' AND state='ready'")
        .get(parentId, event.libraryId) as { payload_json: string } | undefined;
      if (index) return (JSON.parse(index.payload_json) as { assetId?: string }).assetId === payload.assetId ? 'valid' : 'invalid';
      return this.parentKnownInvalid(parentId) ? 'invalid' : 'unknown';
    }
    for (const parentId of payload.observedRatingEventIds) {
      const parent = this.db.prepare('SELECT asset_id FROM rating_values WHERE event_id=? AND library_id=?').get(parentId, event.libraryId) as { asset_id: string } | undefined;
      if (parent) { if (parent.asset_id !== payload.assetId) return 'invalid'; continue; }
      if (this.parentKnownInvalid(parentId)) return 'invalid';
      return 'unknown';
    }
    return 'valid';
  }

  private parentKnownInvalid(parentId: string): boolean {
    const pending = this.db.prepare(`SELECT 1 FROM rating_sync_inbox WHERE event_id=? AND state IN ('pending','applying')
      UNION ALL SELECT 1 FROM sync_inbox WHERE event_id=? AND state='pending'
      UNION ALL SELECT 1 FROM tag_sync_inbox WHERE event_id=? AND state='pending'
      UNION ALL SELECT 1 FROM album_sync_inbox WHERE event_id=? AND state='pending'
      UNION ALL SELECT 1 FROM favorite_sync_inbox WHERE event_id=? AND state='pending' LIMIT 1`)
      .get(parentId, parentId, parentId, parentId, parentId);
    if (pending) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM sync_global_id_registry WHERE global_id=?
      UNION ALL SELECT 1 FROM rating_sync_event_log WHERE event_id=?
      UNION ALL SELECT 1 FROM rating_sync_inbox WHERE event_id=? AND state IN ('conflict','unsupported','rejected')
      UNION ALL SELECT 1 FROM sync_inbox WHERE event_id=? AND state IN ('conflict','unsupported')
      UNION ALL SELECT 1 FROM tag_sync_inbox WHERE event_id=? AND state IN ('conflict','unsupported')
      UNION ALL SELECT 1 FROM album_sync_inbox WHERE event_id=? AND state IN ('conflict','unsupported')
      UNION ALL SELECT 1 FROM favorite_sync_inbox WHERE event_id=? AND state IN ('conflict','unsupported')`)
      .get(parentId, parentId, parentId, parentId, parentId, parentId, parentId));
  }

  private freezeInboxEvent(row: InboxRow, event: EventEnvelope, errorCode: string): void {
    const safeCode = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'protocol_conflict';
    this.db.transaction(() => {
      this.db.prepare("UPDATE rating_sync_inbox SET state='conflict',error_code=?,accepted_at=NULL,next_attempt_at=? WHERE event_id=? AND state IN ('pending','unsupported')")
        .run(safeCode, this.nextAttemptAt(Math.max(1, row.attempts)), event.eventId);
      const summary = JSON.stringify({ eventId: event.eventId, libraryId: event.libraryId, authorPeerId: event.authorPeerId,
        authorSequence: event.authorSequence, errorCode: safeCode });
      this.db.prepare(`INSERT OR IGNORE INTO rating_sync_conflicts(relay_peer_id,event_id,library_id,author_peer_id,author_sequence,envelope_json,error_code,received_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(row.peer_id, event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, summary, safeCode, this.now());
      this.db.prepare('UPDATE rating_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=? AND author_sequence>=?')
        .run(event.libraryId, event.authorPeerId, event.authorSequence);
    }).immediate();
  }

  private persistUnsupported(relayPeerId: string, event: EventEnvelope): RatingIngestResult {
    const prior = this.db.prepare('SELECT envelope_json,state FROM rating_sync_inbox WHERE event_id=?').get(event.eventId) as { envelope_json: string; state: string } | undefined;
    if (prior) return { status: this.stateStatus(prior.state), appliedEventIds: [] };
    this.db.prepare(`INSERT INTO rating_sync_inbox(event_id,peer_id,library_id,author_peer_id,author_sequence,envelope_json,state,error_code,received_at,accepted_at,applied_at,attempts,next_attempt_at)
      VALUES(?,?,?,?,?,?,'unsupported','unsupported_event',?,NULL,NULL,0,?)`).run(event.eventId, relayPeerId, event.libraryId, event.authorPeerId,
      event.authorSequence, JSON.stringify(event), this.now(), this.nextAttemptAt(1));
    return { status: 'unsupported', appliedEventIds: [] };
  }

  private assertPeerMayRelay(relayPeerId: string, event: EventEnvelope): void {
    if (!this.isTrusted(relayPeerId) || !this.isTrusted(event.authorPeerId) ||
        !this.db.prepare('SELECT 1 FROM sync_remote_library_grants WHERE peer_id=? AND library_id=?').get(relayPeerId, event.libraryId)) {
      throw new RatingSyncAuthorizationError('relay is not authorized for this library');
    }
    if (!this.hasLibraryRead(event.authorPeerId, event.libraryId)) throw new RatingSyncAuthorizationError('rating signer lacks library read access');
  }

  private isTrusted(peerId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peerId));
  }

  private hasLibraryRead(peerId: string, libraryId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM library_grants WHERE peer_id=? AND library_id=? AND permission='read'").get(peerId, libraryId));
  }

  private registerAuthor(libraryId: string, peerId: string, at: string): boolean {
    if (this.db.prepare('SELECT 1 FROM rating_sync_author_registry WHERE library_id=? AND author_peer_id=?').get(libraryId, peerId)) return true;
    const count = (this.db.prepare('SELECT count(*) AS total FROM rating_sync_author_registry WHERE library_id=?').get(libraryId) as { total: number }).total;
    if (count >= MAX_RATING_AUTHORS_PER_LIBRARY) return false;
    this.db.prepare('INSERT INTO rating_sync_author_registry(library_id,author_peer_id,first_seen_at) VALUES(?,?,?)').run(libraryId, peerId, at);
    return true;
  }

  private activeRatingEventIds(libraryId: string, assetId: string): string[] {
    return (this.db.prepare(`SELECT v.event_id FROM rating_values v WHERE v.library_id=? AND v.asset_id=?
      AND NOT EXISTS(SELECT 1 FROM rating_observations o WHERE o.observed_event_id=v.event_id) ORDER BY v.event_id`)
      .all(libraryId, assetId) as Array<{ event_id: string }>).map((row) => row.event_id);
  }

  private insertRatingValue(event: Pick<EventEnvelope, 'eventId' | 'libraryId' | 'authorPeerId' | 'createdAt'>, assetId: string, rating: number | null, observedEventIds: readonly string[]): void {
    this.db.prepare('INSERT INTO rating_values(event_id,library_id,asset_id,rating,author_peer_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(event.eventId, event.libraryId, assetId, rating, event.authorPeerId, event.createdAt);
    const insert = this.db.prepare('INSERT INTO rating_observations(event_id,observed_event_id,library_id,asset_id) VALUES(?,?,?,?)');
    for (const observedId of observedEventIds) insert.run(event.eventId, observedId, event.libraryId, assetId);
  }

  private insertSigningEvent(event: UnsignedEventEnvelope): void {
    this.db.prepare(`INSERT INTO rating_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,'signing')`)
      .run(event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, event.protocolVersion, event.schemaVersion,
        event.eventType, JSON.stringify(event.causalParents), JSON.stringify(event.payload), event.createdAt, JSON.stringify(event));
  }

  private insertReadyEvent(event: EventEnvelope): void {
    this.db.prepare(`INSERT INTO rating_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,
      causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'ready')`)
      .run(event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, event.protocolVersion, event.schemaVersion,
        event.eventType, JSON.stringify(event.causalParents), JSON.stringify(event.payload), event.createdAt, event.signature, JSON.stringify(event));
  }

  private requireAssetIndex(libraryId: string, assetId: string): string {
    const row = this.db.prepare(`SELECT event_id FROM sync_event_log WHERE library_id=? AND event_type='asset.indexed' AND state='ready'
      AND json_extract(payload_json,'$.assetId')=? ORDER BY author_sequence DESC LIMIT 1`).get(libraryId, assetId) as { event_id: string } | undefined;
    if (!row) throw new RatingSyncConflictError('initial rating requires an indexed asset event');
    return row.event_id;
  }

  private projectedView(libraryId: string, assetId: string): RatingView {
    const values = (this.db.prepare(`SELECT DISTINCT v.rating FROM rating_values v WHERE v.library_id=? AND v.asset_id=?
      AND NOT EXISTS(SELECT 1 FROM rating_observations o WHERE o.observed_event_id=v.event_id)`).all(libraryId, assetId) as Array<{ rating: number | null }>).map((row) => row.rating);
    const unique = [...new Set(values)].sort((left, right) => left === null ? (right === null ? 0 : -1) : right === null ? 1 : left - right);
    if (unique.length === 0) return { rating: null, conflict: false, ratingCandidates: [] };
    if (unique.length === 1) return { rating: unique[0] ?? null, conflict: false, ratingCandidates: unique };
    return { rating: null, conflict: true, ratingCandidates: unique };
  }

  private refreshProjection(libraryId: string, assetId: string): void {
    if (!this.visible(libraryId, assetId)) {
      this.db.prepare('DELETE FROM asset_rating_projection WHERE library_id=? AND asset_id=?').run(libraryId, assetId);
      return;
    }
    const view = this.projectedView(libraryId, assetId);
    if (view.ratingCandidates.length === 0) this.db.prepare('DELETE FROM asset_rating_projection WHERE library_id=? AND asset_id=?').run(libraryId, assetId);
    else this.db.prepare(`INSERT INTO asset_rating_projection(library_id,asset_id,rating,conflict,candidates_json) VALUES(?,?,?,?,?)
      ON CONFLICT(library_id,asset_id) DO UPDATE SET rating=excluded.rating,conflict=excluded.conflict,candidates_json=excluded.candidates_json`)
      .run(libraryId, assetId, view.rating, view.conflict ? 1 : 0, JSON.stringify(view.ratingCandidates));
  }

  private visible(libraryId: string, assetId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM assets a WHERE a.library_id=? AND a.asset_id=?
      AND NOT EXISTS(SELECT 1 FROM sync_asset_projection p WHERE p.library_id=a.library_id AND p.asset_id=a.asset_id AND p.tombstone_event_id IS NOT NULL)
      UNION ALL SELECT 1 FROM sync_asset_projection p WHERE p.library_id=? AND p.asset_id=? AND p.tombstone_event_id IS NULL
      LIMIT 1`).get(libraryId, assetId, libraryId, assetId));
  }

  private isAuthorFrozen(libraryId: string, authorPeerId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM rating_sync_conflicts WHERE library_id=? AND author_peer_id=?
      UNION ALL SELECT 1 FROM rating_sync_inbox WHERE library_id=? AND author_peer_id=? AND state IN ('conflict','unsupported','rejected') LIMIT 1`)
      .get(libraryId, authorPeerId, libraryId, authorPeerId));
  }

  private stateStatus(state: string): RatingIngestResult['status'] {
    if (state === 'ready' || state === 'applied') return 'duplicate';
    if (state === 'unsupported') return 'unsupported';
    if (state === 'conflict' || state === 'rejected') return 'conflict';
    return 'pending';
  }

  private nextAttemptAt(attempts: number): string {
    const time = Date.parse(this.now());
    const delay = Math.min(300_000, 10_000 * 2 ** Math.min(5, Math.max(0, attempts - 1)));
    return new Date((Number.isFinite(time) ? time : Date.now()) + delay).toISOString();
  }
}
