# 推荐 Monorepo 目录结构

```text
photomesh/
├── AGENTS.md                       # 根 Codex 行为约束（规范说明见 docs/guides/codex/AGENTS.md）
├── README.md / README.en.md
├── LICENSE                         # Apache-2.0
├── SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md
├── pnpm-workspace.yaml
├── package.json / pnpm-lock.yaml / turbo.json
├── .nvmrc / .editorconfig / .gitignore
├── .github/
│   ├── workflows/ci.yml
│   ├── workflows/release.yml
│   ├── workflows/security.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── apps/
│   ├── desktop/                    # Tauri 2 + Vue 3
│   │   ├── src/
│   │   ├── src-tauri/
│   │   └── package.json
│   ├── web/                        # Vue 3 SPA，复用 @photomesh/ui
│   ├── mobile/                     # Flutter/Dart 原生工程，pubspec.yaml
│   │   ├── lib/ / android/ / ios/ / test/ / integration_test/
│   └── node-agent/                 # Windows/NAS/Linux Node.js 服务
│       ├── src/
│       │   ├── app/                # Bootstrap/健康检查
│       │   ├── auth/               # 信任/权限/设备配对
│       │   ├── media/              # 导入/哈希/缩略图
│       │   ├── storage/            # 外部目录/托管/S3 adapter
│       │   ├── sync/               # 事件日志/outbox/inbox/P2P
│       │   ├── jobs/               # 任务调度与恢复
│       │   ├── api/                # 客户端 HTTPS API
│       │   └── db/                 # SQLite/PG 存储适配和迁移
│       └── test/
├── packages/
│   ├── contracts/                  # OpenAPI/JSON Schema/协议版本
│   ├── api-client-ts/              # OpenAPI 生成 TypeScript SDK
│   ├── ui/                         # Vue 共享组件与主题
│   ├── i18n/                       # 简体中文、英语、繁中与 RTL 预留
│   ├── sync-core/                  # TS 协议事件/因果/合并算法
│   ├── storage-core/               # TS 文件模型/路径/HASH 流处理
│   ├── security/                   # 鉴权服务接口与审计契约
│   ├── config/                     # eslint/tsconfig/test 等共享配置
│   └── testing/                    # 共享测试夹具、测试工具
├── workers/
│   ├── media-worker/               # 独立媒体与可选 FFmpeg 处理器
│   ├── ai-worker/                  # P1：默认可禁用
│   └── plugin-host/                # P2：Python/JS 独立受限执行器
├── integrations/
│   ├── mcp-server/                 # P2：权限受控 Codex MCP
│   ├── sdk-python/                 # P2：Python SDK
│   └── webhook-adapter/
├── database/
│   ├── migrations/sqlite/
│   ├── migrations/postgres/
│   └── seeds/
├── deploy/
│   ├── docker/
│   ├── compose/
│   ├── windows/
│   └── backup/
├── contracts/                     # 稳定 schema 备份/生成输入
├── docs/
│   ├── prd/ / architecture/ / adr/ / api/ / operations/
│   ├── diagrams/
│   └── testing/
├── scripts/
│   ├── dev.ps1 / build.ps1 / test.ps1
│   ├── flutter-test.ps1           # 被根任务调用的 Flutter 测试
│   └── verify-assets.ps1
└── tests/
    ├── p2p-two-nodes/
    ├── e2e-playwright/
    ├── fault-injection/
    ├── performance-100k/
    ├── migrations/
    └── fixtures/
```

## 工作区边界与原则

- **pnpm+Turborepo** 只管理 JS/TS workspace；`apps/mobile` 由 Flutter 的 `pub` 管理，根 `test:mobile`/`build:mobile` PowerShell 脚本调用 `flutter test`/`flutter build`。不要把 Flutter 伪装为 npm 子包。
- `packages/contracts` 是跨语言事实来源，通过 OpenAPI/JSON Schema 生成 TS/Dart/Python SDK；不要手写三套互相不兼容的 DTO。
- `apps/node-agent` 只依赖稳定协议与服务接口，媒体和 AI worker 要能被完全禁用。
- `packages/sync-core` 中合并算法保持无 IO 的纯函数，方便用 Vitest、属性测试和故障回放测试。
- `apps/desktop` 前端和 `apps/web` 可共用 Vue 组件、主题及 i18n；系统 API 通过 Tauri bridge adapter 封装。
- 发布阶段增加 macOS Runner 才能完整构建/签名 iOS 与 macOS 软件，Windows 开发机并不能独立完成这些平台的官方打包。

## 首版依赖顺序

`contracts` → `database + storage-core + auth` → `node-agent REST` → `P2P event sync` → `Android upload/queue` → `Vue/Tauri time-line` → `offline cache` → `release migration tests`。

跨模块接口变更必须先更新 schema 和协议兼容测试，再同时更新 Dart 与 TS 客户端。
