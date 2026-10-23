# PhotoMesh

[![CI](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml)
[![Pre-release](https://img.shields.io/github/v/release/LingBrian/PhotoMesh?include_prereleases&label=pre-release)](https://github.com/LingBrian/PhotoMesh/releases)
[![Apache-2.0](https://img.shields.io/github/license/LingBrian/PhotoMesh)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/LingBrian/PhotoMesh?style=flat)](https://github.com/LingBrian/PhotoMesh/stargazers)

PhotoMesh is a self-hosted, decentralized photo library. Each node keeps its own originals and synchronizes only authorized metadata and events; original-file access is checked by the node. The project is in preview. Validate deployments with synthetic data first, and do not entrust an unvalidated instance with the only copy of irreplaceable photos.

## Technology stack

| Layer | Technology |
| --- | --- |
| Monorepo | pnpm Workspace, Turborepo, TypeScript strict |
| Node service | Node.js LTS, TypeScript, SQLite |
| Web / Windows desktop | Vue 3, TypeScript, Tauri 2 |
| Android | Flutter / Dart, managed by Flutter Pub and repository scripts, outside npm dependencies |
| Quality and contracts | Vitest, Playwright, Flutter test, Docker Compose, OpenAPI / JSON Schema |

## Node deployment

### Start from download: first Windows deployment

Use an empty test photo directory for the first run. PhotoMesh is a preview; do not make it the only copy of important photos.

1. **Install Git and Node.js.** Install Git from [Git for Windows](https://git-scm.com/download/win) and Node.js 22.12 or a newer 22.x release from the [Node.js download page](https://nodejs.org/en/download). Reopen PowerShell, then verify with `git --version` and `node --version`.
2. **Install pnpm.** If Corepack is available, run `corepack enable` and `corepack prepare pnpm@11.0.0 --activate`. Check `pnpm --version`. The repository's root `package.json` `packageManager` field is authoritative if its pinned version differs.
3. **Download the source.** On the [PhotoMesh GitHub repository](https://github.com/LingBrian/PhotoMesh), choose the green **Code → Download ZIP** button and extract to a path such as `D:\PhotoMesh\PhotoMesh`. Or clone with Git:

```powershell
git clone https://github.com/LingBrian/PhotoMesh.git D:\PhotoMesh\PhotoMesh
Set-Location D:\PhotoMesh\PhotoMesh
```

4. **Create separate data and test-photo directories.** The data directory holds SQLite, managed uploads, and runtime state. External photo roots are scanned read-only. Start with an empty test directory; never authorize an entire disk:

```powershell
New-Item -ItemType Directory -Force D:\PhotoMesh\agent-data | Out-Null
New-Item -ItemType Directory -Force D:\PhotoMesh\sample-photos | Out-Null
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"demo-photos","libraryId":"demo","path":"D:\\PhotoMesh\\sample-photos","pathStyle":"win32"}]'
$env:PHOTOMESH_ADMIN_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

5. **Install dependencies and build the node.** Run these commands from the repository root. The first install downloads dependencies:

```powershell
Set-Location D:\PhotoMesh\PhotoMesh
pnpm install --frozen-lockfile
pnpm --filter @photomesh/node-agent build
```

6. **Start the node.** Keep this PowerShell window open. The API binds to local loopback `127.0.0.1:8443` by default:

```powershell
pnpm --filter @photomesh/node-agent start
```

7. **Verify the service and scan.** Open another PowerShell window on the same computer and run the health request. The node window should show its bind address and scan initialization:

```powershell
Invoke-RestMethod http://127.0.0.1:8443/v1/health
```

When it returns a healthy response, add a few disposable test photos to `sample-photos` and confirm scanning only indexes them. Stop with `Ctrl+C`. Environment variables set with `$env:` must be set again in each new window. Never commit tokens or keys, or include them in screenshots or logs.

### Connect a client device

The client connects to the node API from its settings. For the first check, use the Web client on the same Windows computer so you do not need to expose a LAN port:

1. While the node is running, open another PowerShell at the repository root and run `pnpm --filter @photomesh/web dev`. Open the local development URL printed in the terminal.
2. Open **Settings → Node settings**. Enter `http://127.0.0.1:8443` as the node URL and the `PHOTOMESH_ADMIN_TOKEN` used by the node, save, then return to the timeline and confirm the library list loads.
3. Under **Settings → Pairing**, create an invitation and pass its short-lived QR/invite data to another PhotoMesh node. It expires in about two minutes and can only be used once. Share it in person or through a trusted channel; never post it publicly.
4. For devices on separate computers, first place both nodes on a trusted private network and follow the [LAN secure pairing guide](docs/operations/LAN安全配对.md) to configure explicit private addresses and firewall rules. The QR identity key verifies the peer; mDNS/IP only helps discover its address.
5. The host administrator must approve the pending peer and grant only the required library. After revocation, verify that the device can no longer read the index. The Android upload credential currently uses the administrator token and must not be given to untrusted devices; see the [Android client guide](docs/modules/apps/mobile/README.md).

Do not expose the `8443` management API to the public Internet or an untrusted LAN. Cross-device UI access needs a trusted reverse proxy with TLS and authentication. LAN pairing does not provide TLS for the HTTP API.

On Windows, install Node.js 22.12+ and pnpm 11. Keep Agent data separate from photo directories, and explicitly allow only the external roots to scan:

```powershell
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\Photos","pathStyle":"win32"}]'
pnpm install --frozen-lockfile
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
```

The Agent reads external photo roots without modifying them; its database and uploaded files use the separate data directory. The service binds to a local address by default. Do not expose the HTTP API to a LAN or the public Internet without TLS and authentication. See the [deployment and prerelease guide](docs/预发布发布流程.md) and [Docker deployment guide](docs/modules/deploy/docker/README.md) for configuration, two-node exercises, and NAS limits.

## Connect a client device

1. Create a short-lived pairing invitation on a running node.
2. Scan its QR code from the client. If mDNS is unavailable, enter the node's private IP manually.
3. Verify the peer key identity, have the node administrator approve it, and grant only the required read-only library access.

See the [LAN secure pairing guide](docs/operations/LAN安全配对.md). Android permissions, network policies, upload queues, and background limits are covered in the [Android client guide](docs/modules/apps/mobile/README.md).

## Local development

Requires Node.js 22.12+ and pnpm 11. Install Flutter separately when working on Android; Flutter dependencies use `pub`.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @photomesh/web dev
```

Common checks and builds:

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

Flutter commands require the Flutter SDK and Android toolchain. Start with the [documentation index](docs/AI文档总览.md) for architecture, APIs, development rules, tests, release acceptance, and module guides. Deployment and operations are covered in the [deployment guide](docs/预发布发布流程.md).

## License

PhotoMesh is licensed under the [Apache License 2.0](LICENSE).

## Star history

[![PhotoMesh GitHub Star History](https://api.star-history.com/chart?repos=LingBrian/PhotoMesh&type=date&legend=top-left)](https://www.star-history.com/#LingBrian/PhotoMesh&Date)
