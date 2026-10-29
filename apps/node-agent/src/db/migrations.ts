export interface Migration {
  id: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '0001_upload_foundation',
    sql: `
      CREATE TABLE assets (
        asset_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'live_photo')),
        capture_ts TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX assets_library_capture_idx ON assets (library_id, capture_ts, asset_id);

      CREATE TABLE asset_files (
        file_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        media_role TEXT NOT NULL,
        storage_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX asset_files_asset_idx ON asset_files (asset_id, media_role);

      CREATE TABLE file_locations (
        location_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES asset_files(file_id) ON DELETE RESTRICT,
        node_id TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        original_path TEXT,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'import')),
        source_node_id TEXT,
        path_ref TEXT NOT NULL,
        storage_class TEXT NOT NULL CHECK (storage_class IN ('managed', 'external')),
        availability TEXT NOT NULL CHECK (availability IN ('online', 'cached', 'offline', 'missing')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX file_locations_file_idx ON file_locations (file_id, node_id);

      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_until TEXT,
        checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX jobs_state_created_idx ON jobs (state, created_at);

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE INDEX events_unpublished_idx ON events (created_at) WHERE published_at IS NULL;

      CREATE TABLE upload_sessions (
        session_id TEXT PRIMARY KEY,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        library_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'import')),
        source_path TEXT,
        source_node_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'live_photo')),
        total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
        expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
        state TEXT NOT NULL CHECK (state IN ('created', 'uploading', 'verifying', 'completed', 'failed')),
        offset_bytes INTEGER NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0 AND offset_bytes <= total_bytes),
        expires_at TEXT NOT NULL,
        final_storage_ref TEXT NOT NULL UNIQUE,
        completed_asset_id TEXT REFERENCES assets(asset_id) ON DELETE RESTRICT,
        completed_file_id TEXT REFERENCES asset_files(file_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (idempotency_scope, idempotency_key)
      );
      CREATE INDEX upload_sessions_state_expiry_idx ON upload_sessions (state, expires_at);

      CREATE TABLE upload_chunks (
        session_id TEXT NOT NULL REFERENCES upload_sessions(session_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        staging_ref TEXT NOT NULL UNIQUE,
        accepted_offset INTEGER NOT NULL CHECK (accepted_offset >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk_index)
      );
    `
  },
  {
    id: '0002_lan_pairing',
    sql: `
      CREATE TABLE node_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        peer_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE pairing_invites (
        invite_id TEXT PRIMARY KEY,
        secret_sha256 TEXT NOT NULL CHECK (length(secret_sha256) = 64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX pairing_invites_expiry_idx ON pairing_invites (expires_at, consumed_at);

      CREATE TABLE trusted_peers (
        peer_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        label TEXT NOT NULL,
        trust_state TEXT NOT NULL CHECK (trust_state IN ('trusted', 'revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE library_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        permission TEXT NOT NULL CHECK (permission IN ('read')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (peer_id, library_id, permission)
      );
      CREATE INDEX library_grants_library_idx ON library_grants (library_id, peer_id);
    `
  },
  {
    id: '0003_sync_event_log',
    sql: `
      CREATE TABLE sync_event_log (
        event_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        event_type TEXT NOT NULL,
        causal_parents_json TEXT NOT NULL CHECK (json_valid(causal_parents_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        signature TEXT,
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('signing', 'ready')),
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX sync_event_log_library_idx ON sync_event_log (library_id, author_peer_id, author_sequence);
      CREATE INDEX sync_event_log_type_idx ON sync_event_log (library_id, event_type, event_id);

      CREATE TABLE sync_outbox (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (peer_id, event_id)
      );
      CREATE INDEX sync_outbox_due_idx ON sync_outbox (peer_id, next_attempt_at, event_id);

      CREATE TABLE sync_inbox (
        event_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'unsupported', 'conflict')),
        error_code TEXT,
        received_at TEXT NOT NULL,
        applied_at TEXT,
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX sync_inbox_pending_idx ON sync_inbox (library_id, state, author_peer_id, author_sequence);

      CREATE TABLE sync_author_heads (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        event_id TEXT NOT NULL REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0, 1)),
        PRIMARY KEY (library_id, author_peer_id)
      );

      CREATE TABLE sync_peer_cursors (
        library_id TEXT NOT NULL,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        author_peer_id TEXT NOT NULL,
        contiguous_sequence INTEGER NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0),
        event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (library_id, peer_id, author_peer_id)
      );

      CREATE TABLE sync_remote_library_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (peer_id, library_id)
      );

      CREATE TABLE sync_asset_projection (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'live_photo')),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        tombstone_event_id TEXT,
        restored_by_event_id TEXT,
        last_event_id TEXT NOT NULL REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        PRIMARY KEY (library_id, asset_id)
      );
      CREATE INDEX sync_asset_projection_visible_idx ON sync_asset_projection (library_id, tombstone_event_id, asset_id);

      CREATE TABLE sync_tombstones (
        event_id TEXT PRIMARY KEY REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        restored_by_event_id TEXT REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        UNIQUE (event_id, library_id, asset_id)
      );
      CREATE INDEX sync_tombstones_active_idx ON sync_tombstones (library_id, asset_id, restored_by_event_id, event_id);

      CREATE TABLE sync_conflicts (
        conflict_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        candidate_events_json TEXT NOT NULL CHECK (json_valid(candidate_events_json)),
        display_event_id TEXT NOT NULL REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        resolved_by_event_id TEXT REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE (library_id, asset_id, field_name, candidate_events_json)
      );
      CREATE INDEX sync_conflicts_asset_idx ON sync_conflicts (library_id, asset_id, resolved_by_event_id);

      CREATE TABLE sync_field_values (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES sync_event_log(event_id) ON DELETE RESTRICT,
        author_peer_id TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
        PRIMARY KEY (library_id, asset_id, field_name, event_id)
      );
      CREATE INDEX sync_field_values_current_idx ON sync_field_values (library_id, asset_id, field_name, is_current);

      CREATE TABLE sync_rejected_events (
        event_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL,
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        error_code TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `
  },
  {
    id: '0004_media_versions',
    sql: `
      CREATE UNIQUE INDEX assets_asset_library_unique_idx ON assets (asset_id, library_id);
      CREATE TABLE media_versions (
        version_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        source_version_id TEXT,
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
        transform_json TEXT NOT NULL CHECK (json_valid(transform_json)),
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed')),
        storage_ref TEXT NOT NULL UNIQUE CHECK (storage_ref GLOB 'derived/*' AND instr(storage_ref, '..') = 0),
        output_sha256 TEXT CHECK (output_sha256 IS NULL OR (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*')),
        mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
        byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        error_code TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (library_id, idempotency_scope, idempotency_key),
        UNIQUE (version_id, asset_id, library_id),
        FOREIGN KEY (asset_id, library_id) REFERENCES assets (asset_id, library_id) ON DELETE RESTRICT,
        FOREIGN KEY (source_version_id, asset_id, library_id)
          REFERENCES media_versions (version_id, asset_id, library_id) ON DELETE RESTRICT,
        CHECK (
          (status = 'ready' AND output_sha256 IS NOT NULL AND mime_type IS NOT NULL AND byte_size IS NOT NULL AND
            width IS NOT NULL AND height IS NOT NULL AND error_code IS NULL) OR
          (status = 'staging' AND output_sha256 IS NULL AND mime_type IS NULL AND byte_size IS NULL AND
            width IS NULL AND height IS NULL AND error_code IS NULL) OR
          (status = 'failed' AND output_sha256 IS NULL AND mime_type IS NULL AND byte_size IS NULL AND
            width IS NULL AND height IS NULL AND error_code IS NOT NULL)
        )
      );
      CREATE INDEX media_versions_asset_created_idx ON media_versions (library_id, asset_id, created_at DESC, version_id);
      CREATE INDEX media_versions_status_created_idx ON media_versions (status, created_at);
      CREATE TRIGGER media_versions_insert_guard BEFORE INSERT ON media_versions
      WHEN NEW.status <> 'staging' OR NOT EXISTS (
        SELECT 1 FROM assets a WHERE a.asset_id = NEW.asset_id AND a.library_id = NEW.library_id AND a.kind = 'photo'
      ) OR (NEW.source_version_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM asset_files f WHERE f.asset_id = NEW.asset_id AND f.media_role = 'original' AND f.sha256 = NEW.source_sha256
      )) OR (NEW.source_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM media_versions p WHERE p.version_id = NEW.source_version_id AND p.asset_id = NEW.asset_id
          AND p.library_id = NEW.library_id AND p.status = 'ready' AND p.output_sha256 = NEW.source_sha256
      ))
      BEGIN SELECT RAISE(ABORT, 'media version source is invalid'); END;
      CREATE TRIGGER media_versions_identity_guard BEFORE UPDATE ON media_versions
      WHEN NEW.version_id IS NOT OLD.version_id OR NEW.asset_id IS NOT OLD.asset_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.source_version_id IS NOT OLD.source_version_id OR NEW.source_sha256 IS NOT OLD.source_sha256 OR
        NEW.transform_json IS NOT OLD.transform_json OR NEW.idempotency_scope IS NOT OLD.idempotency_scope OR
        NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR
        NEW.storage_ref IS NOT OLD.storage_ref OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'media version identity is immutable'); END;
      CREATE TRIGGER media_versions_status_guard BEFORE UPDATE OF status ON media_versions
      WHEN OLD.status <> NEW.status AND NOT (OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
      BEGIN SELECT RAISE(ABORT, 'invalid media version status transition'); END;
      CREATE TRIGGER media_versions_terminal_guard BEFORE UPDATE ON media_versions
      WHEN OLD.status IN ('ready', 'failed') AND (
        NEW.status IS NOT OLD.status OR NEW.output_sha256 IS NOT OLD.output_sha256 OR NEW.mime_type IS NOT OLD.mime_type OR
        NEW.byte_size IS NOT OLD.byte_size OR NEW.width IS NOT OLD.width OR NEW.height IS NOT OLD.height OR
        NEW.error_code IS NOT OLD.error_code OR NEW.updated_at IS NOT OLD.updated_at
      )
      BEGIN SELECT RAISE(ABORT, 'terminal media version is immutable'); END;
      CREATE TRIGGER media_versions_no_delete BEFORE DELETE ON media_versions
      BEGIN SELECT RAISE(ABORT, 'media version deletion is disabled'); END;
    `
  },
  {
    id: '0005_asset_tags',
    sql: `
      CREATE TABLE asset_tags (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (length(CAST(tag AS BLOB)) BETWEEN 1 AND 128 AND tag = trim(tag)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (library_id, asset_id, tag)
      );
      CREATE INDEX asset_tags_library_tag_idx ON asset_tags (library_id, tag, asset_id);
      CREATE TRIGGER asset_tags_insert_guard BEFORE INSERT ON asset_tags
      WHEN NOT (
        EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id
              AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
        ) OR EXISTS (
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
        )
      )
      BEGIN SELECT RAISE(ABORT, 'asset tag target is not visible'); END;
      CREATE TRIGGER asset_tags_no_update BEFORE UPDATE ON asset_tags
      BEGIN SELECT RAISE(ABORT, 'asset tags are immutable; use delete and insert'); END;
    `
  },
  {
    id: '0006_asset_tag_sync',
    sql: `
      CREATE TABLE library_tag_write_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (peer_id, library_id)
      );
      CREATE INDEX library_tag_write_grants_library_idx ON library_tag_write_grants (library_id, peer_id, revoked_at);

      CREATE TABLE tag_sync_author_registry (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (library_id, author_peer_id)
      );

      CREATE TABLE tag_sync_event_log (
        event_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        event_type TEXT NOT NULL CHECK (event_type IN ('asset.tag.added', 'asset.tag.removed')),
        causal_parents_json TEXT NOT NULL CHECK (json_valid(causal_parents_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        signature TEXT,
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('signing', 'ready')),
        CHECK ((state = 'signing' AND signature IS NULL) OR (state = 'ready' AND signature IS NOT NULL)),
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX tag_sync_event_log_library_idx ON tag_sync_event_log (library_id, author_peer_id, author_sequence);
      CREATE TRIGGER tag_sync_event_log_identity_guard BEFORE UPDATE ON tag_sync_event_log
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.author_peer_id IS NOT OLD.author_peer_id OR NEW.author_sequence IS NOT OLD.author_sequence OR
        NEW.protocol_version IS NOT OLD.protocol_version OR NEW.schema_version IS NOT OLD.schema_version OR
        NEW.event_type IS NOT OLD.event_type OR NEW.causal_parents_json IS NOT OLD.causal_parents_json OR
        NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at OR
        OLD.state <> 'signing' OR NEW.state <> 'ready'
      BEGIN SELECT RAISE(ABORT, 'tag sync event identity is immutable'); END;
      CREATE TRIGGER tag_sync_event_log_no_delete BEFORE DELETE ON tag_sync_event_log
      BEGIN SELECT RAISE(ABORT, 'tag sync event deletion is disabled'); END;

      CREATE TABLE tag_sync_author_heads (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        event_id TEXT NOT NULL REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0, 1)),
        PRIMARY KEY (library_id, author_peer_id)
      );

      CREATE TABLE tag_sync_outbox (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (peer_id, event_id)
      );
      CREATE INDEX tag_sync_outbox_due_idx ON tag_sync_outbox (peer_id, next_attempt_at, event_id);

      CREATE TABLE tag_sync_inbox (
        event_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'unsupported', 'conflict')),
        error_code TEXT,
        received_at TEXT NOT NULL,
        applied_at TEXT,
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX tag_sync_inbox_pending_idx ON tag_sync_inbox (library_id, state, author_peer_id, author_sequence);

      CREATE TABLE tag_sync_peer_cursors (
        library_id TEXT NOT NULL,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        author_peer_id TEXT NOT NULL,
        contiguous_sequence INTEGER NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0),
        event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (library_id, peer_id, author_peer_id)
      );

      CREATE TABLE asset_tag_adds (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (length(CAST(tag AS BLOB)) BETWEEN 1 AND 128 AND tag = trim(tag)),
        add_event_id TEXT NOT NULL REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        PRIMARY KEY (library_id, asset_id, tag, add_event_id)
      );
      CREATE INDEX asset_tag_adds_asset_idx ON asset_tag_adds (library_id, asset_id, tag, add_event_id);

      CREATE TABLE asset_tag_remove_observations (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (length(CAST(tag AS BLOB)) BETWEEN 1 AND 128 AND tag = trim(tag)),
        add_event_id TEXT NOT NULL REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        remove_event_id TEXT NOT NULL REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        PRIMARY KEY (library_id, asset_id, tag, add_event_id, remove_event_id)
      );
      CREATE INDEX asset_tag_remove_add_idx ON asset_tag_remove_observations (library_id, asset_id, tag, add_event_id);
      CREATE TRIGGER asset_tag_add_event_guard BEFORE INSERT ON asset_tag_adds
      WHEN NOT EXISTS (
        SELECT 1 FROM tag_sync_event_log e
        JOIN json_each(e.causal_parents_json) parent ON EXISTS (
          SELECT 1 FROM sync_event_log metadata WHERE metadata.event_id = parent.value AND metadata.library_id = e.library_id
            AND metadata.state = 'ready' AND metadata.event_type IN ('asset.indexed', 'asset.metadata.updated', 'asset.tombstoned', 'asset.restored')
            AND json_extract(metadata.payload_json, '$.assetId') = NEW.asset_id
            AND (NOT EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = metadata.event_id)
              OR EXISTS (SELECT 1 FROM sync_inbox i WHERE i.event_id = metadata.event_id AND i.state = 'applied'))
        )
        WHERE e.event_id = NEW.add_event_id AND e.library_id = NEW.library_id AND e.event_type = 'asset.tag.added'
          AND json_extract(e.payload_json, '$.assetId') = NEW.asset_id AND json_extract(e.payload_json, '$.tag') = NEW.tag
      )
      BEGIN SELECT RAISE(ABORT, 'asset_tag_add_event_mismatch'); END;
      CREATE TRIGGER asset_tag_remove_observation_guard BEFORE INSERT ON asset_tag_remove_observations
      WHEN NOT EXISTS (
        SELECT 1 FROM tag_sync_event_log r
        JOIN asset_tag_adds a ON a.add_event_id = NEW.add_event_id
          AND a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id AND a.tag = NEW.tag
        JOIN json_each(r.payload_json, '$.observedAddEventIds') observed ON observed.value = NEW.add_event_id
        JOIN json_each(r.causal_parents_json) parent ON parent.value = NEW.add_event_id
        WHERE r.event_id = NEW.remove_event_id AND r.library_id = NEW.library_id AND r.event_type = 'asset.tag.removed'
          AND json_extract(r.payload_json, '$.assetId') = NEW.asset_id AND json_extract(r.payload_json, '$.tag') = NEW.tag
      )
      BEGIN SELECT RAISE(ABORT, 'asset_tag_remove_event_mismatch'); END;
      CREATE TRIGGER asset_tag_adds_no_update BEFORE UPDATE ON asset_tag_adds
      BEGIN SELECT RAISE(ABORT, 'asset tag add operations are immutable'); END;
      CREATE TRIGGER asset_tag_adds_no_delete BEFORE DELETE ON asset_tag_adds
      BEGIN SELECT RAISE(ABORT, 'asset tag add operations are retained'); END;
      CREATE TRIGGER asset_tag_remove_observations_no_update BEFORE UPDATE ON asset_tag_remove_observations
      BEGIN SELECT RAISE(ABORT, 'asset tag remove operations are immutable'); END;
      CREATE TRIGGER asset_tag_remove_observations_no_delete BEFORE DELETE ON asset_tag_remove_observations
      BEGIN SELECT RAISE(ABORT, 'asset tag remove operations are retained'); END;

      CREATE TABLE asset_tag_legacy_seeds (
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (length(CAST(tag AS BLOB)) BETWEEN 1 AND 128 AND tag = trim(tag)),
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'complete')),
        seed_event_id TEXT REFERENCES tag_sync_event_log(event_id) ON DELETE RESTRICT,
        PRIMARY KEY (library_id, asset_id, tag),
        CHECK ((state = 'pending' AND seed_event_id IS NULL) OR (state IN ('queued', 'complete') AND seed_event_id IS NOT NULL))
      );
      INSERT INTO asset_tag_legacy_seeds (library_id, asset_id, tag, created_at, state, seed_event_id)
        SELECT library_id, asset_id, tag, created_at, 'pending', NULL FROM asset_tags;
    `
  },
  {
    id: '0007_virtual_albums',
    sql: `
      CREATE TABLE albums (
        album_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (
          length(CAST(title AS BLOB)) BETWEEN 1 AND 256 AND
          title = trim(title, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) ||
            char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) ||
            char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
        ),
        created_by_peer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (library_id, album_id)
      );
      CREATE INDEX albums_library_order_idx ON albums (library_id, album_id COLLATE BINARY);
      CREATE TRIGGER albums_library_guard BEFORE INSERT ON albums
      WHEN NOT EXISTS (SELECT 1 FROM assets WHERE library_id = NEW.library_id
        UNION ALL SELECT 1 FROM sync_asset_projection WHERE library_id = NEW.library_id)
      BEGIN SELECT RAISE(ABORT, 'album_library_not_found'); END;
      CREATE TRIGGER albums_no_update BEFORE UPDATE ON albums
      BEGIN SELECT RAISE(ABORT, 'albums are immutable'); END;
      CREATE TRIGGER albums_no_delete BEFORE DELETE ON albums
      BEGIN SELECT RAISE(ABORT, 'albums are retained'); END;

      CREATE TABLE album_operations (
        operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
        principal_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        asset_id TEXT,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('album.created', 'member.added', 'member.add.noop', 'member.removed', 'member.remove.noop')),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT,
        UNIQUE (operation_id, library_id, album_id, asset_id, operation_type, author_peer_id),
        CHECK ((operation_type = 'album.created' AND asset_id IS NULL) OR
          (operation_type <> 'album.created' AND asset_id IS NOT NULL))
      );
      CREATE INDEX album_operations_author_idx ON album_operations (library_id, author_peer_id, operation_type);
      CREATE INDEX album_operations_resource_idx ON album_operations (library_id, album_id, asset_id, created_at, operation_id);
      CREATE TRIGGER album_operations_author_limit BEFORE INSERT ON album_operations
      WHEN NOT EXISTS (SELECT 1 FROM album_operations WHERE library_id = NEW.library_id AND author_peer_id = NEW.author_peer_id)
        AND (SELECT count(DISTINCT author_peer_id) FROM album_operations WHERE library_id = NEW.library_id) >= 64
      BEGIN SELECT RAISE(ABORT, 'album_author_limit'); END;
      CREATE TRIGGER album_operations_scope_guard BEFORE INSERT ON album_operations
      WHEN NOT EXISTS (SELECT 1 FROM albums a WHERE a.library_id = NEW.library_id AND a.album_id = NEW.album_id
        AND ((NEW.operation_type = 'album.created' AND a.created_by_peer_id = NEW.author_peer_id) OR NEW.operation_type <> 'album.created'))
        OR (NEW.operation_type <> 'album.created' AND NOT EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
          UNION ALL
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
        ))
      BEGIN SELECT RAISE(ABORT, 'album_operation_scope_mismatch'); END;
      CREATE TRIGGER album_operations_no_update BEFORE UPDATE ON album_operations
      BEGIN SELECT RAISE(ABORT, 'album operations are immutable'); END;
      CREATE TRIGGER album_operations_no_delete BEFORE DELETE ON album_operations
      BEGIN SELECT RAISE(ABORT, 'album operations are retained'); END;

      CREATE TABLE album_memberships (
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        add_operation_id TEXT NOT NULL UNIQUE REFERENCES album_operations(operation_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (library_id, album_id, asset_id, author_peer_id),
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE INDEX album_memberships_page_idx ON album_memberships (library_id, album_id, asset_id COLLATE BINARY, author_peer_id);
      CREATE TRIGGER album_memberships_add_guard BEFORE INSERT ON album_memberships
      WHEN NOT EXISTS (SELECT 1 FROM album_operations o WHERE o.operation_id = NEW.add_operation_id
        AND o.operation_type = 'member.added' AND o.library_id = NEW.library_id AND o.album_id = NEW.album_id
        AND o.asset_id = NEW.asset_id AND o.author_peer_id = NEW.author_peer_id)
        OR NOT EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
          UNION ALL
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
        )
      BEGIN SELECT RAISE(ABORT, 'album_membership_scope_mismatch'); END;
      CREATE TRIGGER album_memberships_no_update BEFORE UPDATE ON album_memberships
      BEGIN SELECT RAISE(ABORT, 'album membership projections are immutable'); END;

      CREATE TABLE album_membership_remove_targets (
        remove_operation_id TEXT NOT NULL REFERENCES album_operations(operation_id) ON DELETE RESTRICT,
        observed_add_operation_id TEXT NOT NULL REFERENCES album_operations(operation_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (remove_operation_id, observed_add_operation_id)
      );
      CREATE INDEX album_membership_remove_add_idx ON album_membership_remove_targets (observed_add_operation_id);
      CREATE TRIGGER album_membership_remove_target_guard BEFORE INSERT ON album_membership_remove_targets
      WHEN NOT EXISTS (
        SELECT 1 FROM album_operations r JOIN album_operations a
          ON a.operation_id = NEW.observed_add_operation_id AND a.operation_type = 'member.added'
          AND a.library_id = NEW.library_id AND a.album_id = NEW.album_id AND a.asset_id = NEW.asset_id
        WHERE r.operation_id = NEW.remove_operation_id AND r.operation_type = 'member.removed'
          AND r.library_id = NEW.library_id AND r.album_id = NEW.album_id AND r.asset_id = NEW.asset_id
      )
      BEGIN SELECT RAISE(ABORT, 'album_remove_target_mismatch'); END;
      CREATE TRIGGER album_membership_remove_targets_no_update BEFORE UPDATE ON album_membership_remove_targets
      BEGIN SELECT RAISE(ABORT, 'album remove targets are immutable'); END;
      CREATE TRIGGER album_membership_remove_targets_no_delete BEFORE DELETE ON album_membership_remove_targets
      BEGIN SELECT RAISE(ABORT, 'album remove targets are retained'); END;
      CREATE TRIGGER album_memberships_delete_guard BEFORE DELETE ON album_memberships
      WHEN NOT EXISTS (SELECT 1 FROM album_membership_remove_targets t
        JOIN album_operations r ON r.operation_id = t.remove_operation_id AND r.operation_type = 'member.removed'
        WHERE t.observed_add_operation_id = OLD.add_operation_id AND t.library_id = OLD.library_id
          AND t.album_id = OLD.album_id AND t.asset_id = OLD.asset_id)
      BEGIN SELECT RAISE(ABORT, 'album membership remove target required'); END;
    `
  },
  {
    id: '0008_virtual_album_sync',
    sql: `
      CREATE TABLE sync_global_id_registry (
        global_id TEXT PRIMARY KEY CHECK (length(global_id) = 36),
        event_stream TEXT CHECK (event_stream IN ('asset-metadata-v1', 'asset-tags-v1', 'virtual-albums-v1')),
        operation_kind TEXT CHECK (operation_kind IN ('album-operation', 'album-lifecycle', 'album-visibility')),
        CHECK (event_stream IS NOT NULL OR operation_kind IS NOT NULL),
        CHECK (event_stream IS NULL OR operation_kind IS NULL OR
          (event_stream = 'virtual-albums-v1' AND operation_kind IN ('album-operation', 'album-lifecycle')))
      );

      INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
      SELECT event_id, 'asset-metadata-v1', NULL FROM sync_event_log
      UNION SELECT event_id, 'asset-metadata-v1', NULL FROM sync_inbox
      UNION SELECT event_id, 'asset-tags-v1', NULL FROM tag_sync_event_log
      UNION SELECT event_id, 'asset-tags-v1', NULL FROM tag_sync_inbox;
      INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
      SELECT operation_id,
        CASE WHEN operation_type IN ('album.created', 'member.added', 'member.removed') THEN 'virtual-albums-v1' ELSE NULL END,
        'album-operation'
      FROM album_operations;

       DROP TRIGGER albums_library_guard;
       CREATE TRIGGER albums_library_guard BEFORE INSERT ON albums
       WHEN NOT EXISTS (SELECT 1 FROM assets WHERE library_id = NEW.library_id
         UNION ALL SELECT 1 FROM sync_asset_projection WHERE library_id = NEW.library_id
         UNION ALL SELECT 1 FROM sync_remote_library_grants g JOIN trusted_peers p ON p.peer_id = g.peer_id
           WHERE g.library_id = NEW.library_id AND p.trust_state = 'trusted'
         UNION ALL SELECT 1 FROM album_sync_inbox i WHERE i.library_id = NEW.library_id AND i.author_peer_id = NEW.created_by_peer_id
           AND i.state = 'applying' AND json_extract(i.envelope_json, '$.eventType') = 'album.created')
       BEGIN SELECT RAISE(ABORT, 'album_library_not_found'); END;

      CREATE TRIGGER sync_global_id_registry_no_delete BEFORE DELETE ON sync_global_id_registry
      BEGIN SELECT RAISE(ABORT, 'global event ID registry is retained'); END;
      CREATE TRIGGER sync_global_id_registry_update_guard BEFORE UPDATE ON sync_global_id_registry
      WHEN (OLD.event_stream IS NOT NULL AND NEW.event_stream IS NOT OLD.event_stream) OR
        (OLD.operation_kind IS NOT NULL AND NEW.operation_kind IS NOT OLD.operation_kind) OR
        (NEW.event_stream IS NOT NULL AND NEW.operation_kind IS NOT NULL AND
          NOT (NEW.event_stream = 'virtual-albums-v1' AND NEW.operation_kind IN ('album-operation', 'album-lifecycle')))
      BEGIN SELECT RAISE(ABORT, 'global event ID registry identity is immutable'); END;

      CREATE TABLE library_album_write_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (peer_id, library_id)
      );
      CREATE INDEX library_album_write_grants_library_idx ON library_album_write_grants (library_id, peer_id, revoked_at);
      CREATE TABLE library_album_delete_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (peer_id, library_id)
      );
      CREATE INDEX library_album_delete_grants_library_idx ON library_album_delete_grants (library_id, peer_id, revoked_at);

      CREATE TABLE album_sync_author_registry (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (library_id, author_peer_id)
      );
      INSERT INTO album_sync_author_registry (library_id, author_peer_id, first_seen_at)
      SELECT library_id, author_peer_id, MIN(created_at) FROM album_operations GROUP BY library_id, author_peer_id;

      CREATE TABLE album_sync_event_log (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        event_type TEXT NOT NULL CHECK (event_type IN ('album.created', 'album.member.added', 'album.member.removed', 'album.deleted', 'album.restored')),
        causal_parents_json TEXT NOT NULL CHECK (json_valid(causal_parents_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        signature TEXT,
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('signing', 'ready')),
        CHECK ((state = 'signing' AND signature IS NULL) OR (state = 'ready' AND signature IS NOT NULL)),
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX album_sync_event_log_library_idx ON album_sync_event_log (library_id, author_peer_id, author_sequence);
      CREATE TRIGGER album_sync_event_global_id_guard BEFORE INSERT ON album_sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind = 'album-visibility' OR
         (r.operation_kind = 'album-operation' AND NOT EXISTS (SELECT 1 FROM album_operations o
           WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.created', 'member.added', 'member.removed'))) OR
         (r.operation_kind = 'album-lifecycle' AND NOT EXISTS (SELECT 1 FROM album_lifecycle_operations o
           WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.deleted', 'album.restored')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_sync_event_global_id_register AFTER INSERT ON album_sync_event_log
      BEGIN
        INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'virtual-albums-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'virtual-albums-v1'
        WHERE sync_global_id_registry.event_stream IS NULL;
      END;
      CREATE TRIGGER album_sync_event_identity_guard BEFORE UPDATE ON album_sync_event_log
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.author_peer_id IS NOT OLD.author_peer_id OR NEW.author_sequence IS NOT OLD.author_sequence OR
        NEW.protocol_version IS NOT OLD.protocol_version OR NEW.schema_version IS NOT OLD.schema_version OR
        NEW.event_type IS NOT OLD.event_type OR NEW.causal_parents_json IS NOT OLD.causal_parents_json OR
        NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at OR
        OLD.state <> 'signing' OR NEW.state <> 'ready'
      BEGIN SELECT RAISE(ABORT, 'album sync event identity is immutable'); END;
      CREATE TRIGGER album_sync_event_no_delete BEFORE DELETE ON album_sync_event_log
      BEGIN SELECT RAISE(ABORT, 'album sync event deletion is disabled'); END;

      CREATE TABLE album_sync_inbox (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'unsupported', 'conflict')),
        error_code TEXT,
        received_at TEXT NOT NULL,
        applied_at TEXT,
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX album_sync_inbox_pending_idx ON album_sync_inbox (library_id, state, author_peer_id, author_sequence);
       CREATE TABLE album_sync_conflicts (
         conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
         relay_peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
         event_id TEXT NOT NULL,
         library_id TEXT NOT NULL,
         author_peer_id TEXT NOT NULL,
         author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
         envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
         error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 64),
         received_at TEXT NOT NULL,
         UNIQUE (library_id, author_peer_id)
       );
       CREATE INDEX album_sync_conflicts_author_idx ON album_sync_conflicts (library_id, author_peer_id, author_sequence);
       CREATE TRIGGER album_sync_conflicts_no_update BEFORE UPDATE ON album_sync_conflicts
       BEGIN SELECT RAISE(ABORT, 'album sync conflicts are immutable'); END;
       CREATE TRIGGER album_sync_conflicts_no_delete BEFORE DELETE ON album_sync_conflicts
       BEGIN SELECT RAISE(ABORT, 'album sync conflicts cannot be deleted'); END;
      CREATE TRIGGER album_sync_inbox_global_id_guard BEFORE INSERT ON album_sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind = 'album-visibility' OR
         (r.operation_kind = 'album-operation' AND NOT EXISTS (SELECT 1 FROM album_operations o
           WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.created', 'member.added', 'member.removed'))) OR
         (r.operation_kind = 'album-lifecycle' AND NOT EXISTS (SELECT 1 FROM album_lifecycle_operations o
           WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.deleted', 'album.restored')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_sync_inbox_global_id_register AFTER INSERT ON album_sync_inbox
      BEGIN
        INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'virtual-albums-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'virtual-albums-v1'
        WHERE sync_global_id_registry.event_stream IS NULL;
      END;
      CREATE TRIGGER album_sync_inbox_identity_guard BEFORE UPDATE ON album_sync_inbox
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_id IS NOT OLD.peer_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.author_peer_id IS NOT OLD.author_peer_id OR NEW.author_sequence IS NOT OLD.author_sequence OR NEW.envelope_json IS NOT OLD.envelope_json
      BEGIN SELECT RAISE(ABORT, 'album sync inbox identity is immutable'); END;

      CREATE TABLE album_sync_outbox (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES album_sync_event_log(event_id) ON DELETE RESTRICT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (peer_id, event_id)
      );
      CREATE INDEX album_sync_outbox_due_idx ON album_sync_outbox (peer_id, next_attempt_at, event_id);
      CREATE TABLE album_sync_author_heads (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        event_id TEXT NOT NULL REFERENCES album_sync_event_log(event_id) ON DELETE RESTRICT,
        ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0, 1)),
        PRIMARY KEY (library_id, author_peer_id)
      );
      CREATE TABLE album_sync_peer_cursors (
        library_id TEXT NOT NULL,
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        author_peer_id TEXT NOT NULL,
        contiguous_sequence INTEGER NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0),
        event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (library_id, peer_id, author_peer_id)
      );

      CREATE TABLE album_lifecycle_operations (
        operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
        principal_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('album.deleted', 'album.delete.noop', 'album.restored', 'album.restore.noop')),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        observed_delete_event_ids_json TEXT NOT NULL CHECK (json_valid(observed_delete_event_ids_json)),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE INDEX album_lifecycle_author_idx ON album_lifecycle_operations (library_id, author_peer_id, operation_type);
      CREATE TABLE album_visibility_operations (
        operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
        principal_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('local.hidden', 'local.hide.noop', 'local.restored', 'local.restore.noop')),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE INDEX album_visibility_operation_scope_idx ON album_visibility_operations (library_id, album_id, created_at);
      CREATE TABLE album_local_visibility (
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        operation_id TEXT NOT NULL REFERENCES album_visibility_operations(operation_id) ON DELETE RESTRICT,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (library_id, album_id),
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE TABLE album_global_delete_tokens (
        delete_event_id TEXT PRIMARY KEY REFERENCES album_lifecycle_operations(operation_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE INDEX album_global_delete_tokens_active_idx ON album_global_delete_tokens (library_id, album_id, delete_event_id);
      CREATE TABLE album_global_restore_targets (
        restore_operation_id TEXT NOT NULL REFERENCES album_lifecycle_operations(operation_id) ON DELETE RESTRICT,
        observed_delete_event_id TEXT NOT NULL REFERENCES album_global_delete_tokens(delete_event_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        PRIMARY KEY (restore_operation_id, observed_delete_event_id),
        FOREIGN KEY (library_id, album_id) REFERENCES albums(library_id, album_id) ON DELETE RESTRICT
      );
      CREATE INDEX album_global_restore_targets_delete_idx ON album_global_restore_targets (observed_delete_event_id);
      CREATE TRIGGER album_global_restore_target_guard BEFORE INSERT ON album_global_restore_targets
      WHEN NOT EXISTS (SELECT 1 FROM album_lifecycle_operations r JOIN album_global_delete_tokens d
        ON d.delete_event_id = NEW.observed_delete_event_id AND d.library_id = NEW.library_id AND d.album_id = NEW.album_id
        WHERE r.operation_id = NEW.restore_operation_id AND r.operation_type = 'album.restored'
          AND r.library_id = NEW.library_id AND r.album_id = NEW.album_id)
      BEGIN SELECT RAISE(ABORT, 'album restore target mismatch'); END;

      CREATE TRIGGER sync_event_global_id_guard BEFORE INSERT ON sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER sync_event_global_id_register AFTER INSERT ON sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.event_id, 'asset-metadata-v1', NULL); END;
      CREATE TRIGGER sync_inbox_global_id_guard BEFORE INSERT ON sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER sync_inbox_global_id_register AFTER INSERT ON sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.event_id, 'asset-metadata-v1', NULL); END;
      CREATE TRIGGER tag_sync_event_global_id_guard BEFORE INSERT ON tag_sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER tag_sync_event_global_id_register AFTER INSERT ON tag_sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.event_id, 'asset-tags-v1', NULL); END;
      CREATE TRIGGER tag_sync_inbox_global_id_guard BEFORE INSERT ON tag_sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER tag_sync_inbox_global_id_register AFTER INSERT ON tag_sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.event_id, 'asset-tags-v1', NULL); END;

      DROP TRIGGER album_operations_author_limit;
      CREATE TRIGGER album_operations_global_id_guard BEFORE INSERT ON album_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream = 'virtual-albums-v1' AND NOT EXISTS (SELECT 1 FROM album_sync_inbox i
           WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND i.library_id = NEW.library_id AND
             i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id AND
             (NEW.operation_type <> 'member.added' OR json_extract(i.envelope_json, '$.eventType') = 'album.member.added') AND
             (NEW.operation_type <> 'member.removed' OR json_extract(i.envelope_json, '$.eventType') = 'album.member.removed') AND
             (NEW.operation_type <> 'album.created' OR json_extract(i.envelope_json, '$.eventType') = 'album.created')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_operations_global_id_register AFTER INSERT ON album_operations
      BEGIN
        INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id,
          CASE WHEN NEW.operation_type IN ('album.created', 'member.added', 'member.removed') THEN 'virtual-albums-v1' ELSE NULL END,
          'album-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind = 'album-operation',
          event_stream = COALESCE(sync_global_id_registry.event_stream, excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND
          (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream = 'virtual-albums-v1');
      END;
      CREATE TRIGGER album_lifecycle_global_id_guard BEFORE INSERT ON album_lifecycle_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream = 'virtual-albums-v1' AND NOT EXISTS (SELECT 1 FROM album_sync_inbox i
           WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND i.library_id = NEW.library_id AND
             i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id AND
             json_extract(i.envelope_json, '$.eventType') = NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_lifecycle_global_id_register AFTER INSERT ON album_lifecycle_operations
      BEGIN
        INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id,
          CASE WHEN NEW.operation_type IN ('album.deleted', 'album.restored') THEN 'virtual-albums-v1' ELSE NULL END,
          'album-lifecycle')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind = 'album-lifecycle',
          event_stream = COALESCE(sync_global_id_registry.event_stream, excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND
          (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream = 'virtual-albums-v1');
      END;
      CREATE TRIGGER album_visibility_global_id_guard BEFORE INSERT ON album_visibility_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry WHERE global_id = NEW.operation_id)
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_visibility_global_id_register AFTER INSERT ON album_visibility_operations
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id, NULL, 'album-visibility'); END;

      CREATE TRIGGER album_operations_author_limit_pm045 BEFORE INSERT ON album_operations
      WHEN NOT EXISTS (SELECT 1 FROM album_sync_author_registry WHERE library_id = NEW.library_id AND author_peer_id = NEW.author_peer_id)
        AND (SELECT count(*) FROM album_sync_author_registry WHERE library_id = NEW.library_id) >= 64
      BEGIN SELECT RAISE(ABORT, 'album_author_limit'); END;
      CREATE TRIGGER album_operations_author_register AFTER INSERT ON album_operations
      BEGIN INSERT OR IGNORE INTO album_sync_author_registry (library_id, author_peer_id, first_seen_at)
        VALUES (NEW.library_id, NEW.author_peer_id, NEW.created_at); END;
      CREATE TRIGGER album_lifecycle_author_limit BEFORE INSERT ON album_lifecycle_operations
      WHEN NOT EXISTS (SELECT 1 FROM album_sync_author_registry WHERE library_id = NEW.library_id AND author_peer_id = NEW.author_peer_id)
        AND (SELECT count(*) FROM album_sync_author_registry WHERE library_id = NEW.library_id) >= 64
      BEGIN SELECT RAISE(ABORT, 'album_author_limit'); END;
      CREATE TRIGGER album_lifecycle_author_register AFTER INSERT ON album_lifecycle_operations
      BEGIN INSERT OR IGNORE INTO album_sync_author_registry (library_id, author_peer_id, first_seen_at)
        VALUES (NEW.library_id, NEW.author_peer_id, NEW.created_at); END;
      CREATE TRIGGER album_operations_no_update_pm045 BEFORE UPDATE ON album_operations
      BEGIN SELECT RAISE(ABORT, 'album operations are immutable'); END;
      CREATE TRIGGER album_operations_no_delete_pm045 BEFORE DELETE ON album_operations
      BEGIN SELECT RAISE(ABORT, 'album operations are retained'); END;
      CREATE TRIGGER album_lifecycle_no_update BEFORE UPDATE ON album_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'album lifecycle operations are immutable'); END;
      CREATE TRIGGER album_lifecycle_no_delete BEFORE DELETE ON album_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'album lifecycle operations are retained'); END;
      CREATE TRIGGER album_visibility_no_update BEFORE UPDATE ON album_visibility_operations
      BEGIN SELECT RAISE(ABORT, 'album visibility operations are immutable'); END;
      CREATE TRIGGER album_visibility_no_delete BEFORE DELETE ON album_visibility_operations
      BEGIN SELECT RAISE(ABORT, 'album visibility operations are retained'); END;

      DROP TRIGGER album_operations_scope_guard;
      CREATE TRIGGER album_operations_scope_guard BEFORE INSERT ON album_operations
      WHEN NOT EXISTS (SELECT 1 FROM albums a WHERE a.library_id = NEW.library_id AND a.album_id = NEW.album_id
        AND ((NEW.operation_type = 'album.created' AND a.created_by_peer_id = NEW.author_peer_id) OR NEW.operation_type <> 'album.created'))
        OR (NEW.operation_type <> 'album.created' AND NOT EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
          UNION ALL
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND a.asset_id = p.asset_id)
          UNION ALL
          SELECT 1 FROM album_sync_inbox i WHERE i.event_id = NEW.operation_id AND i.state = 'applying'
            AND i.library_id = NEW.library_id AND i.author_peer_id = NEW.author_peer_id
            AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id
            AND json_extract(i.envelope_json, '$.payload.assetId') = NEW.asset_id
            AND ((NEW.operation_type = 'member.added' AND json_extract(i.envelope_json, '$.eventType') = 'album.member.added') OR
                 (NEW.operation_type = 'member.removed' AND json_extract(i.envelope_json, '$.eventType') = 'album.member.removed'))
        ))
      BEGIN SELECT RAISE(ABORT, 'album_operation_scope_mismatch'); END;
      DROP TRIGGER album_memberships_add_guard;
      CREATE TRIGGER album_memberships_add_guard BEFORE INSERT ON album_memberships
      WHEN NOT EXISTS (SELECT 1 FROM album_operations o WHERE o.operation_id = NEW.add_operation_id
        AND o.operation_type = 'member.added' AND o.library_id = NEW.library_id AND o.album_id = NEW.album_id
        AND o.asset_id = NEW.asset_id AND o.author_peer_id = NEW.author_peer_id)
        OR (NOT EXISTS (
          SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
            AND NOT EXISTS (SELECT 1 FROM sync_asset_projection p WHERE p.library_id = a.library_id AND p.asset_id = a.asset_id AND p.tombstone_event_id IS NOT NULL)
          UNION ALL
          SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id
            AND p.tombstone_event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.library_id = p.library_id AND p.asset_id = a.asset_id)
        ) AND NOT EXISTS (SELECT 1 FROM album_sync_inbox i WHERE i.event_id = NEW.add_operation_id AND i.state = 'applying'
          AND i.library_id = NEW.library_id AND i.author_peer_id = NEW.author_peer_id
          AND json_extract(i.envelope_json, '$.eventType') = 'album.member.added'
          AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id
          AND json_extract(i.envelope_json, '$.payload.assetId') = NEW.asset_id))
      BEGIN SELECT RAISE(ABORT, 'album_membership_scope_mismatch'); END;
    `
  },
  {
    id: '0009_asset_favorites',
    sql: `
      DROP TRIGGER sync_global_id_registry_no_delete;
      DROP TRIGGER sync_global_id_registry_update_guard;
      DROP TRIGGER album_sync_event_global_id_guard;
      DROP TRIGGER album_sync_event_global_id_register;
      DROP TRIGGER album_sync_inbox_global_id_guard;
      DROP TRIGGER album_sync_inbox_global_id_register;
      DROP TRIGGER sync_event_global_id_guard;
      DROP TRIGGER sync_event_global_id_register;
      DROP TRIGGER sync_inbox_global_id_guard;
      DROP TRIGGER sync_inbox_global_id_register;
      DROP TRIGGER tag_sync_event_global_id_guard;
      DROP TRIGGER tag_sync_event_global_id_register;
      DROP TRIGGER tag_sync_inbox_global_id_guard;
      DROP TRIGGER tag_sync_inbox_global_id_register;
      DROP TRIGGER album_operations_global_id_guard;
      DROP TRIGGER album_operations_global_id_register;
      DROP TRIGGER album_lifecycle_global_id_guard;
      DROP TRIGGER album_lifecycle_global_id_register;
      DROP TRIGGER album_visibility_global_id_guard;
      DROP TRIGGER album_visibility_global_id_register;

      ALTER TABLE sync_global_id_registry RENAME TO sync_global_id_registry_0008;
      CREATE TABLE sync_global_id_registry (
        global_id TEXT PRIMARY KEY CHECK (length(global_id) = 36),
        event_stream TEXT CHECK (event_stream IN ('asset-metadata-v1', 'asset-tags-v1', 'virtual-albums-v1', 'asset-favorites-v1')),
        operation_kind TEXT CHECK (operation_kind IN ('album-operation', 'album-lifecycle', 'album-visibility', 'favorite-operation')),
        CHECK (event_stream IS NOT NULL OR operation_kind IS NOT NULL),
        CHECK (event_stream IS NULL OR operation_kind IS NULL OR
          (event_stream = 'virtual-albums-v1' AND operation_kind IN ('album-operation', 'album-lifecycle')) OR
          (event_stream = 'asset-favorites-v1' AND operation_kind = 'favorite-operation'))
      );
      INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        SELECT global_id, event_stream, operation_kind FROM sync_global_id_registry_0008;
      DROP TABLE sync_global_id_registry_0008;

      CREATE TABLE library_favorite_write_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (peer_id, library_id)
      );
      CREATE INDEX library_favorite_write_grants_library_idx ON library_favorite_write_grants (library_id, peer_id, revoked_at);
      CREATE TABLE favorite_sync_author_registry (
        library_id TEXT NOT NULL,
        author_peer_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (library_id, author_peer_id)
      );
      CREATE TABLE favorite_sync_event_log (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36), library_id TEXT NOT NULL, author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK (author_sequence > 0), protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        event_type TEXT NOT NULL CHECK (event_type IN ('asset.favorite.added', 'asset.favorite.removed')),
        causal_parents_json TEXT NOT NULL CHECK (json_valid(causal_parents_json)), payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL, signature TEXT, envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('signing', 'ready')),
        CHECK ((state = 'signing' AND signature IS NULL) OR (state = 'ready' AND signature IS NOT NULL)),
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX favorite_sync_event_log_library_idx ON favorite_sync_event_log (library_id, author_peer_id, author_sequence);
      CREATE TABLE favorite_sync_inbox (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36), peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL, author_peer_id TEXT NOT NULL, author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'unsupported', 'conflict')),
        error_code TEXT, received_at TEXT NOT NULL, applied_at TEXT,
        UNIQUE (library_id, author_peer_id, author_sequence)
      );
      CREATE INDEX favorite_sync_inbox_pending_idx ON favorite_sync_inbox (library_id, state, author_peer_id, author_sequence);
      CREATE TABLE favorite_sync_conflicts (
        conflict_id INTEGER PRIMARY KEY AUTOINCREMENT, relay_peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL, library_id TEXT NOT NULL, author_peer_id TEXT NOT NULL, author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)), error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 64),
        received_at TEXT NOT NULL, UNIQUE (library_id, author_peer_id)
      );
      CREATE INDEX favorite_sync_conflicts_author_idx ON favorite_sync_conflicts (library_id, author_peer_id, author_sequence);
      CREATE TABLE favorite_sync_outbox (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES favorite_sync_event_log(event_id) ON DELETE RESTRICT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at TEXT NOT NULL, last_error TEXT, accepted_at TEXT,
        PRIMARY KEY (peer_id, event_id)
      );
      CREATE INDEX favorite_sync_outbox_due_idx ON favorite_sync_outbox (peer_id, next_attempt_at, event_id);
      CREATE TABLE favorite_sync_author_heads (
        library_id TEXT NOT NULL, author_peer_id TEXT NOT NULL, author_sequence INTEGER NOT NULL CHECK (author_sequence > 0),
        event_id TEXT NOT NULL REFERENCES favorite_sync_event_log(event_id) ON DELETE RESTRICT,
        ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0, 1)), PRIMARY KEY (library_id, author_peer_id)
      );
      CREATE TABLE favorite_sync_peer_cursors (
        library_id TEXT NOT NULL, peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        author_peer_id TEXT NOT NULL, contiguous_sequence INTEGER NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0),
        event_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (library_id, peer_id, author_peer_id)
      );
      CREATE TABLE favorite_operations (
        operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36), principal_id TEXT NOT NULL, author_peer_id TEXT NOT NULL,
        library_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('asset.favorite.added', 'asset.favorite.removed', 'favorite.add.noop', 'favorite.remove.noop')),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)), created_at TEXT NOT NULL
      );
      CREATE INDEX favorite_operations_asset_idx ON favorite_operations (library_id, asset_id, operation_id);
      CREATE TABLE favorite_add_tokens (
        event_id TEXT PRIMARY KEY REFERENCES favorite_sync_event_log(event_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL, asset_id TEXT NOT NULL, author_peer_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX favorite_add_tokens_asset_idx ON favorite_add_tokens (library_id, asset_id, author_peer_id, event_id);
      CREATE TABLE favorite_remove_targets (
        remove_event_id TEXT NOT NULL REFERENCES favorite_sync_event_log(event_id) ON DELETE RESTRICT,
        observed_add_event_id TEXT NOT NULL REFERENCES favorite_add_tokens(event_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY (remove_event_id, observed_add_event_id)
      );
      CREATE INDEX favorite_remove_targets_add_idx ON favorite_remove_targets (observed_add_event_id);
      CREATE TABLE asset_favorites (library_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY (library_id, asset_id));

      CREATE TRIGGER sync_global_id_registry_no_delete BEFORE DELETE ON sync_global_id_registry
      BEGIN SELECT RAISE(ABORT, 'global event ID registry is retained'); END;
      CREATE TRIGGER sync_global_id_registry_update_guard BEFORE UPDATE ON sync_global_id_registry
      WHEN (OLD.event_stream IS NOT NULL AND NEW.event_stream IS NOT OLD.event_stream) OR
        (OLD.operation_kind IS NOT NULL AND NEW.operation_kind IS NOT OLD.operation_kind) OR
        (NEW.event_stream IS NOT NULL AND NEW.operation_kind IS NOT NULL AND NOT (
          (NEW.event_stream = 'virtual-albums-v1' AND NEW.operation_kind IN ('album-operation', 'album-lifecycle')) OR
          (NEW.event_stream = 'asset-favorites-v1' AND NEW.operation_kind = 'favorite-operation')))
      BEGIN SELECT RAISE(ABORT, 'global event ID registry identity is immutable'); END;

      CREATE TRIGGER sync_event_global_id_guard BEFORE INSERT ON sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER sync_event_global_id_register AFTER INSERT ON sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-metadata-v1', NULL); END;
      CREATE TRIGGER sync_inbox_global_id_guard BEFORE INSERT ON sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER sync_inbox_global_id_register AFTER INSERT ON sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-metadata-v1', NULL); END;
      CREATE TRIGGER tag_sync_event_global_id_guard BEFORE INSERT ON tag_sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER tag_sync_event_global_id_register AFTER INSERT ON tag_sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-tags-v1', NULL); END;
      CREATE TRIGGER tag_sync_inbox_global_id_guard BEFORE INSERT ON tag_sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER tag_sync_inbox_global_id_register AFTER INSERT ON tag_sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-tags-v1', NULL); END;
      CREATE TRIGGER album_sync_event_global_id_guard BEFORE INSERT ON album_sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind = 'album-visibility' OR
         (r.operation_kind = 'album-operation' AND NOT EXISTS (SELECT 1 FROM album_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.created', 'member.added', 'member.removed'))) OR
         (r.operation_kind = 'album-lifecycle' AND NOT EXISTS (SELECT 1 FROM album_lifecycle_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.deleted', 'album.restored')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_sync_event_global_id_register AFTER INSERT ON album_sync_event_log
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'virtual-albums-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'virtual-albums-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER album_sync_inbox_global_id_guard BEFORE INSERT ON album_sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind = 'album-visibility' OR
         (r.operation_kind = 'album-operation' AND NOT EXISTS (SELECT 1 FROM album_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.created', 'member.added', 'member.removed'))) OR
         (r.operation_kind = 'album-lifecycle' AND NOT EXISTS (SELECT 1 FROM album_lifecycle_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('album.deleted', 'album.restored')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_sync_inbox_global_id_register AFTER INSERT ON album_sync_inbox
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'virtual-albums-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'virtual-albums-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER album_operations_global_id_guard BEFORE INSERT ON album_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream = 'virtual-albums-v1' AND NOT EXISTS (SELECT 1 FROM album_sync_inbox i WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND
           i.library_id = NEW.library_id AND i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id AND
           (NEW.operation_type <> 'member.added' OR json_extract(i.envelope_json, '$.eventType') = 'album.member.added') AND
           (NEW.operation_type <> 'member.removed' OR json_extract(i.envelope_json, '$.eventType') = 'album.member.removed') AND
           (NEW.operation_type <> 'album.created' OR json_extract(i.envelope_json, '$.eventType') = 'album.created')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_operations_global_id_register AFTER INSERT ON album_operations
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id, CASE WHEN NEW.operation_type IN ('album.created', 'member.added', 'member.removed') THEN 'virtual-albums-v1' ELSE NULL END, 'album-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind = 'album-operation', event_stream = COALESCE(sync_global_id_registry.event_stream, excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream = 'virtual-albums-v1'); END;
      CREATE TRIGGER album_lifecycle_global_id_guard BEFORE INSERT ON album_lifecycle_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream = 'virtual-albums-v1' AND NOT EXISTS (SELECT 1 FROM album_sync_inbox i WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND
           i.library_id = NEW.library_id AND i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.payload.albumId') = NEW.album_id AND
           json_extract(i.envelope_json, '$.eventType') = NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_lifecycle_global_id_register AFTER INSERT ON album_lifecycle_operations
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id, CASE WHEN NEW.operation_type IN ('album.deleted', 'album.restored') THEN 'virtual-albums-v1' ELSE NULL END, 'album-lifecycle')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind = 'album-lifecycle', event_stream = COALESCE(sync_global_id_registry.event_stream, excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream = 'virtual-albums-v1'); END;
      CREATE TRIGGER album_visibility_global_id_guard BEFORE INSERT ON album_visibility_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry WHERE global_id = NEW.operation_id)
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER album_visibility_global_id_register AFTER INSERT ON album_visibility_operations
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.operation_id, NULL, 'album-visibility'); END;

      CREATE TRIGGER favorite_sync_event_global_id_guard BEFORE INSERT ON favorite_sync_event_log
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'asset-favorites-v1') OR
         (r.operation_kind IS NOT NULL AND r.operation_kind <> 'favorite-operation') OR
         (r.operation_kind = 'favorite-operation' AND NOT EXISTS (SELECT 1 FROM favorite_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('asset.favorite.added', 'asset.favorite.removed')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER favorite_sync_event_global_id_register AFTER INSERT ON favorite_sync_event_log
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-favorites-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'asset-favorites-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER favorite_sync_inbox_global_id_guard BEFORE INSERT ON favorite_sync_inbox
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'asset-favorites-v1') OR
         (r.operation_kind IS NOT NULL AND r.operation_kind <> 'favorite-operation') OR
         (r.operation_kind = 'favorite-operation' AND NOT EXISTS (SELECT 1 FROM favorite_operations o WHERE o.operation_id = NEW.event_id AND o.operation_type IN ('asset.favorite.added', 'asset.favorite.removed')))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER favorite_sync_inbox_global_id_register AFTER INSERT ON favorite_sync_inbox
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind) VALUES (NEW.event_id, 'asset-favorites-v1', NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream = 'asset-favorites-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER favorite_operations_global_id_guard BEFORE INSERT ON favorite_operations
      WHEN EXISTS (SELECT 1 FROM sync_global_id_registry r WHERE r.global_id = NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream <> 'asset-favorites-v1') OR
         (r.operation_kind IS NOT NULL AND r.operation_kind <> 'favorite-operation') OR
         (r.event_stream = 'asset-favorites-v1' AND NOT EXISTS (
           SELECT 1 FROM favorite_sync_event_log e WHERE e.event_id = NEW.operation_id AND e.library_id = NEW.library_id AND e.author_peer_id = NEW.author_peer_id AND e.event_type = NEW.operation_type
           UNION ALL SELECT 1 FROM favorite_sync_inbox i WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND i.library_id = NEW.library_id AND
             i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.eventType') = NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT, 'global event ID collision'); END;
      CREATE TRIGGER favorite_operations_global_id_register AFTER INSERT ON favorite_operations
      BEGIN INSERT INTO sync_global_id_registry (global_id, event_stream, operation_kind)
        VALUES (NEW.operation_id, CASE WHEN NEW.operation_type IN ('asset.favorite.added', 'asset.favorite.removed') THEN 'asset-favorites-v1' ELSE NULL END, 'favorite-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind = 'favorite-operation', event_stream = COALESCE(sync_global_id_registry.event_stream, excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream = 'asset-favorites-v1'); END;

      CREATE TRIGGER favorite_sync_event_identity_guard BEFORE UPDATE ON favorite_sync_event_log
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.library_id IS NOT OLD.library_id OR NEW.author_peer_id IS NOT OLD.author_peer_id OR
        NEW.author_sequence IS NOT OLD.author_sequence OR NEW.protocol_version IS NOT OLD.protocol_version OR NEW.schema_version IS NOT OLD.schema_version OR
        NEW.event_type IS NOT OLD.event_type OR NEW.causal_parents_json IS NOT OLD.causal_parents_json OR NEW.payload_json IS NOT OLD.payload_json OR
        NEW.created_at IS NOT OLD.created_at OR OLD.state <> 'signing' OR NEW.state <> 'ready'
      BEGIN SELECT RAISE(ABORT, 'favorite sync event identity is immutable'); END;
      CREATE TRIGGER favorite_sync_event_no_delete BEFORE DELETE ON favorite_sync_event_log
      BEGIN SELECT RAISE(ABORT, 'favorite sync event deletion is disabled'); END;
      CREATE TRIGGER favorite_sync_inbox_identity_guard BEFORE UPDATE ON favorite_sync_inbox
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_id IS NOT OLD.peer_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.author_peer_id IS NOT OLD.author_peer_id OR NEW.author_sequence IS NOT OLD.author_sequence OR NEW.envelope_json IS NOT OLD.envelope_json
      BEGIN SELECT RAISE(ABORT, 'favorite sync inbox identity is immutable'); END;
      CREATE TRIGGER favorite_sync_conflicts_no_update BEFORE UPDATE ON favorite_sync_conflicts
      BEGIN SELECT RAISE(ABORT, 'favorite sync conflicts are immutable'); END;
      CREATE TRIGGER favorite_sync_conflicts_no_delete BEFORE DELETE ON favorite_sync_conflicts
      BEGIN SELECT RAISE(ABORT, 'favorite sync conflicts cannot be deleted'); END;
      CREATE TRIGGER favorite_operations_no_update BEFORE UPDATE ON favorite_operations
      BEGIN SELECT RAISE(ABORT, 'favorite operations are immutable'); END;
      CREATE TRIGGER favorite_operations_no_delete BEFORE DELETE ON favorite_operations
      BEGIN SELECT RAISE(ABORT, 'favorite operations are retained'); END;
      CREATE TRIGGER favorite_add_tokens_no_update BEFORE UPDATE ON favorite_add_tokens
      BEGIN SELECT RAISE(ABORT, 'favorite add tokens are immutable'); END;
      CREATE TRIGGER favorite_add_tokens_no_delete BEFORE DELETE ON favorite_add_tokens
      BEGIN SELECT RAISE(ABORT, 'favorite add tokens are retained'); END;
      CREATE TRIGGER favorite_remove_targets_no_update BEFORE UPDATE ON favorite_remove_targets
      BEGIN SELECT RAISE(ABORT, 'favorite remove targets are immutable'); END;
      CREATE TRIGGER favorite_remove_targets_no_delete BEFORE DELETE ON favorite_remove_targets
      BEGIN SELECT RAISE(ABORT, 'favorite remove targets are retained'); END;

      CREATE TRIGGER favorite_operations_author_limit BEFORE INSERT ON favorite_operations
      WHEN NEW.operation_type IN ('asset.favorite.added', 'asset.favorite.removed') AND
        NOT EXISTS (SELECT 1 FROM favorite_sync_author_registry WHERE library_id = NEW.library_id AND author_peer_id = NEW.author_peer_id) AND
        (SELECT count(*) FROM favorite_sync_author_registry WHERE library_id = NEW.library_id) >= 64
      BEGIN SELECT RAISE(ABORT, 'favorite_author_limit'); END;
      CREATE TRIGGER favorite_operations_author_register AFTER INSERT ON favorite_operations
      WHEN NEW.operation_type IN ('asset.favorite.added', 'asset.favorite.removed')
      BEGIN INSERT OR IGNORE INTO favorite_sync_author_registry (library_id, author_peer_id, first_seen_at)
        VALUES (NEW.library_id, NEW.author_peer_id, NEW.created_at); END;
      CREATE TRIGGER favorite_operations_scope_guard BEFORE INSERT ON favorite_operations
      WHEN NEW.operation_type IN ('asset.favorite.added', 'asset.favorite.removed') AND NOT EXISTS (
        SELECT 1 FROM assets a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id
        UNION ALL SELECT 1 FROM sync_asset_projection p WHERE p.library_id = NEW.library_id AND p.asset_id = NEW.asset_id AND p.tombstone_event_id IS NULL
        UNION ALL SELECT 1 FROM favorite_sync_inbox i WHERE i.event_id = NEW.operation_id AND i.state = 'applying' AND i.library_id = NEW.library_id AND
          i.author_peer_id = NEW.author_peer_id AND json_extract(i.envelope_json, '$.payload.assetId') = NEW.asset_id AND json_extract(i.envelope_json, '$.eventType') = NEW.operation_type)
      BEGIN SELECT RAISE(ABORT, 'favorite_operation_scope_mismatch'); END;
      CREATE TRIGGER favorite_add_token_guard BEFORE INSERT ON favorite_add_tokens
      WHEN NOT EXISTS (SELECT 1 FROM favorite_operations o JOIN favorite_sync_event_log e ON e.event_id = o.operation_id
        WHERE o.operation_id = NEW.event_id AND o.operation_type = 'asset.favorite.added' AND o.library_id = NEW.library_id AND
          o.asset_id = NEW.asset_id AND o.author_peer_id = NEW.author_peer_id AND e.library_id = NEW.library_id AND e.event_type = 'asset.favorite.added')
      BEGIN SELECT RAISE(ABORT, 'favorite_add_token_scope_mismatch'); END;
      CREATE TRIGGER favorite_remove_target_guard BEFORE INSERT ON favorite_remove_targets
      WHEN NOT EXISTS (SELECT 1 FROM favorite_operations o JOIN favorite_sync_event_log e ON e.event_id = o.operation_id
        JOIN favorite_add_tokens a ON a.event_id = NEW.observed_add_event_id
        WHERE o.operation_id = NEW.remove_event_id AND o.operation_type = 'asset.favorite.removed' AND o.library_id = NEW.library_id AND
          o.asset_id = NEW.asset_id AND e.event_type = 'asset.favorite.removed' AND a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'favorite_remove_target_scope_mismatch'); END;
      CREATE TRIGGER asset_favorites_insert_guard BEFORE INSERT ON asset_favorites
      WHEN NOT EXISTS (SELECT 1 FROM favorite_add_tokens a WHERE a.library_id = NEW.library_id AND a.asset_id = NEW.asset_id AND
        NOT EXISTS (SELECT 1 FROM favorite_remove_targets r WHERE r.observed_add_event_id = a.event_id))
      BEGIN SELECT RAISE(ABORT, 'favorite projection requires active add'); END;
      CREATE TRIGGER asset_favorites_delete_guard BEFORE DELETE ON asset_favorites
      WHEN EXISTS (SELECT 1 FROM favorite_add_tokens a WHERE a.library_id = OLD.library_id AND a.asset_id = OLD.asset_id AND
        NOT EXISTS (SELECT 1 FROM favorite_remove_targets r WHERE r.observed_add_event_id = a.event_id))
      BEGIN SELECT RAISE(ABORT, 'favorite projection has active add'); END;
    `
  },
  {
    id: '0010_asset_ratings',
    sql: `
      DROP TRIGGER sync_global_id_registry_no_delete;
      DROP TRIGGER sync_global_id_registry_update_guard;
      DROP TRIGGER sync_event_global_id_guard; DROP TRIGGER sync_event_global_id_register;
      DROP TRIGGER sync_inbox_global_id_guard; DROP TRIGGER sync_inbox_global_id_register;
      DROP TRIGGER tag_sync_event_global_id_guard; DROP TRIGGER tag_sync_event_global_id_register;
      DROP TRIGGER tag_sync_inbox_global_id_guard; DROP TRIGGER tag_sync_inbox_global_id_register;
      DROP TRIGGER album_sync_event_global_id_guard; DROP TRIGGER album_sync_event_global_id_register;
      DROP TRIGGER album_sync_inbox_global_id_guard; DROP TRIGGER album_sync_inbox_global_id_register;
      DROP TRIGGER album_operations_global_id_guard; DROP TRIGGER album_operations_global_id_register;
      DROP TRIGGER album_lifecycle_global_id_guard; DROP TRIGGER album_lifecycle_global_id_register;
      DROP TRIGGER album_visibility_global_id_guard; DROP TRIGGER album_visibility_global_id_register;
      DROP TRIGGER favorite_sync_event_global_id_guard; DROP TRIGGER favorite_sync_event_global_id_register;
      DROP TRIGGER favorite_sync_inbox_global_id_guard; DROP TRIGGER favorite_sync_inbox_global_id_register;
      DROP TRIGGER favorite_operations_global_id_guard; DROP TRIGGER favorite_operations_global_id_register;
      CREATE TABLE sync_global_id_registry_0010 (
        global_id TEXT PRIMARY KEY CHECK(length(global_id)=36),
        event_stream TEXT CHECK(event_stream IN ('asset-metadata-v1','asset-tags-v1','virtual-albums-v1','asset-favorites-v1','asset-ratings-v1')),
        operation_kind TEXT CHECK(operation_kind IN ('album-operation','album-lifecycle','album-visibility','favorite-operation','rating-operation')),
        CHECK(event_stream IS NOT NULL OR operation_kind IS NOT NULL),
        CHECK(event_stream IS NULL OR operation_kind IS NULL OR
          (event_stream='virtual-albums-v1' AND operation_kind IN ('album-operation','album-lifecycle')) OR
          (event_stream='asset-favorites-v1' AND operation_kind='favorite-operation') OR
          (event_stream='asset-ratings-v1' AND operation_kind='rating-operation'))
      );
      INSERT INTO sync_global_id_registry_0010 SELECT global_id,event_stream,operation_kind FROM sync_global_id_registry;
      DROP TABLE sync_global_id_registry;
      ALTER TABLE sync_global_id_registry_0010 RENAME TO sync_global_id_registry;
      CREATE TABLE library_rating_write_grants (
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT, library_id TEXT NOT NULL,
        granted_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY(peer_id,library_id)
      );
      CREATE INDEX library_rating_write_grants_library_idx ON library_rating_write_grants(library_id,peer_id,revoked_at);
      CREATE TABLE rating_sync_author_registry(library_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,first_seen_at TEXT NOT NULL,PRIMARY KEY(library_id,author_peer_id));
      CREATE TABLE rating_sync_event_log(
        event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),library_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,
        author_sequence INTEGER NOT NULL CHECK(author_sequence>0),protocol_version INTEGER NOT NULL CHECK(protocol_version>0),
        schema_version INTEGER NOT NULL CHECK(schema_version>0),event_type TEXT NOT NULL CHECK(event_type='asset.rating.set'),
        causal_parents_json TEXT NOT NULL CHECK(json_valid(causal_parents_json)),payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,signature TEXT,envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
        state TEXT NOT NULL CHECK(state IN ('signing','ready')),
        CHECK((state='signing' AND signature IS NULL) OR (state='ready' AND signature IS NOT NULL)),
        UNIQUE(library_id,author_peer_id,author_sequence)
      );
      CREATE INDEX rating_sync_event_log_library_idx ON rating_sync_event_log(library_id,author_peer_id,author_sequence);
      CREATE TABLE rating_sync_inbox(
        event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,author_sequence INTEGER NOT NULL CHECK(author_sequence>0),
        envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),state TEXT NOT NULL CHECK(state IN ('pending','applying','applied','unsupported','conflict','rejected')),
        error_code TEXT,received_at TEXT NOT NULL,accepted_at TEXT,applied_at TEXT,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        next_attempt_at TEXT NOT NULL,UNIQUE(library_id,author_peer_id,author_sequence)
      );
      CREATE INDEX rating_sync_inbox_pending_idx ON rating_sync_inbox(library_id,state,author_peer_id,author_sequence);
      CREATE TABLE rating_sync_conflicts(
        conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,relay_peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL,library_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,author_sequence INTEGER NOT NULL CHECK(author_sequence>0),
        envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),error_code TEXT NOT NULL CHECK(length(error_code) BETWEEN 1 AND 64),
        received_at TEXT NOT NULL,UNIQUE(library_id,author_peer_id)
      );
      CREATE INDEX rating_sync_conflicts_author_idx ON rating_sync_conflicts(library_id,author_peer_id,author_sequence);
      CREATE TABLE rating_sync_outbox(
        peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,event_id TEXT NOT NULL REFERENCES rating_sync_event_log(event_id) ON DELETE RESTRICT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at TEXT NOT NULL,last_error TEXT,accepted_at TEXT,PRIMARY KEY(peer_id,event_id)
      );
      CREATE INDEX rating_sync_outbox_due_idx ON rating_sync_outbox(peer_id,next_attempt_at,event_id);
      CREATE TABLE rating_sync_author_heads(
        library_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,author_sequence INTEGER NOT NULL CHECK(author_sequence>0),
        event_id TEXT NOT NULL REFERENCES rating_sync_event_log(event_id) ON DELETE RESTRICT,ready INTEGER NOT NULL DEFAULT 1 CHECK(ready IN (0,1)),
        PRIMARY KEY(library_id,author_peer_id)
      );
      CREATE TABLE rating_sync_peer_cursors(
        library_id TEXT NOT NULL,peer_id TEXT NOT NULL REFERENCES trusted_peers(peer_id) ON DELETE RESTRICT,author_peer_id TEXT NOT NULL,
        contiguous_sequence INTEGER NOT NULL DEFAULT 0 CHECK(contiguous_sequence>=0),event_id TEXT,updated_at TEXT NOT NULL,
        PRIMARY KEY(library_id,peer_id,author_peer_id)
      );
      CREATE TABLE rating_operations(
        operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),principal_id TEXT NOT NULL,author_peer_id TEXT NOT NULL,
        library_id TEXT NOT NULL,asset_id TEXT NOT NULL,operation_type TEXT NOT NULL CHECK(operation_type IN ('asset.rating.set','rating.noop')),
        request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL
      );
      CREATE INDEX rating_operations_asset_idx ON rating_operations(library_id,asset_id,operation_id);
      CREATE TABLE rating_values(
        event_id TEXT PRIMARY KEY REFERENCES rating_sync_event_log(event_id) ON DELETE RESTRICT,library_id TEXT NOT NULL,asset_id TEXT NOT NULL,
        rating INTEGER CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL),author_peer_id TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE INDEX rating_values_asset_idx ON rating_values(library_id,asset_id,event_id);
      CREATE TABLE rating_observations(
        event_id TEXT NOT NULL REFERENCES rating_values(event_id) ON DELETE RESTRICT,observed_event_id TEXT NOT NULL REFERENCES rating_values(event_id) ON DELETE RESTRICT,
        library_id TEXT NOT NULL,asset_id TEXT NOT NULL,PRIMARY KEY(event_id,observed_event_id),CHECK(event_id<>observed_event_id)
      );
      CREATE INDEX rating_observations_observed_idx ON rating_observations(observed_event_id);
      CREATE TABLE asset_rating_projection(
        library_id TEXT NOT NULL,asset_id TEXT NOT NULL,rating INTEGER CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL),
        conflict INTEGER NOT NULL CHECK(conflict IN (0,1)),candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
        PRIMARY KEY(library_id,asset_id)
      );

      CREATE TRIGGER sync_global_id_registry_no_delete BEFORE DELETE ON sync_global_id_registry
      BEGIN SELECT RAISE(ABORT,'global event ID registry is retained'); END;
      CREATE TRIGGER sync_global_id_registry_update_guard BEFORE UPDATE ON sync_global_id_registry
      WHEN (OLD.event_stream IS NOT NULL AND NEW.event_stream IS NOT OLD.event_stream) OR (OLD.operation_kind IS NOT NULL AND NEW.operation_kind IS NOT OLD.operation_kind) OR
        (NEW.event_stream IS NOT NULL AND NEW.operation_kind IS NOT NULL AND NOT (
          (NEW.event_stream='virtual-albums-v1' AND NEW.operation_kind IN ('album-operation','album-lifecycle')) OR
          (NEW.event_stream='asset-favorites-v1' AND NEW.operation_kind='favorite-operation') OR
          (NEW.event_stream='asset-ratings-v1' AND NEW.operation_kind='rating-operation')))
      BEGIN SELECT RAISE(ABORT,'global event ID registry identity is immutable'); END;
      CREATE TRIGGER sync_event_global_id_guard BEFORE INSERT ON sync_event_log
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER sync_event_global_id_register AFTER INSERT ON sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-metadata-v1',NULL); END;
      CREATE TRIGGER sync_inbox_global_id_guard BEFORE INSERT ON sync_inbox
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND (r.event_stream IS NOT 'asset-metadata-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER sync_inbox_global_id_register AFTER INSERT ON sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-metadata-v1',NULL); END;
      CREATE TRIGGER tag_sync_event_global_id_guard BEFORE INSERT ON tag_sync_event_log
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER tag_sync_event_global_id_register AFTER INSERT ON tag_sync_event_log
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-tags-v1',NULL); END;
      CREATE TRIGGER tag_sync_inbox_global_id_guard BEFORE INSERT ON tag_sync_inbox
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND (r.event_stream IS NOT 'asset-tags-v1' OR r.operation_kind IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER tag_sync_inbox_global_id_register AFTER INSERT ON tag_sync_inbox
      BEGIN INSERT OR IGNORE INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-tags-v1',NULL); END;
      CREATE TRIGGER album_sync_event_global_id_guard BEFORE INSERT ON album_sync_event_log
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'virtual-albums-v1') OR r.operation_kind='album-visibility' OR
         (r.operation_kind='album-operation' AND NOT EXISTS(SELECT 1 FROM album_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('album.created','member.added','member.removed'))) OR
         (r.operation_kind='album-lifecycle' AND NOT EXISTS(SELECT 1 FROM album_lifecycle_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('album.deleted','album.restored')))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER album_sync_event_global_id_register AFTER INSERT ON album_sync_event_log
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'virtual-albums-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='virtual-albums-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER album_sync_inbox_global_id_guard BEFORE INSERT ON album_sync_inbox
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'virtual-albums-v1') OR r.operation_kind='album-visibility' OR
         (r.operation_kind='album-operation' AND NOT EXISTS(SELECT 1 FROM album_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('album.created','member.added','member.removed'))) OR
         (r.operation_kind='album-lifecycle' AND NOT EXISTS(SELECT 1 FROM album_lifecycle_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('album.deleted','album.restored')))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER album_sync_inbox_global_id_register AFTER INSERT ON album_sync_inbox
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'virtual-albums-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='virtual-albums-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER album_operations_global_id_guard BEFORE INSERT ON album_operations
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream='virtual-albums-v1' AND NOT EXISTS(SELECT 1 FROM album_sync_inbox i WHERE i.event_id=NEW.operation_id AND i.state='applying' AND
           i.library_id=NEW.library_id AND i.author_peer_id=NEW.author_peer_id AND json_extract(i.envelope_json,'$.payload.albumId')=NEW.album_id AND
           (NEW.operation_type<>'member.added' OR json_extract(i.envelope_json,'$.eventType')='album.member.added') AND
           (NEW.operation_type<>'member.removed' OR json_extract(i.envelope_json,'$.eventType')='album.member.removed') AND
           (NEW.operation_type<>'album.created' OR json_extract(i.envelope_json,'$.eventType')='album.created')))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER album_operations_global_id_register AFTER INSERT ON album_operations
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind)
        VALUES(NEW.operation_id,CASE WHEN NEW.operation_type IN ('album.created','member.added','member.removed') THEN 'virtual-albums-v1' ELSE NULL END,'album-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind='album-operation',event_stream=COALESCE(sync_global_id_registry.event_stream,excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream='virtual-albums-v1'); END;
      CREATE TRIGGER album_lifecycle_global_id_guard BEFORE INSERT ON album_lifecycle_operations
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'virtual-albums-v1') OR r.operation_kind IS NOT NULL OR
         (r.event_stream='virtual-albums-v1' AND NOT EXISTS(SELECT 1 FROM album_sync_inbox i WHERE i.event_id=NEW.operation_id AND i.state='applying' AND
           i.library_id=NEW.library_id AND i.author_peer_id=NEW.author_peer_id AND json_extract(i.envelope_json,'$.payload.albumId')=NEW.album_id AND json_extract(i.envelope_json,'$.eventType')=NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER album_lifecycle_global_id_register AFTER INSERT ON album_lifecycle_operations
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind)
        VALUES(NEW.operation_id,CASE WHEN NEW.operation_type IN ('album.deleted','album.restored') THEN 'virtual-albums-v1' ELSE NULL END,'album-lifecycle')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind='album-lifecycle',event_stream=COALESCE(sync_global_id_registry.event_stream,excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream='virtual-albums-v1'); END;
      CREATE TRIGGER album_visibility_global_id_guard BEFORE INSERT ON album_visibility_operations
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry WHERE global_id=NEW.operation_id)
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER album_visibility_global_id_register AFTER INSERT ON album_visibility_operations
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.operation_id,NULL,'album-visibility'); END;
      CREATE TRIGGER favorite_sync_event_global_id_guard BEFORE INSERT ON favorite_sync_event_log
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-favorites-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'favorite-operation') OR
         (r.operation_kind='favorite-operation' AND NOT EXISTS(SELECT 1 FROM favorite_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('asset.favorite.added','asset.favorite.removed')))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER favorite_sync_event_global_id_register AFTER INSERT ON favorite_sync_event_log
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-favorites-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='asset-favorites-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER favorite_sync_inbox_global_id_guard BEFORE INSERT ON favorite_sync_inbox
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-favorites-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'favorite-operation') OR
         (r.operation_kind='favorite-operation' AND NOT EXISTS(SELECT 1 FROM favorite_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type IN ('asset.favorite.added','asset.favorite.removed')))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER favorite_sync_inbox_global_id_register AFTER INSERT ON favorite_sync_inbox
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind) VALUES(NEW.event_id,'asset-favorites-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='asset-favorites-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER favorite_operations_global_id_guard BEFORE INSERT ON favorite_operations
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-favorites-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'favorite-operation') OR
         (r.event_stream='asset-favorites-v1' AND NOT EXISTS(SELECT 1 FROM favorite_sync_event_log e WHERE e.event_id=NEW.operation_id AND e.library_id=NEW.library_id AND e.author_peer_id=NEW.author_peer_id AND e.event_type=NEW.operation_type
           UNION ALL SELECT 1 FROM favorite_sync_inbox i WHERE i.event_id=NEW.operation_id AND i.state='applying' AND i.library_id=NEW.library_id AND i.author_peer_id=NEW.author_peer_id AND json_extract(i.envelope_json,'$.eventType')=NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER favorite_operations_global_id_register AFTER INSERT ON favorite_operations
      BEGIN INSERT INTO sync_global_id_registry(global_id,event_stream,operation_kind)
        VALUES(NEW.operation_id,CASE WHEN NEW.operation_type IN ('asset.favorite.added','asset.favorite.removed') THEN 'asset-favorites-v1' ELSE NULL END,'favorite-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind='favorite-operation',event_stream=COALESCE(sync_global_id_registry.event_stream,excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream='asset-favorites-v1'); END;
      CREATE TRIGGER rating_sync_event_global_id_guard BEFORE INSERT ON rating_sync_event_log
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-ratings-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'rating-operation') OR
         (r.operation_kind='rating-operation' AND NOT EXISTS(SELECT 1 FROM rating_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type='asset.rating.set'))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER rating_sync_event_global_id_register AFTER INSERT ON rating_sync_event_log
      BEGIN INSERT INTO sync_global_id_registry VALUES(NEW.event_id,'asset-ratings-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='asset-ratings-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER rating_sync_inbox_global_id_guard BEFORE INSERT ON rating_sync_inbox
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.event_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-ratings-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'rating-operation') OR
         (r.operation_kind='rating-operation' AND NOT EXISTS(SELECT 1 FROM rating_operations o WHERE o.operation_id=NEW.event_id AND o.operation_type='asset.rating.set'))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER rating_sync_inbox_global_id_register AFTER INSERT ON rating_sync_inbox
      BEGIN INSERT INTO sync_global_id_registry VALUES(NEW.event_id,'asset-ratings-v1',NULL)
        ON CONFLICT(global_id) DO UPDATE SET event_stream='asset-ratings-v1' WHERE sync_global_id_registry.event_stream IS NULL; END;
      CREATE TRIGGER rating_operations_global_id_guard BEFORE INSERT ON rating_operations
      WHEN EXISTS(SELECT 1 FROM sync_global_id_registry r WHERE r.global_id=NEW.operation_id AND
        ((r.event_stream IS NOT NULL AND r.event_stream<>'asset-ratings-v1') OR (r.operation_kind IS NOT NULL AND r.operation_kind<>'rating-operation') OR
         (r.event_stream='asset-ratings-v1' AND NOT EXISTS(
           SELECT 1 FROM rating_sync_event_log e WHERE e.event_id=NEW.operation_id AND e.library_id=NEW.library_id AND e.author_peer_id=NEW.author_peer_id AND e.event_type=NEW.operation_type
           UNION ALL SELECT 1 FROM rating_sync_inbox i WHERE i.event_id=NEW.operation_id AND i.state='applying' AND i.library_id=NEW.library_id AND i.author_peer_id=NEW.author_peer_id AND json_extract(i.envelope_json,'$.eventType')=NEW.operation_type))))
      BEGIN SELECT RAISE(ABORT,'global event ID collision'); END;
      CREATE TRIGGER rating_operations_global_id_register AFTER INSERT ON rating_operations
      BEGIN INSERT INTO sync_global_id_registry VALUES(NEW.operation_id,CASE WHEN NEW.operation_type='asset.rating.set' THEN 'asset-ratings-v1' ELSE NULL END,'rating-operation')
        ON CONFLICT(global_id) DO UPDATE SET operation_kind='rating-operation',event_stream=COALESCE(sync_global_id_registry.event_stream,excluded.event_stream)
        WHERE sync_global_id_registry.operation_kind IS NULL AND (sync_global_id_registry.event_stream IS NULL OR sync_global_id_registry.event_stream='asset-ratings-v1'); END;

      CREATE TRIGGER rating_sync_event_identity_guard BEFORE UPDATE ON rating_sync_event_log
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.library_id IS NOT OLD.library_id OR NEW.author_peer_id IS NOT OLD.author_peer_id OR
        NEW.author_sequence IS NOT OLD.author_sequence OR NEW.protocol_version IS NOT OLD.protocol_version OR NEW.schema_version IS NOT OLD.schema_version OR
        NEW.event_type IS NOT OLD.event_type OR NEW.causal_parents_json IS NOT OLD.causal_parents_json OR NEW.payload_json IS NOT OLD.payload_json OR
        NEW.created_at IS NOT OLD.created_at OR OLD.state<>'signing' OR NEW.state<>'ready'
      BEGIN SELECT RAISE(ABORT,'rating sync event identity is immutable'); END;
      CREATE TRIGGER rating_sync_event_no_delete BEFORE DELETE ON rating_sync_event_log BEGIN SELECT RAISE(ABORT,'rating sync event deletion is disabled'); END;
      CREATE TRIGGER rating_sync_inbox_identity_guard BEFORE UPDATE ON rating_sync_inbox
      WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_id IS NOT OLD.peer_id OR NEW.library_id IS NOT OLD.library_id OR
        NEW.author_peer_id IS NOT OLD.author_peer_id OR NEW.author_sequence IS NOT OLD.author_sequence OR NEW.envelope_json IS NOT OLD.envelope_json
      BEGIN SELECT RAISE(ABORT,'rating sync inbox identity is immutable'); END;
      CREATE TRIGGER rating_sync_conflicts_no_update BEFORE UPDATE ON rating_sync_conflicts BEGIN SELECT RAISE(ABORT,'rating sync conflicts are immutable'); END;
      CREATE TRIGGER rating_sync_conflicts_no_delete BEFORE DELETE ON rating_sync_conflicts BEGIN SELECT RAISE(ABORT,'rating sync conflicts cannot be deleted'); END;
      CREATE TRIGGER rating_operations_no_update BEFORE UPDATE ON rating_operations BEGIN SELECT RAISE(ABORT,'rating operations are immutable'); END;
      CREATE TRIGGER rating_operations_no_delete BEFORE DELETE ON rating_operations BEGIN SELECT RAISE(ABORT,'rating operations are retained'); END;
      CREATE TRIGGER rating_values_no_update BEFORE UPDATE ON rating_values BEGIN SELECT RAISE(ABORT,'rating values are immutable'); END;
      CREATE TRIGGER rating_values_no_delete BEFORE DELETE ON rating_values BEGIN SELECT RAISE(ABORT,'rating history is retained'); END;
      CREATE TRIGGER rating_observations_no_update BEFORE UPDATE ON rating_observations BEGIN SELECT RAISE(ABORT,'rating observations are immutable'); END;
      CREATE TRIGGER rating_observations_no_delete BEFORE DELETE ON rating_observations BEGIN SELECT RAISE(ABORT,'rating observations are retained'); END;
      CREATE TRIGGER rating_author_limit BEFORE INSERT ON rating_operations
      WHEN NEW.operation_type='asset.rating.set' AND NOT EXISTS(SELECT 1 FROM rating_sync_author_registry WHERE library_id=NEW.library_id AND author_peer_id=NEW.author_peer_id) AND
        (SELECT count(*) FROM rating_sync_author_registry WHERE library_id=NEW.library_id)>=64
      BEGIN SELECT RAISE(ABORT,'rating_author_limit'); END;
      CREATE TRIGGER rating_author_register AFTER INSERT ON rating_operations WHEN NEW.operation_type='asset.rating.set'
      BEGIN INSERT OR IGNORE INTO rating_sync_author_registry VALUES(NEW.library_id,NEW.author_peer_id,NEW.created_at); END;
      CREATE TRIGGER rating_operation_scope_guard BEFORE INSERT ON rating_operations
      WHEN NEW.operation_type='asset.rating.set' AND NOT EXISTS(
        SELECT 1 FROM assets a WHERE a.library_id=NEW.library_id AND a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM sync_asset_projection p WHERE p.library_id=a.library_id AND p.asset_id=a.asset_id AND p.tombstone_event_id IS NOT NULL)
        UNION ALL SELECT 1 FROM sync_asset_projection p WHERE p.library_id=NEW.library_id AND p.asset_id=NEW.asset_id AND p.tombstone_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.library_id=p.library_id AND a.asset_id=p.asset_id)
        UNION ALL SELECT 1 FROM rating_sync_inbox i WHERE i.event_id=NEW.operation_id AND i.state='applying' AND i.library_id=NEW.library_id AND i.author_peer_id=NEW.author_peer_id AND json_extract(i.envelope_json,'$.payload.assetId')=NEW.asset_id AND json_extract(i.envelope_json,'$.eventType')='asset.rating.set')
      BEGIN SELECT RAISE(ABORT,'rating_operation_scope_mismatch'); END;
      CREATE TRIGGER rating_value_guard BEFORE INSERT ON rating_values
      WHEN NOT EXISTS(SELECT 1 FROM rating_operations o JOIN rating_sync_event_log e ON e.event_id=o.operation_id WHERE o.operation_id=NEW.event_id AND o.operation_type='asset.rating.set' AND o.library_id=NEW.library_id AND o.asset_id=NEW.asset_id AND o.author_peer_id=NEW.author_peer_id AND e.event_type='asset.rating.set')
      BEGIN SELECT RAISE(ABORT,'rating_value_scope_mismatch'); END;
      CREATE TRIGGER rating_observation_guard BEFORE INSERT ON rating_observations
      WHEN NOT EXISTS(SELECT 1 FROM rating_values n JOIN rating_values o ON o.event_id=NEW.observed_event_id WHERE n.event_id=NEW.event_id AND n.library_id=NEW.library_id AND o.library_id=NEW.library_id AND n.asset_id=NEW.asset_id AND o.asset_id=NEW.asset_id)
      BEGIN SELECT RAISE(ABORT,'rating_observation_scope_mismatch'); END;
      CREATE TRIGGER asset_rating_projection_scope_guard BEFORE INSERT ON asset_rating_projection
      WHEN NOT EXISTS(SELECT 1 FROM assets a WHERE a.library_id=NEW.library_id AND a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM sync_asset_projection p WHERE p.library_id=a.library_id AND p.asset_id=a.asset_id AND p.tombstone_event_id IS NOT NULL)
        UNION ALL SELECT 1 FROM sync_asset_projection p WHERE p.library_id=NEW.library_id AND p.asset_id=NEW.asset_id AND p.tombstone_event_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'rating projection requires visible asset'); END;
    `
  },
  {
    id: '0011_gallery_search_index',
    sql: `
      CREATE TABLE gallery_search_content (
        rowid INTEGER PRIMARY KEY,
        library_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('photo','video','live_photo')),
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        filename TEXT NOT NULL,
        source_path TEXT,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('upload','import')),
        availability TEXT NOT NULL CHECK(availability IN ('online','cached','offline','missing')),
        captured_at TEXT,
        UNIQUE(library_id,asset_id)
      );
      CREATE INDEX gallery_search_content_capture_idx ON gallery_search_content(library_id,captured_at DESC,asset_id COLLATE BINARY DESC);
      CREATE VIRTUAL TABLE gallery_search_fts USING fts5(filename,source_path,asset_id,origin_node_id,
        content='gallery_search_content',content_rowid='rowid',tokenize='trigram');

      CREATE VIEW gallery_search_source AS
        SELECT a.library_id,a.asset_id,a.origin_node_id,a.kind,COALESCE(f.sha256,'') AS sha256,COALESCE(f.byte_size,0) AS byte_size,
          COALESCE(l.original_filename,a.asset_id) AS filename,l.original_path AS source_path,
          CASE WHEN l.source_kind='upload' THEN 'upload' ELSE 'import' END AS source_kind,
          COALESCE(l.availability,'missing') AS availability,strftime('%Y-%m-%dT%H:%M:%fZ',a.capture_ts) AS captured_at
        FROM assets a
        LEFT JOIN asset_files f ON f.asset_id=a.asset_id AND f.media_role='original'
        LEFT JOIN file_locations l ON l.location_id=(SELECT candidate.location_id FROM file_locations candidate
          WHERE candidate.file_id=f.file_id AND candidate.node_id=a.origin_node_id
          ORDER BY CASE candidate.availability WHEN 'online' THEN 0 WHEN 'cached' THEN 1 ELSE 2 END,
            candidate.location_id COLLATE BINARY LIMIT 1)
        WHERE NOT EXISTS(SELECT 1 FROM sync_asset_projection p WHERE p.library_id=a.library_id AND p.asset_id=a.asset_id AND p.tombstone_event_id IS NOT NULL)
        UNION ALL
        SELECT p.library_id,p.asset_id,p.origin_node_id,p.kind,p.sha256,p.byte_length,
          CASE WHEN json_type(p.metadata_json,'$.filename')='text' THEN json_extract(p.metadata_json,'$.filename') ELSE p.asset_id END,
          CASE WHEN json_type(p.metadata_json,'$.sourcePath')='text' THEN json_extract(p.metadata_json,'$.sourcePath') ELSE NULL END,
          CASE WHEN json_extract(p.metadata_json,'$.sourceKind')='upload' THEN 'upload' ELSE 'import' END,
          'missing',CASE WHEN json_type(p.metadata_json,'$.capturedAt')='text'
            THEN strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(p.metadata_json,'$.capturedAt')) ELSE NULL END
        FROM sync_asset_projection p
        WHERE p.tombstone_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.library_id=p.library_id AND a.asset_id=p.asset_id);

      CREATE TRIGGER gallery_search_fts_ai AFTER INSERT ON gallery_search_content BEGIN
        INSERT INTO gallery_search_fts(rowid,filename,source_path,asset_id,origin_node_id)
          VALUES(NEW.rowid,NEW.filename,COALESCE(NEW.source_path,''),NEW.asset_id,NEW.origin_node_id);
      END;
      CREATE TRIGGER gallery_search_fts_ad AFTER DELETE ON gallery_search_content BEGIN
        INSERT INTO gallery_search_fts(gallery_search_fts,rowid,filename,source_path,asset_id,origin_node_id)
          VALUES('delete',OLD.rowid,OLD.filename,COALESCE(OLD.source_path,''),OLD.asset_id,OLD.origin_node_id);
      END;
      CREATE TRIGGER gallery_search_fts_au AFTER UPDATE ON gallery_search_content BEGIN
        INSERT INTO gallery_search_fts(gallery_search_fts,rowid,filename,source_path,asset_id,origin_node_id)
          VALUES('delete',OLD.rowid,OLD.filename,COALESCE(OLD.source_path,''),OLD.asset_id,OLD.origin_node_id);
        INSERT INTO gallery_search_fts(rowid,filename,source_path,asset_id,origin_node_id)
          VALUES(NEW.rowid,NEW.filename,COALESCE(NEW.source_path,''),NEW.asset_id,NEW.origin_node_id);
      END;

      CREATE TRIGGER gallery_search_assets_ai AFTER INSERT ON assets BEGIN
        DELETE FROM gallery_search_content WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
      END;
      CREATE TRIGGER gallery_search_assets_au AFTER UPDATE ON assets BEGIN
        DELETE FROM gallery_search_content WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
        DELETE FROM gallery_search_content WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE (library_id=OLD.library_id AND asset_id=OLD.asset_id) OR (library_id=NEW.library_id AND asset_id=NEW.asset_id);
      END;
      CREATE TRIGGER gallery_search_assets_ad AFTER DELETE ON assets BEGIN
        DELETE FROM gallery_search_content WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
      END;

      CREATE TRIGGER gallery_search_asset_files_ai AFTER INSERT ON asset_files BEGIN
        DELETE FROM gallery_search_content WHERE asset_id=NEW.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id=NEW.asset_id;
      END;
      CREATE TRIGGER gallery_search_asset_files_au AFTER UPDATE ON asset_files BEGIN
        DELETE FROM gallery_search_content WHERE asset_id IN (OLD.asset_id,NEW.asset_id);
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id IN (OLD.asset_id,NEW.asset_id);
      END;
      CREATE TRIGGER gallery_search_asset_files_ad AFTER DELETE ON asset_files BEGIN
        DELETE FROM gallery_search_content WHERE asset_id=OLD.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id=OLD.asset_id;
      END;

      CREATE TRIGGER gallery_search_file_locations_ai AFTER INSERT ON file_locations BEGIN
        DELETE FROM gallery_search_content WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id=NEW.file_id);
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id=NEW.file_id);
      END;
      CREATE TRIGGER gallery_search_file_locations_au AFTER UPDATE ON file_locations BEGIN
        DELETE FROM gallery_search_content WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id IN (OLD.file_id,NEW.file_id));
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id IN (OLD.file_id,NEW.file_id));
      END;
      CREATE TRIGGER gallery_search_file_locations_ad AFTER DELETE ON file_locations BEGIN
        DELETE FROM gallery_search_content WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id=OLD.file_id);
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE asset_id IN (SELECT asset_id FROM asset_files WHERE file_id=OLD.file_id);
      END;

      CREATE TRIGGER gallery_search_projection_ai AFTER INSERT ON sync_asset_projection BEGIN
        DELETE FROM gallery_search_content WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
      END;
      CREATE TRIGGER gallery_search_projection_au AFTER UPDATE ON sync_asset_projection BEGIN
        DELETE FROM gallery_search_content WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
        DELETE FROM gallery_search_content WHERE library_id=NEW.library_id AND asset_id=NEW.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE (library_id=OLD.library_id AND asset_id=OLD.asset_id) OR (library_id=NEW.library_id AND asset_id=NEW.asset_id);
      END;
      CREATE TRIGGER gallery_search_projection_ad AFTER DELETE ON sync_asset_projection BEGIN
        DELETE FROM gallery_search_content WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
        INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
          SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at
          FROM gallery_search_source WHERE library_id=OLD.library_id AND asset_id=OLD.asset_id;
      END;

      INSERT INTO gallery_search_content(library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at)
        SELECT library_id,asset_id,origin_node_id,kind,sha256,byte_size,filename,source_path,source_kind,availability,captured_at FROM gallery_search_source;
    `
  },
  {
    id: '0012_gallery_filter_indexes',
    sql: `
      CREATE INDEX gallery_search_content_kind_capture_idx
        ON gallery_search_content(library_id,kind,captured_at DESC,asset_id COLLATE BINARY DESC);
      CREATE INDEX gallery_search_content_source_kind_capture_idx
        ON gallery_search_content(library_id,source_kind,captured_at DESC,asset_id COLLATE BINARY DESC);
      CREATE INDEX gallery_search_content_availability_capture_idx
        ON gallery_search_content(library_id,availability,captured_at DESC,asset_id COLLATE BINARY DESC);
    `
  }
];
