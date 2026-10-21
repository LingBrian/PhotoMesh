enum UploadJobState { queued, uploading, paused, completed, needsPermission, failed }

enum NetworkPolicy { wifiOnly, anyNetwork, manualOnly }

class UploadJob {
  const UploadJob({
    required this.id,
    required this.assetId,
    required this.filePath,
    required this.originalPath,
    required this.filename,
    required this.totalBytes,
    required this.sha256,
    required this.idempotencyKey,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
    this.sessionId,
    this.offset = 0,
    this.errorCode,
  });

  final String id;
  final String? assetId;
  final String filePath;
  final String originalPath;
  final String filename;
  final int totalBytes;
  final String sha256;
  final String idempotencyKey;
  final UploadJobState state;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? sessionId;
  final int offset;
  final String? errorCode;

  UploadJob copyWith({UploadJobState? state, String? sessionId, int? offset, String? errorCode, String? filePath, bool clearError = false}) => UploadJob(
        id: id,
        assetId: assetId,
        filePath: filePath ?? this.filePath,
        originalPath: originalPath,
        filename: filename,
        totalBytes: totalBytes,
        sha256: sha256,
        idempotencyKey: idempotencyKey,
        state: state ?? this.state,
        createdAt: createdAt,
        updatedAt: DateTime.now().toUtc(),
        sessionId: sessionId ?? this.sessionId,
        offset: offset ?? this.offset,
        errorCode: clearError ? null : errorCode ?? this.errorCode,
      );

  Map<String, Object?> toRow() => {
        'id': id, 'asset_id': assetId, 'file_path': filePath, 'original_path': originalPath, 'filename': filename,
        'total_bytes': totalBytes, 'sha256': sha256, 'idempotency_key': idempotencyKey,
        'state': state.name, 'created_at': createdAt.toIso8601String(),
        'updated_at': updatedAt.toIso8601String(), 'session_id': sessionId,
        'offset': offset, 'error_code': errorCode,
      };

  static UploadJob fromRow(Map<String, Object?> row) => UploadJob(
        id: row['id']! as String,
        assetId: row['asset_id'] as String?,
        filePath: row['file_path']! as String,
        originalPath: row['original_path']! as String,
        filename: row['filename']! as String,
        totalBytes: row['total_bytes']! as int,
        sha256: row['sha256']! as String,
        idempotencyKey: row['idempotency_key']! as String,
        state: UploadJobState.values.byName(row['state']! as String),
        createdAt: DateTime.parse(row['created_at']! as String),
        updatedAt: DateTime.parse(row['updated_at']! as String),
        sessionId: row['session_id'] as String?,
        offset: row['offset']! as int,
        errorCode: row['error_code'] as String?,
      );
}

class BoundNode {
  const BoundNode({required this.baseUrl, required this.libraryId, required this.nodeId});
  final String baseUrl;
  final String libraryId;
  final String nodeId;
}
