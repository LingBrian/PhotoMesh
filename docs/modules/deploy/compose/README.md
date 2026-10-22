# Compose

此 Compose 仅用于隔离的双节点同步模拟，不能作为生产部署模板。Node Agent 容器在 Linux Secret Service 不可用时无法使用真实密钥存储；模拟环境显式使用仅供测试的 fixture 文件密钥和固定管理员 token。

## 双节点同步模拟

```powershell
docker compose -f deploy/compose/docker-compose.sync.yml up -d --build
pnpm test:sync-compose
```

环境启动两个相互独立的 Node agent：`windows-sim` 用于模拟 NTFS 来源语义，`nas-sim` 用于模拟 Linux/NAS。两者使用独立 SQLite、身份密钥目录和托管原图卷，通过仅含两个节点的私有 Docker bridge 网络连接；不会配置中心数据库或公网服务。测试 API 只绑定节点的私有容器地址，宿主机映射限定在 `127.0.0.1:18443` 和 `127.0.0.1:18444`。默认管理员令牌只用于本地 fixture，不能用于实际部署。

`pnpm test:sync-compose` 会完成双向配对和图库授权、分别上传两份不同原图、断开/恢复 NAS 节点、重启节点，并检查投影最终收敛而原图仍留在各自节点。它保留专用 named volumes，避免自动清理测试节点数据。彻底重置仅限这个模拟环境时，使用：

```powershell
docker compose -f deploy/compose/docker-compose.sync.yml down -v
```

该模拟容器运行在 Linux 内核上，不能替代真实 Windows/NTFS 和 NAS 实机验收。其他重复投递、乱序、因果缺口、墓碑、授权拒绝和 N-1 兼容用例由 Node agent Vitest 集成测试覆盖。

本机 Node Agent 启动、Windows 外部目录只读扫描、网络边界、预发布客户端安装和 GitHub Actions 发版步骤见[部署与预发布教程](../../../预发布发布流程.md)。不要把本页的固定 token、测试配置或 `down -v` 命令用于真实图库。
