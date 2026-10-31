import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { eventDigest, isAlbumSyncEventType, parseEventEnvelope, type EventContext, type EventEnvelope, type JsonValue, type UnsignedEventEnvelope } from './event-envelope.js';

export const maxAlbumAuthorsPerLibrary = 64;
export type AlbumOperationType = 'album.created' | 'member.added' | 'member.removed';
export interface AlbumSyncCursor { libraryId: string; authorPeerId: string; sequence: number }
export interface AlbumSyncGrantStatus { peerId:string; writeGranted:boolean; writeRevokedAt:string|null; deleteGranted:boolean; deleteRevokedAt:string|null }
export interface AlbumLocalOperation {
  operationId: string; authorPeerId: string; libraryId: string; albumId: string; assetId: string | null;
  operationType: AlbumOperationType; createdAt: string; observedAddIds?: readonly string[];
  title?: string; draftFactory: (input: {context: EventContext; libraryId: string; authorPeerId: string; eventType: string; payload: JsonValue; createdAt: string}) => UnsignedEventEnvelope;
}
export type AlbumDraftInput = Omit<AlbumLocalOperation, 'draftFactory'> & { draftFactory: AlbumLocalOperation['draftFactory'] };
export interface AlbumLifecycleLocalOperation {
  operationId: string; authorPeerId: string; libraryId: string; albumId: string;
  operationType: 'album.deleted' | 'album.restored'; createdAt: string; observedDeleteIds?: readonly string[];
  draftFactory: AlbumLocalOperation['draftFactory'];
}
export type AlbumLifecycleDraftInput = AlbumLifecycleLocalOperation;
export type AlbumIngestResult = {status:'applied'|'pending'|'duplicate'|'unsupported'|'conflict'; appliedEventIds:string[]};
export class AlbumSyncConflictError extends Error { constructor(message: string) { super(message); this.name='AlbumSyncConflictError'; } }
export class AlbumSyncAuthorizationError extends Error { constructor(message='album write authority is required') { super(message); this.name='AlbumSyncAuthorizationError'; } }
interface Row { event_id:string; library_id:string; author_peer_id:string; author_sequence:number; envelope_json:string; state:string }

