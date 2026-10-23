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

Download the latest Windows Pre-release installer from [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases), and download that release's `SHA256SUMS`. Verify it in PowerShell with `Get-FileHash .\PhotoMesh-version-windows-x64.exe -Algorithm SHA256` before installing. The current installer is unsigned; continue only on a test computer if Windows displays a security warning. If no release asset is available, use the source download and local Web development steps above.

1. **Open the client.** Start the Agent on its node computer, then launch PhotoMesh from the Start menu. Or, from the repository root, run `pnpm --filter @photomesh/web dev` in another PowerShell and open the local URL printed in the terminal.
2. **Enter the node URL and token.** Open **Settings → Node settings**. On the same computer, enter `http://127.0.0.1:8443`. For a node on another computer, use its private LAN IP (for example `http://192.168.1.20:8443`), and expose the HTTP API across devices only behind a trusted TLS reverse proxy. Enter the node's `PHOTOMESH_ADMIN_TOKEN`, click **Save and connect**, and confirm the status is online and the library list loads. Give this token only to trusted administrator devices.
3. **Create an invitation.** Under **Settings → Pairing**, click **Create invite**. The page shows a QR code and a JSON invite. It expires in about two minutes and can be used once. The client does not currently include a camera QR scanner: on the other node's client, copy the JSON invite into the “Scan invite” text box and click Join.
4. **Approve the peer.** The host node's local API requires an administrator to approve the new identity. The UI can create/join invitations and list/revoke trusted peers, but does not yet have an approval button. On the host computer, read pending peers in local PowerShell: `Invoke-RestMethod http://127.0.0.1:8443/v1/pairing/peers -Headers @{ Authorization = "Bearer $env:PHOTOMESH_ADMIN_TOKEN" }`. Check the Peer ID under `pending`, then use the approval endpoint in the [LAN pairing guide](docs/operations/LAN安全配对.md) to grant only the required read-only library access.
5. **Verify and revoke.** Confirm the trusted peer state in the pairing settings. After testing, revoke the peer and verify it can no longer read the gallery index. Revocation cannot remotely erase data already cached by that peer. Android uploads currently use the administrator token; do not give it to untrusted devices. See the [Android client guide](docs/modules/apps/mobile/README.md).

Verify on one computer before attempting access over a network. Do not expose the `8443` management API to the public Internet or an untrusted LAN. P2P pairing protects the node-to-node channel; it does not provide TLS for the management HTTP API.

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
