import 'dart:io';
import 'dart:ui';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:photo_manager/photo_manager.dart' show PermissionStateExt;
import 'package:workmanager/workmanager.dart';

import 'node_settings.dart';
import 'photo_library.dart';
import 'upload_job.dart';
import 'upload_queue.dart';
import 'upload_service.dart';

const _periodicTask = 'photomesh.upload.periodic';
const _scanTask = 'photomesh.scan-and-upload';

@pragma('vm:entry-point')
void photoMeshCallbackDispatcher() {
  Workmanager().executeTask((taskName, _) async {
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final support = await getApplicationSupportDirectory();
    final queue = UploadQueue(path: p.join(support.path, 'photomesh_upload_queue.db'));
    try {
      final settings = NodeSettings();
      final policy = await settings.loadPolicy();
      final library = PhotoLibraryService(queue: queue);
      final permission = await library.checkPermission();
      if (permission.hasAccess && taskName == _scanTask) await library.scanAndQueue();
      if (!await networkPolicyAllows(policy, await Connectivity().checkConnectivity())) return true;
      final uploader = UploadService(
        queue: queue,
        settings: settings,
        resolveSource: library.resolveOriginal,
        networkAllowed: () async => networkPolicyAllows(policy, await Connectivity().checkConnectivity()),
      );
      try {
        for (final job in await queue.runnable(limit: 4)) {
          final result = await uploader.upload(job);
          if (result.state == UploadJobState.paused) return false;
        }
      } finally {
        uploader.close();
      }
      return true;
    } finally {
      await queue.close();
    }
  });
}

class BackgroundSync {
  Future<void> initialize() => Workmanager().initialize(photoMeshCallbackDispatcher);

  Future<void> schedule(NetworkPolicy policy) async {
    if (policy == NetworkPolicy.manualOnly) {
      await Workmanager().cancelByUniqueName(_periodicTask);
      return;
    }
    await Workmanager().registerPeriodicTask(
      _periodicTask,
      _scanTask,
      frequency: const Duration(minutes: 15),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
      constraints: Constraints(networkType: policy == NetworkPolicy.wifiOnly ? NetworkType.unmetered : NetworkType.connected),
    );
  }

  Future<void> runNow() => Workmanager().registerOneOffTask(
        'photomesh.upload.${DateTime.now().millisecondsSinceEpoch}',
        _scanTask,
        constraints: Constraints(networkType: NetworkType.connected),
        existingWorkPolicy: ExistingWorkPolicy.keep,
      );
}

Future<bool> networkPolicyAllows(NetworkPolicy policy, List<ConnectivityResult> network) async {
  if (policy == NetworkPolicy.manualOnly || network.isEmpty || network.contains(ConnectivityResult.none)) return false;
  if (policy == NetworkPolicy.wifiOnly) return network.contains(ConnectivityResult.wifi);
  return network.contains(ConnectivityResult.wifi) || network.contains(ConnectivityResult.mobile);
}

Future<UploadQueue> openDeviceQueue() async {
  final support = await getApplicationSupportDirectory();
  await Directory(support.path).create(recursive: true);
  return UploadQueue(path: p.join(support.path, 'photomesh_upload_queue.db'));
}
