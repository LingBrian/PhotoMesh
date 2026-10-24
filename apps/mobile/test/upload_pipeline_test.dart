import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:photomesh_mobile/background_sync.dart';
import 'package:photomesh_mobile/node_settings.dart';
import 'package:photomesh_mobile/photo_library.dart';
import 'package:photomesh_mobile/upload_job.dart';
import 'package:photomesh_mobile/upload_queue.dart';
import 'package:photomesh_mobile/upload_service.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class _Settings implements NodeSettingsStore {
  @override
  Future<BoundNode?> loadNode() async => const BoundNode(baseUrl: 'https://node.example', libraryId: 'library-1', nodeId: 'device-1');
  @override
  Future<String?> loadToken() async => 'test-token';
}

class _MemoryFiles implements UploadFileAccess {
  _MemoryFiles(this.bytes);
  final List<int> bytes;
  @override
  Future<int> length(String path) async => bytes.length;
  @override
  Stream<List<int>> openRead(String path, {int? start, int? end}) =>
      Stream.value(bytes.sublist(start ?? 0, end ?? bytes.length));
}

class _PermissionGateway implements PhotoLibraryGateway {
  PermissionState state = PermissionState.denied;

  @override
  Future<PermissionState> currentPermission() async => state;
  @override
  Future<PermissionState> requestPermission() async => state;
  @override
  Future<AssetEntity?> byId(String assetId) async => null;
  @override
  Future<List<AssetEntity>> latest({int page = 0, int pageSize = 80}) async => const [];
}

