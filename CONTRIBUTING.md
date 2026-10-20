# 贡献指南

感谢参与 PhotoMesh。提交变更前请先阅读根目录 [`AGENTS.md`](AGENTS.md)、产品需求、技术架构、ADR 和 [`project/Monorepo_目录结构.md`](project/Monorepo_目录结构.md)。这些文件定义安全不变量和模块边界。

## 开发步骤

1. 从主分支创建 `feat/*` 分支；不要直接改写已公开历史。
2. 一次提交聚焦一个可由 CI 验证的模块。接口或数据模型变更须先提交 ADR、兼容性结论和迁移方案。
3. 为行为变化补充测试；不要删除、跳过或弱化既有检查来通过 CI。
4. 本地执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm contracts:check` 和 `pnpm build`。修改移动端时另执行 `pnpm test:mobile`。
5. 按 Conventional Commits 编写提交信息，例如 `feat(node-agent): add health endpoint`。
6. 提交 PR 时填写模板，说明功能、数据与安全影响、测试结果、迁移/回滚和相关文档。

## 安全与隐私

- 不覆盖、编辑、重编码或自动删除原图；测试也不得使用用户真实图库。
- 不提交私钥、token、恢复密钥、私密相册数据或敏感日志。
- 每个资源访问都要经过真实后端 ACL 校验；未授权默认拒绝。
- 不把同步表述为备份。删除、公开分享、生产迁移和密钥轮换须有明确审批流程。
- 协议/schema 与 SQLite/PostgreSQL 迁移不得绕过 ADR 评审和兼容性说明。

## Flutter

移动端使用 Dart `pub`，不加入 pnpm workspace。根目录 `pnpm test:mobile` 和 `pnpm build:mobile` 调用 `scripts/` 中的 PowerShell 脚本；本地需要安装 Flutter SDK。

## 行为准则

参与者须遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。安全漏洞请按 [`SECURITY.md`](SECURITY.md) 私下报告。
