import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';

import 'background_sync.dart';
import 'l10n/app_strings.dart';
import 'node_settings.dart';
import 'photo_library.dart';
import 'upload_job.dart';
import 'upload_queue.dart';
import 'upload_service.dart';

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
    if (!permission.hasAccess) {
      await _requestPermission();
      return;
    }
    final assets = await photos.latestForSelection();
    if (!mounted) return;
    final selected = await showDialog<Set<String>>(
      context: context,
      builder: (context) {
        final ids = <String>{};
        return StatefulBuilder(builder: (context, setDialogState) => AlertDialog(
              title: Text(_s('selectPhotos')),
              content: SizedBox(
                width: 480,
                height: 420,
                child: assets.isEmpty
                    ? Center(child: Text(_s('empty')))
                    : ListView.builder(
                        itemCount: assets.length,
                        itemBuilder: (context, index) {
                          final asset = assets[index];
                          return CheckboxListTile(
                            value: ids.contains(asset.id),
                            title: Text(asset.title ?? asset.id, maxLines: 1, overflow: TextOverflow.ellipsis),
                            subtitle: Text(asset.relativePath ?? ''),
                            onChanged: (value) => setDialogState(() {
                              if (value == true) {
                                ids.add(asset.id);
                              } else {
                                ids.remove(asset.id);
                              }
                            }),
                          );
                        },
                      ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(context), child: Text(_s('cancel'))),
                FilledButton(onPressed: () => Navigator.pop(context, ids), child: Text(_s('add'))),
              ],
            ));
      },
    );
    if (selected == null) return;
    var added = 0;
    for (final asset in assets.where((asset) => selected.contains(asset.id))) {
      if (await photos.queueAsset(asset) != null) added++;
    }
    if (mounted) setState(() => _status = _s('manualAdded').replaceAll('{count}', '$added'));
    await _refreshQueue();
    await _processQueue(manual: true);
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
    return '${_s(key)}${job.errorCode == null ? '' : ' · ${job.errorCode}'}';
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
      appBar: AppBar(title: Text(_s('title'))),
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

class WorkmanagerCancel {
  static Future<void> cancel() => BackgroundSync().schedule(NetworkPolicy.manualOnly);
}
