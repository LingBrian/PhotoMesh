import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

const maxMobilePreviewBytes = 32 * 1024 * 1024;

enum MediaAvailability { online, cached, offline, missing }

class MobileAsset {
  const MobileAsset({
    required this.assetId,
    required this.libraryId,
    required this.originNodeId,
    required this.kind,
    required this.sha256,
    required this.availability,
    required this.filename,
    required this.capturedAt,
    required this.sourcePath,
    required this.sourceKind,
    required this.byteSize,
    required this.version,
  });

  final String assetId;
  final String libraryId;
  final String originNodeId;
  final String kind;
  final String sha256;
  final MediaAvailability availability;
  final String filename;
  final String? capturedAt;
  final String? sourcePath;
  final String sourceKind;
  final int byteSize;
  final String version;

  factory MobileAsset.fromJson(Map<String, dynamic> json) {
    final availability = switch (json['availability']) {
      'online' => MediaAvailability.online,
      'cached' => MediaAvailability.cached,
      'offline' => MediaAvailability.offline,
      'missing' => MediaAvailability.missing,
      _ => MediaAvailability.missing,
    };
    final byteSize = json['byteSize'];
    if (json['assetId'] is! String ||
        (json['assetId'] as String).isEmpty ||
        json['libraryId'] is! String ||
        json['originNodeId'] is! String ||
        json['kind'] is! String ||
        json['sha256'] is! String ||
        json['filename'] is! String ||
        json['sourceKind'] is! String ||
        byteSize is! int ||
        byteSize < 0 ||
        json['version'] is! String ||
        json['capturedAt'] != null && json['capturedAt'] is! String ||
        json['sourcePath'] != null && json['sourcePath'] is! String) {
      throw const MobileGalleryException('invalid-response');
    }
    return MobileAsset(
      assetId: json['assetId'] as String,
      libraryId: json['libraryId'] as String,
      originNodeId: json['originNodeId'] as String,
      kind: json['kind'] as String,
      sha256: json['sha256'] as String,
      availability: availability,
      filename: json['filename'] as String,
      capturedAt: json['capturedAt'] as String?,
      sourcePath: json['sourcePath'] as String?,
      sourceKind: json['sourceKind'] as String,
      byteSize: byteSize,
      version: json['version'] as String,
    );
  }
}

class MobileAssetPage {
  const MobileAssetPage({required this.items, required this.nextCursor});
  final List<MobileAsset> items;
  final String? nextCursor;
}

abstract interface class MobileGallerySource {
  String get libraryId;
  Future<MobileAssetPage> loadPage({String? cursor});
  Future<Uint8List> loadPreview(MobileAsset asset);
  void close();
}

/// Optional extension so existing gallery fakes need not implement editing.
abstract interface class MobileGalleryVersionSource {
  Future<bool> supportsMediaVersions();
  Future<List<Map<String, dynamic>>> loadVersions(MobileAsset asset);
  Future<Map<String, dynamic>> createVersion(
    MobileAsset asset, {
    required String? sourceVersionId,
    required String sourceSha256,
    required Map<String, dynamic> transform,
    required String idempotencyKey,
  });
  Future<Map<String, dynamic>> loadVersion(
    MobileAsset asset,
    String versionId,
  );
  Future<Uint8List> loadVersionContent(MobileAsset asset, String versionId);
}

class MobileGalleryException implements Exception {
  const MobileGalleryException(this.code);
  final String code;

  @override
  String toString() => code;
}

class MobileGalleryApi implements MobileGallerySource, MobileGalleryVersionSource {
  MobileGalleryApi({
    required String baseUrl,
    required this.libraryId,
    required String token,
    http.Client? client,
    this.pageSize = 100,
    this.maxPreviewBytes = maxMobilePreviewBytes,
    this.requestTimeout = const Duration(seconds: 30),
  })  : _baseUrl = baseUrl.trim().replaceFirst(RegExp(r'/+$'), ''),
        _token = token.trim(),
        _client = client ?? http.Client() {
    if (pageSize < 1 || pageSize > 200 || maxPreviewBytes < 1) {
      throw ArgumentError('Invalid gallery API limits');
    }
  }

