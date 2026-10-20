# AGENTS.md — PhotoMesh Codex 开发准则

> 适用：仓库所有路径及所有 Codex Agent。AGENTS.md 与项目 PRD、ADR 和测试规范共同构成开发约束；冲突时应停止执行并上报，不擅自放松安全性。

## 0. 项目定位

PhotoMesh（暂定名）是 Apache-2.0 开源、完全去中心化 P2P 的跨平台相册系统。多个 Windows/NAS/Linux 主节点独立保存原图，仅同步授权元数据及同步事件；Windows+Android+NAS 为 MVP 优先，AI 为第二阶段。首发无强制公网服务，支持局域网安全直连。

## 1. 永不可破坏的安全不变量

1. **绝不就地覆盖、编辑、重编码或自动删除用户原图。** 所有预览/派生文件输出到独立目录；外部文件夹默认只读。
2. 上传成功必须经过目标完整内容 SHA-256 校验与可恢复原子提交；只要校验失败就不得标记成功。
3. 不得把同步当作备份；执行不可逆删除、数据库迁移、密钥轮换、公开分享、生产部署须明确人工审批。
4. 每次访问元数据、缩略图、原图、MCP 和插件资源都执行真实后端 ACL 校验；无授权默认拒绝。
5. 不把任何身份私钥、API token、恢复密钥或相册明文写入 Git、日志或 telemetry。
6. 节点信任来自验证密钥/签名而非广播名、IP 或假定局域网可信。
7. 网络中断/重复事件/乱序/时钟偏差下不能静默丢弃用户操作；P2P 事件要求幂等、因果与 tombstone 测试。
8. 2GB NAS、无 GPU 模式必须能运行核心备份与相册服务；AI 与转码可完全禁用。

## 2. 技术选择与分层

- Windows/Linux/macOS 桌面：Tauri 2 + Vue 3 + TypeScript；Web：Vue 3；Android/iOS：Flutter；服务端：Node.js LTS + TypeScript。
- Node agent 的存储默认 SQLite，可选 PostgreSQL Adapter；没有必需 Redis 或中心账号服务器。
- pnpm Workspace + Turborepo 管理 TS workspace；Flutter 通过 pub 管理，根脚本编排测试/构建。
- `packages/contracts` 的 OpenAPI/JSON Schema 是跨语言数据契约唯一事实来源；SDK 自动生成。
- 模块边界：`identity`, `storage`, `media`, `sync`, `authz`, `api`, `jobs`, `client`，不让 UI 直接绕过 Node API 读写图库数据库。
- i18n：简体中文和英语首版；用户界面字符串不能硬编码。

## 3. Codex 工作流程

1. 开始任务先阅读 `docs/01_PRD_产品需求.md`、`docs/02_技术架构设计.md`、`docs/05_ADR_未决决策与风险.md` 和当前接口/schema。
2. 生成一个包含背景、目标、非目标、输入输出、风险、依赖、测试方法的任务计划；一次只做能被 CI 验证的独立模块。
3. 在隔离的 `git worktree`/`feat/*` 分支工作；多个 Agent 不可并行编辑相同 migrations/契约源。
4. 协议或数据库 Schema 改动：先给出 ADR、向前/向后兼容结论和迁移计划，获批准后实施。
5. 先写失败测试，再实现最小功能，再运行回归，修复至绿色；不得通过删除测试、跳过检查来过 CI。
6. 每完成一个模块必须运行相关 `unit`、`lint`、`typecheck`、`integration`（适用时 `flutter test`、Playwright、P2P 故障）并记录真实结果。
7. 单测行/分支覆盖按 CI 配置设严格 **>80%** 门槛，关键路径仍需手工审查。
8. 每个 PR 必须包含：功能说明、数据与安全影响、对应 FR/Issue、测试命令/输出、截图（UI 变更）、迁移/回滚说明、文档变更。
9. **可以自动本地提交到隔离分支**，提交信息遵循 Conventional Commits；**禁止未经授权自动 push 到受保护分支、merge、发版、执行生产迁移或删除用户数据**。
10. 每个模块完成时输出：变更文件、测试结果、未通过/跳过项、潜在风险、下一依赖任务，不得虚报完成。

## 4. Git、CI 和发布约束

- GitHub PR 必须经 protected branch CI 和评审；优先 Squash/Merge，禁止重写已公开历史。
- 使用 SemVer；Stable、Beta、Nightly；相邻次版本节点的协议兼容由自动测试证明。
- 生产数据迁移：预检、备份、迁移、校验、恢复演练；升级不可逆时不能随意降低数据库版本。
- 二进制发行必须签名、附校验值/SBOM/Changelog，按渠道发布；密钥不能暴露在 PR 构建日志。
- 保留重大安全问题私密报告流程，不在公开 issue 中泄露漏洞利用或真实用户密钥。

## 5. 每个任务必须执行的最小命令（根据已有脚本实际存在情况调整）

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# 当任务涉及移动端：
cd apps/mobile; flutter pub get; flutter test
# 当任务涉及双节点同步：
# 运行仓库中的 docker compose 集成测试脚本；不得假装已运行不存在的命令。
```

> 代码库建立前，这些是**预期的标准命令**，不是目前已有可执行仓库；M0 必须把它们落地并设置 CI。

## 6. 风险与权限审批矩阵

| 操作 | 自动执行？ |
| --- | --- |
| 新增测试、修复局部业务逻辑、改说明文件 | 可，在任务范围和隔离分支内 |
| 本地隔离分支 `git add/commit` | 可，任务许可且审查 diff 后 |
| 修改 P2P 协议、密钥格式、ACL 或重要迁移 | 先设计/审核，批准后执行 |
| 自动 push/合并 main/正式发行 | 不可，需明确授权 |
| 删除原图/清空对象存储/大规模重排文件 | 不可，需用户明确审批和备份 |
| 使用云端 AI 分析加密/私密相册 | 不可，需明确任务授权 |

## 7. 代码与测试风格

- TypeScript strict，模块边界、可测试纯函数、结构化错误码、依赖注入；所有文件操作必须接受注入式文件系统以便故障测试。
- 上传/同步 API 要幂等键、请求 ID、审计日志和有限重试；日志避免敏感字段。
- 不使用壁钟时间处理跨节点并发冲突的唯一依据；不得把 ZIP 解压目标路径等未经规范化的路径直接写入磁盘。
- 提交 PR 前验证 OpenAPI 模型、Dart/TypeScript SDK、一致性、i18n 漏翻译、无障碍 lint、许可审计。
- 发现安全设计与用户需求矛盾时：提出最低风险兼容实现，附可测试替代方案，等待决策，而不是静默妥协。

## 8. Codex 阶段提示词

见 `codex/阶段提示词.md`，按 M0→M1→M2→M3→M4→M5 执行；AI、E2EE 完整共享、插件生态安排在后续阶段。不要将所有愿景功能堆到首个 PR。
