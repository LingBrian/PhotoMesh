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

### 从下载开始：Windows 首次部署

以下步骤先用空的测试照片目录验证。PhotoMesh 仍是预览版，请勿让它成为重要照片的唯一副本。

1. **安装 Git 和 Node.js。** 从 [Git for Windows](https://git-scm.com/download/win) 安装 Git；从 [Node.js 下载页](https://nodejs.org/en/download) 安装 Node.js 22.12 或更新的 22.x。安装后重新打开 PowerShell，运行 `git --version` 和 `node --version` 确认可用。
2. **安装 pnpm。** Node.js 自带 Corepack 时执行 `corepack enable`，然后执行 `corepack prepare pnpm@11.25.0 --activate`。运行 `pnpm --version`；仓库声明的包管理器版本优先，若版本不匹配就按根目录 `package.json` 的 `packageManager` 字段安装对应版本。
3. **下载源码。** 初学者可在 [PhotoMesh GitHub 仓库](https://github.com/LingBrian/PhotoMesh) 点击绿色 **Code → Download ZIP**，解压到例如 `D:\PhotoMesh\PhotoMesh`。也可用 Git：

```powershell
git clone https://github.com/LingBrian/PhotoMesh.git D:\PhotoMesh\PhotoMesh
Set-Location D:\PhotoMesh\PhotoMesh
```

4. **准备独立的数据目录和测试图库。** 数据目录放数据库、上传文件和运行状态；外部原图目录仅用于只读扫描。先创建空测试目录，绝不要把整块磁盘设为扫描根目录：

```powershell
New-Item -ItemType Directory -Force D:\PhotoMesh\agent-data | Out-Null
New-Item -ItemType Directory -Force D:\PhotoMesh\sample-photos | Out-Null
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"demo-photos","libraryId":"demo","path":"D:\\PhotoMesh\\sample-photos","pathStyle":"win32"}]'
$env:PHOTOMESH_ADMIN_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

5. **安装依赖并构建节点。** 在仓库根目录运行。首次安装需要联网下载依赖，完成后再启动：

```powershell
Set-Location D:\PhotoMesh\PhotoMesh
pnpm install --frozen-lockfile
pnpm --filter @photomesh/node-agent build
```

6. **启动节点。** 在当前 PowerShell 窗口运行；保持窗口打开。默认 API 仅监听本机 `127.0.0.1:8443`：

```powershell
pnpm --filter @photomesh/node-agent start
```

7. **确认服务和扫描结果。** 另开一个 PowerShell 窗口，在同一机器请求健康检查；服务启动窗口应显示监听地址和扫描初始化状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8443/v1/health
```

看到健康响应后再添加少量可丢弃的测试图片到 `sample-photos`，确认扫描仅建立索引，不会修改源文件。按 `Ctrl+C` 正常停止。每次新开窗口都要重新设置 `$env:` 变量；密钥和令牌不要提交到 Git、截图或日志。

### 终端连接步骤

先在 [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases) 下载最新 Pre-release 的 Windows 安装包；下载同一版本的 `SHA256SUMS`，在 PowerShell 用 `$asset = Get-ChildItem . -Filter '*x64-setup.exe' | Select-Object -First 1; $hash = (Get-FileHash $asset.FullName -Algorithm SHA256).Hash.ToLower(); if ((Get-Content .\SHA256SUMS -Raw) -notmatch [regex]::Escape($hash)) { throw 'SHA-256 mismatch' }` 核对后再安装。Windows 安全提示当前未签名安装包时，只在测试电脑上确认继续。还没有发布资产时，用上面的源码下载和本地开发步骤启动 Web 客户端。

1. **打开客户端。** 在节点电脑启动 Agent；再从开始菜单打开 PhotoMesh，或在仓库根目录另开 PowerShell 运行 `pnpm --filter @photomesh/web dev`，并打开终端打印的本地地址。
2. **填写节点地址和令牌。** 打开 **设置 → 节点设置**，本机输入 `http://127.0.0.1:8443`；节点在另一台电脑时，填节点的私有 LAN IP（例如 `http://192.168.1.20:8443`），但只有在已配置可信 TLS 反向代理后才可跨设备开放 HTTP API。把节点运行时的 `PHOTOMESH_ADMIN_TOKEN` 填入令牌框，点 **保存并连接**，返回时间线确认状态为在线、图库列表可读取。令牌只给受信任的管理员设备。
3. **创建邀请。** 在 **设置 → 配对** 点击 **创建邀请**。页面会显示二维码和一段 JSON 邀请文本，有效期约 2 分钟，只能使用一次。客户端目前没有摄像头扫码器：在接入节点的另一端打开其客户端设置，把邀请 JSON 复制粘贴到“扫描邀请”文本框，再点击加入。
4. **批准对端。** 邀请发起端运行节点的本机 API 需要管理员批准新身份。当前界面可创建/加入邀请和查看/撤销可信节点，尚无批准按钮；在该节点电脑本机 PowerShell 读取待批准列表：`Invoke-RestMethod http://127.0.0.1:8443/v1/pairing/peers -Headers @{ Authorization = "Bearer $env:PHOTOMESH_ADMIN_TOKEN" }`。核对 `pending` 中的 Peer ID 后，按 [LAN 配对指南](docs/operations/LAN安全配对.md) 调用批准接口，只授予确实需要的图库只读权限。
5. **验证和撤销。** 两端在配对页确认可信节点状态。完成验证后，撤销设备并确认它不再能读取图库索引；撤销不会远程删除对端此前缓存的数据。Android 上传目前使用管理员令牌，不能把它交给不受信任设备；详见 [Android 客户端说明](docs/modules/apps/mobile/README.md)。

先在同一台电脑验证连接，再考虑跨设备网络。不要把 `8443` 管理 API 映射到公网或不可信 LAN。P2P 配对只保护节点间通道，不为管理 HTTP API 提供 TLS。

## 本地开发

需要 Node.js 22.12+、pnpm 11；Flutter SDK 单独安装，Dart/Flutter 依赖由 `pub` 管理。

```powershell
pnpm install --frozen-lockfile
pnpm --filter @photomesh/web dev
```

常用验证与构建：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm test:e2e
pnpm build
pnpm test:sync-compose
pnpm test:mobile
pnpm build:mobile
```

Flutter 命令需要先安装 Flutter SDK 与 Android 工具链。架构、API、开发规范、测试/发布验收和各模块说明从[文档总览](docs/AI文档总览.md)进入；预发布和节点运维见[部署教程](docs/预发布发布流程.md)。

## 许可证

PhotoMesh 使用 [Apache License 2.0](LICENSE)。

## Star 趋势

[![PhotoMesh GitHub Star History](https://api.star-history.com/chart?repos=LingBrian/PhotoMesh&type=date&legend=top-left)](https://www.star-history.com/#LingBrian/PhotoMesh&Date)
