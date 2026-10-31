# Operations

记录节点安装、升级、监控、备份与恢复操作手册。

## Agent 关停与重启恢复（PM-039）

- 正常停止可发送 `SIGINT`（前台 Ctrl+C）或 `SIGTERM`（服务管理器停止）。Agent 同时停止接受新的 HTTP 请求、停止 LAN P2P 与外部目录扫描，并等待这些资源及在途请求结束；随后等待媒体版本/上传恢复工作，最后关闭 SQLite。恢复或扫描中的临时/分块数据不会因关停被主动删除。
- 启动时先执行 SQLite `quick_check`，通过后才迁移/启动监听；失败时 Agent 失败关闭，不自动修复或覆盖数据库。保留数据目录，使用经验证的备份恢复流程处理，不要手动删除数据库、WAL/SHM 或 staging 文件。
- 崩溃恢复会将未完成的运行中上传 job 重新排队。所有分块已持久化且未过期的会话会自动重试完成，并再次验证完整对象 SHA-256；尚未收齐的会话保留 durable offset，客户端使用原 session ID 查询偏移并续传。媒体版本 staging 任务也会在启动后恢复。
- 本地验证：`pnpm --filter @photomesh/node-agent exec vitest run test/repository.test.ts test/uploads.test.ts test/lifecycle.test.ts test/external-scan.test.ts`。重启/文件系统测试只使用自动创建的临时目录，不代表已经完成真实 NAS、断电或生产数据恢复演练。
