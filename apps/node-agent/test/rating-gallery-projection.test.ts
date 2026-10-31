import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';
import { SqliteRepository } from '../src/db/repository.js';
import { RatingSyncRepository } from '../src/sync/rating-sync-repository.js';
import type { EventEnvelope } from '../src/sync/event-envelope.js';

const peerId = '12D3KooWPM047GalleryAuthor';
const now = '2026-10-29T00:00:00.000Z';
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('PM-047 gallery rating projection', () => {
  it('returns unrated defaults and the persisted rating without exposing event authors', async () => {
    const db = new Database(':memory:');
    try {
      await new SqliteRepository(db).migrate(migrations);
      db.prepare(`INSERT INTO assets(asset_id,library_id,origin_node_id,kind,created_at) VALUES('asset-1','family',?,'photo',?)`).run(peerId, now);
      db.prepare(`INSERT INTO sync_event_log
        (event_id,library_id,author_peer_id,author_sequence,protocol_version,schema_version,event_type,causal_parents_json,payload_json,created_at,signature,envelope_json,state)
        VALUES(?,'family',?,1,1,1,'asset.indexed','[]',?,?,'sig','{}','ready')`)
        .run(uuid(1), peerId, JSON.stringify({ assetId: 'asset-1', originNodeId: peerId, kind: 'photo', sha256: 'a'.repeat(64), byteLength: 10 }), now);
      const gallery = new SqliteRepository(db);
      expect(gallery.listGalleryAssets('family', undefined, 10).items[0]).toMatchObject({
        assetId: 'asset-1', favorite: false, rating: null, ratingConflict: false, ratingCandidates: []
      });
      const ratings = new RatingSyncRepository(db, () => now);
      ratings.setRating({ operationId: uuid(2), principalId: 'local-admin', authorPeerId: peerId, libraryId: 'family', assetId: 'asset-1', rating: 4,
        requestFingerprint: 'b'.repeat(64), createdAt: now });
      ratings.completeLocalDraft({ ...ratings.getUnsignedLocalDrafts(peerId)[0]!, signature: 'A'.repeat(86) } as EventEnvelope);
      const item = gallery.listGalleryAssets('family', undefined, 10).items[0];
      expect(item).toMatchObject({ rating: 4, ratingConflict: false, ratingCandidates: [4] });
      expect(item).not.toHaveProperty('ratingAuthorPeerId');
      expect(item).not.toHaveProperty('principalId');
      db.prepare('UPDATE asset_rating_projection SET rating=NULL,conflict=1,candidates_json=? WHERE library_id=? AND asset_id=?')
        .run('[2,5]', 'family', 'asset-1');
      expect(gallery.listGalleryAssets('family', undefined, 10).items[0]).toMatchObject({
        rating: null, ratingConflict: true, ratingCandidates: [2, 5]
      });
    } finally { db.close(); }
  });
});
