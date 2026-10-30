import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCaptureDateMetadata, type CaptureDateMetadata } from '../metadata/capture-date.js';
import { eventDigest, parseEventEnvelope, type EventEnvelope, type EventDraftFactory, type JsonValue, type SyncEventType, type UnsignedEventEnvelope } from './event-envelope.js';

export interface EventContext { authorSequence: number; causalParents: string[] }
export interface SyncCursor { libraryId: string; authorPeerId: string; sequence: number }
export interface IngestResult { status: 'applied' | 'pending' | 'duplicate' | 'unsupported'; appliedEventIds: string[] }
export interface SyncProjection {
  libraryId: string; assetId: string; originNodeId: string; kind: string; sha256: string; byteLength: number;
  metadata: Record<string, JsonValue>; tombstoned: boolean; lastEventId: string;
}
export interface LocalAssetIndexRecord {
  libraryId: string; assetId: string; kind: string; sha256: string; byteLength: number; captureDate: CaptureDateMetadata;
}

export class SyncAuthorizationError extends Error {
  constructor() { super('peer is not authorized for this library'); this.name = 'SyncAuthorizationError'; }
}
export class SyncProtocolConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'SyncProtocolConflictError'; }
}
export class SyncCausalityError extends Error {
  constructor(message: string) { super(message); this.name = 'SyncCausalityError'; }
}

