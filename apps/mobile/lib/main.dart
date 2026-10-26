import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';

import 'background_sync.dart';
import 'gallery_api.dart';
import 'l10n/app_strings.dart';
import 'node_settings.dart';
import 'photo_library.dart';
import 'remote_gallery.dart';
import 'upload_job.dart';
import 'upload_queue.dart';
import 'upload_service.dart';

String combineManualSelectionStatus({required String? queueStatus, required String selectionSummary}) {
  if (queueStatus == null || queueStatus == selectionSummary) return selectionSummary;
  return '$queueStatus\n$selectionSummary';
}

List<T> orderBySelection<T>(Iterable<T> assets, String Function(T) idOf, Iterable<String> selectedIds) {
  final byId = {for (final asset in assets) idOf(asset): asset};
  return [for (final id in selectedIds) if (byId.containsKey(id)) byId[id]!];
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PhotoMeshApp());
}

class PhotoMeshApp extends StatelessWidget {
  const PhotoMeshApp({super.key, this.testMode = false});
  final bool testMode;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'PhotoMesh',
        theme: ThemeData(colorSchemeSeed: const Color(0xFF28734E), useMaterial3: true),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        home: BackupHome(testMode: testMode),
      );
}

class BackupHome extends StatefulWidget {
  const BackupHome({super.key, this.testMode = false});
  final bool testMode;

  @override
  State<BackupHome> createState() => _BackupHomeState();
}

class _BackupHomeState extends State<BackupHome> with WidgetsBindingObserver {
  final _address = TextEditingController();
  final _libraryId = TextEditingController();
  final _token = TextEditingController();
  final _queueItems = <UploadJob>[];
  UploadQueue? _queue;
  NodeSettings? _settings;
  PhotoLibraryService? _photos;
  BackgroundSync? _background;
  NetworkPolicy _policy = NetworkPolicy.wifiOnly;
  PermissionState? _permission;
  String _deviceId = '';
  bool _busy = false;
  String? _status;
  StreamSubscription<List<ConnectivityResult>>? _networkChanges;

