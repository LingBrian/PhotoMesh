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
  }
];