UploadJob _job(List<int> bytes) {
  final now = DateTime.utc(2026);
  return UploadJob(
    id: 'job-1', assetId: null, filePath: '/fixture/original.bin', originalPath: 'DCIM/Camera/original.bin',
    filename: 'original.bin', totalBytes: bytes.length, sha256: sha256.convert(bytes).toString(),
    idempotencyKey: '0123456789abcdef01234567', state: UploadJobState.queued, createdAt: now, updatedAt: now,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  late Directory tempDirectory;
  late UploadQueue queue;

  setUp(() async {
    tempDirectory = await Directory.systemTemp.createTemp('photomesh-mobile-test-');
    queue = UploadQueue(factory: databaseFactoryFfi, path: '${tempDirectory.path}${Platform.pathSeparator}queue.db');
  });

  tearDown(() async {
    await queue.close();
    await tempDirectory.delete(recursive: true);
  });

  test('continues manual selection after gallery access failures and reports skipped items', () async {
    final visited = <int>[];
    final result = await queueSelectedPhotos<int>([1, 2, 3, 4], (id) async {
      visited.add(id);
      if (id == 2) throw FileSystemException('permission revoked');
      if (id == 3) throw PlatformException(code: 'permission_revoked');
      return id == 1 ? _job([1, 2, 3]) : null;
    });

    expect(visited, [1, 2, 3, 4]);
    expect(result.queued, 1);
    expect(result.skipped, 3);
  });

  test('upload verifies the source and server SHA-256 before completing', () async {
    final bytes = [1, 2, 3, 4, 5, 6];
    final job = _job(bytes);
    await queue.enqueue(job);
    var remoteOffset = 0;
    var uploaded = <int>[];
    final client = MockClient((request) async {
      if (request.url.path == '/v1/uploads') {
        expect(request.headers['idempotency-key'], job.idempotencyKey);
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['originalPath'], 'DCIM/Camera/original.bin');
        return http.Response('{"sessionId":"session-1","offset":0,"state":"created"}', 201);
      }
      if (request.url.path == '/v1/uploads/session-1') {
        return http.Response(jsonEncode({'sessionId': 'session-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.contains('/chunks/')) {
        final part = request.bodyBytes;
        expect(request.headers['upload-offset'], '$remoteOffset');
        expect(request.headers['upload-chunk-sha256'], sha256.convert(part).toString());
        uploaded.addAll(part);
        remoteOffset += part.length;
        return http.Response(jsonEncode({'sessionId': 'session-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.endsWith('/complete')) {
        expect(uploaded, bytes);
        return http.Response(jsonEncode({'sha256': sha256.convert(uploaded).toString(), 'byteLength': uploaded.length}), 200);
      }
      return http.Response('not found', 404);
    });
    final service = UploadService(queue: queue, settings: _Settings(), client: client,
        fileAccess: _MemoryFiles(bytes), chunkBytes: 3);

    final result = await service.upload(job);
    expect(result.state, UploadJobState.completed);
    expect(result.offset, bytes.length);
    expect((await queue.get(job.id))?.state, UploadJobState.completed);
    service.close();
  });

  test('keeps final gallery chunk uncompleted when access is revoked during transfer', () async {
    final bytes = [7, 8, 9];
    final base = _job(bytes);
    final galleryJob = UploadJob(
      id: 'revoked-final-chunk', assetId: 'media-store-id', filePath: base.filePath,
      originalPath: base.originalPath, filename: base.filename, totalBytes: base.totalBytes,
      sha256: base.sha256, idempotencyKey: base.idempotencyKey, state: UploadJobState.queued,
      createdAt: base.createdAt, updatedAt: base.updatedAt,
    );
    await queue.enqueue(galleryJob);
    var remoteOffset = 0;
    var permissionChecks = 0;
    var completionCalls = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/v1/uploads') return http.Response('{"sessionId":"last-chunk","offset":0}', 201);
      if (request.url.path == '/v1/uploads/last-chunk') {
        return http.Response(jsonEncode({'sessionId': 'last-chunk', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.contains('/chunks/')) {
        remoteOffset += request.bodyBytes.length;
        return http.Response(jsonEncode({'sessionId': 'last-chunk', 'offset': remoteOffset}), 200);
      }
      if (request.url.path.endsWith('/complete')) {
        completionCalls++;
        return http.Response(jsonEncode({'sha256': base.sha256, 'byteLength': bytes.length}), 200);
      }
      return http.Response('', 404);
    });
    final service = UploadService(
      queue: queue,
      settings: _Settings(),
      client: client,
      fileAccess: _MemoryFiles(bytes),
      resolveSource: (_) async => base.filePath,
      galleryPermissionAllowed: () async => ++permissionChecks == 1,
      chunkBytes: bytes.length,
    );

    final result = await service.upload(galleryJob);
    expect(permissionChecks, 2);
    expect(remoteOffset, bytes.length);
    expect(completionCalls, 0);
    expect(result.state, UploadJobState.needsPermission);
    expect(result.errorCode, 'PERMISSION_REVOKED');
    expect(result.offset, bytes.length);
    service.close();
  });

  test('resumes from durable server offset after a mid-transfer server restart', () async {
    final bytes = [11, 12, 13, 14, 15, 16];
    final job = _job(bytes);
    await queue.enqueue(job);
    var remoteOffset = 0;
    var failOnce = true;
    var uploaded = <int>[];
    final client = MockClient((request) async {
      if (request.url.path == '/v1/uploads') {
        return http.Response('{"sessionId":"resume-1","offset":0,"state":"created"}', 201);
      }
      if (request.url.path == '/v1/uploads/resume-1') {
        return http.Response(jsonEncode({'sessionId': 'resume-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.endsWith('/chunks/0')) {
        uploaded.addAll(request.bodyBytes);
        remoteOffset = uploaded.length;
        return http.Response(jsonEncode({'sessionId': 'resume-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.endsWith('/chunks/1') && failOnce) {
        failOnce = false;
        return http.Response('server restarted', 503);
      }
      if (request.url.path.endsWith('/chunks/1')) {
        expect(request.headers['upload-offset'], '$remoteOffset');
        uploaded.addAll(request.bodyBytes);
        remoteOffset = uploaded.length;
        return http.Response(jsonEncode({'sessionId': 'resume-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.endsWith('/complete')) {
        return http.Response(jsonEncode({'sha256': sha256.convert(uploaded).toString(), 'byteLength': uploaded.length}), 200);
      }
      return http.Response('not found', 404);
    });
    final service = UploadService(queue: queue, settings: _Settings(), client: client,
        fileAccess: _MemoryFiles(bytes), chunkBytes: 3);

    final paused = await service.upload(job);
    expect(paused.state, UploadJobState.paused);
    expect(paused.sessionId, 'resume-1');
    expect(paused.offset, 3);
    final completed = await service.upload(paused);
    expect(completed.state, UploadJobState.completed);
    expect(uploaded, bytes);
    service.close();
  });

  test('does not mark completed when the server digest receipt differs', () async {
    final bytes = [21, 22, 23];
    final job = _job(bytes);
    await queue.enqueue(job);
    final client = MockClient((request) async {
      if (request.url.path == '/v1/uploads') return http.Response('{"sessionId":"bad-hash","offset":0}', 201);
      if (request.url.path == '/v1/uploads/bad-hash') return http.Response('{"sessionId":"bad-hash","offset":0,"state":"uploading"}', 200);
      if (request.url.path.contains('/chunks/')) return http.Response('{"sessionId":"bad-hash","offset":3}', 200);
      if (request.url.path.endsWith('/complete')) return http.Response(jsonEncode({'sha256': List<String>.filled(64, '0').join(), 'byteLength': 3}), 200);
      return http.Response('', 404);
    });
    final service = UploadService(queue: queue, settings: _Settings(), client: client, fileAccess: _MemoryFiles(bytes), chunkBytes: 3);

    final result = await service.upload(job);
    expect(result.state, UploadJobState.failed);
    expect(result.errorCode, 'SERVER_DIGEST_MISMATCH');
    expect((await queue.get(job.id))?.state, UploadJobState.failed);
    service.close();
  });

  test('rejects changed original bytes before creating a remote session', () async {
    final expected = [31, 32, 33];
    var requests = 0;
    final client = MockClient((_) async { requests++; return http.Response('', 500); });
    final service = UploadService(queue: queue, settings: _Settings(), client: client,
        fileAccess: _MemoryFiles([31, 32, 34]), chunkBytes: 3);

    final result = await service.upload(_job(expected));
    expect(result.state, UploadJobState.failed);
    expect(result.errorCode, 'SOURCE_CHANGED');
    expect(requests, 0);
    service.close();
  });

  test('keeps a gallery job in permission-required state when Android access is revoked', () async {
    final bytes = [41, 42, 43];
    final job = _job(bytes).copyWith();
    final galleryJob = UploadJob(
      id: 'gallery-job', assetId: 'media-store-id', filePath: job.filePath, originalPath: job.originalPath,
      filename: job.filename, totalBytes: job.totalBytes, sha256: job.sha256, idempotencyKey: job.idempotencyKey,
      state: UploadJobState.queued, createdAt: job.createdAt, updatedAt: job.updatedAt,
    );
    await queue.enqueue(galleryJob);
    await queue.markGalleryJobsNeedsPermission();

    final stored = await queue.get(galleryJob.id);
    expect(stored?.state, UploadJobState.needsPermission);
    expect(stored?.errorCode, 'PERMISSION_REVOKED');
    expect(await queue.runnable(), isEmpty);
    await queue.resumeGalleryJobs();
    expect((await queue.get(galleryJob.id))?.state, UploadJobState.queued);
  });

  test('marks gallery jobs when permission is denied and resumes limited access', () async {
    final base = _job([43, 44, 45]);
    final job = UploadJob(
      id: 'permission-transition-job', assetId: 'media-store-id', filePath: base.filePath,
      originalPath: base.originalPath, filename: base.filename, totalBytes: base.totalBytes,
      sha256: base.sha256, idempotencyKey: base.idempotencyKey, state: UploadJobState.queued,
      createdAt: base.createdAt, updatedAt: base.updatedAt,
    );
    await queue.enqueue(job);
    final gateway = _PermissionGateway();
    final library = PhotoLibraryService(queue: queue, gateway: gateway);

    await library.checkPermission();
    expect(await library.currentPermissionAllowsAccess(), isFalse);
    expect((await queue.get(job.id))?.state, UploadJobState.needsPermission);

    gateway.state = PermissionState.limited;
    expect(await library.currentPermissionAllowsAccess(), isTrue);
    await library.checkPermission();
    expect((await queue.get(job.id))?.state, UploadJobState.queued);
  });

  test('does not start a gallery upload when the source is unavailable after permission revocation', () async {
    final bytes = [44, 45, 46];
    final base = _job(bytes);
    final job = UploadJob(
      id: 'permission-job', assetId: 'revoked-media-id', filePath: base.filePath, originalPath: base.originalPath,
      filename: base.filename, totalBytes: base.totalBytes, sha256: base.sha256, idempotencyKey: base.idempotencyKey,
      state: UploadJobState.queued, createdAt: base.createdAt, updatedAt: base.updatedAt,
    );
    await queue.enqueue(job);
    var requests = 0;
    final client = MockClient((_) async { requests++; return http.Response('', 500); });
    final service = UploadService(
      queue: queue,
      settings: _Settings(),
      client: client,
      fileAccess: _MemoryFiles(bytes),
      resolveSource: (_) async => null,
      galleryPermissionAllowed: () async => false,
    );

    final result = await service.upload(job);
    expect(result.state, UploadJobState.needsPermission);
    expect(result.errorCode, 'PERMISSION_REVOKED');
    expect(requests, 0);
    service.close();
  });

  test('keeps an unavailable gallery source distinct when permission remains granted', () async {
    final bytes = [47, 48, 49];
    final base = _job(bytes);
    final job = UploadJob(
      id: 'missing-gallery-job', assetId: 'missing-media-id', filePath: base.filePath,
      originalPath: base.originalPath, filename: base.filename, totalBytes: base.totalBytes,
      sha256: base.sha256, idempotencyKey: base.idempotencyKey, state: UploadJobState.queued,
      createdAt: base.createdAt, updatedAt: base.updatedAt,
    );
    await queue.enqueue(job);
    var requests = 0;
    final client = MockClient((_) async { requests++; return http.Response('', 500); });
    final service = UploadService(
      queue: queue,
      settings: _Settings(),
      client: client,
      fileAccess: _MemoryFiles(bytes),
      resolveSource: (_) async => null,
      galleryPermissionAllowed: () async => true,
    );

    final result = await service.upload(job);
    expect(result.state, UploadJobState.needsPermission);
    expect(result.errorCode, 'SOURCE_UNAVAILABLE');
    expect(requests, 0);
    service.close();
  });

  test('pauses a gallery upload after permission revocation and resumes from its saved offset', () async {
    final bytes = [61, 62, 63, 64, 65, 66];
    final base = _job(bytes);
    final job = UploadJob(
      id: 'permission-resume-job', assetId: 'media-store-id', filePath: '/fixture/gallery.bin',
      originalPath: 'DCIM/Camera/gallery.bin', filename: 'gallery.bin', totalBytes: bytes.length,
      sha256: base.sha256, idempotencyKey: base.idempotencyKey, state: UploadJobState.queued,
      createdAt: base.createdAt, updatedAt: base.updatedAt,
    );
    await queue.enqueue(job);
    var permissionAllowed = true;
    var permissionChecks = 0;
    var resolverCalls = 0;
    var createRequests = 0;
    var remoteOffset = 0;
    var uploaded = <int>[];
    final chunkIndexes = <int>[];
    var completeRequests = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/v1/uploads') {
        createRequests++;
        return http.Response('{"sessionId":"permission-resume-1","offset":0,"state":"created"}', 201);
      }
      if (request.url.path == '/v1/uploads/permission-resume-1') {
        return http.Response(jsonEncode({'sessionId': 'permission-resume-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.contains('/chunks/')) {
        final index = int.parse(request.url.path.split('/').last);
        chunkIndexes.add(index);
        expect(request.headers['upload-offset'], '$remoteOffset');
        uploaded.addAll(request.bodyBytes);
        remoteOffset = uploaded.length;
        if (index == 0) permissionAllowed = false;
        return http.Response(jsonEncode({'sessionId': 'permission-resume-1', 'offset': remoteOffset, 'state': 'uploading'}), 200);
      }
      if (request.url.path.endsWith('/complete')) {
        completeRequests++;
        return http.Response(jsonEncode({'sha256': sha256.convert(uploaded).toString(), 'byteLength': uploaded.length}), 200);
      }
      return http.Response('not found', 404);
    });
    final service = UploadService(
      queue: queue,
      settings: _Settings(),
      client: client,
      fileAccess: _MemoryFiles(bytes),
      resolveSource: (_) async { resolverCalls++; return '/fixture/gallery.bin'; },
      galleryPermissionAllowed: () async { permissionChecks++; return permissionAllowed; },
      chunkBytes: 3,
    );

    final paused = await service.upload(job);
    expect(paused.state, UploadJobState.needsPermission);
    expect(paused.errorCode, 'PERMISSION_REVOKED');
    expect(paused.offset, 3);
    expect(paused.sessionId, 'permission-resume-1');
    expect(chunkIndexes, [0]);
    expect(completeRequests, 0);
    expect(permissionChecks, 2);
    expect(resolverCalls, 1);
    final persisted = (await queue.get(job.id))!;
    expect(persisted.state, UploadJobState.needsPermission);
    expect(persisted.offset, 3);
    expect(persisted.sessionId, 'permission-resume-1');

    permissionAllowed = true;
    await queue.resumeGalleryJobs();
    final resumed = (await queue.get(job.id))!;
    expect(resumed.state, UploadJobState.queued);
    final completed = await service.upload(resumed);
    expect(completed.state, UploadJobState.completed);
    expect(completed.offset, bytes.length);
    expect(chunkIndexes, [0, 1]);
    expect(uploaded, bytes);
    expect(completeRequests, 1);
    expect(createRequests, 1);
    expect(permissionChecks, 3);
    expect(resolverCalls, 2);
    service.close();
  });

  test('persists job identity, original path, session, and offset across database reopen', () async {
    final job = _job([51, 52, 53]).copyWith(sessionId: 'persisted-session', offset: 3);
    await queue.enqueue(job);
    await queue.close();
    queue = UploadQueue(factory: databaseFactoryFfi, path: '${tempDirectory.path}${Platform.pathSeparator}queue.db');

    final restored = await queue.get(job.id);
    expect(restored?.idempotencyKey, job.idempotencyKey);
    expect(restored?.originalPath, 'DCIM/Camera/original.bin');
    expect(restored?.sessionId, 'persisted-session');
    expect(restored?.offset, 3);
  });

  test('applies Wi-Fi, any-network, and manual policies explicitly', () async {
    expect(await networkPolicyAllows(NetworkPolicy.wifiOnly, [ConnectivityResult.mobile]), isFalse);
    expect(await networkPolicyAllows(NetworkPolicy.wifiOnly, [ConnectivityResult.wifi]), isTrue);
    expect(await networkPolicyAllows(NetworkPolicy.anyNetwork, [ConnectivityResult.mobile]), isTrue);
    expect(await networkPolicyAllows(NetworkPolicy.anyNetwork, [ConnectivityResult.ethernet]), isFalse);
    expect(await networkPolicyAllows(NetworkPolicy.anyNetwork, [ConnectivityResult.none]), isFalse);
    expect(await networkPolicyAllows(NetworkPolicy.manualOnly, [ConnectivityResult.wifi]), isFalse);
  });
}
