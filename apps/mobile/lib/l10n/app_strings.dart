const appStrings = <String, Map<String, String>>{
  'zh': {
    'title': 'PhotoMesh 手机备份', 'node': '目标主节点', 'address': '节点 HTTPS 地址', 'library': '图库 ID',
    'token': '节点管理员令牌', 'bind': '绑定主节点', 'bound': '已绑定目标主节点', 'device': '本机设备 ID',
    'permission': '相册权限', 'grant': '授权并扫描', 'permissionGranted': '已授权，可访问系统允许的照片',
    'permissionDenied': '相册访问已关闭。任务保留，重新授权后继续。', 'scan': '立即扫描新照片',
    'manual': '选择照片并上传', 'policy': '网络策略', 'wifi': '仅 Wi-Fi', 'any': 'Wi-Fi 或移动网络',
    'manualOnly': '仅手动', 'queue': '本机上传任务', 'uploadNow': '现在上传队列', 'retry': '重试',
    'queued': '等待中', 'uploading': '传输中', 'paused': '已暂停，可续传', 'completed': '已完成（SHA-256 已核对）',
    'needsPermission': '需要相册权限', 'failed': '失败', 'empty': '暂无上传任务',
    'permissionRevoked': '照片访问权限已撤销。任务已保留；重新授权后可继续。',
    'sourceUnavailable': '无法访问媒体源；请检查权限或该项目是否仍存在。',
    'backgroundNotice': 'Android 会按电量、待机和网络条件调度后台任务。系统可能延迟、停止或在重启后重新安排任务；自动扫描与上传不保证实时。打开应用或点“现在上传队列”可立即尝试。',
    'httpNotice': '出于令牌安全，正式构建只连接 HTTPS 节点。HTTP 仅在调试构建中用于本机或 Android 模拟器宿主。',
    'authNotice': '当前 Node Agent 上传 API 只接受管理员令牌，尚无按设备/图库授权的上传凭据。请勿把令牌存入共享设备；多设备正式部署前需完成服务端权限接口。',
    'nodeRequired': '请先绑定节点。访问令牌仅保存在 Android 安全存储中。',
    'networkBlocked': '当前网络不符合策略；任务已保留。', 'scanAdded': '已加入 {count} 个新照片任务。',
    'manualAdded': '已加入 {count} 个所选照片。', 'selectPhotos': '选择最近照片', 'cancel': '取消', 'add': '加入队列',
    'scanFailed': '扫描中断；检查相册权限后可以重试。',
    'chooseNetwork': '选择网络策略', 'permissionAction': '打开系统设置', 'nodeSaved': '目标节点已保存。',
    'sourceChanged': '原文件内容有变化，未上传。', 'runLimit': '每轮后台最多处理 4 项，后续由系统调度。',
  },
  'en': {
    'title': 'PhotoMesh Mobile Backup', 'node': 'Target node', 'address': 'Node HTTPS URL', 'library': 'Library ID',
    'token': 'Node admin token', 'bind': 'Bind node', 'bound': 'Target node is bound', 'device': 'This device ID',
    'permission': 'Photo permission', 'grant': 'Grant and scan', 'permissionGranted': 'Authorized for the photos allowed by Android',
    'permissionDenied': 'Photo access is off. Jobs are kept and can resume after access is restored.', 'scan': 'Scan for new photos',
    'manual': 'Select photos and upload', 'policy': 'Network policy', 'wifi': 'Wi-Fi only', 'any': 'Wi-Fi or mobile data',
    'manualOnly': 'Manual only', 'queue': 'Local upload queue', 'uploadNow': 'Upload queue now', 'retry': 'Retry',
    'queued': 'Queued', 'uploading': 'Uploading', 'paused': 'Paused; can resume', 'completed': 'Complete (SHA-256 verified)',
    'needsPermission': 'Photo permission needed', 'failed': 'Failed', 'empty': 'No upload jobs',
    'permissionRevoked': 'Photo access was revoked. The job is kept and can resume after access is restored.',
    'sourceUnavailable': 'The media source is unavailable. Check photo access or whether the item still exists.',
    'backgroundNotice': 'Android schedules background work according to battery, idle, and network conditions. It may delay or stop tasks and reschedule them after restart. Automatic scan and upload are not real-time guarantees. Open the app or tap “Upload queue now” to try immediately.',
    'httpNotice': 'For token safety, release builds connect only to HTTPS nodes. HTTP is allowed only in debug builds for localhost or the Android emulator host.',
    'authNotice': 'The current Node Agent upload API accepts only an administrator token; scoped per-device/library upload credentials are not available yet. Do not store this token on a shared device. Complete server-side authorization before deploying this for multiple devices.',
    'nodeRequired': 'Bind a node first. The access token is stored only in Android secure storage.',
    'networkBlocked': 'The current network does not match this policy; jobs are kept.', 'scanAdded': 'Added {count} new photo jobs.',
    'manualAdded': 'Added {count} selected photos.', 'selectPhotos': 'Select recent photos', 'cancel': 'Cancel', 'add': 'Add to queue',
    'scanFailed': 'The scan stopped. Check photo permission and try again.',
    'chooseNetwork': 'Choose a network policy', 'permissionAction': 'Open system settings', 'nodeSaved': 'Target node saved.',
    'sourceChanged': 'The source file changed; it was not uploaded.', 'runLimit': 'Each background run handles up to 4 jobs; the system schedules later work.',
  },
};

String appString(String languageCode, String key) => appStrings[languageCode]?[key] ?? appStrings['en']![key] ?? key;

String localizedUploadError(String languageCode, String? errorCode) {
  if (errorCode == null || errorCode.isEmpty) return '';
  final key = switch (errorCode) {
    'PERMISSION_REVOKED' => 'permissionRevoked',
    'SOURCE_UNAVAILABLE' => 'sourceUnavailable',
    'SOURCE_CHANGED' => 'sourceChanged',
    _ => null,
  };
  return key == null ? errorCode : appString(languageCode, key);
}
