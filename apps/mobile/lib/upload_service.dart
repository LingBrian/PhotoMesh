import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'node_settings.dart';
import 'upload_job.dart';
import 'upload_queue.dart';

const uploadChunkBytes = 4 * 1024 * 1024;

abstract interface class UploadFileAccess {
  Future<int> length(String path);
  Stream<List<int>> openRead(String path, {int? start, int? end});
}

typedef ResolveUploadSource = Future<String?> Function(UploadJob job);

class IoUploadFileAccess implements UploadFileAccess {
  const IoUploadFileAccess();
  @override
  Future<int> length(String path) => File(path).length();
  @override
  Stream<List<int>> openRead(String path, {int? start, int? end}) => File(path).openRead(start, end);
}

class UploadService {
  UploadService({
    required UploadQueue queue,
    required NodeSettingsStore settings,
    http.Client? client,
    UploadFileAccess fileAccess = const IoUploadFileAccess(),
    ResolveUploadSource? resolveSource,
    Future<bool> Function()? networkAllowed,
    Duration requestTimeout = const Duration(seconds: 30),
    int chunkBytes = uploadChunkBytes,
  })  : _queue = queue,
        _settings = settings,
        _client = client ?? http.Client(),
        _files = fileAccess,
        _resolveSource = resolveSource,
        _networkAllowed = networkAllowed,
        _requestTimeout = requestTimeout,
        _chunkBytes = chunkBytes;

  final UploadQueue _queue;
  final NodeSettingsStore _settings;
  final http.Client _client;
  final UploadFileAccess _files;
  final ResolveUploadSource? _resolveSource;
  final Future<bool> Function()? _networkAllowed;
  final Duration _requestTimeout;
  final int _chunkBytes;

  Future<UploadJob> upload(UploadJob job) async {
    var current = job;
    final node = await _settings.loadNode();
    final token = await _settings.loadToken();
    if (node == null || token == null || token.isEmpty) return _save(job.copyWith(state: UploadJobState.failed, errorCode: 'NODE_NOT_BOUND'));
    try {
      final resolvedPath = await _resolveSource?.call(job);
      if (resolvedPath != null) current = current.copyWith(filePath: resolvedPath);
      if (resolvedPath == null && job.assetId != null && _resolveSource != null) {
        return await _save(current.copyWith(state: UploadJobState.needsPermission, errorCode: 'SOURCE_UNAVAILABLE'));
      }
      if (await _files.length(current.filePath) != current.totalBytes) {
        return await _save(current.copyWith(state: UploadJobState.failed, errorCode: 'SOURCE_CHANGED'));
      }
      final digest = await sha256.bind(_files.openRead(current.filePath)).first;
      if (digest.toString() != current.sha256) {
        return await _save(current.copyWith(state: UploadJobState.failed, errorCode: 'SOURCE_CHANGED'));
      }

      current = current.copyWith(state: UploadJobState.uploading, clearError: true);
      await _queue.save(current);
      final headers = {'authorization': 'Bearer $token'};
      var sessionId = current.sessionId;
      if (sessionId == null) {
        final create = await _client.post(
          _uri(node, '/v1/uploads'),
          headers: {...headers, 'content-type': 'application/json', 'idempotency-key': current.idempotencyKey},
          body: jsonEncode({
            'libraryId': node.libraryId,
            'filename': current.filename,
            'originalPath': current.originalPath,
            'sourceKind': 'upload',
            'sourceNodeId': node.nodeId,
            'kind': _kindOf(current.filename),
            'totalBytes': current.totalBytes,
            'sha256': current.sha256,
          }),
        ).timeout(_requestTimeout);
        _expectSuccess(create, {201});
        sessionId = (jsonDecode(create.body) as Map<String, dynamic>)['sessionId'] as String;
        current = current.copyWith(sessionId: sessionId);
        await _queue.save(current);
      }

      final sessionResponse = await _client.get(_uri(node, '/v1/uploads/$sessionId'), headers: headers).timeout(_requestTimeout);
      _expectSuccess(sessionResponse, {200});
      final session = jsonDecode(sessionResponse.body) as Map<String, dynamic>;
      if (session['state'] == 'completed') return await _completeAndConfirm(node, headers, current, sessionId);
      var offset = session['offset'] as int;
      if (offset < 0 || offset > current.totalBytes || (offset != current.totalBytes && offset % _chunkBytes != 0)) {
        return await _save(current.copyWith(state: UploadJobState.failed, errorCode: 'SERVER_OFFSET_INVALID'));
      }
      current = current.copyWith(offset: offset);
      await _queue.save(current);
      var index = offset ~/ _chunkBytes;
      while (offset < current.totalBytes) {
        if (_networkAllowed != null && !await _networkAllowed()) {
          return await _save(current.copyWith(state: UploadJobState.paused, errorCode: 'NETWORK_POLICY_BLOCKED'));
        }
        final end = min(offset + _chunkBytes, current.totalBytes);
        final bytes = await _readRange(current.filePath, offset, end);
        final partHash = sha256.convert(bytes).toString();
        final response = await _client.put(
          _uri(node, '/v1/uploads/$sessionId/chunks/$index'),
          headers: {...headers, 'content-type': 'application/octet-stream', 'upload-offset': '$offset', 'upload-chunk-sha256': partHash},
          body: bytes,
        ).timeout(_requestTimeout);
        _expectSuccess(response, {200});
        final body = jsonDecode(response.body) as Map<String, dynamic>;
        final acceptedOffset = body['offset'] as int;
        if (acceptedOffset != end) {
          return await _save(current.copyWith(state: UploadJobState.failed, errorCode: 'SERVER_OFFSET_INVALID'));
        }
        offset = acceptedOffset;
        index++;
        current = current.copyWith(offset: offset);
        await _queue.save(current);
      }
      return await _completeAndConfirm(node, headers, current, sessionId);
    } on SocketException {
      return _save(current.copyWith(state: UploadJobState.paused, errorCode: 'NETWORK_UNAVAILABLE'));
    } on http.ClientException {
      return _save(current.copyWith(state: UploadJobState.paused, errorCode: 'NETWORK_UNAVAILABLE'));
    } on TimeoutException {
      return _save(current.copyWith(state: UploadJobState.paused, errorCode: 'NETWORK_TIMEOUT'));
    } on FileSystemException {
      return _save(current.copyWith(state: UploadJobState.needsPermission, errorCode: 'SOURCE_UNAVAILABLE'));
    } on UploadHttpException catch (error) {
      final state = error.statusCode == 507 || error.statusCode >= 500 ? UploadJobState.paused : UploadJobState.failed;
      return _save(current.copyWith(state: state, errorCode: 'HTTP_${error.statusCode}'));
    }
  }

