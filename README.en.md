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

On Windows, install Node.js 22.12+ and pnpm 11. Keep Agent data separate from photo directories, and explicitly allow only the external roots to scan:

\`\`\`powershell
$env:PHOTOMESH_DATA_DIR = 'D:\\PhotoMesh\\agent-data'
$env:PHOTOMESH_EXTERNAL_ROOTS = '[{"rootId":"family-photos","libraryId":"family","path":"D:\\\\Photos","pathStyle":"win32"}]'
pnpm install --frozen-lockfile
pnpm --filter @photomesh/node-agent build
pnpm --filter @photomesh/node-agent start
\`\`\`

The Agent reads external photo roots without modifying them; its database and uploaded files use the separate data directory. The service binds to a local address by default. Do not expose the HTTP API to a LAN or the public Internet without TLS and authentication. See the [deployment and prerelease guide](docs/预发布发布流程.md) and [Docker deployment guide](docs/modules/deploy/docker/README.md) for configuration, two-node exercises, and NAS limits.

## Connect a client device

1. Create a short-lived pairing invitation on a running node.
2. Scan its QR code from the client. If mDNS is unavailable, enter the node's private IP manually.
3. Verify the peer key identity, have the node administrator approve it, and grant only the required read-only library access.

See the [LAN secure pairing guide](docs/operations/LAN安全配对.md). Android permissions, network policies, upload queues, and background limits are covered in the [Android client guide](docs/modules/apps/mobile/README.md).

## Local development

Requires Node.js 22.12+ and pnpm 11. Install Flutter separately when working on Android; Flutter dependencies use \`pub\`.

\`\`\`powershell
pnpm install --frozen-lockfile
pnpm --filter @photomesh/web dev
\`\`\`

Common checks and builds:

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

Flutter commands require the Flutter SDK and Android toolchain. Start with the [documentation index](docs/AI文档总览.md) for architecture, APIs, development rules, tests, release acceptance, and module guides. Deployment and operations are covered in the [deployment guide](docs/预发布发布流程.md).

## License

PhotoMesh is licensed under the [Apache License 2.0](LICENSE).

## Star history

[![PhotoMesh GitHub Star History](https://api.star-history.com/chart?repos=LingBrian/PhotoMesh&type=date&legend=top-left)](https://www.star-history.com/#LingBrian/PhotoMesh&Date)
