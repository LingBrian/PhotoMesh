import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/gallery_api.dart';
import 'package:photomesh_mobile/remote_gallery.dart';

final _tinyPng = Uint8List.fromList([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0,
  5, 0, 1, 165, 246, 69, 64, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);

MobileAsset _asset() => const MobileAsset(
      assetId: 'asset-1',
      libraryId: 'library-1',
      originNodeId: 'node-1',
      kind: 'photo',
      sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      availability: MediaAvailability.online,
      filename: 'photo.jpg',
      capturedAt: '2024-01-02T03:04:05.000Z',
      sourcePath: null,
      sourceKind: 'import',
      byteSize: 4,
      version: 'v1',
    );

class _FakeGallerySource implements MobileGallerySource {
  _FakeGallerySource({required this.asset, this.failPreview = false});

  final MobileAsset asset;
  final bool failPreview;
  int originalReads = 0;
  bool closed = false;

  @override
  String get libraryId => asset.libraryId;

  @override
  Future<MobileAssetPage> loadPage({String? cursor}) async =>
      MobileAssetPage(items: [asset], nextCursor: null);

  @override
  Future<Uint8List> loadPreview(MobileAsset requestedAsset) async {
    originalReads++;
    if (failPreview) throw const MobileGalleryException('asset-unavailable');
    return _tinyPng;
  }

  @override
  void close() => closed = true;
}

class _FakeVersionSource extends _FakeGallerySource
    implements MobileGalleryVersionSource {
  _FakeVersionSource({
    required super.asset,
    this.capability = true,
    this.failVersionContent = false,
    this.failFirstVersionStatus = false,
  });
  final bool capability;
  final bool failVersionContent;
  final bool failFirstVersionStatus;
  String? createdSourceVersionId;
  String? createdSourceSha256;
  final List<String> createdIdempotencyKeys = [];
  int versionReads = 0;
  int _statusReads = 0;

  @override
  Future<bool> supportsMediaVersions() async => capability;
  @override
  Future<List<Map<String, dynamic>>> loadVersions(MobileAsset asset) async => [
        {'versionId': 'version-1', 'status': 'ready', 'outputSha256': List.filled(64, 'b').join()},
        {'versionId': 'version-pending', 'status': 'staging'},
      ];
  @override
  Future<Map<String, dynamic>> createVersion(MobileAsset asset,
      {required String? sourceVersionId,
      required String sourceSha256,
      required Map<String, dynamic> transform,
      required String idempotencyKey}) async {
    createdIdempotencyKeys.add(idempotencyKey);
    createdSourceVersionId = sourceVersionId;
    createdSourceSha256 = sourceSha256;
    return {'operationId': 'op-1', 'versionId': 'new-version', 'status': 'staging'};
  }
  @override
  Future<Map<String, dynamic>> loadVersion(
    MobileAsset asset,
    String versionId,
  ) async {
    _statusReads++;
    if (failFirstVersionStatus && _statusReads == 1) {
      throw const MobileGalleryException('request-failed');
    }
    return {'versionId': versionId, 'status': 'ready'};
  }
  @override
  Future<Uint8List> loadVersionContent(
    MobileAsset asset,
    String versionId,
  ) async {
    versionReads++;
    if (failVersionContent) {
      throw const MobileGalleryException('version-unavailable');
    }
    return _tinyPng;
  }
}

void main() {
  testWidgets(
      'remote timeline does not fetch original bytes until preview is opened',
      (tester) async {
    final source = _FakeGallerySource(asset: _asset());
    await tester
        .pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    expect(find.text('photo.jpg'), findsOneWidget);
    expect(source.originalReads, 0);

    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.text('photo.jpg'), findsNWidgets(2));
    expect(find.text('Loading preview…'), findsNothing);
    expect(source.originalReads, 1);

    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsNothing);
  });

  testWidgets('capability-off does not expose an editor', (tester) async {
    final source = _FakeVersionSource(asset: _asset(), capability: false);
    await tester.pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create edited version'));
    await tester.pumpAndSettle();
    expect(find.text('Media version editing is not enabled on this node.'), findsOneWidget);
    expect(find.text('Save as new version'), findsNothing);
  });

  testWidgets('lists and previews a ready version then saves from it', (tester) async {
    final source = _FakeVersionSource(asset: _asset());
    await tester.pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create edited version'));
    await tester.pumpAndSettle();
    expect(find.textContaining('version-pending · Processing'), findsOneWidget);
    await tester.tap(find.textContaining('version-1 · Ready'));
    await tester.pumpAndSettle();
    expect(source.versionReads, 1);
    await tester.tap(find.text('Save as new version'));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(source.createdSourceVersionId, 'version-1');
    expect(source.createdSourceSha256, List.filled(64, 'b').join());
  });

  testWidgets('reuses an idempotency key after reopening the editor',
      (tester) async {
    final source = _FakeVersionSource(
      asset: _asset(),
      failFirstVersionStatus: true,
    );
    await tester.pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create edited version'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Rotate 90° (0°)'));
    await tester.tap(find.text('Rotate 90° (0°)'));
    await tester.ensureVisible(find.text('Save as new version'));
    await tester.tap(find.text('Save as new version'));
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(source.createdIdempotencyKeys, hasLength(1));

    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Close'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create edited version'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Rotate 90° (0°)'));
    await tester.tap(find.text('Rotate 90° (0°)'));
    await tester.ensureVisible(find.text('Save as new version'));
    await tester.tap(find.text('Save as new version'));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    expect(source.createdIdempotencyKeys, hasLength(2));
    expect(source.createdIdempotencyKeys.first, source.createdIdempotencyKeys.last);
  });

  testWidgets('does not fall back to original when a derived version fails to load',
      (tester) async {
    final source = _FakeVersionSource(
      asset: _asset(),
      failVersionContent: true,
    );
    await tester.pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create edited version'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('version-1 · Ready'));
    await tester.pumpAndSettle();

    expect(source.versionReads, 1);
    expect(source.originalReads, 1);
    expect(find.text('Version processing failed'), findsOneWidget);
  });

  testWidgets('shows a localized denial without exposing API error bodies',
      (tester) async {
    final source = _FakeGallerySource(asset: _asset(), failPreview: true);
    await tester
        .pumpWidget(MaterialApp(home: RemoteGalleryScreen(api: source)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();

    expect(find.textContaining('cannot read it'), findsOneWidget);
    expect(find.textContaining('private server details'), findsNothing);
    expect(source.originalReads, 1);
  });
}