  String _s(String key) => appString(Localizations.localeOf(context).languageCode, key);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (!widget.testMode) unawaited(_bootstrap());
  }

  Future<void> _bootstrap() async {
    try {
      final queue = await openDeviceQueue();
      final settings = NodeSettings();
      final photos = PhotoLibraryService(queue: queue);
      final background = BackgroundSync();
      await background.initialize();
      final node = await settings.loadNode();
      final policy = await settings.loadPolicy();
      final deviceId = await settings.deviceId();
      final permission = await photos.checkPermission();
      if (!mounted) return;
      setState(() {
        _queue = queue;
        _settings = settings;
        _photos = photos;
        _background = background;
        _policy = policy;
        _deviceId = deviceId;
        _permission = permission;
        _address.text = node?.baseUrl ?? '';
        _libraryId.text = node?.libraryId ?? '';
      });
      PhotoManager.addChangeCallback(_onPhotoLibraryChanged);
      await PhotoManager.startChangeNotify();
      _networkChanges = Connectivity().onConnectivityChanged.listen((network) async {
        if (_policy != NetworkPolicy.manualOnly && await networkPolicyAllows(_policy, network)) {
          unawaited(_processQueue());
        }
      });
      if (permission.hasAccess) {
        await photos.scanAndQueue();
        if (policy != NetworkPolicy.manualOnly) unawaited(_processQueue());
      }
      await background.schedule(policy);
      await _refreshQueue();
    } catch (error) {
      if (mounted) setState(() => _status = error.toString());
    }
  }

  void _onPhotoLibraryChanged(MethodCall _) {
    unawaited(_scanAndMaybeUpload());
  }

  Future<void> _scanAndMaybeUpload() async {
    final photos = _photos;
    if (photos == null || _busy) return;
    try {
      final added = await photos.scanAndQueue();
      if (added > 0 && mounted) setState(() => _status = _s('scanAdded').replaceAll('{count}', '$added'));
      await _refreshQueue();
      if (_policy != NetworkPolicy.manualOnly) unawaited(_processQueue());
    } catch (_) {
      if (mounted) setState(() => _status = _s('scanFailed'));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !widget.testMode) unawaited(_onResume());
  }

  Future<void> _onResume() async {
    final photos = _photos;
    if (photos == null) return;
    final permission = await photos.checkPermission();
    if (!mounted) return;
    setState(() => _permission = permission);
    if (permission.hasAccess) await _scanAndMaybeUpload();
    await _refreshQueue();
  }

  Future<void> _requestPermission() async {
    final photos = _photos;
    if (photos == null) return;
    final permission = await photos.requestPermission();
    if (!mounted) return;
    setState(() => _permission = permission);
    if (!permission.hasAccess) await PhotoManager.openSetting();
    await _scanAndMaybeUpload();
  }

  Future<void> _openRemoteGallery() async {
    final settings = _settings;
    if (settings == null) {
      if (mounted) setState(() => _status = _s('nodeRequired'));
      return;
    }
    final node = await settings.loadNode();
    final token = await settings.loadToken();
    if (!mounted) return;
    if (node == null || token == null || token.isEmpty) {
      setState(() => _status = _s('nodeRequired'));
      return;
    }
    final api = MobileGalleryApi(
      baseUrl: node.baseUrl,
      libraryId: node.libraryId,
      token: token,
    );
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => RemoteGalleryScreen(api: api),
      ),
    );
  }

  Future<void> _bindNode() async {
    final settings = _settings;
    if (settings == null) return;
    try {
      final deviceId = _deviceId.isEmpty ? await settings.deviceId() : _deviceId;
      await settings.bind(
        BoundNode(baseUrl: _address.text.trim(), libraryId: _libraryId.text.trim(), nodeId: deviceId),
        _token.text,
      );
      if (!mounted) return;
      _token.clear();
      setState(() => _status = _s('nodeSaved'));
      await _background?.schedule(_policy);
    } catch (error) {
      if (mounted) setState(() => _status = error is FormatException ? error.message : _s('nodeRequired'));
    }
  }

  Future<void> _changePolicy(NetworkPolicy? policy) async {
    if (policy == null) return;
    await _settings?.savePolicy(policy);
    if (!mounted) return;
    setState(() => _policy = policy);
    if (policy == NetworkPolicy.manualOnly) {
      await WorkmanagerCancel.cancel();
    } else {
      await _background?.schedule(policy);
      unawaited(_processQueue());
    }
  }

  Future<void> _selectPhotos() async {
    final photos = _photos;
    if (photos == null) return;
    final permission = await photos.checkPermission();
    if (!mounted) return;
    if (!permission.hasAccess) {
      await _requestPermission();
      return;
    }
    final selected = await showDialog<List<AssetEntity>>(
      context: context,
      barrierDismissible: false,
      builder: (_) => PhotoSelectionDialog(photos: photos, languageCode: Localizations.localeOf(context).languageCode),
    );
    if (selected == null) return;
    final result = await queueSelectedPhotos(
      selected,
      photos.queueAsset,
    );
    var message = _s('manualAdded').replaceAll('{count}', '${result.queued}');
    if (result.skipped > 0) {
      message = '$message ${_s('manualSkipped').replaceAll('{count}', '${result.skipped}')}';
    }
    if (mounted) setState(() => _status = message);
    await _refreshQueue();
    await _processQueue(manual: true);
    if (mounted && result.skipped > 0) {
      setState(() => _status = combineManualSelectionStatus(
            queueStatus: _status,
            selectionSummary: message,
          ));
    }
  }

  Future<void> _processQueue({bool manual = false}) async {
    final queue = _queue;
    final settings = _settings;
    final photos = _photos;
    if (queue == null || settings == null || photos == null || _busy) return;
    if (await settings.loadNode() == null || (await settings.loadToken()) == null) {
      if (mounted) setState(() => _status = _s('nodeRequired'));
      return;
    }
    final connectivity = await Connectivity().checkConnectivity();
    final allowed = manual && _policy == NetworkPolicy.manualOnly
        ? connectivity.any((kind) => kind != ConnectivityResult.none)
        : await networkPolicyAllows(_policy, connectivity);
    if (!allowed) {
      if (mounted) setState(() => _status = _s('networkBlocked'));
      return;
    }
    setState(() => _busy = true);
    final uploader = UploadService(
      queue: queue,
      settings: settings,
      resolveSource: photos.resolveOriginal,
      galleryPermissionAllowed: photos.currentPermissionAllowsAccess,
      networkAllowed: () async => manual && _policy == NetworkPolicy.manualOnly
          ? (await Connectivity().checkConnectivity()).any((kind) => kind != ConnectivityResult.none)
          : networkPolicyAllows(_policy, await Connectivity().checkConnectivity()),
    );
    try {
      for (final job in await queue.runnable(limit: 4)) {
        await uploader.upload(job);
        await _refreshQueue();
      }
    } finally {
      uploader.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _runQueueNow() async {
    if (_policy == NetworkPolicy.manualOnly) {
      await _processQueue(manual: true);
    } else {
      await _processQueue(manual: true);
    }
  }

  Future<void> _retry(UploadJob job) async {
    await _queue?.save(job.copyWith(state: UploadJobState.queued, clearError: true));
    await _refreshQueue();
    await _processQueue(manual: true);
  }

  Future<void> _refreshQueue() async {
    final queue = _queue;
    if (queue == null || !mounted) return;
    final rows = await queue.list();
    if (mounted) {
      setState(() {
        _queueItems
          ..clear()
          ..addAll(rows);
      });
    }
  }

  String _stateText(UploadJob job) {
    if (job.state == UploadJobState.uploading && !_busy) return _s('queued');
    final key = switch (job.state) {
      UploadJobState.queued => 'queued',
      UploadJobState.uploading => 'uploading',
      UploadJobState.paused => 'paused',
      UploadJobState.completed => 'completed',
      UploadJobState.needsPermission => 'needsPermission',
      UploadJobState.failed => 'failed',
    };
    final errorText = localizedUploadError(Localizations.localeOf(context).languageCode, job.errorCode);
    return '${_s(key)}${errorText.isEmpty ? '' : ' · $errorText'}';
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (!widget.testMode) {
      PhotoManager.removeChangeCallback(_onPhotoLibraryChanged);
      unawaited(PhotoManager.stopChangeNotify());
      unawaited(_networkChanges?.cancel());
      unawaited(_queue?.close());
    }
    _address.dispose();
    _libraryId.dispose();
    _token.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final permissionGranted = _permission?.hasAccess ?? false;
    return Scaffold(
      appBar: AppBar(
        title: Text(_s('title')),
        actions: [
          IconButton(
            tooltip: _s('remoteGallery'),
            onPressed: _openRemoteGallery,
            icon: const Icon(Icons.photo_library_outlined),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_s('node'), style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              TextField(controller: _address, decoration: InputDecoration(labelText: _s('address'))),
              TextField(controller: _libraryId, decoration: InputDecoration(labelText: _s('library'))),
              TextField(controller: _token, obscureText: true, decoration: InputDecoration(labelText: _s('token'))),
              const SizedBox(height: 8),
              SelectableText('${_s('device')}: $_deviceId'),
              Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: _bindNode, child: Text(_s('bind'))),
              ),
              Text(_s('httpNotice'), style: Theme.of(context).textTheme.bodySmall),
              Text(_s('authNotice'), style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)),
            ],
          ))),
          Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_s('permission'), style: Theme.of(context).textTheme.titleLarge),
              Text(permissionGranted ? _s('permissionGranted') : _s('permissionDenied')),
              Wrap(spacing: 8, children: [
                OutlinedButton.icon(onPressed: _requestPermission, icon: const Icon(Icons.photo_library_outlined), label: Text(_s('grant')),
                ),
                OutlinedButton.icon(onPressed: _scanAndMaybeUpload, icon: const Icon(Icons.sync), label: Text(_s('scan')),
                ),
                OutlinedButton.icon(onPressed: _selectPhotos, icon: const Icon(Icons.add_photo_alternate_outlined), label: Text(_s('manual')),
                ),
              ]),
            ],
          ))),
          Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_s('chooseNetwork'), style: Theme.of(context).textTheme.titleLarge),
              DropdownButton<NetworkPolicy>(
                value: _policy,
                isExpanded: true,
                items: [
                  DropdownMenuItem(value: NetworkPolicy.wifiOnly, child: Text(_s('wifi'))),
                  DropdownMenuItem(value: NetworkPolicy.anyNetwork, child: Text(_s('any'))),
                  DropdownMenuItem(value: NetworkPolicy.manualOnly, child: Text(_s('manualOnly'))),
                ],
                onChanged: _changePolicy,
              ),
              Text(_s('backgroundNotice'), style: Theme.of(context).textTheme.bodySmall),
              Text(_s('runLimit'), style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              FilledButton.icon(onPressed: _busy ? null : _runQueueNow, icon: const Icon(Icons.cloud_upload_outlined), label: Text(_s('uploadNow')),
              ),
            ],
          ))),
          if (_status != null) Padding(padding: const EdgeInsets.all(8), child: Text(_status!)),
          Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(_s('queue'), style: Theme.of(context).textTheme.titleLarge)),
          if (_queueItems.isEmpty) Text(_s('empty')),
          for (final job in _queueItems)
            Card(child: ListTile(
              leading: Icon(job.state == UploadJobState.completed ? Icons.check_circle : Icons.image_outlined),
              title: Text(job.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text('${_stateText(job)}\n${job.offset}/${job.totalBytes} bytes', maxLines: 2),
              isThreeLine: true,
              trailing: job.state == UploadJobState.completed
                  ? null
                  : TextButton(onPressed: _busy ? null : () => _retry(job), child: Text(_s('retry'))),
            )),
        ],
      ),
    );
  }
}