  final String _baseUrl;
  @override
  final String libraryId;
  final String _token;
  final http.Client _client;
  final int pageSize;
  final int maxPreviewBytes;
  final Duration requestTimeout;

  @override
  Future<MobileAssetPage> loadPage({String? cursor}) async {
    _requireToken();
    final query = <String, String>{
      'libraryId': libraryId,
      'limit': '$pageSize'
    };
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;
    try {
      final response = await _client
          .get(
            _uri(['v1', 'assets'], queryParameters: query),
            headers: _headers,
          )
          .timeout(requestTimeout);
      if (response.statusCode == 401) {
        throw const MobileGalleryException('unauthorized');
      }
      if (response.statusCode == 403 || response.statusCode == 404) {
        throw const MobileGalleryException('library-unavailable');
      }
      if (response.statusCode != 200) {
        throw const MobileGalleryException('request-failed');
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic> || decoded['items'] is! List) {
        throw const MobileGalleryException('invalid-response');
      }
      final items = (decoded['items'] as List).map((item) {
        if (item is! Map<String, dynamic>) {
          throw const MobileGalleryException('invalid-response');
        }
        return MobileAsset.fromJson(item);
      }).toList(growable: false);
      final nextCursor = decoded['nextCursor'];
      if (nextCursor != null && nextCursor is! String) {
        throw const MobileGalleryException('invalid-response');
      }
      return MobileAssetPage(items: items, nextCursor: nextCursor as String?);
    } on MobileGalleryException {
      rethrow;
    } on TimeoutException {
      throw const MobileGalleryException('request-failed');
    } on FormatException {
      throw const MobileGalleryException('invalid-response');
    } on http.ClientException {
      throw const MobileGalleryException('request-failed');
    } catch (_) {
      throw const MobileGalleryException('request-failed');
    }
  }