/** SQLite-backed immutable event log, durable outbox/inbox and deterministic metadata projection. */
export class SyncRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  getLocalEventContext(libraryId: string, authorPeerId: string): EventContext {
    return this.readLocalEventContext(libraryId, authorPeerId);
  }

  getEventEnvelope(eventId: string): EventEnvelope | undefined {
    const row = this.db.prepare(`SELECT envelope_json FROM sync_event_log WHERE event_id = ? AND state = 'ready'`)
      .get(eventId) as { envelope_json: string } | undefined;
    return row ? parseEventEnvelope(JSON.parse(row.envelope_json)) : undefined;
  }

  getTombstoneState(libraryId: string, eventId: string): 'active' | 'inactive' | 'not_found' {
    const row = this.db.prepare(`SELECT restored_by_event_id FROM sync_tombstones
      WHERE library_id = ? AND event_id = ?`).get(libraryId, eventId) as { restored_by_event_id: string | null } | undefined;
    if (!row) return 'not_found';
    return row.restored_by_event_id === null ? 'active' : 'inactive';
  }

  getTombstoneRestoreEventId(libraryId: string, eventId: string): string | null {
    const row = this.db.prepare(`SELECT restored_by_event_id FROM sync_tombstones
      WHERE library_id = ? AND event_id = ?`).get(libraryId, eventId) as { restored_by_event_id: string | null } | undefined;
    return row?.restored_by_event_id ?? null;
  }

  getActiveTombstoneEventId(libraryId: string, assetId: string): string | null {
    const row = this.db.prepare(`SELECT tombstone_event_id FROM sync_asset_projection
      WHERE library_id = ? AND asset_id = ?`).get(libraryId, assetId) as { tombstone_event_id: string | null } | undefined;
    return row?.tombstone_event_id ?? null;
  }

  /** Caller includes this write in the same SQLite transaction as its source mutation. */
  reserveLocalEventDraft(libraryId: string, authorPeerId: string, factory: EventDraftFactory): UnsignedEventEnvelope {
    const event = factory(this.readLocalEventContext(libraryId, authorPeerId));
    this.db.prepare(`INSERT INTO sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'signing')`)
      .run(event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, event.protocolVersion, event.schemaVersion,
        event.eventType, JSON.stringify(event.causalParents), JSON.stringify(event.payload), event.createdAt, JSON.stringify(event));
    this.db.prepare(`INSERT INTO sync_author_heads (library_id, author_peer_id, author_sequence, event_id, ready)
      VALUES (?, ?, ?, ?, 0) ON CONFLICT(library_id, author_peer_id) DO UPDATE SET
      author_sequence = excluded.author_sequence, event_id = excluded.event_id, ready = 0`)
      .run(event.libraryId, event.authorPeerId, event.authorSequence, event.eventId);
    return event;
  }

  getUnsignedLocalDrafts(authorPeerId: string): UnsignedEventEnvelope[] {
    const rows = this.db.prepare(`SELECT envelope_json FROM sync_event_log WHERE author_peer_id = ? AND state = 'signing'
      ORDER BY library_id, author_sequence`).all(authorPeerId) as Array<{ envelope_json: string }>;
    return rows.map((row) => JSON.parse(row.envelope_json) as UnsignedEventEnvelope);
  }

  /** Idempotently reserve one historical local asset event per SQLite transaction. */
  reserveNextMissingLocalAssetIndex(authorPeerId: string, factory: (record: LocalAssetIndexRecord) => EventDraftFactory): boolean {
    const reserve = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT a.library_id, a.asset_id, a.kind, f.sha256, f.byte_size,
          strftime('%Y-%m-%dT%H:%M:%fZ',a.capture_ts) AS captured_at,a.capture_local_time,a.capture_offset_minutes,
          a.capture_source,a.capture_confidence
        FROM assets a JOIN asset_files f ON f.asset_id = a.asset_id AND f.media_role = 'original'
        WHERE NOT EXISTS (SELECT 1 FROM sync_event_log e WHERE e.library_id = a.library_id AND e.author_peer_id = ?
          AND e.event_type = 'asset.indexed' AND json_extract(e.payload_json, '$.assetId') = a.asset_id)
        ORDER BY a.library_id, a.asset_id LIMIT 1`).get(authorPeerId) as {
          library_id: string; asset_id: string; kind: string; sha256: string; byte_size: number; captured_at: string | null;
          capture_local_time: string | null; capture_offset_minutes: number | null; capture_source: string; capture_confidence: string;
        } | undefined;
      if (!row) return false;
      const rawCaptureDate = {
        capturedAt: row.captured_at, localTime: row.capture_local_time, offsetMinutes: row.capture_offset_minutes,
        source: row.capture_source, confidence: row.capture_confidence
      };
      const captureDate: CaptureDateMetadata = isCaptureDateMetadata(rawCaptureDate) ? rawCaptureDate : row.captured_at
        ? { capturedAt: row.captured_at, localTime: null, offsetMinutes: null, source: 'legacy_unknown', confidence: 'unknown' }
        : { capturedAt: null, localTime: null, offsetMinutes: null, source: 'unknown', confidence: 'unknown' };
      this.reserveLocalEventDraft(row.library_id, authorPeerId, factory({
        libraryId: row.library_id, assetId: row.asset_id, kind: row.kind, sha256: row.sha256, byteLength: row.byte_size, captureDate
      }));
      return true;
    });
    return reserve.immediate();
  }

  completeLocalDraft(event: EventEnvelope): void {
    const complete = this.db.transaction(() => {
      const draft = this.db.prepare(`SELECT state FROM sync_event_log WHERE event_id = ? AND author_peer_id = ?`)
        .get(event.eventId, event.authorPeerId) as { state: string } | undefined;
      if (!draft) throw new SyncProtocolConflictError('local event draft not found');
      if (draft.state === 'ready') return;
      const result = this.db.prepare(`UPDATE sync_event_log SET signature = ?, envelope_json = ?, state = 'ready' WHERE event_id = ? AND state = 'signing'`)
        .run(event.signature, JSON.stringify(event), event.eventId);
      if (result.changes !== 1) throw new SyncProtocolConflictError('local event draft state changed');
      const head = this.db.prepare(`UPDATE sync_author_heads SET ready = 1 WHERE library_id = ? AND author_peer_id = ? AND event_id = ?`)
        .run(event.libraryId, event.authorPeerId, event.eventId);
      if (head.changes !== 1) throw new SyncProtocolConflictError('local event is no longer the author head');
      this.applyProjection(event);
      this.enqueueForGrantedPeers(event);
    });
    complete.immediate();
  }

  appendLocalEvent(event: EventEnvelope, requireActiveTombstoneId?: string): void {
    const append = this.db.transaction(() => {
      if (requireActiveTombstoneId !== undefined) {
        if (event.eventType !== 'asset.restored' || (event.payload as Record<string, JsonValue>).tombstoneEventId !== requireActiveTombstoneId ||
            this.getTombstoneState(event.libraryId, requireActiveTombstoneId) !== 'active') {
          throw new SyncCausalityError('restore tombstone is no longer active in this library');
        }
      }
      const context = this.readLocalEventContext(event.libraryId, event.authorPeerId);
      const expectedParents = requireActiveTombstoneId === undefined
        ? context.causalParents
        : [...new Set([...context.causalParents, requireActiveTombstoneId])].sort();
      if (expectedParents.length > 64) throw new SyncCausalityError('causal frontier exceeds the 64-parent limit');
      if (event.authorSequence !== context.authorSequence || !sameStrings(event.causalParents, expectedParents)) {
        throw new SyncProtocolConflictError('local event context changed while the event was being signed');
      }
      this.insertEvent(event);
      this.db.prepare(`INSERT INTO sync_author_heads (library_id, author_peer_id, author_sequence, event_id, ready)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(library_id, author_peer_id) DO UPDATE SET
        author_sequence = excluded.author_sequence, event_id = excluded.event_id, ready = 1`)
        .run(event.libraryId, event.authorPeerId, event.authorSequence, event.eventId);
      this.applyProjection(event);
      this.enqueueForGrantedPeers(event);
    });
    append.immediate();
  }

  setRemoteLibraries(peerId: string, libraryIds: readonly string[]): void {
    const update = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sync_remote_library_grants WHERE peer_id = ?').run(peerId);
      const insert = this.db.prepare('INSERT INTO sync_remote_library_grants (peer_id, library_id, observed_at) VALUES (?, ?, ?)');
      for (const libraryId of [...new Set(libraryIds)].sort()) insert.run(peerId, libraryId, this.now());
    });
    update.immediate();
  }

  getRemoteLibraries(peerId: string): string[] {
    return (this.db.prepare('SELECT library_id FROM sync_remote_library_grants WHERE peer_id = ? ORDER BY library_id')
      .all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  listGrantedLibraries(peerId: string): string[] {
    return (this.db.prepare(`SELECT g.library_id FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.peer_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted' ORDER BY g.library_id`)
      .all(peerId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  getCursors(libraryIds: readonly string[]): SyncCursor[] {
    if (libraryIds.length === 0) return [];
    const placeholders = libraryIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT library_id, author_peer_id, author_sequence FROM sync_author_heads
      WHERE ready = 1 AND library_id IN (${placeholders}) ORDER BY library_id, author_peer_id`).all(...libraryIds) as Array<{
        library_id: string; author_peer_id: string; author_sequence: number;
      }>).map((row) => ({ libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.author_sequence }));
  }

  getAcknowledgedCursors(peerId: string): SyncCursor[] {
    const rows = this.db.prepare(`SELECT library_id, author_peer_id, contiguous_sequence FROM sync_peer_cursors WHERE peer_id = ?
      ORDER BY library_id, author_peer_id`).all(peerId) as Array<{ library_id: string; author_peer_id: string; contiguous_sequence: number }>;
    return rows.map((row) => ({ libraryId: row.library_id, authorPeerId: row.author_peer_id, sequence: row.contiguous_sequence }));
  }

  eventsMissingForPeer(peerId: string, remoteCursors: readonly SyncCursor[], maxEvents = 100): EventEnvelope[] {
    const libraries = this.listGrantedLibraries(peerId);
    if (libraries.length === 0) return [];
    const cursorMap = new Map(remoteCursors.map((cursor) => [`${cursor.libraryId}\0${cursor.authorPeerId}`, cursor.sequence]));
    const select = this.db.prepare(`SELECT e.envelope_json FROM sync_event_log e
      JOIN library_grants g ON g.library_id = e.library_id AND g.peer_id = ? AND g.permission = 'read'
      JOIN trusted_peers p ON p.peer_id = g.peer_id AND p.trust_state = 'trusted'
      WHERE e.state = 'ready' AND e.library_id = ? AND e.author_peer_id = ? AND e.author_sequence > ?
      ORDER BY e.author_sequence LIMIT ?`);
    const events: EventEnvelope[] = [];
    for (const libraryId of libraries) {
      const authors = this.db.prepare('SELECT author_peer_id FROM sync_author_heads WHERE library_id = ? AND ready = 1 ORDER BY author_peer_id')
        .all(libraryId) as Array<{ author_peer_id: string }>;
      for (const { author_peer_id: authorPeerId } of authors) {
        // The target peer is already the origin of its own author stream; never echo its events back.
        if (authorPeerId === peerId) continue;
        const after = cursorMap.get(`${libraryId}\0${authorPeerId}`) ?? 0;
        const remaining = maxEvents - events.length;
        if (remaining <= 0) return events;
        const rows = select.all(peerId, libraryId, authorPeerId, after, remaining) as Array<{ envelope_json: string }>;
        for (const row of rows) events.push(JSON.parse(row.envelope_json) as EventEnvelope);
      }
    }
    return events.slice(0, maxEvents);
  }

  recordOfferedEvents(peerId: string, events: readonly EventEnvelope[]): void {
    if (events.length === 0) return;
    const update = this.db.prepare('UPDATE sync_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE peer_id = ? AND event_id = ?');
    const create = this.db.prepare(`INSERT OR IGNORE INTO sync_outbox (peer_id, event_id, attempts, next_attempt_at)
      SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
        WHERE g.peer_id = ? AND g.library_id = (SELECT library_id FROM sync_event_log WHERE event_id = ?) AND g.permission = 'read' AND p.trust_state = 'trusted')`);
    const record = this.db.transaction(() => {
      for (const event of events) {
        const next = new Date(Date.now() + 1000).toISOString();
        update.run(next, peerId, event.eventId);
        create.run(peerId, event.eventId, next, peerId, event.eventId);
      }
    });
    record.immediate();
  }

  acknowledgeCursors(peerId: string, cursors: readonly SyncCursor[]): void {
    const update = this.db.transaction(() => {
      const put = this.db.prepare(`INSERT INTO sync_peer_cursors
        (library_id, peer_id, author_peer_id, contiguous_sequence, event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(library_id, peer_id, author_peer_id) DO UPDATE SET
        contiguous_sequence = MAX(sync_peer_cursors.contiguous_sequence, excluded.contiguous_sequence),
        event_id = CASE WHEN excluded.contiguous_sequence >= sync_peer_cursors.contiguous_sequence THEN excluded.event_id ELSE sync_peer_cursors.event_id END,
        updated_at = excluded.updated_at`);
      const remove = this.db.prepare(`DELETE FROM sync_outbox WHERE peer_id = ? AND event_id IN
        (SELECT event_id FROM sync_event_log WHERE library_id = ? AND author_peer_id = ? AND author_sequence <= ?)`);
      for (const cursor of cursors) {
        const localHead = this.db.prepare(`SELECT author_sequence FROM sync_author_heads WHERE library_id = ? AND author_peer_id = ? AND ready = 1`)
          .get(cursor.libraryId, cursor.authorPeerId) as { author_sequence: number } | undefined;
        if (!localHead) continue;
        // A peer may know events we have not received. Clamp its claim to our local log so it cannot poison future anti-entropy.
        const acknowledgedSequence = Math.min(cursor.sequence, localHead.author_sequence);
        const event = acknowledgedSequence > 0
          ? this.db.prepare(`SELECT event_id FROM sync_event_log WHERE library_id = ? AND author_peer_id = ? AND author_sequence = ? AND state = 'ready'`)
            .get(cursor.libraryId, cursor.authorPeerId, acknowledgedSequence) as { event_id: string } | undefined
          : undefined;
        put.run(cursor.libraryId, peerId, cursor.authorPeerId, acknowledgedSequence, event?.event_id ?? null, this.now());
        remove.run(peerId, cursor.libraryId, cursor.authorPeerId, acknowledgedSequence);
      }
    });
    update.immediate();
  }

  ingest(peerId: string, event: EventEnvelope): IngestResult {
    const accept = this.db.transaction((): IngestResult => {
      if (this.db.prepare(`SELECT 1 FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`).get(peerId) === undefined ||
          this.db.prepare(`SELECT 1 FROM trusted_peers WHERE peer_id = ? AND trust_state = 'trusted'`).get(event.authorPeerId) === undefined ||
          this.db.prepare('SELECT 1 FROM sync_remote_library_grants WHERE peer_id = ? AND library_id = ?').get(peerId, event.libraryId) === undefined) {
        throw new SyncAuthorizationError();
      }
      const existing = this.db.prepare('SELECT envelope_json FROM sync_event_log WHERE event_id = ?').get(event.eventId) as { envelope_json: string } | undefined;
      if (existing) {
        if (eventDigest(JSON.parse(existing.envelope_json) as EventEnvelope) !== eventDigest(event)) this.reject(peerId, event, 'event_id_conflict');
        return { status: 'duplicate', appliedEventIds: [] };
      }
      const seqConflict = this.db.prepare(`SELECT event_id FROM sync_event_log WHERE library_id = ? AND author_peer_id = ? AND author_sequence = ?`)
        .get(event.libraryId, event.authorPeerId, event.authorSequence) as { event_id: string } | undefined;
      if (seqConflict) this.reject(peerId, event, 'author_sequence_conflict');
      this.insertEvent(event);
      this.db.prepare(`INSERT INTO sync_inbox
        (event_id, peer_id, library_id, author_peer_id, author_sequence, envelope_json, state, received_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(event.eventId, peerId, event.libraryId, event.authorPeerId, event.authorSequence, JSON.stringify(event), this.now());
      const appliedEventIds = this.applyReadyEvents(event.libraryId);
      const state = this.db.prepare('SELECT state FROM sync_inbox WHERE event_id = ?').get(event.eventId) as { state: 'pending' | 'applied' | 'unsupported' | 'conflict' };
      if (state.state === 'unsupported') return { status: 'unsupported', appliedEventIds };
      return { status: state.state === 'applied' ? 'applied' : 'pending', appliedEventIds };
    });
    try {
      return accept.immediate();
    } catch (error) {
      if (error instanceof SyncProtocolConflictError) this.persistRejected(peerId, event, error.message);
      throw error;
    }
  }

  getProjection(libraryId: string, assetId: string): SyncProjection | undefined {
    const row = this.db.prepare(`SELECT * FROM sync_asset_projection WHERE library_id = ? AND asset_id = ?`).get(libraryId, assetId) as {
      library_id: string; asset_id: string; origin_node_id: string; kind: string; sha256: string; byte_length: number;
      metadata_json: string; tombstone_event_id: string | null; last_event_id: string;
    } | undefined;
    return row ? {
      libraryId: row.library_id, assetId: row.asset_id, originNodeId: row.origin_node_id,
      kind: row.kind, sha256: row.sha256, byteLength: row.byte_length, metadata: JSON.parse(row.metadata_json) as Record<string, JsonValue>,
      tombstoned: row.tombstone_event_id !== null, lastEventId: row.last_event_id
    } : undefined;
  }

  listVisibleProjections(libraryId: string): SyncProjection[] {
    const rows = this.db.prepare(`SELECT * FROM sync_asset_projection WHERE library_id = ? AND tombstone_event_id IS NULL ORDER BY asset_id`)
      .all(libraryId) as Array<{ library_id: string; asset_id: string; origin_node_id: string; kind: string; sha256: string; byte_length: number; metadata_json: string; tombstone_event_id: null; last_event_id: string }>;
    return rows.map((row) => ({
      libraryId: row.library_id, assetId: row.asset_id, originNodeId: row.origin_node_id,
      kind: row.kind, sha256: row.sha256, byteLength: row.byte_length,
      metadata: JSON.parse(row.metadata_json) as Record<string, JsonValue>, tombstoned: false, lastEventId: row.last_event_id
    }));
  }

  private readLocalEventContext(libraryId: string, authorPeerId: string): EventContext {
    const own = this.db.prepare(`SELECT author_sequence, ready FROM sync_author_heads WHERE library_id = ? AND author_peer_id = ?`)
      .get(libraryId, authorPeerId) as { author_sequence: number; ready: number } | undefined;
    if (own?.ready === 0) throw new SyncCausalityError('a previous local event signature is still pending recovery');
    const authors = this.db.prepare(`SELECT author_peer_id, event_id FROM sync_author_heads WHERE library_id = ? AND ready = 1 ORDER BY author_peer_id`)
      .all(libraryId) as Array<{ author_peer_id: string; event_id: string }>;
    const current = authors.find((item) => item.author_peer_id === authorPeerId);
    if (authors.length >= 64 && !current) throw new SyncCausalityError('causal frontier exceeds the 64-parent limit');
    const ownSequence = own?.author_sequence ?? 0;
    return {
      authorSequence: ownSequence + 1,
      causalParents: authors.map((item) => item.event_id).sort()
    };
  }

  private insertEvent(event: EventEnvelope): void {
    this.db.prepare(`INSERT INTO sync_event_log
      (event_id, library_id, author_peer_id, author_sequence, protocol_version, schema_version, event_type,
       causal_parents_json, payload_json, created_at, signature, envelope_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`)
      .run(event.eventId, event.libraryId, event.authorPeerId, event.authorSequence, event.protocolVersion, event.schemaVersion,
        event.eventType, JSON.stringify(event.causalParents), JSON.stringify(event.payload), event.createdAt, event.signature, JSON.stringify(event));
  }

  private enqueueForGrantedPeers(event: EventEnvelope): void {
    this.db.prepare(`INSERT OR IGNORE INTO sync_outbox (peer_id, event_id, attempts, next_attempt_at)
      SELECT g.peer_id, ?, 0, ? FROM library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
      WHERE g.library_id = ? AND g.permission = 'read' AND p.trust_state = 'trusted'`)
      .run(event.eventId, this.now(), event.libraryId);
  }

  private applyReadyEvents(libraryId: string): string[] {
    const applied: string[] = [];
    for (let pass = 0; pass < 256; pass += 1) {
      const pending = this.db.prepare(`SELECT i.event_id, i.envelope_json FROM sync_inbox i
        WHERE i.library_id = ? AND i.state = 'pending' ORDER BY i.author_peer_id, i.author_sequence, i.event_id`)
        .all(libraryId) as Array<{ event_id: string; envelope_json: string }>;
      let progressed = false;
      for (const row of pending) {
        const event = JSON.parse(row.envelope_json) as EventEnvelope;
        if (event.protocolVersion !== 1 || event.schemaVersion !== 1 || !isSupportedType(event.eventType)) {
          this.db.prepare(`UPDATE sync_inbox SET state = 'unsupported', error_code = 'unsupported_event_version' WHERE event_id = ?`).run(event.eventId);
          progressed = true;
          continue;
        }
        const head = this.db.prepare(`SELECT author_sequence FROM sync_author_heads WHERE library_id = ? AND author_peer_id = ?`)
          .get(event.libraryId, event.authorPeerId) as { author_sequence: number } | undefined;
        if (event.authorSequence !== (head?.author_sequence ?? 0) + 1) continue;
        const ready = event.causalParents.every((parent) => {
          const parentRow = this.db.prepare('SELECT state FROM sync_inbox WHERE event_id = ?').get(parent) as { state: string } | undefined;
          return parentRow ? parentRow.state === 'applied' : this.db.prepare('SELECT 1 FROM sync_event_log WHERE event_id = ?').get(parent) !== undefined;
        });
        if (!ready) continue;
        this.applyProjection(event);
        this.db.prepare(`INSERT INTO sync_author_heads (library_id, author_peer_id, author_sequence, event_id)
          VALUES (?, ?, ?, ?) ON CONFLICT(library_id, author_peer_id) DO UPDATE SET
          author_sequence = excluded.author_sequence, event_id = excluded.event_id`)
          .run(event.libraryId, event.authorPeerId, event.authorSequence, event.eventId);
        this.db.prepare(`UPDATE sync_inbox SET state = 'applied', applied_at = ? WHERE event_id = ?`).run(this.now(), event.eventId);
        this.db.prepare(`INSERT INTO sync_peer_cursors (library_id, peer_id, author_peer_id, contiguous_sequence, event_id, updated_at)
          VALUES (?, (SELECT peer_id FROM sync_inbox WHERE event_id = ?), ?, ?, ?, ?)
          ON CONFLICT(library_id, peer_id, author_peer_id) DO UPDATE SET contiguous_sequence = excluded.contiguous_sequence,
          event_id = excluded.event_id, updated_at = excluded.updated_at`)
          .run(event.libraryId, event.eventId, event.authorPeerId, event.authorSequence, event.eventId, this.now());
        applied.push(event.eventId);
        progressed = true;
      }
      if (!progressed) break;
    }
    return applied;
  }

  private applyProjection(event: EventEnvelope): void {
    const payload = event.payload as Record<string, JsonValue>;
    const assetId = String(payload.assetId);
    if (event.eventType === 'asset.indexed') {
      const exists = this.getProjection(event.libraryId, assetId);
      if (exists && (exists.sha256 !== payload.sha256 || exists.originNodeId !== payload.originNodeId)) {
        throw new SyncProtocolConflictError('asset index conflicts with existing immutable content identity');
      }
      const capture = payload.capture;
      const metadata = typeof capture === 'object' && capture !== null && !Array.isArray(capture)
        ? { capture, capturedAt: capture.capturedAt ?? null } : {};
      this.db.prepare(`INSERT INTO sync_asset_projection
        (library_id, asset_id, origin_node_id, kind, sha256, byte_length, metadata_json, last_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(library_id, asset_id) DO NOTHING`)
        .run(event.libraryId, assetId, payload.originNodeId, payload.kind, payload.sha256, payload.byteLength, JSON.stringify(metadata), event.eventId);
      return;
    }
    if (event.eventType === 'asset.metadata.updated') {
      this.applyMetadata(event, assetId, payload.fields as Record<string, JsonValue>);
      return;
    }
    if (event.eventType === 'asset.tombstoned') {
      const exists = this.db.prepare(`SELECT 1 FROM sync_asset_projection WHERE library_id = ? AND asset_id = ?`).get(event.libraryId, assetId);
      if (!exists) throw new SyncCausalityError('tombstone refers to an asset not yet indexed');
      this.db.prepare(`INSERT OR IGNORE INTO sync_tombstones (event_id, library_id, asset_id) VALUES (?, ?, ?)`)
        .run(event.eventId, event.libraryId, assetId);
      this.refreshTombstoneProjection(event.libraryId, assetId, event.eventId);
      return;
    }
    const tombstoneEventId = String(payload.tombstoneEventId);
    if (!event.causalParents.includes(tombstoneEventId)) throw new SyncCausalityError('restore must causally reference its tombstone');
    const tombstone = this.db.prepare(`SELECT event_type, payload_json FROM sync_event_log WHERE event_id = ? AND library_id = ?`)
      .get(tombstoneEventId, event.libraryId) as { event_type: string; payload_json: string } | undefined;
    if (!tombstone || tombstone.event_type !== 'asset.tombstoned' || JSON.parse(tombstone.payload_json).assetId !== assetId) {
      throw new SyncCausalityError('restore references an unknown or unrelated tombstone');
    }
    this.db.prepare(`UPDATE sync_tombstones SET restored_by_event_id = ? WHERE event_id = ? AND restored_by_event_id IS NULL`)
      .run(event.eventId, tombstoneEventId);
    this.refreshTombstoneProjection(event.libraryId, assetId, event.eventId);
  }

  private refreshTombstoneProjection(libraryId: string, assetId: string, lastEventId: string): void {
    const active = this.db.prepare(`SELECT event_id FROM sync_tombstones WHERE library_id = ? AND asset_id = ?
      AND restored_by_event_id IS NULL ORDER BY event_id LIMIT 1`).get(libraryId, assetId) as { event_id: string } | undefined;
    this.db.prepare(`UPDATE sync_asset_projection SET tombstone_event_id = ?, restored_by_event_id = ?, last_event_id = ?
      WHERE library_id = ? AND asset_id = ?`).run(active?.event_id ?? null, active ? null : lastEventId, lastEventId, libraryId, assetId);
  }

  private applyMetadata(event: EventEnvelope, assetId: string, fields: Record<string, JsonValue>): void {
    if (!this.getProjection(event.libraryId, assetId)) throw new SyncCausalityError('metadata event refers to an asset not yet indexed');
    const ancestors = this.getAncestors(event.causalParents);
    const put = this.db.prepare(`INSERT INTO sync_field_values
      (library_id, asset_id, field_name, event_id, author_peer_id, value_json, is_current)
      VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`);
    for (const [field, value] of Object.entries(fields)) {
      const old = this.db.prepare(`SELECT event_id FROM sync_field_values WHERE library_id = ? AND asset_id = ? AND field_name = ? AND is_current = 1`)
        .all(event.libraryId, assetId, field) as Array<{ event_id: string }>;
      for (const row of old) {
        if (ancestors.has(row.event_id)) {
          this.db.prepare(`UPDATE sync_field_values SET is_current = 0 WHERE library_id = ? AND asset_id = ? AND field_name = ? AND event_id = ?`)
            .run(event.libraryId, assetId, field, row.event_id);
        }
      }
      put.run(event.libraryId, assetId, field, event.eventId, event.authorPeerId, JSON.stringify(value));
      const current = this.db.prepare(`SELECT event_id, author_peer_id, value_json FROM sync_field_values
        WHERE library_id = ? AND asset_id = ? AND field_name = ? AND is_current = 1 ORDER BY author_peer_id, event_id`)
        .all(event.libraryId, assetId, field) as Array<{ event_id: string; author_peer_id: string; value_json: string }>;
      const selected = current.at(-1);
      if (current.length > 1) {
        const candidates = current.map((item) => item.event_id).sort();
        const candidateJson = JSON.stringify(candidates);
        const conflictId = createHash('sha256').update(`${event.libraryId}\0${assetId}\0${field}\0${candidateJson}`).digest('hex');
        this.db.prepare(`INSERT OR IGNORE INTO sync_conflicts
          (conflict_id, library_id, asset_id, field_name, candidate_events_json, display_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(conflictId, event.libraryId, assetId, field, candidateJson, selected!.event_id, this.now());
      } else {
        this.db.prepare(`UPDATE sync_conflicts SET resolved_by_event_id = ? WHERE library_id = ? AND asset_id = ? AND field_name = ? AND resolved_by_event_id IS NULL`)
          .run(event.eventId, event.libraryId, assetId, field);
      }
      const projection = this.getProjection(event.libraryId, assetId)!;
      projection.metadata[field] = JSON.parse(selected!.value_json) as JsonValue;
      this.db.prepare('UPDATE sync_asset_projection SET metadata_json = ?, last_event_id = ? WHERE library_id = ? AND asset_id = ?')
        .run(JSON.stringify(projection.metadata), event.eventId, event.libraryId, assetId);
    }
  }

  private getAncestors(eventIds: readonly string[]): Set<string> {
    const ancestors = new Set<string>();
    const pending = [...eventIds];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      const row = this.db.prepare('SELECT causal_parents_json FROM sync_event_log WHERE event_id = ?').get(id) as { causal_parents_json: string } | undefined;
      if (row) pending.push(...JSON.parse(row.causal_parents_json) as string[]);
    }
    return ancestors;
  }

  private reject(peerId: string, event: EventEnvelope, errorCode: string): never {
    throw new SyncProtocolConflictError(errorCode);
  }

  private persistRejected(peerId: string, event: EventEnvelope, errorCode: string): void {
    const persist = this.db.transaction(() => {
    this.db.prepare(`INSERT OR IGNORE INTO sync_rejected_events
      (event_id, peer_id, library_id, author_peer_id, author_sequence, envelope_json, error_code, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, peerId, event.libraryId, event.authorPeerId, event.authorSequence, JSON.stringify(event), errorCode, this.now());
    });
    persist.immediate();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSupportedType(value: string): value is SyncEventType {
  return value === 'asset.indexed' || value === 'asset.metadata.updated' || value === 'asset.tombstoned' || value === 'asset.restored';
}