class PhotoSelectionDialog extends StatefulWidget {
  const PhotoSelectionDialog({super.key, required this.photos, required this.languageCode});

  final PhotoLibraryService photos;
  final String languageCode;

  @override
  State<PhotoSelectionDialog> createState() => _PhotoSelectionDialogState();
}

class _PhotoSelectionDialogState extends State<PhotoSelectionDialog> {
  static const _pageSize = 80;
  static const _thumbnailCacheLimit = 96;
  final _assets = <AssetEntity>[];
  final _selectedIds = <String>{};
  final _thumbnails = <String, Future<Uint8List?>>{};
  bool _loading = false;
  bool _hasMore = true;
  int _page = 0;
  String? _error;

  String _s(String key) => appString(widget.languageCode, key);

  @override
  void initState() {
    super.initState();
    unawaited(_loadNextPage());
  }

  Future<void> _loadNextPage() async {
    if (_loading || !_hasMore) return;
    setState(() { _loading = true; _error = null; });
    try {
      final page = await widget.photos.latestForSelection(page: _page, pageSize: _pageSize);
      if (!mounted) return;
      setState(() {
        _assets.addAll(page);
        _hasMore = page.length == _pageSize;
        _page++;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() { _loading = false; _error = _s('scanFailed'); });
    }
  }

  Future<Uint8List?> _thumbnailFor(AssetEntity asset) {
    final cached = _thumbnails.remove(asset.id);
    final future = cached ?? asset.thumbnailDataWithSize(const ThumbnailSize(240, 240));
    _thumbnails[asset.id] = future;
    while (_thumbnails.length > _thumbnailCacheLimit) {
      _thumbnails.remove(_thumbnails.keys.first);
    }
    return future;
  }

  void _toggle(AssetEntity asset) {
    setState(() {
      if (!_selectedIds.add(asset.id)) _selectedIds.remove(asset.id);
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Dialog.fullscreen(
      child: SafeArea(
        child: Column(children: [
          Material(
            color: scheme.surface,
            child: LayoutBuilder(builder: (context, constraints) {
              final compact = constraints.maxWidth < 400 || MediaQuery.textScalerOf(context).scale(1) > 1.2;
              final count = Semantics(
                label: _s('selectedCount').replaceAll('{count}', '${_selectedIds.length}'),
                child: Text(
                  _s('selectedCount').replaceAll('{count}', '${_selectedIds.length}'),
                  style: Theme.of(context).textTheme.titleMedium,
                  maxLines: compact ? 2 : 1,
                  overflow: TextOverflow.ellipsis,
                ),
              );
              return Row(children: [
                IconButton(tooltip: _s('cancel'), onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
                Expanded(child: compact
                    ? Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text(_s('selectPhotos'), style: Theme.of(context).textTheme.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
                        count,
                      ])
                    : Text(_s('selectPhotos'), style: Theme.of(context).textTheme.titleLarge, maxLines: 1, overflow: TextOverflow.ellipsis)),
                if (!compact) Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: count),
              ]);
            }),
          ),
          Expanded(child: _assets.isEmpty && _loading
              ? const Center(child: CircularProgressIndicator())
              : _assets.isEmpty && _error == null
                  ? Center(child: Text(_s('noPhotos')))
                  : LayoutBuilder(builder: (context, constraints) {
                      final columns = (constraints.maxWidth / 116).floor().clamp(2, 8).toInt();
                      return GridView.builder(
                        padding: const EdgeInsets.all(4),
                        gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: columns, crossAxisSpacing: 3, mainAxisSpacing: 3,
                        ),
                        itemCount: _assets.length + (_hasMore || _loading || _error != null ? 1 : 0),
                        itemBuilder: (context, index) {
                          if (index == _assets.length) {
                            if (_error != null) return Center(child: TextButton(onPressed: _loadNextPage, child: Text(_s('retry'))));
                            if (_loading) return const Center(child: CircularProgressIndicator());
                            return Center(child: OutlinedButton.icon(onPressed: _loadNextPage, icon: const Icon(Icons.expand_more), label: Text(_s('loadMorePhotos'))));
                          }
                          final asset = _assets[index];
                          final isSelected = _selectedIds.contains(asset.id);
                          return Semantics(
                            button: true,
                            selected: isSelected,
                            label: '${asset.title ?? _s('photo')}, ${isSelected ? _s('selected') : _s('notSelected')}',
                            child: Material(
                              color: scheme.surfaceContainerHighest,
                              child: InkWell(
                                onTap: () => _toggle(asset),
                                child: Stack(fit: StackFit.expand, children: [
                                  FutureBuilder<Uint8List?>(
                                    future: _thumbnailFor(asset),
                                    builder: (context, snapshot) => snapshot.data == null
                                        ? const Center(child: Icon(Icons.image_outlined))
                                        : Image.memory(snapshot.data!, fit: BoxFit.cover, gaplessPlayback: true),
                                  ),
                                  if (isSelected) Container(color: scheme.primary.withValues(alpha: 0.22)),
                                  Positioned(top: 4, right: 4, child: SizedBox(width: 48, height: 48, child: Center(child: Icon(isSelected ? Icons.check_circle : Icons.radio_button_unchecked, color: isSelected ? scheme.primary : Colors.white, size: 28)))),
                                  if (isSelected)
                                    Positioned(
                                      bottom: 6,
                                      left: 6,
                                      child: CircleAvatar(
                                        radius: 13,
                                        backgroundColor: scheme.primary,
                                        child: Text(
                                          '${_selectedIds.toList().indexOf(asset.id) + 1}',
                                          style: const TextStyle(color: Colors.white, fontSize: 12),
                                        ),
                                      ),
                                    ),
                                ]),
                              ),
                            ),
                          );
                        },
                      );
                    })),
          if (_error != null && _assets.isNotEmpty) Padding(padding: const EdgeInsets.all(4), child: Text(_error!)),
          Material(
            elevation: 8,
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final compact = constraints.maxWidth < 440 || MediaQuery.textScalerOf(context).scale(1) > 1.2;
                    final hint = Text(
                      _selectedIds.isEmpty
                          ? _s('selectPhotosHint')
                          : _s('selectedCount').replaceAll('{count}', '${_selectedIds.length}'),
                      maxLines: compact ? 2 : 1,
                      overflow: TextOverflow.ellipsis,
                    );
                    final actions = Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.pop(context),
                          child: Text(_s('cancel')),
                        ),
                        FilledButton.icon(
                          onPressed: _selectedIds.isEmpty
                              ? null
                              : () => Navigator.pop(
                                    context,
                                    orderBySelection(_assets, (asset) => asset.id, _selectedIds),
                                  ),
                          icon: const Icon(Icons.add),
                          label: Text(_s('add')),
                        ),
                      ],
                    );
                    return compact
                        ? Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [hint, actions],
                          )
                        : Row(
                            children: [
                              Expanded(child: hint),
                              actions,
                            ],
                          );
                  },
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

class WorkmanagerCancel {
  static Future<void> cancel() => BackgroundSync().schedule(NetworkPolicy.manualOnly);
}
