# PhotoMesh

[![CI](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LingBrian/PhotoMesh/actions/workflows/ci.yml)
[![Pre-release](https://img.shields.io/github/v/release/LingBrian/PhotoMesh?include_prereleases&label=pre-release)](https://github.com/LingBrian/PhotoMesh/releases)
[![License: Apache-2.0](https://img.shields.io/github/license/LingBrian/PhotoMesh)](LICENSE)

PhotoMesh is a self-hosted, decentralized photo library for multiple platforms. Trusted nodes keep their own originals and synchronize only authorized metadata and events. Uploads and downloads verify the complete SHA-256 digest. The project targets Windows, Android, Linux/NAS, and the Web without requiring a central account service.

> This is an early preview. Try it with synthetic test data first; do not rely on an unvalidated deployment for the only copy of irreplaceable photos. Check the GitHub Actions report for candidate gate results. A Stable release requires a separate maintainer approval.

## Features and safety boundaries

- The Node Agent provides SQLite metadata, resumable chunk uploads, read-only external directory scanning, and LAN pairing/sync foundations.
- The Android client provides photo permissions, an upload queue, network policies, and SHA-256 verification. Android schedules background work and does not guarantee real-time execution.
- Vue Web and Tauri desktop provide a gallery UI. The server checks ACLs on every data access.
- Originals are never overwritten, re-encoded, or automatically deleted in place. Sync is not backup; source photos on NAS are read-only by default.
- Previews, tests, and derived data use separate locations. APIs deny unauthorized access by default.

## Tutorial: run a two-node local exercise

Requires Node.js 22.12+, pnpm 11, and Docker Compose v2. This exercise uses synthetic data and never reads personal photos:

```powershell
pnpm install --frozen-lockfile
pnpm test:sync-compose
```

The script starts isolated Windows-simulated and NAS-simulated nodes and checks pairing, library grants, event sync, offline recovery, and restart behavior. It preserves dedicated Docker named volumes. See the [two-node Compose guide](docs/modules/deploy/compose/README.md) for limits and simulator-only reset instructions.

## Tutorial: run the Node Agent with a read-only photo root

In Windows PowerShell, choose a separate data directory and explicitly allow one photo root:

```powershell
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\Photos","pathStyle":"win32"}]'
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
```

The scanner reads `D:\Photos`; its index and tasks are stored in `D:\PhotoMesh\agent-data`. Read the [Node Agent configuration and API guide](docs/modules/apps/node-agent/README.md) and [LAN pairing tutorial](docs/operations/LAN安全配对.md) before deployment. Do not expose an API without configured TLS and authentication to a LAN or the public Internet.

## Tutorial: start the Web UI and build Android

Start the Web development server from the repository root:

```powershell
pnpm --filter @photomesh/web dev
```

The mobile client uses Flutter `pub`, outside the pnpm workspace. Install Flutter and the Android toolchain, then run tests and build an APK:

```powershell
pnpm test:mobile
pnpm build:mobile
```

See the [Android client guide](docs/modules/apps/mobile/README.md) for permissions, Wi-Fi/mobile policies, resumable uploads, and background behavior. Android controls background scheduling; emulator builds do not replace the real-device acceptance checklist.

## Development and validation

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
pnpm test:e2e
```

Use `pnpm test:sync-compose` for the two-node Docker exercise. The `Release candidate gate` workflow generates an acceptance report; `Build and publish prerelease` runs the full gate and builds products from `main`. Reports include performance, SHA-256, migration recovery, ACL, SBOM, changelog, and failure details. Missing evidence or failed checks mark a candidate as blocked. Flutter tests require a standalone SDK; GitHub Actions installs the toolchain for CI.

## Tutorial: build and publish a prerelease

Run **Build and publish prerelease** in GitHub Actions with a version such as `0.x.y-rc.n`, `0.x.y-beta.n`, or `0.x.y-alpha.n`. You can also trigger it from `main` with GitHub CLI:

```powershell
gh workflow run prerelease.yml --ref main -f version=0.1.0-rc.1
```

The workflow runs the full acceptance gate before building the Web bundle, Linux x86_64 NAS Docker image, Android APK, and Windows installers. It creates no prerelease if the gate or any platform build fails. See the [prerelease process](docs/预发布发布流程.md). Stable releases require separate human approval.

## Documentation

Start with the [AI documentation index](docs/AI文档总览.md). Product requirements, architecture, ADRs, release acceptance, operations, and pairing docs live under `docs/`.

## License

PhotoMesh is licensed under the [Apache License 2.0](LICENSE). Third-party components, build artifacts, and models retain their own license terms.