export class AlbumSyncRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  reserveLocalDraft(input: AlbumDraftInput): UnsignedEventEnvelope { return this.reserveLocalDraftInternal(input,false); }

  reserveLocalLifecycleDraft(input: AlbumLifecycleDraftInput): UnsignedEventEnvelope {
    return this.db.transaction(() => {
      const operation = this.db.prepare(`SELECT author_peer_id,library_id,album_id,operation_type,observed_delete_event_ids_json
        FROM album_lifecycle_operations WHERE operation_id=?`).get(input.operationId) as {
          author_peer_id:string; library_id:string; album_id:string; operation_type:string; observed_delete_event_ids_json:string;
        } | undefined;
      if (!operation || operation.author_peer_id !== input.authorPeerId || operation.library_id !== input.libraryId ||
          operation.album_id !== input.albumId || operation.operation_type !== input.operationType) {
        throw new AlbumSyncConflictError('lifecycle draft differs from its reserved operation');
      }
      const rawObserved = JSON.parse(operation.observed_delete_event_ids_json) as unknown;
      if (!Array.isArray(rawObserved) || !rawObserved.every((id): id is string => typeof id === 'string')) {
        throw new AlbumSyncConflictError('invalid lifecycle restore observations');
      }
      const observedDeleteIds = input.operationType === 'album.restored'
        ? [...rawObserved].sort()
        : [];
      if (input.operationType === 'album.restored' && (observedDeleteIds.length < 1 || observedDeleteIds.length > 64 ||
          new Set(observedDeleteIds).size !== observedDeleteIds.length ||
          (input.observedDeleteIds !== undefined &&
            JSON.stringify([...new Set(input.observedDeleteIds)].sort()) !== JSON.stringify(observedDeleteIds)))) {
        throw new AlbumSyncConflictError('invalid lifecycle restore observations');
      }
      if (input.operationType === 'album.deleted' && rawObserved.length !== 0) {
        throw new AlbumSyncConflictError('delete operation cannot observe restore targets');
      }
      const eventType = input.operationType;
      const payload: JsonValue = eventType === 'album.deleted'
        ? { albumId: input.albumId }
        : { albumId: input.albumId, observedDeleteEventIds: observedDeleteIds };
      const createEventId = this.albumCreateEvent(input.libraryId, input.albumId);
      if (!createEventId) throw new AlbumSyncConflictError('album create event is missing');
      let causalParents: string[];
      if (eventType === 'album.deleted') {
        causalParents = [createEventId];
      } else {
        const placeholders = observedDeleteIds.map(() => '?').join(',');
        const matching = this.db.prepare(`SELECT delete_event_id FROM album_global_delete_tokens
          WHERE library_id=? AND album_id=? AND delete_event_id IN (${placeholders})
          ORDER BY delete_event_id COLLATE BINARY`).all(input.libraryId, input.albumId, ...observedDeleteIds) as Array<{delete_event_id:string}>;
        if (matching.length !== observedDeleteIds.length ||
            JSON.stringify(matching.map((row) => row.delete_event_id)) !== JSON.stringify(observedDeleteIds)) {
          throw new AlbumSyncConflictError('restore targets do not belong to this album');
        }
        causalParents = observedDeleteIds;
      }
      const prior = this.db.prepare('SELECT author_sequence,event_id,ready FROM album_sync_author_heads WHERE library_id=? AND author_peer_id=?')
        .get(input.libraryId, input.authorPeerId) as {author_sequence:number;event_id:string;ready:number}|undefined;
      if (prior?.ready === 0) throw new AlbumSyncConflictError('an earlier album draft requires signing recovery');
      this.registerAuthor(input.libraryId, input.authorPeerId, input.createdAt);
      const context:EventContext = {
        authorSequence:(prior?.author_sequence ?? 0)+1,
        causalParents:[...new Set(causalParents)].sort()
      };
      const draft = input.draftFactory({ context, libraryId:input.libraryId, authorPeerId:input.authorPeerId,
        eventType, payload, createdAt:input.createdAt });
      if (draft.eventId !== input.operationId || draft.authorSequence !== context.authorSequence ||
          draft.libraryId !== input.libraryId || draft.authorPeerId !== input.authorPeerId || draft.eventType !== eventType ||
          JSON.stringify(draft.causalParents)!==JSON.stringify(context.causalParents) || JSON.stringify(draft.payload)!==JSON.stringify(payload)) {
        throw new AlbumSyncConflictError('album lifecycle draft differs from reserved operation');
      }
      this.db.prepare(`INSERT INTO album_sync_event_log
        (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,
         payload_json,created_at,signature,envelope_json,state) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,'signing')`)
        .run(draft.eventId,input.libraryId,input.authorPeerId,context.authorSequence,draft.protocolVersion,draft.schemaVersion,
          eventType,JSON.stringify(context.causalParents),JSON.stringify(payload),input.createdAt,JSON.stringify(draft));
      this.db.prepare(`INSERT INTO album_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready)
        VALUES(?,?,?,?,0) ON CONFLICT(library_id,author_peer_id) DO UPDATE SET author_sequence=excluded.author_sequence,
        event_id=excluded.event_id,ready=0`).run(input.libraryId,input.authorPeerId,context.authorSequence,draft.eventId);
      return draft;
    }).immediate();
  }

  private reserveLocalDraftInternal(input:AlbumDraftInput,allowEarlierUnsigned:boolean):UnsignedEventEnvelope {
    return this.db.transaction(() => {
      const {operationType: type, libraryId, authorPeerId, albumId, assetId, createdAt} = input;
      const eventType = type === 'member.added' ? 'album.member.added' : type === 'member.removed' ? 'album.member.removed' : 'album.created';
      const payload: JsonValue = type === 'album.created'
        ? {albumId, title: input.title ?? '', createdAt}
        : type === 'member.added' ? {albumId, assetId: assetId ?? ''}
          : {albumId, assetId: assetId ?? '', observedAddEventIds: [...new Set(input.observedAddIds ?? [])].sort()};
      if (type === 'member.added' && (!assetId || !this.assetIndexParent(libraryId, assetId))) throw new AlbumSyncConflictError('album member add requires an indexed asset parent');
      const causal = type === 'album.created' ? [] : type === 'member.added'
        ? [this.albumCreateEvent(libraryId, albumId), this.assetIndexParent(libraryId, assetId!)!]
        : [...(input.observedAddIds ?? [])];
      if (type !== 'album.created' && !causal[0]) throw new AlbumSyncConflictError('album create event is missing');
      const prior = this.db.prepare('SELECT author_sequence,event_id,ready FROM album_sync_author_heads WHERE library_id=? AND author_peer_id=?').get(libraryId, authorPeerId) as {author_sequence:number;event_id:string;ready:number}|undefined;
      if (prior?.ready === 0 && !allowEarlierUnsigned) throw new AlbumSyncConflictError('an earlier album draft requires signing recovery');
      this.registerAuthor(libraryId, authorPeerId, createdAt);
      const context:EventContext = {authorSequence:(prior?.author_sequence ?? 0)+1, causalParents:[...new Set(causal)].filter((x):x is string=>Boolean(x)).sort()};
      const draft = input.draftFactory({context,libraryId,authorPeerId,eventType,payload,createdAt});
      if (draft.eventId !== input.operationId || draft.authorSequence !== context.authorSequence || draft.libraryId !== libraryId || draft.authorPeerId !== authorPeerId || draft.eventType !== eventType || JSON.stringify(draft.causalParents)!==JSON.stringify(context.causalParents) || JSON.stringify(draft.payload)!==JSON.stringify(payload)) throw new AlbumSyncConflictError('album draft differs from reserved operation');
      this.db.prepare(`INSERT INTO album_sync_event_log (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,'signing')`)
        .run(draft.eventId,libraryId,authorPeerId,context.authorSequence,draft.protocolVersion,draft.schemaVersion,eventType,JSON.stringify(context.causalParents),JSON.stringify(payload),createdAt,JSON.stringify(draft));
      this.db.prepare(`INSERT INTO album_sync_author_heads (library_id,author_peer_id,author_sequence,event_id,ready) VALUES (?,?,?,?,0) ON CONFLICT(library_id,author_peer_id) DO UPDATE SET author_sequence=excluded.author_sequence,event_id=excluded.event_id,ready=0`).run(libraryId,authorPeerId,context.authorSequence,draft.eventId);
      return draft;
    }).immediate();
  }

  getUnsignedLocalDrafts(authorPeerId:string): UnsignedEventEnvelope[] {
    return (this.db.prepare("SELECT envelope_json FROM album_sync_event_log WHERE author_peer_id=? AND state='signing' ORDER BY library_id COLLATE BINARY,author_sequence").all(authorPeerId) as Array<{envelope_json:string}>).map(r=>JSON.parse(r.envelope_json));
  }
  completeLocalDraft(event:EventEnvelope):void {
    const parsed=parseEventEnvelope(event);
    if (!isAlbumSyncEventType(parsed.eventType)) throw new AlbumSyncConflictError('not an album event');
    this.db.transaction(()=>{
      const row=this.db.prepare("SELECT event_id,library_id,author_peer_id,author_sequence,envelope_json,state FROM album_sync_event_log WHERE event_id=?").get(event.eventId) as Row|undefined;
      const {signature:_s,...unsigned}=event; void _s;
      if (!row||row.state!=='signing'||row.library_id!==event.libraryId||row.author_peer_id!==event.authorPeerId||row.author_sequence!==event.authorSequence||row.envelope_json!==JSON.stringify(unsigned)) throw new AlbumSyncConflictError('album draft is missing or changed');
      this.db.prepare("UPDATE album_sync_event_log SET signature=?,envelope_json=?,state='ready' WHERE event_id=?").run(event.signature,JSON.stringify(event),event.eventId);
      this.db.prepare('UPDATE album_sync_author_heads SET ready=1 WHERE library_id=? AND author_peer_id=? AND event_id=?').run(event.libraryId,event.authorPeerId,event.eventId);
      this.db.prepare(`INSERT OR IGNORE INTO album_sync_outbox(peer_id,event_id,attempts,next_attempt_at) SELECT g.peer_id,?,0,? FROM library_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id WHERE g.library_id=? AND g.permission='read' AND p.trust_state='trusted'`).run(event.eventId,this.now(),event.libraryId);
    }).immediate();
  }

  reconcileLegacyOperations(authorPeerId:string): number {
    const rows=this.db.prepare(`SELECT o.operation_id,o.library_id,o.album_id,o.asset_id,o.operation_type,o.created_at,a.title FROM album_operations o JOIN albums a ON a.library_id=o.library_id AND a.album_id=o.album_id WHERE o.author_peer_id=? AND o.operation_type IN ('album.created','member.added','member.removed') ORDER BY o.library_id COLLATE BINARY,o.operation_id COLLATE BINARY`).all(authorPeerId) as Array<{operation_id:string;library_id:string;album_id:string;asset_id:string|null;operation_type:AlbumOperationType;created_at:string;title:string}>;
    let queued=0; const pending=new Map(rows.map(r=>[r.operation_id,r]));
    while(pending.size) {
      let progress=false;
      for(const row of [...pending.values()].sort((a,b)=>a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0)){
        const existing=this.db.prepare('SELECT 1 FROM album_sync_event_log WHERE event_id=?').get(row.operation_id);
        if(existing){pending.delete(row.operation_id);progress=true;continue;}
        if(row.operation_type==='member.added' && (!row.asset_id||!this.assetIndexParent(row.library_id,row.asset_id))) continue;
        if(row.operation_type==='member.removed') {
          const targets=this.db.prepare('SELECT observed_add_operation_id FROM album_membership_remove_targets WHERE remove_operation_id=? ORDER BY observed_add_operation_id COLLATE BINARY').all(row.operation_id) as Array<{observed_add_operation_id:string}>;
          if(targets.some(t=>pending.has(t.observed_add_operation_id))) continue;
          if(!targets.length) { pending.delete(row.operation_id); progress=true; continue; }
        }
        if(row.operation_type!=='album.created' && !this.albumCreateEvent(row.library_id,row.album_id)) continue;
        const targetRows=row.operation_type==='member.removed' ? this.db.prepare('SELECT observed_add_operation_id FROM album_membership_remove_targets WHERE remove_operation_id=? ORDER BY observed_add_operation_id COLLATE BINARY').all(row.operation_id) as Array<{observed_add_operation_id:string}> : [];
        const factory=({context,libraryId,authorPeerId:author,eventType,payload,createdAt}: Parameters<AlbumLocalOperation['draftFactory']>[0])=>({eventId:row.operation_id,libraryId,protocolVersion:1,schemaVersion:1,authorPeerId:author,authorSequence:context.authorSequence,causalParents:context.causalParents,eventType,payload,createdAt});
        this.reserveLocalDraftInternal({operationId:row.operation_id,authorPeerId,libraryId:row.library_id,albumId:row.album_id,assetId:row.asset_id,operationType:row.operation_type,createdAt:row.created_at,observedAddIds:targetRows.map(t=>t.observed_add_operation_id),title:row.title,draftFactory:factory},true);
        pending.delete(row.operation_id); queued++; progress=true;
      }
      if(!progress) break;
    }
    return queued;
  }

  ingest(relayPeerId:string,value:EventEnvelope):AlbumIngestResult {
    const event=parseEventEnvelope(value);
    return this.db.transaction(():AlbumIngestResult=>{
      const trusted=(peer:string)=>this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peer);
      if(!trusted(relayPeerId)||!trusted(event.authorPeerId)||!this.db.prepare('SELECT 1 FROM sync_remote_library_grants WHERE peer_id=? AND library_id=?').get(relayPeerId,event.libraryId)) throw new AlbumSyncAuthorizationError('relay is not authorized for this album library');
      const grantTable=event.eventType==='album.deleted'||event.eventType==='album.restored'?'library_album_delete_grants':'library_album_write_grants';
      const grant=this.db.prepare(`SELECT 1 FROM ${grantTable} WHERE peer_id=? AND library_id=? AND revoked_at IS NULL`).get(event.authorPeerId,event.libraryId);
      if(!grant) throw new AlbumSyncAuthorizationError();
      const blockedAt=this.db.prepare(`SELECT MIN(author_sequence) AS sequence FROM (
        SELECT author_sequence FROM album_sync_conflicts WHERE library_id=? AND author_peer_id=?
        UNION ALL SELECT author_sequence FROM album_sync_inbox WHERE library_id=? AND author_peer_id=? AND state='conflict'
      )`).get(event.libraryId,event.authorPeerId,event.libraryId,event.authorPeerId) as {sequence:number|null};
      if(blockedAt.sequence!==null&&event.authorSequence>=blockedAt.sequence){this.recordProtocolConflict(relayPeerId,event,'author_stream_blocked');return {status:'conflict',appliedEventIds:[]};}
      const old=this.db.prepare('SELECT event_id,library_id,author_peer_id,author_sequence,envelope_json,state FROM album_sync_event_log WHERE event_id=? UNION ALL SELECT event_id,library_id,author_peer_id,author_sequence,envelope_json,state FROM album_sync_inbox WHERE event_id=? LIMIT 1').get(event.eventId,event.eventId) as Row|undefined;
      if(old) {
        if(eventDigest(parseEventEnvelope(JSON.parse(old.envelope_json)))===eventDigest(event)) return {status:old.state==='ready'?'duplicate':old.state==='applied'?'duplicate':old.state==='unsupported'?'unsupported':old.state==='conflict'?'conflict':'pending',appliedEventIds:[]};
        this.db.prepare("UPDATE album_sync_inbox SET state='conflict',error_code='event_id_digest_conflict' WHERE event_id=? AND state IN ('pending','unsupported','conflict')").run(event.eventId);
        this.recordProtocolConflict(relayPeerId,event,'event_id_digest_conflict');
        this.db.prepare('UPDATE album_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=?').run(event.libraryId,event.authorPeerId);
        return {status:'conflict',appliedEventIds:[]};
      }
      const seq=this.db.prepare('SELECT event_id FROM album_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence=? UNION ALL SELECT event_id FROM album_sync_inbox WHERE library_id=? AND author_peer_id=? AND author_sequence=? LIMIT 1').get(event.libraryId,event.authorPeerId,event.authorSequence,event.libraryId,event.authorPeerId,event.authorSequence);
      if(seq) { this.db.prepare("UPDATE album_sync_inbox SET state='conflict',error_code='author_sequence_conflict' WHERE library_id=? AND author_peer_id=? AND author_sequence=? AND state IN ('pending','unsupported','conflict')").run(event.libraryId,event.authorPeerId,event.authorSequence); this.recordProtocolConflict(relayPeerId,event,'author_sequence_conflict'); this.db.prepare('UPDATE album_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=?').run(event.libraryId,event.authorPeerId); return {status:'conflict',appliedEventIds:[]}; }
      const supported=event.protocolVersion===1&&event.schemaVersion===1&&isAlbumSyncEventType(event.eventType);
       const incomingBytes=Buffer.byteLength(JSON.stringify(event),'utf8');
       const globalBytes=(this.db.prepare("SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))),0) AS n FROM album_sync_inbox WHERE state IN ('pending','unsupported','conflict')").get() as {n:number}).n;
       const relayBytes=(this.db.prepare("SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))),0) AS n FROM album_sync_inbox WHERE peer_id=? AND state IN ('pending','unsupported','conflict')").get(relayPeerId) as {n:number}).n;
       if(globalBytes+incomingBytes>64*1024*1024||relayBytes+incomingBytes>8*1024*1024) throw new AlbumSyncConflictError('album sync pending capacity exceeded');
      try { this.db.prepare(`INSERT INTO album_sync_inbox(event_id,peer_id,library_id,author_peer_id,author_sequence,envelope_json,state,error_code,received_at,applied_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)`).run(event.eventId,relayPeerId,event.libraryId,event.authorPeerId,event.authorSequence,JSON.stringify(event),supported?'pending':'unsupported',supported?null:'unsupported_event_version',this.now()); }
      catch(e) { if(String(e).includes('global event ID')) { this.recordProtocolConflict(relayPeerId,event,'global_event_id_collision'); this.db.prepare('UPDATE album_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=?').run(event.libraryId,event.authorPeerId); return {status:'conflict',appliedEventIds:[]}; } throw e; }
      if(!supported) return {status:'unsupported',appliedEventIds:[]};
       const appliedEventIds=this.applyReadyEvents(event.libraryId);
       const state=(this.db.prepare('SELECT state FROM album_sync_inbox WHERE event_id=?').get(event.eventId) as {state:string}).state;
       return {status:state==='applied'?'applied':state==='conflict'?'conflict':'pending',appliedEventIds};
    }).immediate();
  }

  recordProtocolConflict(relayPeerId: string, value: unknown, errorCode = 'invalid_event_envelope'): boolean {
    if (!isRecord(value) || typeof value.eventId !== 'string' || typeof value.libraryId !== 'string' ||
        typeof value.authorPeerId !== 'string' || !Number.isSafeInteger(value.authorSequence) || Number(value.authorSequence) < 1 ||
        value.eventId.length < 1 || value.eventId.length > 128 || value.libraryId.length < 1 || value.libraryId.length > 128 ||
        !/^[A-Za-z0-9]{10,128}$/.test(value.authorPeerId)) return false;
    const safeError = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'invalid_event_envelope';
    const eventId = value.eventId;
    const libraryId = value.libraryId;
    const authorPeerId = value.authorPeerId;
    const authorSequence = Number(value.authorSequence);
    return this.db.transaction(() => {
      const trusted = (peerId: string) => this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peerId);
      const remoteGrant = this.db.prepare('SELECT 1 FROM sync_remote_library_grants WHERE peer_id=? AND library_id=?').get(relayPeerId, libraryId);
      const authorGrant = this.db.prepare(`SELECT 1 FROM library_album_write_grants WHERE peer_id=? AND library_id=? AND revoked_at IS NULL
        UNION ALL SELECT 1 FROM library_album_delete_grants WHERE peer_id=? AND library_id=? AND revoked_at IS NULL LIMIT 1`)
        .get(authorPeerId, libraryId, authorPeerId, libraryId);
      if (!trusted(relayPeerId) || !trusted(authorPeerId) || !remoteGrant || !authorGrant) return false;
      const existing = this.db.prepare('SELECT MIN(author_sequence) AS sequence FROM album_sync_conflicts WHERE library_id=? AND author_peer_id=?')
        .get(libraryId, authorPeerId) as { sequence: number | null };
      if (existing.sequence !== null) {
        this.db.prepare('UPDATE album_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=? AND author_sequence>=?')
          .run(libraryId, authorPeerId, authorSequence);
        return true;
      }
      let digest: string;
      try { digest = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
      catch { return false; }
      const summary = JSON.stringify({ eventId, libraryId, authorPeerId, authorSequence,
        signature: typeof value.signature === 'string' ? value.signature.slice(0, 128) : null, digest, errorCode: safeError });
      this.db.prepare(`INSERT OR IGNORE INTO album_sync_conflicts
        (relay_peer_id,event_id,library_id,author_peer_id,author_sequence,envelope_json,error_code,received_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(relayPeerId, eventId, libraryId, authorPeerId, authorSequence, summary, safeError, this.now());
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
        this.db.prepare("INSERT OR IGNORE INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(?,'virtual-albums-v1',NULL)").run(eventId);
      }
      this.db.prepare('UPDATE album_sync_author_heads SET ready=0 WHERE library_id=? AND author_peer_id=? AND author_sequence>=?')
        .run(libraryId, authorPeerId, authorSequence);
      return true;
    }).immediate();
  }

  reconcilePendingEvents(libraryId?: string): string[] {
    const ids = libraryId ? [libraryId] : (this.db.prepare("SELECT DISTINCT library_id FROM album_sync_inbox WHERE state='pending' ORDER BY library_id COLLATE BINARY").all() as Array<{library_id:string}>).map(x=>x.library_id);
    return this.db.transaction(()=>ids.flatMap(id=>this.applyReadyEvents(id))).immediate();
  }

  setAlbumWriteGrant(libraryId:string, peerId:string, grantedAt:string):void { this.setGrant('library_album_write_grants',libraryId,peerId,grantedAt); }
  setAlbumDeleteGrant(libraryId:string, peerId:string, grantedAt:string):void { this.setGrant('library_album_delete_grants',libraryId,peerId,grantedAt); }
  revokeAlbumWriteGrant(libraryId:string, peerId:string, at:string):void { this.revokeGrant('library_album_write_grants',libraryId,peerId,at); }
  revokeAlbumDeleteGrant(libraryId:string, peerId:string, at:string):void { this.revokeGrant('library_album_delete_grants',libraryId,peerId,at); }
  listAlbumSyncGrants(libraryId:string):AlbumSyncGrantStatus[] {
    return (this.db.prepare(`SELECT p.peer_id, w.revoked_at AS write_revoked_at, d.revoked_at AS delete_revoked_at,
      CASE WHEN w.peer_id IS NOT NULL AND w.revoked_at IS NULL AND p.trust_state='trusted' THEN 1 ELSE 0 END AS write_granted,
      CASE WHEN d.peer_id IS NOT NULL AND d.revoked_at IS NULL AND p.trust_state='trusted' THEN 1 ELSE 0 END AS delete_granted
      FROM trusted_peers p LEFT JOIN library_album_write_grants w ON w.peer_id=p.peer_id AND w.library_id=?
      LEFT JOIN library_album_delete_grants d ON d.peer_id=p.peer_id AND d.library_id=?
      WHERE w.peer_id IS NOT NULL OR d.peer_id IS NOT NULL ORDER BY p.peer_id COLLATE BINARY`).all(libraryId,libraryId) as Array<{peer_id:string;write_revoked_at:string|null;delete_revoked_at:string|null;write_granted:number;delete_granted:number}>).map(r=>({peerId:r.peer_id,writeGranted:r.write_granted===1,writeRevokedAt:r.write_revoked_at,deleteGranted:r.delete_granted===1,deleteRevokedAt:r.delete_revoked_at}));
  }
  listGrantedLibraries(peerId:string):string[] { return (this.db.prepare("SELECT g.library_id FROM library_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id WHERE g.peer_id=? AND g.permission='read' AND p.trust_state='trusted' ORDER BY g.library_id COLLATE BINARY").all(peerId) as Array<{library_id:string}>).map(r=>r.library_id); }
  setRemoteLibraries(peerId:string,libraryIds:readonly string[]):void {
    if(!this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peerId)) throw new AlbumSyncAuthorizationError('relay must be trusted');
    this.db.transaction(()=>{this.db.prepare('DELETE FROM sync_remote_library_grants WHERE peer_id=?').run(peerId);const insert=this.db.prepare('INSERT INTO sync_remote_library_grants(peer_id,library_id,observed_at) VALUES(?,?,?)');for(const id of [...new Set(libraryIds)].sort())insert.run(peerId,id,this.now());}).immediate();
  }
  getRemoteLibraries(peerId:string):string[] { return (this.db.prepare('SELECT library_id FROM sync_remote_library_grants WHERE peer_id=? ORDER BY library_id COLLATE BINARY').all(peerId) as Array<{library_id:string}>).map(r=>r.library_id); }
  requeueSupportedUnsupportedEvents(libraryId?:string):string[] {
    const rows=this.db.prepare(`SELECT event_id,envelope_json FROM album_sync_inbox WHERE state='unsupported' ${libraryId?'AND library_id=?':''} ORDER BY library_id COLLATE BINARY,author_peer_id COLLATE BINARY,author_sequence`).all(...(libraryId?[libraryId]:[])) as Array<{event_id:string;envelope_json:string}>;
    const ids:string[]=[]; for(const row of rows){const e=parseEventEnvelope(JSON.parse(row.envelope_json));if(e.protocolVersion!==1||e.schemaVersion!==1||!isAlbumSyncEventType(e.eventType))continue;this.db.prepare("UPDATE album_sync_inbox SET state='pending',error_code=NULL WHERE event_id=? AND state='unsupported'").run(row.event_id);ids.push(row.event_id);}
    if(libraryId)this.reconcilePendingEvents(libraryId);else this.reconcilePendingEvents();return ids;
  }

  private setGrant(table:string,libraryId:string,peerId:string,at:string):void {
    if (!['library_album_write_grants','library_album_delete_grants'].includes(table)) throw new Error('invalid grant table');
    if (!this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peerId)) throw new AlbumSyncAuthorizationError('peer must be trusted');
    this.db.prepare(`INSERT INTO ${table}(peer_id,library_id,granted_at,revoked_at) VALUES(?,?,?,NULL) ON CONFLICT(peer_id,library_id) DO UPDATE SET granted_at=excluded.granted_at,revoked_at=NULL`).run(peerId,libraryId,at);
  }
  private revokeGrant(table:string,libraryId:string,peerId:string,at:string):void {
    if (!['library_album_write_grants','library_album_delete_grants'].includes(table)) throw new Error('invalid grant table');
    this.db.prepare(`UPDATE ${table} SET revoked_at=? WHERE library_id=? AND peer_id=? AND revoked_at IS NULL`).run(at,libraryId,peerId);
  }

  private applyReadyEvents(libraryId:string):string[] {
    const applied:string[]=[];
    for(let loops=0;loops<256;loops++) {
      let progress=false;
      const rows=this.db.prepare("SELECT event_id,envelope_json FROM album_sync_inbox WHERE library_id=? AND state='pending' ORDER BY author_peer_id COLLATE BINARY,author_sequence,event_id COLLATE BINARY").all(libraryId) as Array<{event_id:string;envelope_json:string}>;
      for(const row of rows) {
        const e=parseEventEnvelope(JSON.parse(row.envelope_json));
        // Trust, relay-library access, and author grants were checked before durable inbox insertion.
        // Once accepted, retain this signed history even if those permissions are later revoked.
        const head=this.db.prepare('SELECT author_sequence,ready FROM album_sync_author_heads WHERE library_id=? AND author_peer_id=?').get(libraryId,e.authorPeerId) as {author_sequence:number;ready:number}|undefined;
        if(head?.ready===0||e.authorSequence!==(head?.author_sequence??0)+1) continue;
        const blocked=this.db.prepare("SELECT 1 FROM album_sync_conflicts WHERE library_id=? AND author_peer_id=? AND author_sequence<=? UNION ALL SELECT 1 FROM album_sync_inbox WHERE library_id=? AND author_peer_id=? AND author_sequence<=? AND state IN ('conflict','unsupported') LIMIT 1").get(libraryId,e.authorPeerId,e.authorSequence,libraryId,e.authorPeerId,e.authorSequence);
        if(blocked) continue;
        const hasParent=(id:string)=>Boolean(this.db.prepare("SELECT 1 FROM album_sync_event_log WHERE event_id=? AND library_id=? AND state='ready' UNION ALL SELECT 1 FROM sync_event_log WHERE event_id=? AND library_id=? AND state='ready' LIMIT 1").get(id,libraryId,id,libraryId));
        const hasInvalidKnownParent=(id:string)=>{
          const known=this.db.prepare(`SELECT library_id,state,source FROM (
            SELECT library_id,state,'album-event' AS source FROM album_sync_event_log WHERE event_id=?
            UNION ALL SELECT library_id,state,'album-inbox' FROM album_sync_inbox WHERE event_id=?
            UNION ALL SELECT library_id,state,'metadata-event' FROM sync_event_log WHERE event_id=?
            UNION ALL SELECT library_id,state,'metadata-inbox' FROM sync_inbox WHERE event_id=?
            UNION ALL SELECT library_id,state,'tag-event' FROM tag_sync_event_log WHERE event_id=?
            UNION ALL SELECT library_id,state,'tag-inbox' FROM tag_sync_inbox WHERE event_id=?
            UNION ALL SELECT library_id,NULL,'album-noop' FROM album_operations WHERE operation_id=? AND operation_type IN ('member.add.noop','member.remove.noop')
            UNION ALL SELECT library_id,NULL,'lifecycle-noop' FROM album_lifecycle_operations WHERE operation_id=? AND operation_type IN ('album.delete.noop','album.restore.noop')
            UNION ALL SELECT library_id,NULL,'visibility-operation' FROM album_visibility_operations WHERE operation_id=?
            UNION ALL SELECT library_id,NULL,'album-conflict' FROM album_sync_conflicts WHERE event_id=?
            UNION ALL SELECT NULL,NULL,'tag-registry' FROM sync_global_id_registry WHERE global_id=? AND event_stream='asset-tags-v1'
          )`).all(id,id,id,id,id,id,id,id,id,id,id) as Array<{library_id:string;state:string|null;source:string}>;
          return known.some((parent)=>parent.library_id!==libraryId||parent.source==='tag-event'||parent.source==='tag-inbox'||
            parent.source==='album-noop'||parent.source==='lifecycle-noop'||parent.source==='visibility-operation'||parent.source==='album-conflict'||parent.state==='conflict');
        };
        const missingParents=e.causalParents.filter((id)=>!hasParent(id));
        if(missingParents.some(hasInvalidKnownParent)) {
          this.db.prepare("UPDATE album_sync_inbox SET state='conflict',error_code='invalid_causal_parent' WHERE event_id=? AND state='pending'").run(e.eventId);
          progress=true; continue;
        }
        if(missingParents.length>0) continue;
        this.db.prepare("UPDATE album_sync_inbox SET state='applying' WHERE event_id=? AND state='pending'").run(e.eventId);
        try { this.db.transaction(()=>this.applyEvent(e))(); }
        catch { this.db.prepare("UPDATE album_sync_inbox SET state='conflict',error_code='invalid_or_conflicting_event' WHERE event_id=?").run(e.eventId); progress=true; continue; }
        this.db.prepare(`INSERT INTO album_sync_event_log(event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'ready')`).run(e.eventId,e.libraryId,e.authorPeerId,e.authorSequence,e.protocolVersion,e.schemaVersion,e.eventType,JSON.stringify(e.causalParents),JSON.stringify(e.payload),e.createdAt,e.signature,JSON.stringify(e));
        this.db.prepare("UPDATE album_sync_inbox SET state='applied',applied_at=?,error_code=NULL WHERE event_id=? AND state='applying'").run(this.now(),e.eventId);
        this.db.prepare(`INSERT INTO album_sync_author_heads(library_id,author_peer_id,author_sequence,event_id,ready) VALUES(?,?,?,?,1) ON CONFLICT(library_id,author_peer_id) DO UPDATE SET author_sequence=excluded.author_sequence,event_id=excluded.event_id,ready=1`).run(libraryId,e.authorPeerId,e.authorSequence,e.eventId);
        this.db.prepare(`INSERT OR IGNORE INTO album_sync_outbox(peer_id,event_id,attempts,next_attempt_at) SELECT g.peer_id,?,0,? FROM library_grants g JOIN trusted_peers p ON p.peer_id=g.peer_id WHERE g.library_id=? AND g.permission='read' AND p.trust_state='trusted' AND g.peer_id<>?`).run(e.eventId,this.now(),libraryId,e.authorPeerId);
        applied.push(e.eventId); progress=true;
      }
      if(!progress) break;
    }
    return applied;
  }

  private applyEvent(e:EventEnvelope):void {
    const p=e.payload as Record<string,JsonValue>, albumId=String(p.albumId), assetId=typeof p.assetId==='string'?p.assetId:null;
    const fp='0'.repeat(64), result=JSON.stringify({status:'applied'});
    if(e.eventType==='album.created') {
      const title=String(p.title);
      const prior=this.db.prepare('SELECT title,created_by_peer_id FROM albums WHERE library_id=? AND album_id=?').get(e.libraryId,albumId) as {title:string;created_by_peer_id:string}|undefined;
      if(prior) throw new Error('album create identifier conflict');
      this.db.prepare('INSERT INTO albums(album_id,library_id,title,created_by_peer_id,created_at) VALUES(?,?,?,?,?)').run(albumId,e.libraryId,title,e.authorPeerId,String(p.createdAt));
      this.db.prepare(`INSERT INTO album_operations(operation_id,principal_id,author_peer_id,library_id,album_id,asset_id,operation_type,request_fingerprint,result_json,created_at) VALUES(?,? ,?,?,?,NULL,'album.created',?,?,?)`).run(e.eventId,e.authorPeerId,e.authorPeerId,e.libraryId,albumId,fp,result,e.createdAt);
      return;
    }
    if(e.eventType==='album.member.added') {
      const indexParent=assetId?this.assetIndexParent(e.libraryId,assetId):undefined, createParent=this.albumCreateEvent(e.libraryId,albumId); if(!assetId||!indexParent||!createParent||!e.causalParents.includes(indexParent)||!e.causalParents.includes(createParent)) throw new Error('missing dependency');
      const tomb=Boolean(this.db.prepare("SELECT 1 FROM sync_asset_projection WHERE library_id=? AND asset_id=? AND tombstone_event_id IS NOT NULL").get(e.libraryId,assetId));
      const live=this.db.prepare("SELECT 1 FROM assets WHERE library_id=? AND asset_id=? UNION ALL SELECT 1 FROM sync_asset_projection WHERE library_id=? AND asset_id=? AND tombstone_event_id IS NULL LIMIT 1").get(e.libraryId,assetId,e.libraryId,assetId);
      if(!live&&!tomb) throw new Error('unknown asset');
      this.db.prepare("INSERT INTO album_operations(operation_id,principal_id,author_peer_id,library_id,album_id,asset_id,operation_type,request_fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?,'member.added',?,?,?)").run(e.eventId,e.authorPeerId,e.authorPeerId,e.libraryId,albumId,assetId,fp,result,e.createdAt);
      const activePrior=this.db.prepare(`SELECT 1 FROM album_operations a WHERE a.library_id=? AND a.album_id=? AND a.asset_id=? AND a.author_peer_id=? AND a.operation_type='member.added' AND a.operation_id<>? AND NOT EXISTS(SELECT 1 FROM album_membership_remove_targets r WHERE r.observed_add_operation_id=a.operation_id) LIMIT 1`).get(e.libraryId,albumId,assetId,e.authorPeerId,e.eventId);
      if(activePrior) throw new Error('duplicate active author add');
      const removed=this.db.prepare('SELECT 1 FROM album_membership_remove_targets WHERE observed_add_operation_id=? LIMIT 1').get(e.eventId);
      const active=this.db.prepare(`SELECT 1 FROM album_memberships m WHERE m.library_id=? AND m.album_id=? AND m.asset_id=? AND m.author_peer_id=? AND NOT EXISTS(SELECT 1 FROM album_membership_remove_targets r WHERE r.observed_add_operation_id=m.add_operation_id)`).get(e.libraryId,albumId,assetId,e.authorPeerId);
      if(!tomb&&!removed&&!active) this.db.prepare('INSERT INTO album_memberships(library_id,album_id,asset_id,author_peer_id,add_operation_id,created_at) VALUES(?,?,?,?,?,?)').run(e.libraryId,albumId,assetId,e.authorPeerId,e.eventId,e.createdAt);
      return;
    }
    if(e.eventType==='album.member.removed') {
      if(!assetId||!this.albumCreateEvent(e.libraryId,albumId)) throw new Error('missing album');
      const targets=p.observedAddEventIds as string[];
      for(const id of targets) {
        const add=this.db.prepare("SELECT library_id,album_id,asset_id FROM album_operations WHERE operation_id=? AND operation_type='member.added'").get(id) as {library_id:string;album_id:string;asset_id:string}|undefined;
        if(!add||add.library_id!==e.libraryId||add.album_id!==albumId||add.asset_id!==assetId||!e.causalParents.includes(id)) throw new Error('invalid remove target');
      }
      this.db.prepare("INSERT INTO album_operations(operation_id,principal_id,author_peer_id,library_id,album_id,asset_id,operation_type,request_fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?,'member.removed',?,?,?)").run(e.eventId,e.authorPeerId,e.authorPeerId,e.libraryId,albumId,assetId,fp,result,e.createdAt);
      const ins=this.db.prepare('INSERT OR IGNORE INTO album_membership_remove_targets(remove_operation_id,observed_add_operation_id,library_id,album_id,asset_id) VALUES(?,?,?,?,?)');
      for(const id of targets) { ins.run(e.eventId,id,e.libraryId,albumId,assetId); this.db.prepare('DELETE FROM album_memberships WHERE add_operation_id=?').run(id); }
      return;
    }
    if(e.eventType==='album.deleted'||e.eventType==='album.restored') {
      const restored=e.eventType==='album.restored';
      const ids=restored?p.observedDeleteEventIds as string[]:[];
      const create=this.albumCreateEvent(e.libraryId,albumId); if(!create||(!restored&&!e.causalParents.includes(create))) throw new Error('missing album lifecycle parent');
      if(!restored&&this.db.prepare("SELECT 1 FROM album_global_delete_tokens d WHERE d.library_id=? AND d.album_id=? AND d.author_peer_id=? AND NOT EXISTS(SELECT 1 FROM album_global_restore_targets r WHERE r.observed_delete_event_id=d.delete_event_id) LIMIT 1").get(e.libraryId,albumId,e.authorPeerId)) throw new Error('album already deleted');
      if(restored) for(const id of ids) { const token=this.db.prepare('SELECT 1 FROM album_global_delete_tokens WHERE delete_event_id=? AND library_id=? AND album_id=?').get(id,e.libraryId,albumId); if(!token||!e.causalParents.includes(id)) throw new Error('invalid restore target'); }
      const typ=e.eventType;
      this.db.prepare(`INSERT INTO album_lifecycle_operations(operation_id,principal_id,author_peer_id,library_id,album_id,operation_type,request_fingerprint,observed_delete_event_ids_json,result_json,created_at) VALUES(?,?,?,?,?,?,?, ?,?,?)`).run(e.eventId,e.authorPeerId,e.authorPeerId,e.libraryId,albumId,typ,fp,JSON.stringify(ids),result,e.createdAt);
      if(!restored) this.db.prepare('INSERT INTO album_global_delete_tokens(delete_event_id,library_id,album_id,author_peer_id,created_at) VALUES(?,?,?,?,?)').run(e.eventId,e.libraryId,albumId,e.authorPeerId,e.createdAt);
      else { const ins=this.db.prepare('INSERT INTO album_global_restore_targets(restore_operation_id,observed_delete_event_id,library_id,album_id) VALUES(?,?,?,?)'); for(const id of ids) ins.run(e.eventId,id,e.libraryId,albumId); }
    }
  }

  rebuildMembershipsForAsset(libraryId:string,assetId:string):void {
    this.db.transaction(()=>{
      const tomb=Boolean(this.db.prepare("SELECT 1 FROM sync_asset_projection WHERE library_id=? AND asset_id=? AND tombstone_event_id IS NOT NULL").get(libraryId,assetId));
      this.db.prepare('DELETE FROM album_memberships WHERE library_id=? AND asset_id=?').run(libraryId,assetId);
      if(tomb)return;
      const adds=this.db.prepare(`SELECT a.album_id,a.author_peer_id,a.operation_id,a.created_at FROM album_operations a WHERE a.library_id=? AND a.asset_id=? AND a.operation_type='member.added' AND NOT EXISTS(SELECT 1 FROM album_membership_remove_targets r WHERE r.observed_add_operation_id=a.operation_id) ORDER BY a.album_id COLLATE BINARY,a.author_peer_id COLLATE BINARY,a.operation_id COLLATE BINARY`).all(libraryId,assetId) as Array<{album_id:string;author_peer_id:string;operation_id:string;created_at:string}>;
      const authors=new Set<string>();
      const insert=this.db.prepare('INSERT OR IGNORE INTO album_memberships(library_id,album_id,asset_id,author_peer_id,add_operation_id,created_at) VALUES(?,?,?,?,?,?)');
      for(const a of adds){const key=`${a.album_id}\\0${a.author_peer_id}`;if(authors.has(key))continue;authors.add(key);insert.run(libraryId,a.album_id,assetId,a.author_peer_id,a.operation_id,a.created_at);}
    }).immediate();
  }

  getCursors(libraryIds:readonly string[]):AlbumSyncCursor[]{ if(!libraryIds.length)return[]; const q=libraryIds.map(()=>'?').join(','); return (this.db.prepare(`SELECT library_id,author_peer_id,author_sequence FROM album_sync_author_heads WHERE ready=1 AND library_id IN (${q}) ORDER BY library_id COLLATE BINARY,author_peer_id COLLATE BINARY`).all(...libraryIds) as Array<{library_id:string;author_peer_id:string;author_sequence:number}>).map(r=>({libraryId:r.library_id,authorPeerId:r.author_peer_id,sequence:r.author_sequence})); }
  getAcknowledgedCursors(peerId:string):AlbumSyncCursor[] { return (this.db.prepare('SELECT library_id,author_peer_id,contiguous_sequence FROM album_sync_peer_cursors WHERE peer_id=? ORDER BY library_id COLLATE BINARY,author_peer_id COLLATE BINARY').all(peerId) as Array<{library_id:string;author_peer_id:string;contiguous_sequence:number}>).map(x=>({libraryId:x.library_id,authorPeerId:x.author_peer_id,sequence:x.contiguous_sequence})); }
  acknowledgeCursors(peerId:string,cursors:readonly AlbumSyncCursor[]):void {
    if(cursors.length>16384) throw new AlbumSyncConflictError('cursor limit exceeded');
    this.db.transaction(()=>{ for(const c of cursors) {
      if(!Number.isSafeInteger(c.sequence)||c.sequence<0) throw new AlbumSyncConflictError('invalid cursor');
      if(!this.db.prepare("SELECT 1 FROM trusted_peers WHERE peer_id=? AND trust_state='trusted'").get(peerId)||!this.db.prepare("SELECT 1 FROM library_grants WHERE peer_id=? AND library_id=? AND permission='read'").get(peerId,c.libraryId)) continue;
      const head=this.db.prepare("SELECT author_sequence FROM album_sync_author_heads WHERE library_id=? AND author_peer_id=? AND ready=1").get(c.libraryId,c.authorPeerId) as {author_sequence:number}|undefined; if(!head) continue;
      const previous=this.db.prepare('SELECT contiguous_sequence FROM album_sync_peer_cursors WHERE peer_id=? AND library_id=? AND author_peer_id=?').get(peerId,c.libraryId,c.authorPeerId) as {contiguous_sequence:number}|undefined;
      const upto=Math.min(c.sequence,head.author_sequence), prev=previous?.contiguous_sequence??0; if(upto<=prev)continue;
      const missing=this.db.prepare("SELECT 1 FROM album_sync_event_log e WHERE e.library_id=? AND e.author_peer_id=? AND e.author_sequence>? AND e.author_sequence<=? AND e.state='ready' AND NOT EXISTS(SELECT 1 FROM album_sync_outbox o WHERE o.peer_id=? AND o.event_id=e.event_id AND o.attempts>0) LIMIT 1").get(c.libraryId,c.authorPeerId,prev,upto,peerId); if(missing)continue;
      const row=this.db.prepare('SELECT event_id FROM album_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence=? AND state=\'ready\'').get(c.libraryId,c.authorPeerId,upto) as {event_id:string}|undefined; if(!row)continue;
      this.db.prepare('INSERT INTO album_sync_peer_cursors(library_id,peer_id,author_peer_id,contiguous_sequence,event_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(library_id,peer_id,author_peer_id) DO UPDATE SET contiguous_sequence=excluded.contiguous_sequence,event_id=excluded.event_id,updated_at=excluded.updated_at').run(c.libraryId,peerId,c.authorPeerId,upto,row.event_id,this.now());
      this.db.prepare('DELETE FROM album_sync_outbox WHERE peer_id=? AND event_id IN (SELECT event_id FROM album_sync_event_log WHERE library_id=? AND author_peer_id=? AND author_sequence<=?)').run(peerId,c.libraryId,c.authorPeerId,upto);
    }}).immediate();
  }
  recordOfferedEvents(peerId:string,events:readonly EventEnvelope[]):void {
    this.db.transaction(()=>{
      const now=this.now();
      for(const event of events){
        this.db.prepare('INSERT OR IGNORE INTO album_sync_outbox(peer_id,event_id,attempts,next_attempt_at) VALUES(?,?,0,?)').run(peerId,event.eventId,now);
        const row=this.db.prepare('SELECT attempts FROM album_sync_outbox WHERE peer_id=? AND event_id=?').get(peerId,event.eventId) as {attempts:number}|undefined;
        if(!row)continue;
        const attempts=row.attempts+1;
        this.db.prepare('UPDATE album_sync_outbox SET attempts=?,next_attempt_at=?,last_error=NULL WHERE peer_id=? AND event_id=?')
          .run(attempts,this.nextAttemptAt(attempts),peerId,event.eventId);
      }
    }).immediate();
  }
  recordOfferFailure(peerId:string,eventIds:readonly string[],errorCode:string):void {
    this.db.transaction(()=>{
      for(const id of eventIds){
        const row=this.db.prepare('SELECT attempts FROM album_sync_outbox WHERE peer_id=? AND event_id=?').get(peerId,id) as {attempts:number}|undefined;
        if(!row)continue;
        this.db.prepare('UPDATE album_sync_outbox SET next_attempt_at=?,last_error=? WHERE peer_id=? AND event_id=?')
          .run(this.nextAttemptAt(Math.max(1,row.attempts)),errorCode,peerId,id);
      }
    }).immediate();
  }
  private nextAttemptAt(attempts:number):string {
    const delay=Math.min(5*60*1000,10_000*2**Math.min(5,Math.max(0,attempts-1)));
    const parsed=Date.parse(this.now());
    return new Date((Number.isFinite(parsed)?parsed:Date.now())+delay).toISOString();
  }
  getPendingCount(peerId:string):number { return (this.db.prepare("SELECT (SELECT count(*) FROM album_sync_outbox WHERE peer_id=?)+(SELECT count(*) FROM album_sync_inbox WHERE peer_id=? AND state IN ('pending','unsupported','conflict')) AS n").get(peerId,peerId) as {n:number}).n; }
  getPeerSyncStatus(peerId:string):{pending:number;lastError:string|null} { const e=this.db.prepare('SELECT last_error FROM album_sync_outbox WHERE peer_id=? AND last_error IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1').get(peerId) as {last_error:string}|undefined; return {pending:this.getPendingCount(peerId),lastError:e?.last_error??null}; }
  eventsMissingForPeer(peerId:string,cursors:readonly AlbumSyncCursor[],maximumEvents=64,respectBackoff=true):EventEnvelope[]{
    if(!Number.isSafeInteger(maximumEvents)||maximumEvents<1)return[];
    const m=new Map(cursors.map(c=>[`${c.libraryId}\0${c.authorPeerId}`,c.sequence]));
    const libraries=this.listGrantedLibraries(peerId); const out:EventEnvelope[]=[]; const now=this.now();
    for(const libraryId of libraries){
      const authors=this.db.prepare('SELECT author_peer_id FROM album_sync_author_heads WHERE library_id=? AND ready=1 ORDER BY author_peer_id COLLATE BINARY').all(libraryId) as Array<{author_peer_id:string}>;
      for(const {author_peer_id:authorPeerId} of authors){
        if(authorPeerId===peerId)continue;
        const rows=this.db.prepare(`SELECT e.event_id,e.envelope_json FROM album_sync_event_log e
          LEFT JOIN album_sync_outbox o ON o.peer_id=? AND o.event_id=e.event_id
          WHERE e.library_id=? AND e.author_peer_id=? AND e.state='ready' AND e.author_sequence>?
            AND (o.event_id IS NULL OR ?=0 OR o.next_attempt_at<=?)
          ORDER BY e.author_sequence LIMIT ?`).all(peerId,libraryId,authorPeerId,m.get(`${libraryId}\0${authorPeerId}`)??0,respectBackoff?1:0,now,maximumEvents-out.length) as Array<{event_id:string;envelope_json:string}>;
        for(const row of rows){
          this.db.prepare('INSERT OR IGNORE INTO album_sync_outbox(peer_id,event_id,attempts,next_attempt_at) VALUES(?,?,0,?)').run(peerId,row.event_id,now);
          out.push(parseEventEnvelope(JSON.parse(row.envelope_json)));
        }
        if(out.length>=maximumEvents)return out;
      }
    }
    return out;
  }

  private registerAuthor(libraryId:string,authorPeerId:string,at:string):void { if(this.db.prepare('SELECT 1 FROM album_sync_author_registry WHERE library_id=? AND author_peer_id=?').get(libraryId,authorPeerId))return; const n=(this.db.prepare('SELECT COUNT(*) AS n FROM album_sync_author_registry WHERE library_id=?').get(libraryId) as {n:number}).n; if(n>=maxAlbumAuthorsPerLibrary)throw new AlbumSyncConflictError('album author limit reached'); this.db.prepare('INSERT INTO album_sync_author_registry(library_id,author_peer_id,first_seen_at) VALUES(?,?,?)').run(libraryId,authorPeerId,at); }
  private albumCreateEvent(libraryId:string,albumId:string):string|undefined { return (this.db.prepare("SELECT event_id FROM album_sync_event_log WHERE library_id=? AND event_type='album.created' AND json_extract(payload_json,'$.albumId')=? AND state IN ('ready','signing')").get(libraryId,albumId) as {event_id:string}|undefined)?.event_id; }
  private assetIndexParent(libraryId:string,assetId:string):string|undefined { return (this.db.prepare("SELECT event_id FROM sync_event_log WHERE library_id=? AND state='ready' AND event_type='asset.indexed' AND json_extract(payload_json,'$.assetId')=? ORDER BY author_sequence DESC,event_id COLLATE BINARY LIMIT 1").get(libraryId,assetId) as {event_id:string}|undefined)?.event_id; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