  @override
  Future<Uint8List> loadPreview(MobileAsset asset) async {
    if (asset.kind != 'photo') {
      throw const MobileGalleryException('unsupported-media');
    }
    if (asset.availability != MediaAvailability.online &&
        asset.availability != MediaAvailability.cached) {
      throw const MobileGalleryException('source-offline');
    }
    if (asset.byteSize <= 0 || asset.byteSize > maxPreviewBytes) {
      throw const MobileGalleryException('preview-too-large');
    }
    _requireToken();

    try {
      final request = http.Request(
        'GET',
        _uri(['v1', 'assets', asset.assetId, 'original']),
      )..headers.addAll({..._headers, 'cache-control': 'no-store'});
      final response = await _client.send(request).timeout(requestTimeout);
      if (response.statusCode == 409) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('source-offline');
      }
      if (response.statusCode == 401) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('unauthorized');
      }
      if (response.statusCode == 403 || response.statusCode == 404) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('asset-unavailable');
      }
      if (response.statusCode != 200) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('request-failed');
      }
      final contentLength =
          int.tryParse(response.headers['content-length'] ?? '');
      if (contentLength != null && contentLength > maxPreviewBytes) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('preview-too-large');
      }
      final body = BytesBuilder(copy: false);
      var received = 0;
      await for (final chunk in response.stream.timeout(requestTimeout)) {
        received += chunk.length;
        if (received > maxPreviewBytes) {
          throw const MobileGalleryException('preview-too-large');
        }
        body.add(chunk);
      }
      final bytes = body.takeBytes();
      if (bytes.isEmpty) {
        throw const MobileGalleryException('unsupported-media');
      }
      return bytes;
    } on MobileGalleryException {
      rethrow;
    } on TimeoutException {
      throw const MobileGalleryException('request-failed');
    } on http.ClientException {
      throw const MobileGalleryException('request-failed');
    } catch (_) {
      throw const MobileGalleryException('request-failed');
    }
  }

  List<String> _versionPath(MobileAsset asset) => [
        'v1',
        'libraries',
        asset.libraryId,
        'assets',
        asset.assetId,
        'versions',
      ];

  @override
  Future<bool> supportsMediaVersions() async {
    _requireToken();
    try {
      final response = await _client
          .get(_uri(['v1', 'health']), headers: _headers)
          .timeout(requestTimeout);
      if (response.statusCode != 200) return false;
      final body = jsonDecode(response.body);
      return body is Map &&
          body['capabilities'] is List &&
          (body['capabilities'] as List).contains('mediaVersions');
    } catch (_) {
      return false;
    }
  }

  @override
  Future<List<Map<String, dynamic>>> loadVersions(MobileAsset asset) async {
    _requireToken();
    final response = await _client
        .get(_uri(_versionPath(asset)), headers: _headers)
        .timeout(requestTimeout);
    if (response.statusCode == 401 || response.statusCode == 403) {
      throw const MobileGalleryException('unauthorized');
    }
    if (response.statusCode != 200) {
      throw const MobileGalleryException('request-failed');
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map || decoded['items'] is! List) {
      throw const MobileGalleryException('invalid-response');
    }
    final items = decoded['items'] as List;
    if (items.any((item) => item is! Map<String, dynamic>)) {
      throw const MobileGalleryException('invalid-response');
    }
    return items.cast<Map<String, dynamic>>();
  }

  @override
  Future<Map<String, dynamic>> createVersion(
    MobileAsset asset, {
    required String? sourceVersionId,
    required String sourceSha256,
    required Map<String, dynamic> transform,
    required String idempotencyKey,
  }) async {
    final crop = transform['crop'];
    final hasExactTransformKeys = transform.length == 2 &&
        transform.containsKey('crop') &&
        transform.containsKey('rotation');
    final validCrop = hasExactTransformKeys &&
        crop is Map &&
        crop.length == 4 &&
        const ['x', 'y', 'width', 'height'].every((key) => crop[key] is int) &&
        (crop['x'] as int) >= 0 &&
        (crop['y'] as int) >= 0 &&
        (crop['width'] as int) > 0 &&
        (crop['height'] as int) > 0 &&
        (crop['x'] as int) + (crop['width'] as int) <= 1000000 &&
        (crop['y'] as int) + (crop['height'] as int) <= 1000000;
    final rotation = transform['rotation'];
    final isNoOp = validCrop &&
        (crop['x'] as int) == 0 &&
        (crop['y'] as int) == 0 &&
        (crop['width'] as int) == 1000000 &&
        (crop['height'] as int) == 1000000 &&
        rotation == 0;
    if (asset.kind != 'photo' ||
        _mimeFromName(asset.filename) == null ||
        !validCrop ||
        isNoOp ||
        !const [0, 90, 180, 270].contains(rotation) ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(sourceSha256) ||
        sourceVersionId != null && sourceVersionId.isEmpty ||
        !RegExp(r'^[A-Za-z0-9._~-]{16,128}$').hasMatch(idempotencyKey)) {
      throw const MobileGalleryException('invalid-transform');
    }
    _requireToken();
    try {
      final response = await _client
          .post(
            _uri(_versionPath(asset)),
            headers: {..._headers, 'content-type': 'application/json'},
            body: jsonEncode({
              'sourceVersionId': sourceVersionId,
              'sourceSha256': sourceSha256,
              'transform': transform,
              'idempotencyKey': idempotencyKey,
            }),
          )
          .timeout(requestTimeout);
      if (response.statusCode == 401 || response.statusCode == 403) {
        throw const MobileGalleryException('unauthorized');
      }
      if (response.statusCode == 409) {
        throw const MobileGalleryException('source-changed');
      }
      if (response.statusCode == 413) {
        throw const MobileGalleryException('preview-too-large');
      }
      if (response.statusCode == 415) {
        throw const MobileGalleryException('unsupported-media');
      }
      if (response.statusCode == 503) {
        throw const MobileGalleryException('version-unavailable');
      }
      if (response.statusCode != 202) {
        throw const MobileGalleryException('request-failed');
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic> ||
          decoded['versionId'] is! String ||
          decoded['operationId'] is! String) {
        throw const MobileGalleryException('invalid-response');
      }
      return decoded;
    } on MobileGalleryException {
      rethrow;
    } on TimeoutException {
      throw const MobileGalleryException('request-failed');
    } on http.ClientException {
      throw const MobileGalleryException('request-failed');
    } on FormatException {
      throw const MobileGalleryException('invalid-response');
    } catch (_) {
      throw const MobileGalleryException('request-failed');
    }
  }

  @override
  Future<Map<String, dynamic>> loadVersion(
    MobileAsset asset,
    String versionId,
  ) async {
    _requireToken();
    final response = await _client
        .get(
          _uri([..._versionPath(asset), versionId]),
          headers: _headers,
        )
        .timeout(requestTimeout);
    if (response.statusCode == 401 || response.statusCode == 403) {
      throw const MobileGalleryException('unauthorized');
    }
    if (response.statusCode != 200) {
      throw const MobileGalleryException('request-failed');
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map<String, dynamic>) {
      throw const MobileGalleryException('invalid-response');
    }
    return decoded;
  }

  @override
  Future<Uint8List> loadVersionContent(
    MobileAsset asset,
    String versionId,
  ) async {
    _requireToken();
    final request = http.Request(
      'GET',
      _uri([..._versionPath(asset), versionId, 'content']),
    )..headers.addAll({..._headers, 'cache-control': 'no-store'});
    try {
      final response = await _client.send(request).timeout(requestTimeout);
      if (response.statusCode == 401 || response.statusCode == 403) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('unauthorized');
      }
      if (response.statusCode != 200) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('version-unavailable');
      }
      final contentLength = int.tryParse(
        response.headers['content-length'] ?? '',
      );
      if (contentLength != null && contentLength > maxMobilePreviewBytes) {
        await response.stream.listen((_) {}).cancel();
        throw const MobileGalleryException('preview-too-large');
      }
      final body = BytesBuilder(copy: false);
      var received = 0;
      await for (final chunk in response.stream.timeout(requestTimeout)) {
        received += chunk.length;
        if (received > maxMobilePreviewBytes) {
          throw const MobileGalleryException('preview-too-large');
        }
        body.add(chunk);
      }
      final bytes = body.takeBytes();
      if (bytes.isEmpty) {
        throw const MobileGalleryException('version-unavailable');
      }
      return bytes;
    } on MobileGalleryException {
      rethrow;
    } on TimeoutException {
      throw const MobileGalleryException('request-failed');
    } on http.ClientException {
      throw const MobileGalleryException('request-failed');
    } catch (_) {
      throw const MobileGalleryException('request-failed');
    }
  }

  String? _mimeFromName(String name) {
    final normalized = name.toLowerCase();
    if (normalized.endsWith('.png')) return 'image/png';
    if (normalized.endsWith('.webp')) return 'image/webp';
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    return null;
  }

  Map<String, String> get _headers => {'authorization': 'Bearer $_token'};

  void _requireToken() {
    if (_token.isEmpty) throw const MobileGalleryException('unauthorized');
  }

  Uri _uri(List<String> pathSegments, {Map<String, String>? queryParameters}) {
    final base = Uri.parse(_baseUrl);
    final prefixSegments =
        base.pathSegments.where((segment) => segment.isNotEmpty);
    return base.replace(
      pathSegments: [...prefixSegments, ...pathSegments],
      queryParameters: queryParameters ?? const <String, String>{},
      fragment: '',
    );
  }

  @override
  void close() => _client.close();
}
