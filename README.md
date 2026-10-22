# PhotoMesh

[![CI](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml)
[![Pre-release](https://img.shields.io/github/v/release/LingBrian/PhotoMesh?include_prereleases&label=pre-release)](https://github.com/LingBrian/PhotoMesh/releases)
[![License: Apache-2.0](https://img.shields.io/github/license/LingBrian/PhotoMesh)](LICENSE)

PhotoMesh 是一款自托管、去中心化的跨平台相册。可信节点各自保存原图，只同步获授权的元数据和事件；原图上传或下载必须完成 SHA-256 校验。项目面向 Windows、Android、Linux/NAS 和 Web，首版不依赖中心账号服务。

> 当前是早期预览项目。请先用合成测试数据体验，不要把唯一副本或不可替代的原图交给未经验证的部署。发布候选是否通过门禁，以 GitHub Actions 报告为准；Stable 发布仍需维护者单独审批。

## 功能与安全边界

- Node Agent 提供 SQLite 元数据、分块续传、只读外部目录扫描和局域网配对/同步基础能力。
- Android 客户端提供照片授权、上传队列、网络策略与 SHA-256 校验；Android 后台执行受系统调度，不能保证实时运行。
- Vue Web / Tauri 桌面端提供图库浏览界面。每次数据访问由服务端 ACL 控制。
- 原图不可就地覆盖、重编码或自动删除。同步不是备份；NAS 上的源照片默认只读。
- 预览、测试和派生内容使用独立位置；服务/API 默认拒绝未授权访问。

## 教程：本地双节点演练

需要 Node.js 22.12+、pnpm 11 和 Docker Compose v2。演练使用虚构数据，不会访问个人照片：

```powershell
pnpm install --frozen-lockfile
pnpm test:sync-compose
```

脚本启动彼此独立的 Windows 模拟节点与 NAS 模拟节点，验证配对、授权图库、事件同步、断线恢复和节点重启。演练会保留专用 Docker named volumes；Compose 限制和仅重置模拟数据的方法见[双节点 Compose 指南](docs/modules/deploy/compose/README.md)。

## 教程：运行 Node Agent 并只读扫描目录

在 Windows PowerShell 中指定独立的数据目录与获授权的照片根目录，然后启动 agent：

```powershell
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\Photos","pathStyle":"win32"}]'
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
```

扫描器只读访问 `D:\Photos`，索引和任务写入 `D:\PhotoMesh\agent-data`。首次部署前请阅读 [Node Agent 配置与 API 说明](docs/modules/apps/node-agent/README.md) 和[局域网安全配对教程](docs/operations/LAN安全配对.md)。不要将未配置 TLS/认证的 API 暴露到局域网或公网。

## 教程：启动 Web 与构建 Android

在仓库根目录启动 Web 开发服务器：

```powershell
pnpm --filter @photomesh/web dev
```

移动端使用 Flutter `pub`，不加入 pnpm workspace。安装 Flutter SDK 和 Android 工具链后，可运行测试并构建 APK：

```powershell
pnpm test:mobile
pnpm build:mobile
```

客户端权限、Wi-Fi/移动网络策略、续传和后台行为见 [Android 客户端说明](docs/modules/apps/mobile/README.md)。后台任务时机由 Android 决定；真机验收清单不能由模拟器构建替代。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
pnpm test:e2e
```

双节点 Docker 演练使用 `pnpm test:sync-compose`；GitHub Actions 的 `Release candidate gate` 工作流可生成验收报告，`Build and publish prerelease` 工作流只从 `main` 运行完整门禁并构建预发布产品。报告包含性能、SHA-256、迁移恢复、ACL、SBOM、Changelog 和失败定位；若验收证据缺失或检查失败，候选状态会标记为 blocked。Flutter 测试需单独安装 SDK，GitHub Actions 会安装对应工具链。

## 教程：构建并发布预发布版本

在 GitHub Actions 运行 **Build and publish prerelease**，输入 `0.x.y-rc.n`、`0.x.y-beta.n` 或 `0.x.y-alpha.n`。也可用 GitHub CLI 从 `main` 触发：

```powershell
gh workflow run prerelease.yml --ref main -f version=0.1.0-rc.1
```

该流程先运行完整门禁，再构建 Web、Linux x86_64 NAS Docker 镜像、Android APK 和 Windows 安装包。门禁或任一平台构建失败时不会创建预发布。详见[预发布发布流程](docs/预发布发布流程.md)；Stable 需要独立人工审批。

## 文档

从 [AI 文档总览](docs/AI文档总览.md) 开始。产品需求、架构、ADR、发布验收、运行和安全配对文档均归档在 `docs/`。部署方式、双节点 Docker 演练、Windows Node Agent 和预发布安装步骤见[部署与预发布教程](docs/预发布发布流程.md)。

## 许可证

PhotoMesh 使用 [Apache License 2.0](LICENSE)。第三方组件、构建产物和模型需各自遵守其许可证。
