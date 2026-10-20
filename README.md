# PhotoMesh

PhotoMesh 是一个自托管、跨平台的去中心化相册项目。它让多个可信节点各自保存原图，并同步经过授权的元数据与事件。项目当前处于 M0 仓库基座阶段，尚未实现照片导入、持久化或 P2P 同步。

## 设计原则

- 原图保持不可变；预览和其他派生文件写入独立目录。
- 每次读取都由服务端执行访问控制，默认拒绝未授权访问。
- 节点通过密钥和签名建立信任；局域网本身不代表可信。
- 同步不是备份；不可逆删除和生产数据迁移需要人工审批。
- 核心服务面向低资源 NAS，不要求 GPU、Redis 或中心账号服务。

## 仓库组成

- `apps/web`：Vue 3 Web 客户端基座。
- `apps/desktop`：Vue 3 + Tauri 2 桌面壳。
- `apps/mobile`：Flutter 移动端占位工程，由 Dart `pub` 管理。
- `apps/node-agent`：Node.js + TypeScript 服务端基座。
- `packages/contracts` 与 `contracts/`：OpenAPI 草案和组件 JSON Schema 校验。
- `packages/i18n`：简体中文和英语界面文案。

这些入口只证明工作区和工具链可运行，不代表产品功能已完成。阶段计划见 [`codex/阶段提示词.md`](codex/阶段提示词.md)，产品范围和兼容约束见 [`docs/`](docs/) 与 [`project/Monorepo_目录结构.md`](project/Monorepo_目录结构.md)。

## 本地开发

需要 Node.js 22.12 或更新的 LTS 版本与 pnpm 11。Flutter 测试需要单独安装 Flutter SDK。

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
pnpm test:mobile
```

`pnpm test:mobile` 与 `pnpm build:mobile` 通过 `scripts/*.ps1` 调用 Flutter；Flutter 不属于 pnpm workspace。桌面前端可执行 `pnpm --filter @photomesh/desktop dev`，完整 Tauri 打包还需要 Rust 工具链及平台依赖。

## 安全问题

请按 [`SECURITY.md`](SECURITY.md) 中的私密报告流程披露漏洞，不要在公开 Issue 中贴出真实密钥、私人照片或可直接利用的细节。

## 许可证

PhotoMesh 以 Apache-2.0 许可证发布。第三方依赖、模型和媒体工具仍需按各自许可证单独审查。
