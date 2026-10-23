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

### 使用预构建节点包（Windows x64 / Linux x64）

普通使用者下载已构建的节点软件包即可，无需在目标设备安装 Node.js 或编译源码。在 [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases) 选择同一版本的节点包和 `SHA256SUMS.txt`。

1. **下载与校验。** Windows 下载 `PhotoMesh-<版本>-node-agent-windows-x64.zip`；Linux 下载 `PhotoMesh-<版本>-node-agent-linux-x64.tar.gz`。使用清单中对应文件名的 SHA-256 值校验压缩包后再解压。
2. **Windows 解压并启动。** 在文件资源管理器右键 ZIP，选择“全部解压缩”。进入解压目录，双击 `start.bat`。首次运行会提示管理员令牌；留空会生成一次性令牌并显示，请保存到密码管理器。
3. **Linux 解压并启动。** 假设下载目录为当前目录，执行：
   ```sh
   mkdir -p "$HOME/.local/opt/photomesh/node-agent/<版本>"
   tar -xzf PhotoMesh-<版本>-node-agent-linux-x64.tar.gz -C "$HOME/.local/opt/photomesh/node-agent/<版本>"
   cd "$HOME/.local/opt/photomesh/node-agent/<版本>"
   ./start.sh
   ```
   首次运行按提示设置管理员令牌；留空会生成一次性令牌并显示，请安全保存。
4. **可选来源目录。** 启动器可填写一个外部照片目录供只读扫描；留空则不扫描。不要把 PhotoMesh 数据目录放在外部来源目录内。
5. **确认服务启动。** Agent 在前台运行，关闭窗口或按 Ctrl+C 会停止。服务默认只监听本机 `127.0.0.1:8443)。在另一终端检查：Windows 运行 `Invoke-RestMethod http://127.0.0.1:8443/v1/health`；Linux 运行 `curl http://127.0.0.1:8443/v1/health`。
6. Windows 数据目录默认为 `%LOCALAPPDATA%\PhotoMesh\data`；Linux 默认是 `~/.local/share/photomesh`。重启后需输入相同管理员令牌。Linux 节点身份密钥依赖 Secret Service；未配置时，安全配对/P2P 会关闭。
7. 当前节点包仅支持 x64/amd64；没有 ARM64 NAS 包。先用合成照片验证，预览版不要作为唯一原图副本。
### Linux Docker 镜像（可选）

发布包也提供 `PhotoMesh-<版本>-node-agent-linux-amd64.docker.tar`。下载后运行 `docker load -i <镜像归档>`，然后用专用数据卷启动。详细命令、回滚与网络边界见[部署与预发布教程](docs/预发布发布流程.md)。

### 终端连接步骤

先在 [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases) 下载最新 Windows x64 桌面安装包（`PhotoMesh-<版本>-windows-x64-unsigned.exe`）；下载同一版本的 `SHA256SUMS.txt`，在 PowerShell 用 `$asset = Get-ChildItem . -Filter '*windows-x64-unsigned.exe' | Select-Object -First 1; $hash = (Get-FileHash $asset.FullName -Algorithm SHA256).Hash.ToLower(); if ((Get-Content .\SHA256SUMS.txt -Raw) -notmatch [regex]::Escape($hash)) { throw 'SHA-256 mismatch' }` 核对后再安装。Windows 安全提示当前未签名安装包时，只在测试电脑上确认继续。还没有发布资产时，用上面的源码下载和本地开发步骤启动 Web 客户端。

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
