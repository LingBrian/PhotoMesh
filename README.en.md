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

### One-click node install (Windows x64 / Linux x64)

For normal use, install the prebuilt node package; you do not need to download source or compile on the target device. From [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases), download the installer script from the latest Pre-release:

1. **Windows x64:** Download `install.bat` into a new folder and double-click it. It finds the latest prerelease, downloads the matching `install.ps1`, Node Agent ZIP, and `SHA256SUMS.txt`, verifies the SHA-256, then installs the package with its bundled Node.js runtime.
2. **Linux x64:** Download `install.sh` from the same prerelease and run `chmod +x install.sh && ./install.sh`. It downloads the matching node package and checksum manifest, verifies the hash, extracts, and starts it.
3. **First run:** The script prompts for an administrator token. Leave it blank to generate a one-time token; save the displayed value in a password manager. Optionally enter an external photo directory to scan read-only; leave blank to skip. The API listens on local `127.0.0.1:8443` by default. Verify locally with `curl http://127.0.0.1:8443/v1/health`; on Windows use `Invoke-RestMethod http://127.0.0.1:8443/v1/health`.
4. The node runs in the foreground; closing its window or pressing Ctrl+C stops it. Windows data is stored under `%LOCALAPPDATA%\PhotoMesh\data`; Linux uses `~/.local/share/photomesh` by default. Save the token securely and enter the same token again after restarting.
5. Linux node identity keys require Secret Service. Without it, the local API can start but secure pairing/P2P is unavailable. Do not expose the host's full D-Bus session to an untrusted container.
6. Current release packages are x64/amd64 only; there is no ARM64 NAS package. Validate with synthetic photos first and do not use a preview build as the only copy of originals.

### Optional Linux Docker image

The release also provides `PhotoMesh-<version>-node-agent-linux-amd64.docker.tar`. Load it with `docker load -i <image-archive>` and run it with a dedicated data volume. See the [deployment and prerelease guide](docs/预发布发布流程.md) for commands, rollback, and network boundaries.

### Connect a client device

Download the latest Windows x64 desktop installer (`PhotoMesh-<version>-windows-x64-unsigned.exe`) from [GitHub Releases](https://github.com/LingBrian/PhotoMesh/releases), and download that release's `SHA256SUMS.txt`. Verify it in PowerShell with `$asset = Get-ChildItem . -Filter '*x64-setup.exe' | Select-Object -First 1; $hash = (Get-FileHash $asset.FullName -Algorithm SHA256).Hash.ToLower(); if ((Get-Content .\SHA256SUMS -Raw) -notmatch [regex]::Escape($hash)) { throw 'SHA-256 mismatch' }` before installing. The current installer is unsigned; continue only on a test computer if Windows displays a security warning. If no release asset is available, use the source download and local Web development steps above.

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
