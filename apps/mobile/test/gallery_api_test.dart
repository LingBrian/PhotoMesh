import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:photomesh_mobile/gallery_api.dart';

MobileAsset _asset({
  MediaAvailability availability = MediaAvailability.online,
  int byteSize = 4,
  String kind = 'photo',
  String assetId = 'asset-1',
}) =>
    MobileAsset(
      assetId: assetId,
      libraryId: 'library-1',
      originNodeId: 'node-1',
      kind: kind,
      sha256: List.filled(64, 'a').join(),
      availability: availability,
      filename: 'photo.jpg',
      capturedAt: '2024-01-02T03:04:05.000Z',
      sourcePath: null,
      sourceKind: 'import',
      byteSize: byteSize,
      version: 'v1',
    );

Map<String, Object?> _assetJson() => {
      'assetId': 'asset-1',
      'libraryId': 'library-1',
      'originNodeId': 'node-1',
      'kind': 'photo',
      'sha256': List.filled(64, 'a').join(),
      'availability': 'online',
      'filename': 'photo.jpg',
      'capturedAt': '2024-01-02T03:04:05.000Z',
      'sourcePath': null,
      'sourceKind': 'import',
      'byteSize': 4,
      'version': 'v1',
    };

void main() {
  test('loads a cursor page from the bound library with the bearer token',
      () async {
    final client = MockClient((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/v1/assets');
      expect(request.url.queryParameters,
          {'libraryId': 'library-1', 'limit': '40'});
      expect(request.headers['authorization'], 'Bearer secret-token');
      return http.Response(
          jsonEncode({
            'items': [_assetJson()],
            'nextCursor': 'next-1'
          }),
          200);
    });
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: client,
      pageSize: 40,
    );

    final page = await api.loadPage();
    expect(page.items, hasLength(1));
    expect(page.items.single.filename, 'photo.jpg');
    expect(page.items.single.availability, MediaAvailability.online);
    expect(page.nextCursor, 'next-1');
    api.close();
  });

  test('loads original bytes only for an available, bounded photo preview',
      () async {
    var requests = 0;
    final client = MockClient((request) async {
      requests++;
      expect(request.url.path, '/v1/assets/asset-1/original');
      expect(request.headers['authorization'], 'Bearer secret-token');
      return http.Response.bytes([1, 2, 3, 4], 200,
          headers: {'cache-control': 'no-store'});
    });
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example/',
      libraryId: 'library-1',
      token: 'secret-token',
      client: client,
      maxPreviewBytes: 8,
    );

    expect(await api.loadPreview(_asset()), [1, 2, 3, 4]);
    expect(requests, 1);
    api.close();
  });

  test('encodes asset IDs as one path segment', () async {
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient((request) async {
        expect(request.url.pathSegments,
            ['v1', 'assets', 'asset/with space', 'original']);
        return http.Response.bytes([1], 200);
      }),
    );

    await api.loadPreview(_asset(assetId: 'asset/with space'));
    api.close();
  });

  test('does not request offline, unsupported, or oversized media', () async {
    var requests = 0;
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient((_) async {
        requests++;
        return http.Response('', 200);
      }),
      maxPreviewBytes: 8,
    );

    await expectLater(
        api.loadPreview(_asset(availability: MediaAvailability.offline)),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'source-offline')));
    await expectLater(
        api.loadPreview(_asset(kind: 'video')),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'unsupported-media')));
    await expectLater(
        api.loadPreview(_asset(byteSize: 9)),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'preview-too-large')));
    expect(requests, 0);
    api.close();
  });

  test('maps ACL denial and offline responses without returning error bodies',
      () async {
    var status = 404;
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient(
          (_) async => http.Response('sensitive internal response', status)),
    );

    await expectLater(
        api.loadPreview(_asset()),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'asset-unavailable')));
    status = 409;
    await expectLater(
        api.loadPreview(_asset()),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'source-offline')));
    api.close();
  });

  test('capability and immutable version creation use bearer auth and idempotency', () async {
    final calls=<http.Request>[];
    final api=MobileGalleryApi(baseUrl:'https://node.example',libraryId:'library-1',token:'secret-token',client:MockClient((r) async {calls.add(r); if(r.url.path=='/v1/health') return http.Response('{"capabilities":["mediaVersions"]}',200); return http.Response('{"operationId":"op1","versionId":"ver1","status":"staging"}',202); }));
    expect(await api.supportsMediaVersions(),isTrue);
    final result=await api.createVersion(_asset(),sourceVersionId:null,sourceSha256: List.filled(64, 'a').join(),transform:{'crop':{'x':0,'y':0,'width':1000000,'height':1000000},'rotation':90},idempotencyKey:'idem-key-12345678');
    expect(result['versionId'],'ver1');
    expect(calls.last.headers['authorization'],'Bearer secret-token');
    expect(jsonDecode(calls.last.body)['idempotencyKey'],'idem-key-12345678');
    api.close();
  });

  test('rejects invalid crop bounds before network request', () async {
    var requests=0;
    final api=MobileGalleryApi(baseUrl:'https://node.example',libraryId:'library-1',token:'t',client:MockClient((_) async {requests++;return http.Response('',202);}));
    await expectLater(api.createVersion(_asset(),sourceVersionId:null,sourceSha256: List.filled(64, 'a').join(),transform:{'crop':{'x':900000,'y':0,'width':200000,'height':1000000},'rotation':0},idempotencyKey:'k'),throwsA(isA<MobileGalleryException>()));
    expect(requests,0);api.close();
  });

  test('version content uses encoded path segments, bearer auth, and no-store', () async {
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient((request) async {
        expect(
          request.url.pathSegments,
          ['v1', 'libraries', 'library-1', 'assets', 'asset/with space', 'versions', 'version-1', 'content'],
        );
        expect(request.headers['authorization'], 'Bearer secret-token');
        expect(request.headers['cache-control'], 'no-store');
        return http.Response.bytes([5, 6, 7], 200);
      }),
    );

    expect(
      await api.loadVersionContent(
        _asset(assetId: 'asset/with space'),
        'version-1',
      ),
      [5, 6, 7],
    );
    api.close();
  });

  test('rejects oversized derived content before buffering it', () async {
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient((_) async => http.Response.bytes(
            [],
            200,
            headers: {'content-length': '${maxMobilePreviewBytes + 1}'},
          )),
    );

    await expectLater(
      api.loadVersionContent(_asset(), 'version-1'),
      throwsA(isA<MobileGalleryException>()
          .having((error) => error.code, 'code', 'preview-too-large')),
    );
    api.close();
  });

  test('rejects a response that exceeds the preview budget', () async {
    final api = MobileGalleryApi(
      baseUrl: 'https://node.example',
      libraryId: 'library-1',
      token: 'secret-token',
      client: MockClient(
          (_) async => http.Response.bytes(List<int>.filled(10, 1), 200)),
      maxPreviewBytes: 8,
    );

    await expectLater(
        api.loadPreview(_asset(byteSize: 4)),
        throwsA(isA<MobileGalleryException>()
            .having((error) => error.code, 'code', 'preview-too-large')));
    api.close();
  });
}
