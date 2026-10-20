# PhotoMesh

PhotoMesh is a self-hosted, cross-platform, decentralized photo library. Trusted nodes keep their own original files and synchronize authorized metadata and events. The repository is currently at the M0 foundation stage; photo import, persistence, and P2P synchronization are not implemented yet.

## Design principles

- Original files are immutable. Previews and other derived files go to separate storage.
- The server checks authorization on every read and denies access by default.
- Nodes establish trust with keys and signatures; a LAN is not trusted by default.
- Synchronization is not backup. Irreversible deletion and production migrations require human approval.
- Core services target low-resource NAS devices and do not require a GPU, Redis, or a central account service.

## Repository

- `apps/web`: Vue 3 web client foundation.
- `apps/desktop`: Vue 3 and Tauri 2 desktop shell.
- `apps/mobile`: Flutter placeholder managed by Dart `pub`.
- `apps/node-agent`: Node.js and TypeScript service foundation.
- `packages/contracts` and `contracts/`: OpenAPI draft and component JSON Schema checks.
- `packages/i18n`: Simplified Chinese and English UI copy.

These entry points demonstrate a working workspace and toolchain; they do not claim product features are complete. See [`codex/阶段提示词.md`](codex/阶段提示词.md) for stages and [`docs/`](docs/) for product and compatibility constraints.

## Development

Requires Node.js 22.12 or newer LTS and pnpm 11. Flutter tests require a separately installed Flutter SDK.

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
pnpm test:mobile
```

The mobile scripts call Flutter through `scripts/*.ps1`; Flutter is not a pnpm workspace package. The desktop frontend runs with `pnpm --filter @photomesh/desktop dev`. Native Tauri packaging also requires Rust and platform dependencies.

## Security

Use the private reporting process in [`SECURITY.md`](SECURITY.md). Do not post real secrets, private photos, or directly exploitable details in public issues.

## License

PhotoMesh is licensed under Apache-2.0. Third-party dependencies, models, and media tools require separate license review.
