# PhotoMesh

[![CI](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml)
[![Pre-release](https://img.shields.io/github/v/release/LingBrian/PhotoMesh?include_prereleases&label=pre-release)](https://github.com/LingBrian/PhotoMesh/releases)
[![Apache-2.0](https://img.shields.io/github/license/LingBrian/PhotoMesh)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/LingBrian/PhotoMesh?style=flat)](https://github.com/LingBrian/PhotoMesh/stargazers)

PhotoMesh 是一款自托管、去中心化的跨平台相册。各节点独立保存原图，只同步获授权的元数据和事件；访问原图需通过节点授权。项目仍处于预览阶段，请先使用合成数据验证部署，不要将唯一原图副本交给未经验证的实例。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Monorepo | pnpm Workspace、Turborepo、TypeScript strict |
| 节点服务 | Node.js LTS、TypeScript、SQLite |
| Web / Windows 桌面 | Vue 3、TypeScript、Tauri 2 |
| Android | Flutter / Dart；由 Flutter Pub 管理，通过仓库脚本编排，不加入 npm 依赖 |
| 质量与契约 | Vitest、Playwright、Flutter test、Docker Compose、OpenAPI / JSON Schema |

## 节点部署教程

Windows 上准备 Node.js 22.12+ 和 pnpm 11，将 Agent 数据目录与照片目录分开，并只授权需要扫描的外部根目录：

\`\`\`powershell
$env:PHOTOMESH_DATA_DIR = 'D:\\PhotoMesh\\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\\\Photos","pathStyle":"win32"}]'
pnpm install --frozen-lockfile
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
\`\`\`

Agent 对外部照片目录只读，数据库与上传文件写入独立数据目录。服务默认监听本机地址；不要把未配置 TLS/认证的 HTTP API 暴露到 LAN 或公网。Docker 双节点演练、NAS 限制和完整配置见[部署与预发布教程](docs/预发布发布流程.md)及 [Docker 部署说明](docs/modules/deploy/docker/README.md)。

## 终端连接教程

1. 在已运行的节点创建短期配对邀请。
2. 客户端扫描邀请二维码；若 mDNS 不可用，可手动填写节点的私有 IP。
3. 核对对端密钥身份后由节点管理员批准，再按图库授予最小只读权限。

详见 [LAN 安全配对教程](docs/operations/LAN安全配对.md)。Android 首次授权、网络策略、任务队列和后台限制见 [Android 客户端教程](docs/modules/apps/mobile/README.md)。

## 本地开发

需要 Node.js 22.12+、pnpm 11；Flutter SDK 单独安装，Dart/Flutter 依赖由 \`pub\` 管理。

\`\`\`powershell
pnpm install --frozen-lockfile
pnpm --filter @photomesh/web dev
\`\`\`

常用验证与构建：

\`\`\`powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm test:e2e
pnpm build
pnpm test:sync-compose
pnpm test:mobile
pnpm build:mobile
\`\`\`

Flutter 命令需要先安装 Flutter SDK 与 Android 工具链。架构、API、开发规范、测试/发布验收和各模块说明从[文档总览](docs/AI文档总览.md)进入；预发布和节点运维见[部署教程](docs/预发布发布流程.md)。

## 许可证

PhotoMesh 使用 [Apache License 2.0](LICENSE)。

## Star 趋势

[![PhotoMesh GitHub Star History](https://api.star-history.com/chart?repos=LingBrian/PhotoMesh&type=date&legend=top-left)](https://www.star-history.com/#LingBrian/PhotoMesh&Date)
