import 'package:sqflite/sqflite.dart' show databaseFactory;
import 'package:sqflite_common/sqlite_api.dart';

import 'upload_job.dart';

class UploadQueue {
  UploadQueue({DatabaseFactory? factory, String path = 'photomesh_upload_queue.db'})
      : _factory = factory ?? databaseFactory,
        _path = path;

  final DatabaseFactory _factory;
  final String _path;
  Database? _database;

  Future<Database> get database async {
    final existing = _database;
    if (existing != null) return existing;
    final opened = await _factory.openDatabase(
      _path,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (db, _) async {
          await db.execute('''CREATE TABLE upload_jobs (
            id TEXT PRIMARY KEY, asset_id TEXT, file_path TEXT NOT NULL, original_path TEXT NOT NULL,
            filename TEXT NOT NULL, total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
            sha256 TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, session_id TEXT,
            offset INTEGER NOT NULL DEFAULT 0 CHECK(offset >= 0), error_code TEXT
          )''');
          await db.execute('CREATE INDEX upload_jobs_state_created ON upload_jobs(state, created_at)');
        },
      ),
    );
    _database = opened;
    return opened;
  }

  Future<void> enqueue(UploadJob job) async {
    await (await database).insert('upload_jobs', job.toRow(), conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  Future<List<UploadJob>> list({int limit = 100}) async {
    final rows = await (await database).query('upload_jobs', orderBy: 'created_at DESC', limit: limit);
    return rows.map(UploadJob.fromRow).toList(growable: false);
  }

  Future<UploadJob?> get(String id) async {
    final rows = await (await database).query('upload_jobs', where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : UploadJob.fromRow(rows.single);
  }

  Future<bool> hasAsset(String assetId) async {
    final rows = await (await database).query('upload_jobs',
        columns: ['id'], where: 'asset_id = ?', whereArgs: [assetId], limit: 1);
    return rows.isNotEmpty;
  }

  Future<int> markGalleryJobsNeedsPermission() async => (await database).update(
        'upload_jobs',
        {'state': UploadJobState.needsPermission.name, 'error_code': 'PERMISSION_REVOKED', 'updated_at': DateTime.now().toUtc().toIso8601String()},
        where: "asset_id IS NOT NULL AND state IN ('queued', 'uploading', 'paused')",
      );

  Future<int> resumeGalleryJobs() async => (await database).update(
        'upload_jobs',
        {'state': UploadJobState.queued.name, 'error_code': null, 'updated_at': DateTime.now().toUtc().toIso8601String()},
        where: "asset_id IS NOT NULL AND state = 'needsPermission' AND error_code IN ('PERMISSION_REVOKED', 'SOURCE_UNAVAILABLE')",
      );

  Future<List<UploadJob>> runnable({int limit = 10}) async {
    final rows = await (await database).query('upload_jobs',
        where: "state IN ('queued', 'uploading', 'paused')", orderBy: 'created_at ASC', limit: limit);
    return rows.map(UploadJob.fromRow).toList(growable: false);
  }

  Future<void> save(UploadJob job) async {
    await (await database).update('upload_jobs', job.toRow(), where: 'id = ?', whereArgs: [job.id]);
  }

  Future<void> close() async {
    final db = _database;
    _database = null;
    await db?.close();
  }
}
