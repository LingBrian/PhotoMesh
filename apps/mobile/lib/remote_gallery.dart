import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'gallery_api.dart';
import 'l10n/app_strings.dart';

class RemoteGalleryScreen extends StatefulWidget {
  const RemoteGalleryScreen({super.key, required this.api});
  final MobileGallerySource api;

  @override
  State<RemoteGalleryScreen> createState() => _RemoteGalleryScreenState();
}

class _RemoteGalleryScreenState extends State<RemoteGalleryScreen> {
  final _assets = <MobileAsset>[];
  String? _cursor;
  String? _errorCode;
  bool _busy = true;
  int _pageGeneration = 0;

  String _s(String key) =>
      appString(Localizations.localeOf(context).languageCode, key);

  @override
  void initState() {
    super.initState();
    _loadPage(reset: true);
  }

  @override
  void dispose() {
    widget.api.close();
    super.dispose();
  }

  Future<void> _loadPage({bool reset = false}) async {
    if (_busy && !reset) return;
    final generation = ++_pageGeneration;
    final cursor = reset ? null : _cursor;
    setState(() {
      if (reset) {
        _assets.clear();
        _cursor = null;
      }
      _busy = true;
      _errorCode = null;
    });
    try {
      final page = await widget.api.loadPage(cursor: cursor);
      if (!mounted || generation != _pageGeneration) return;
      setState(() {
        if (reset) {
          _assets
            ..clear()
            ..addAll(page.items);
        } else {
          _assets.addAll(page.items);
        }
        _cursor = page.nextCursor;
      });
    } on MobileGalleryException catch (error) {
      if (mounted && generation == _pageGeneration) {
        setState(() => _errorCode = error.code);
      }
    } catch (_) {
      if (mounted && generation == _pageGeneration) {
        setState(() => _errorCode = 'request-failed');
      }
    } finally {
      if (mounted && generation == _pageGeneration) {
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _openPreview(MobileAsset asset) async {
    await showDialog<void>(
      context: context,
      builder: (context) => _MobileAssetPreviewDialog(
        api: widget.api,
        asset: asset,
      ),
    );
  }

  bool _canPreview(MobileAsset asset) =>
      asset.kind == 'photo' &&
      (asset.availability == MediaAvailability.online ||
          asset.availability == MediaAvailability.cached);

  String _availabilityLabel(MediaAvailability availability) =>
      switch (availability) {
        MediaAvailability.online => _s('availabilityOnline'),
        MediaAvailability.cached => _s('availabilityCached'),
        MediaAvailability.offline => _s('availabilityOffline'),
        MediaAvailability.missing => _s('availabilityMissing'),
      };

  String _errorMessage(String code) {
    final key = switch (code) {
      'library-unavailable' || 'unauthorized' => 'galleryUnavailable',
      'source-offline' => 'sourceOffline',
      'preview-too-large' => 'previewTooLarge',
      'unsupported-media' => 'previewUnsupported',
      'asset-unavailable' => 'galleryUnavailable',
      _ => 'galleryRequestFailed',
    };
    return _s(key);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(_s('remoteGallery'))),
        body: RefreshIndicator(
          onRefresh: () => _loadPage(reset: true),
          child: ListView.builder(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: _assets.length + 1,
            itemBuilder: (context, index) {
              if (index == _assets.length) {
                if (_busy) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                if (_cursor != null && _cursor!.isNotEmpty) {
                  return Center(
                    child: TextButton(
                      onPressed: () => _loadPage(),
                      child: Text(_s('galleryLoadMore')),
                    ),
                  );
                }
                if (_assets.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.all(24),
                    child: Center(child: Text(_s('galleryEmpty'))),
                  );
                }
                return const SizedBox(height: 20);
              }
              final asset = _assets[index];
              return ListTile(
                leading: CircleAvatar(
                  child: Icon(asset.kind == 'photo'
                      ? Icons.image_outlined
                      : Icons.movie_outlined),
                ),
                title: Text(asset.filename,
                    maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(
                    '${asset.originNodeId} · ${_availabilityLabel(asset.availability)}'),
                trailing: TextButton(
                  onPressed:
                      _canPreview(asset) ? () => _openPreview(asset) : null,
                  child: Text(_s('preview')),
                ),
              );
            },
          ),
        ),
        bottomSheet: _errorCode == null
            ? null
            : Material(
                color: Theme.of(context).colorScheme.errorContainer,
                child: SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Expanded(child: Text(_errorMessage(_errorCode!))),
                        IconButton(
                          tooltip: _s('close'),
                          onPressed: () => setState(() => _errorCode = null),
                          icon: const Icon(Icons.close),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
      );
}

class _MobileAssetPreviewDialog extends StatefulWidget {
  const _MobileAssetPreviewDialog({required this.api, required this.asset});
  final MobileGallerySource api;
  final MobileAsset asset;

  @override
  State<_MobileAssetPreviewDialog> createState() =>
      _MobileAssetPreviewDialogState();
}

class _VersionEditorDialog extends StatefulWidget {
  const _VersionEditorDialog({
    required this.source,
    required this.asset,
    required this.s,
    required this.pendingIdempotencyKeys,
  });
  final MobileGalleryVersionSource source;
  final MobileAsset asset;
  final String Function(String) s;
  final Map<String, String> pendingIdempotencyKeys;
  @override State<_VersionEditorDialog> createState() => _VersionEditorDialogState();
}
class _VersionEditorDialogState extends State<_VersionEditorDialog> {
  final _x=TextEditingController(text:'0'), _y=TextEditingController(text:'0'), _w=TextEditingController(text:'1000000'), _h=TextEditingController(text:'1000000');
  int _rotation = 0;
  bool _busy = false;
  String? _error;
  final _random = math.Random.secure();
  String? _sourceVersionId;
  late String _sourceSha256 = widget.asset.sha256;
  Uint8List? _derivedPreview;
  List<Map<String, dynamic>> _versions = [];
  @override
  void initState() {
    super.initState();
    _loadVersions();
  }

  String _errorCode(Object error) => error is MobileGalleryException
      ? error.code
      : 'request-failed';

  String _localizedCode(String? code) => widget.s(switch (code) {
        'invalid-transform' => 'invalidCrop',
        'versionTimeout' => 'versionTimeout',
        'source-changed' => 'sourceChanged',
        'preview-too-large' => 'previewTooLarge',
        'unsupported-media' => 'previewUnsupported',
        'unauthorized' || 'request-failed' => 'versionSaveFailed',
        _ => 'versionFailed',
      });

  String _statusLabel(Object? status) => widget.s(switch (status) {
        'ready' => 'versionReady',
        'failed' => 'versionError',
        _ => 'versionStaging',
      });

  Future<void> _loadVersions() async {
    try {
      final values = await widget.source.loadVersions(widget.asset);
      if (mounted) setState(() => _versions = values);
    } catch (error) {
      if (mounted) setState(() => _error = _errorCode(error));
    }
  }

  Future<void> _selectVersion(Map<String, dynamic> version) async {
    final id = version['versionId'];
    final hash = version['outputSha256'];
    if (id is! String || hash is! String || version['status'] != 'ready') {
      return;
    }
    setState(() => _busy = true);
    try {
      final bytes =
          await widget.source.loadVersionContent(widget.asset, id);
      if (!mounted) return;
      setState(() {
        _derivedPreview = bytes;
        _sourceVersionId = id;
        _sourceSha256 = hash;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = _errorCode(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _x.dispose();
    _y.dispose();
    _w.dispose();
    _h.dispose();
    super.dispose();
  }
  Future<void> _save() async {
    int? number(TextEditingController controller) =>
        int.tryParse(controller.text);
    final x = number(_x);
    final y = number(_y);
    final width = number(_w);
    final height = number(_h);
    if (x == null || y == null || width == null || height == null ||
        x < 0 || y < 0 || width < 1 || height < 1 ||
        x + width > 1000000 || y + height > 1000000) {
      setState(() => _error = 'invalid-transform');
      return;
    }
    setState(() => _busy = true);
    try {
      final fingerprint =
          '${widget.asset.assetId}|${_sourceVersionId ?? 'original'}|$_sourceSha256|$x|$y|$width|$height|$_rotation';
      final idempotencyKey = widget.pendingIdempotencyKeys.putIfAbsent(
        fingerprint,
        () => List<int>.generate(
          24,
          (_) => _random.nextInt(256),
        ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join(),
      );
      final response = await widget.source.createVersion(
        widget.asset,
        sourceVersionId: _sourceVersionId,
        sourceSha256: _sourceSha256,
        transform: {
          'crop': {'x': x, 'y': y, 'width': width, 'height': height},
          'rotation': _rotation,
        },
        idempotencyKey: idempotencyKey,
      );
      if (!mounted) return;
      final id = response['versionId'];
      if (id is! String || id.isEmpty) {
        setState(() => _error = 'request-failed');
        return;
      }
      Map<String, dynamic> status = {};
      for (var attempt = 0; attempt < 30; attempt++) {
        await Future<void>.delayed(const Duration(seconds: 1));
        if (!mounted) return;
        status = await widget.source.loadVersion(widget.asset, id);
        if (status['status'] == 'ready' || status['status'] == 'failed') break;
      }
      if (!mounted) return;
      if (status['status'] == 'ready') {
        widget.pendingIdempotencyKeys.remove(fingerprint);
        final messenger = ScaffoldMessenger.of(context);
        Navigator.pop(context);
        messenger.showSnackBar(SnackBar(content: Text(widget.s('versionSaved'))));
      } else {
        if (status['status'] == 'failed') {
          widget.pendingIdempotencyKeys.remove(fingerprint);
        }
        setState(() => _error =
            status['errorCode']?.toString() ?? 'versionTimeout');
      }
    } catch (error) {
      if (mounted) setState(() => _error = _errorCode(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.s('cropControls')),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(widget.s('versionList')),
                ListTile(
                  title: Text(widget.s('originalVersion')),
                  subtitle: Text(widget.asset.filename),
                  selected: _sourceVersionId == null,
                  onTap: _busy
                      ? null
                      : () => setState(() {
                            _sourceVersionId = null;
                            _sourceSha256 = widget.asset.sha256;
                            _derivedPreview = null;
                          }),
                ),
                for (final version in _versions)
                  ListTile(
                    title: Text(
                      '${version['versionId']} · ${_statusLabel(version['status'])}',
                    ),
                    subtitle: version['errorCode'] == null
                        ? null
                        : Text(_localizedCode(version['errorCode']?.toString())),
                    onTap: !_busy && version['status'] == 'ready'
                        ? () => _selectVersion(version)
                        : null,
                  ),
                if (_derivedPreview != null)
                  SizedBox(
                    height: 100,
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        final dpr = MediaQuery.devicePixelRatioOf(context);
                        final cacheWidth = (constraints.maxWidth * dpr)
                            .round()
                            .clamp(1, 2048)
                            .toInt();
                        final cacheHeight = (constraints.maxHeight * dpr)
                            .round()
                            .clamp(1, 2048)
                            .toInt();
                        return Image.memory(
                          _derivedPreview!,
                          fit: BoxFit.contain,
                          cacheWidth: cacheWidth,
                          cacheHeight: cacheHeight,
                        );
                      },
                    ),
                  ),
                for (final field in <(String, TextEditingController)>[
                  (widget.s('cropX'), _x),
                  (widget.s('cropY'), _y),
                  (widget.s('cropWidth'), _w),
                  (widget.s('cropHeight'), _h),
                ])
                  TextField(
                    controller: field.$2,
                    enabled: !_busy,
                    keyboardType: TextInputType.number,
                    decoration: InputDecoration(labelText: field.$1),
                  ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(
                            () => _rotation = (_rotation + 90) % 360,
                          ),
                  child: Text('${widget.s('rotate')} ($_rotation°)'),
                ),
                if (_error != null)
                  Text(
                    _localizedCode(_error),
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: _busy ? null : () => Navigator.pop(context),
            child: Text(widget.s('close')),
          ),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: _busy
                ? const CircularProgressIndicator()
                : Text(widget.s('saveVersion')),
          ),
        ],
      );
}

class _MobileAssetPreviewDialogState extends State<_MobileAssetPreviewDialog> {
  final Map<String, String> _pendingIdempotencyKeys = {};
  late final Future<Uint8List> _preview = widget.api.loadPreview(widget.asset);

  String _s(String key) =>
      appString(Localizations.localeOf(context).languageCode, key);

  String _errorMessage(Object? error) {
    final code =
        error is MobileGalleryException ? error.code : 'request-failed';
    final key = switch (code) {
      'source-offline' => 'sourceOffline',
      'preview-too-large' => 'previewTooLarge',
      'unsupported-media' => 'previewUnsupported',
      'asset-unavailable' || 'unauthorized' => 'previewUnavailable',
      _ => 'galleryRequestFailed',
    };
    return _s(key);
  }

  Future<void> _editVersion(BuildContext context) async {
    final source = widget.api as MobileGalleryVersionSource;
    final enabled = await source.supportsMediaVersions();
    if (!context.mounted) return;
    if (!enabled || (widget.asset.availability != MediaAvailability.online && widget.asset.availability != MediaAvailability.cached)) { ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_s('versionDisabled')))); return; }
    await showDialog<void>(context: context, builder: (dialogContext) => _VersionEditorDialog(source: source, asset: widget.asset, s: _s, pendingIdempotencyKeys: _pendingIdempotencyKeys));
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.sizeOf(context);
    return Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: SizedBox(
        width: math.min(media.width - 24, 900),
        height: math.min(media.height - 24, 760),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.asset.filename,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  if (widget.api is MobileGalleryVersionSource)
                    TextButton(onPressed: () => _editVersion(context), child: Text(_s('editVersion'))),
                  TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(_s('close'))),
                ],
              ),
              const Divider(),
              Expanded(
                child: FutureBuilder<Uint8List>(
                  future: _preview,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState != ConnectionState.done) {
                      return Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const CircularProgressIndicator(),
                            const SizedBox(height: 12),
                            Text(_s('previewLoading')),
                          ],
                        ),
                      );
                    }
                    if (snapshot.hasError || snapshot.data == null) {
                      return Center(child: Text(_errorMessage(snapshot.error)));
                    }
                    return LayoutBuilder(
                      builder: (context, constraints) {
                        final devicePixelRatio =
                            MediaQuery.devicePixelRatioOf(context);
                        final cacheWidth =
                            (constraints.maxWidth * devicePixelRatio)
                                .round()
                                .clamp(1, 2048)
                                .toInt();
                        final cacheHeight =
                            (constraints.maxHeight * devicePixelRatio)
                                .round()
                                .clamp(1, 2048)
                                .toInt();
                        return InteractiveViewer(
                          minScale: 0.8,
                          maxScale: 4,
                          child: Center(
                            child: Image.memory(
                              snapshot.data!,
                              fit: BoxFit.contain,
                              cacheWidth: cacheWidth,
                              cacheHeight: cacheHeight,
                              errorBuilder: (context, error, stackTrace) =>
                                  Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.broken_image_outlined,
                                      size: 64),
                                  const SizedBox(height: 12),
                                  Text(_s('previewUnsupported'),
                                      textAlign: TextAlign.center),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