  Future<UploadJob> _completeAndConfirm(BoundNode node, Map<String, String> headers, UploadJob job, String sessionId) async {
    final response = await _client.post(_uri(node, '/v1/uploads/$sessionId/complete'),
        headers: {...headers, 'content-type': 'application/json'}, body: '{}').timeout(_requestTimeout);
    _expectSuccess(response, {200});
    final result = jsonDecode(response.body) as Map<String, dynamic>;
    if (result['sha256'] != job.sha256 || result['byteLength'] != job.totalBytes) {
      return _save(job.copyWith(state: UploadJobState.failed, errorCode: 'SERVER_DIGEST_MISMATCH'));
    }
    return _save(job.copyWith(state: UploadJobState.completed, offset: job.totalBytes, clearError: true));
  }

  Future<List<int>> _readRange(String path, int start, int end) async {
    final chunks = <int>[];
    await for (final chunk in _files.openRead(path, start: start, end: end)) {
      chunks.addAll(chunk);
    }
    if (chunks.length != end - start) throw const FileSystemException('Read range length changed');
    return chunks;
  }

  Uri _uri(BoundNode node, String path) => Uri.parse('${node.baseUrl}$path');

  Future<UploadJob> _save(UploadJob value) async {
    await _queue.save(value);
    return value;
  }

  static String _kindOf(String filename) {
    final ext = filename.split('.').last.toLowerCase();
    return const {'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'}.contains(ext) ? 'video' : 'photo';
  }

  void close() => _client.close();
}

class UploadHttpException implements Exception {
  const UploadHttpException(this.statusCode);
  final int statusCode;
}

void _expectSuccess(http.Response response, Set<int> expected) {
  if (!expected.contains(response.statusCode)) throw UploadHttpException(response.statusCode);
}

String createIdempotencyKey() {
  final random = Random.secure();
  return List<int>.generate(24, (_) => random.nextInt(256)).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
}
