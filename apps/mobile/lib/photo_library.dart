import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';

import 'upload_job.dart';
import 'upload_queue.dart';
import 'upload_service.dart';

abstract interface class PhotoLibraryGateway {
  Future<PermissionState> requestPermission();
  Future<PermissionState> currentPermission();
  Future<List<AssetEntity>> latest({int page = 0, int pageSize = 80});
  Future<AssetEntity?> byId(String assetId);
}
class DevicePhotoLibrary implements PhotoLibraryGateway {
  const DevicePhotoLibrary();
  @override
  Future<PermissionState> requestPermission() => PhotoManager.requestPermissionExtend();

  @override
  Future<PermissionState> currentPermission() =>
      PhotoManager.getPermissionState(requestOption: const PermissionRequestOption());

  @override
  Future<List<AssetEntity>> latest({int page = 0, int pageSize = 80}) async {
    final albums = await PhotoManager.getAssetPathList(hasAll: true, onlyAll: true, type: RequestType.common);
    if (albums.isEmpty) return const [];
    return albums.first.getAssetListPaged(page: page, size: pageSize);
  }

  @override
  Future<AssetEntity?> byId(String assetId) => AssetEntity.fromId(assetId);
}

class PhotoLibraryService {
  PhotoLibraryService({required UploadQueue queue, PhotoLibraryGateway gateway = const DevicePhotoLibrary()})
      : _queue = queue,
        _gateway = gateway;

  final UploadQueue _queue;
  final PhotoLibraryGateway _gateway;
  bool _scanning = false;

  Future<PermissionState> requestPermission() async {
    final permission = await _gateway.requestPermission();
    if (!permission.hasAccess) await _queue.markGalleryJobsNeedsPermission();
    return permission;
  }

  Future<PermissionState> checkPermission() async {
    final permission = await _gateway.currentPermission();
    if (permission.hasAccess) {
      await _queue.resumeGalleryJobs();
    } else {
      await _queue.markGalleryJobsNeedsPermission();
    }
    return permission;
  }

  Future<int> scanAndQueue({int pageSize = 80}) async {
    if (_scanning) return 0;
    _scanning = true;
    try {
      final permission = await checkPermission();
      if (!permission.hasAccess) return 0;
      var added = 0;
      for (var page = 0;; page++) {
        final assets = await _gateway.latest(page: page, pageSize: pageSize);
        if (assets.isEmpty) break;
        for (final asset in assets) {
          try {
            if (!await _queue.hasAsset(asset.id)) {
              final job = await _jobFor(asset);
              if (job != null) {
                await _queue.enqueue(job);
                added++;
              }
            }
          } on FileSystemException {
            // A media provider or the user may revoke access while the page is being scanned.
          } on PlatformException {
            // Native media access can fail transiently; the next foreground scan will retry.
          }
        }
        if (assets.length < pageSize) break;
      }
      return added;
    } finally {
      _scanning = false;
    }
  }

  Future<UploadJob?> queueAsset(AssetEntity asset) async {
    if (await _queue.hasAsset(asset.id)) return null;
    final job = await _jobFor(asset);
    if (job != null) await _queue.enqueue(job);
    return job;
  }

  Future<String?> resolveOriginal(UploadJob job) async {
    final id = job.assetId;
    if (id == null) return job.filePath;
    try {
      final permission = await checkPermission();
      if (!permission.hasAccess) return null;
      final asset = await _gateway.byId(id);
      final file = await asset?.originFile;
      return file?.path;
    } on FileSystemException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  Future<List<AssetEntity>> latestForSelection({int pageSize = 80}) async {
    final permission = await checkPermission();
    return permission.hasAccess ? _gateway.latest(pageSize: pageSize) : const [];
  }

  Future<UploadJob?> _jobFor(AssetEntity asset) async {
    final file = await asset.originFile;
    if (file == null) return null;
    final stat = await file.stat();
    if (stat.type != FileSystemEntityType.file || stat.size <= 0) return null;
    final digest = await sha256.bind(file.openRead()).first;
    final filename = (await asset.titleAsync).trim();
    if (filename.isEmpty) return null;
    final relative = asset.relativePath;
    final relativePrefix = relative == null || relative.isEmpty
        ? ''
        : relative.endsWith('/') ? relative : '$relative/';
    final originalPath = '$relativePrefix$filename';
    final now = DateTime.now().toUtc();
    return UploadJob(
      id: '${asset.id}:${digest.toString()}',
      assetId: asset.id,
      filePath: file.path,
      originalPath: originalPath,
      filename: filename,
      totalBytes: stat.size,
      sha256: digest.toString(),
      idempotencyKey: createIdempotencyKey(),
      state: UploadJobState.queued,
      createdAt: now,
      updatedAt: now,
    );
  }
}
