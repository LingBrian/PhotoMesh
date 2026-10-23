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

### Preferred: download the prebuilt Node Agent (Linux x86_64)

The release workflow provides a compiled Docker image archive named `PhotoMesh-<version>-node-agent-linux-amd64.docker.tar`. On a Linux x86_64 NAS, this avoids downloading source, installing Node.js, or compiling. There is no ARM64 NAS image or standalone native Windows Node Agent installer yet.

1. Install and start Docker Engine on the Linux x86_64 host. Verify `docker version` and `docker info` succeed.
2. From [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases), download `node-agent-linux-amd64.docker.tar` and `SHA256SUMS.txt` from the same Pre-release. Make sure the versions match.
3. Calculate the archive SHA-256 and confirm that value appears in the checksum manifest. Stop if it does not match:
   
   ```sh
   sha256sum PhotoMesh-*-node-agent-linux-amd64.docker.tar
   grep '<SHA256-from-previous-command>' SHA256SUMS.txt
   ```

4. Load the prebuilt image and confirm its tag:
   
   ```sh
   docker load -i PhotoMesh-<version>-node-agent-linux-amd64.docker.tar
   docker image ls photomesh/node-agent
   ```

5. Create a dedicated Docker volume and start the node on loopback. This command does not mount a photo directory or expose the API to the LAN:
   
   ```sh
   docker volume create photomesh-node-data
   export PHOTOMESH_ADMIN_TOKEN="$(openssl rand -base64 32)"
   docker run -d --name photomesh-node --restart unless-stopped --network host \
     -e PORT=8443 -e PHOTOMESH_DATA_DIR=/data \
     -e PHOTOMESH_API_BIND_ADDRESS=127.0.0.1 \
     -e PHOTOMESH_ADMIN_TOKEN \
     -v photomesh-node-data:/data \
     photomesh/node-agent:<version>
   ```

6. On that Linux host, run `curl http://127.0.0.1:8443/v1/health`. Read startup output with `docker logs photomesh-node`; stop it with `docker stop photomesh-node`. Reuse the same named volume after restart. Never remove a volume that contains real data.

This is a Linux x86_64 preview build. Linux node identity keys require an available Secret Service; without one, pairing/P2P is disabled and this is not a complete NAS node deployment. Do not expose the host's full D-Bus session to an untrusted container. The image has not passed ARM64, NAS production, or secure-key-service integration acceptance. Assess photo-root mounts, LAN API access, backup/recovery, and production operation separately before use with real photos.

### Native Windows run (development/testing path)

There is no standalone Windows Node Agent installer yet, so native Windows use currently requires source and Node.js. Use the steps below only for local preview/testing. For a published prebuilt artifact, use the Linux x86_64 image above.

### Start from download: first Windows deployment

Use an empty test photo directory for the first run. PhotoMesh is a preview; do not make it the only copy of important photos.

1. **Install Git and Node.js.** Install Git from [Git for Windows](https://git-scm.com/download/win) and Node.js 22.12 or a newer 22.x release from the [Node.js download page](https://nodejs.org/en/download). Reopen PowerShell, then verify with `git --version` and `node --version`.
2. **Install pnpm.** If Corepack is available, run `corepack enable` and `corepack prepare pnpm@11.25.0 --activate`. Check `pnpm --version`. The repository's root `package.json` `packageManager` field is authoritative if its pinned version differs.
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

Download the latest Windows Pre-release installer from [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases), and download that release's `SHA256SUMS`. Verify it in PowerShell with `$asset = Get-ChildItem . -Filter '*x64-setup.exe' | Select-Object -First 1; $hash = (Get-FileHash $asset.FullName -Algorithm SHA256).Hash.ToLower(); if ((Get-Content .\SHA256SUMS -Raw) -notmatch [regex]::Escape($hash)) { throw 'SHA-256 mismatch' }` before installing. The current installer is unsigned; continue only on a test computer if Windows displays a security warning. If no release asset is available, use the source download and local Web development steps above.

1. **Open the client.** Start the Agent on its node computer, then launch PhotoMesh from the Start menu. Or, from the repository root, run `pnpm --filter @photomesh/web dev` in another PowerShell and open the local URL printed in the terminal.
2. **Enter the node URL and token.** Open **Settings → Node settings**. On the same computer, enter `http://127.0.0.1:8443`. For a node on another computer, use its private LAN IP (for example `http://192.168.1.20:8443`), and expose the HTTP API across devices only behind a trusted TLS reverse proxy. Enter the node's `PHOTOMESH_ADMIN_TOKEN`, click **Save and connect**, and confirm the status is online and the library list loads. Give this token only to trusted administrator devices.
3. **Create an invitation.** Under **Settings → Pairing**, click **Create invite**. The page shows a QR code and a JSON invite. It expires in about two minutes and can be used once. The client does not currently include a camera QR scanner: on the other node's client, copy the JSON invite into the “Scan invite” text box and click Join.
4. **Approve the peer.** The host node's local API requires an administrator to approve the new identity. The UI can create/join invitations and list/revoke trusted peers, but does not yet have an approval button. On the host computer, read pending peers in local PowerShell: `Invoke-RestMethod http://127.0.0.1:8443/v1/pairing/peers -Headers @{ Authorization = "Bearer $env:PHOTOMESH_ADMIN_TOKEN" }`. Check the Peer ID under `pending`, then use the approval endpoint in the [LAN pairing guide](docs/operations/LAN安全配对.md) to grant only the required read-only library access.
5. **Verify and revoke.** Confirm the trusted peer state in the pairing settings. After testing, revoke the peer and verify it can no longer read the gallery index. Revocation cannot remotely erase data already cached by that peer. Android uploads currently use the administrator token; do not give it to untrusted devices. See the [Android client guide](docs/modules/apps/mobile/README.md).

Verify on one computer before attempting access over a network. Do not expose the `8443` management API to the public Internet or an untrusted LAN. P2P pairing protects the node-to-node channel; it does not provide TLS for the management HTTP API.

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
