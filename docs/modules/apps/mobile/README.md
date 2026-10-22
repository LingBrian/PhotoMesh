# PhotoMesh Android 客户端

客户端通过 Android 相册权限读取原始媒体，不会编辑或删除设备原图。上传任务和服务端已确认的字节偏移保存在应用私有 SQLite 数据库。节点令牌通过 Android 安全存储保存，不写入 SQLite 或应用日志。最低 Android SDK 为 24（Android 7.0）。

## 运行与测试

在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm test:mobile
pnpm test:mobile-compose
```

`pnpm test:mobile` 在此目录执行 `flutter pub get`、`flutter analyze` 和 `flutter test`。Flutter SDK 需单独安装。`pnpm test:mobile-compose` 使用 Windows/NAS Docker fixture，测试首块落盘后的节点重启、相同分块重放、按服务端偏移续传以及最终原图 SHA-256。它只生成合成字节，增加一个唯一的 smoke-test 图库，并保留 Compose 服务与数据卷。默认 Docker Compose 项目名为 `photomesh-sync-final`，可通过 `PHOTOMESH_COMPOSE_PROJECT` 和 `PHOTOMESH_DOCKER_WSL_DISTRO` 覆盖。

## 客户端行为

- Android 相册权限遵循系统允许范围，包括完整授权和用户选择照片授权。应用回到前台时重新检查权限；撤销后将相关任务标为“需要相册权限”，保留队列。重新授权后，相关任务恢复可运行状态。
- 应用前台通过 MediaStore 变更通知发现新照片；启用自动上传时也由 WorkManager 定期巡检。周期最短为 15 分钟，Android 仍可能因电池、待机、配额、网络或厂商省电策略延迟或停止任务。界面不会将后台任务标成实时执行保证。
- Wi-Fi 策略在每个分块发送前检查，并配置 WorkManager 为非计费网络；任意网络策略允许 Wi-Fi 或移动网络。仅手动模式会关闭周期任务，用户明确操作后可以启动上传。
- 每次创建或恢复会话前，都对当前完整原图重新计算 SHA-256。随后按顺序发送 4 MiB 分块及各自 SHA-256；重启后先查询服务端持久化偏移。只有完成回执的整图 SHA-256 和字节数均与源文件一致，任务才标记为完成。
- 手动选择器当前显示系统相册最近 80 个媒体项目。任务可在进程退出或设备重启后恢复；后台运行时机由 Android 决定。
- Release 构建要求 HTTPS。Debug 构建只允许 localhost 或 Android 模拟器宿主（`10.0.2.2`）使用 HTTP。Android 网络安全配置保持 Release 明文流量关闭。

## 授权依赖

当前 Node Agent 上传路由只接受节点管理员令牌，M2 配对流程尚未提供按设备/图库授权的上传凭据。应用将令牌标为管理员令牌并保存在 Android 安全存储中，但正式多设备部署前必须单独完成服务端 scoped authorization。请勿把管理员令牌保存到共享或不受信任的手机。Docker smoke test 只使用 fixture 令牌。

Compose fixture 在本机回环地址提供 HTTP。Android 模拟器可用 `http://10.0.2.2:18443` 访问调试节点；Release 构建不会连接该地址。真机验收需使用 HTTPS Node Agent，或通过 `adb reverse` 映射本机调试端点。不要为此放开 Release 明文网络。

## 真机验收清单

使用 Android 真机、非生产测试节点和合成照片执行。每轮记录 Android 版本、应用构建、节点构建、源文件 SHA-256 和服务端 SHA-256。

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 完整与部分相册授权 | 分别授权完整访问和仅选择照片 | 只列出 Android 当前允许访问的照片。 |
| 撤销权限 | 排队后在系统设置撤销相册权限，再返回应用 | 任务变成“需要相册权限”，队列保留，原文件不变；恢复授权后可以继续。 |
| 锁屏 | 多分块上传时锁定设备 | 状态依据已持久化队列显示；不得承诺实时运行。任何完成任务的源和服务端 SHA-256 必须相同。 |
| 进程或设备重启 | 部分上传中重启设备，再打开应用或等待 WorkManager | 会话及偏移保留，续传先采用服务端当前偏移。 |
| 网络切换 | Wi-Fi-only 时从 Wi-Fi 切换到移动网络，再恢复 Wi-Fi；any-network 下重复 | Wi-Fi-only 在分块边界暂停，恢复 Wi-Fi 后继续；any-network 可在移动网络继续。 |
| 服务端重启 | 分块间停止并重启测试 Node Agent | 会话偏移保持；同一分块重放幂等；只有完整 SHA-256 相同才显示完成。 |

当前环境没有 Android 真机和 `adb`，以上真机验收尚未执行。
