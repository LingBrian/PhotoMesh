# PhotoMesh 文档总览（供 AI 助手与贡献者使用）

本文是仓库文档导航，说明各文档负责的内容以及阅读顺序。它不取代规范文件，也不证明其中描述的功能已经实现。开始处理任务前，请先查看工作区当前代码、Git 分支与测试结果，再按下列顺序阅读相关材料。

## AI 助手阅读规则

1. 先读根目录 [`AGENTS.md`](../AGENTS.md)，遵守原图不可变、默认拒绝授权、迁移审查等约束。
2. 按任务读产品需求、技术架构、当前 ADR 与验收方案；接口和数据库以仓库中的实际 OpenAPI/JSON Schema 与迁移文件为准。
3. 当文档与代码状态看起来不一致时，检查当前分支、提交和测试，不要把规划、提示词、历史报告当成已完成证据。
4. 变更协议或数据库 schema 前，按 ADR 流程先审查兼容性与迁移/恢复计划。任何验收结论都要附实际命令及输出。
5. 遇到多个版本的说明时，以根 `AGENTS.md`、已批准 ADR、当前接口/schema 和测试验收规范为约束；历史交付报告仅作背景资料。

## 规范与协作入口

| 文档 | 内容与用途 |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | 全仓开发规则、安全不变量、技术边界、测试和 Git 约束；最高优先级项目工作指引。 |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 分支、提交、测试和 PR 贡献流程。 |
| [`../SECURITY.md`](../SECURITY.md) | 漏洞报告与安全披露方式。 |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | 社区参与行为规范。 |
| [`../README.md`](../README.md) / [`../README.en.md`](../README.en.md) | 项目简介、仓库组成、本地开发入口（中文/英文）。 |

## 产品、架构与交付计划

| 文档 | 内容与用途 |
| --- | --- |
| [`01_PRD_产品需求.md`](01_PRD_产品需求.md) | 产品用户、目标、功能需求、范围与验收条件。 |
| [`02_技术架构设计.md`](02_技术架构设计.md) | 节点架构、存储、同步、安全、媒体与扩展设计。 |
| [`03_开发路线图与任务清单.md`](03_开发路线图与任务清单.md) | M0 起阶段依赖、交付任务与完成证据。 |
| [`04_测试与发布验收方案.md`](04_测试与发布验收方案.md) | 测试层级、性能、安全、迁移、发布门槛和验收方法。 |
| [`05_ADR_未决决策与风险.md`](05_ADR_未决决策与风险.md) | 架构决策记录、待决事项和风险；实施协议/schema 前应检查批准状态。 |
| [`architecture/Monorepo_目录结构.md`](architecture/Monorepo_目录结构.md) | pnpm/Turborepo、Flutter 边界及目标仓库目录树。 |
| [`reference/完整中文设计总报告.md`](reference/完整中文设计总报告.md) | 原始中文设计交付报告和历史需求上下文；部分内容是规划或历史提示词。 |
| [`reference/word-reports/`](reference/word-reports/) | 归档的 Word 版 PRD、技术架构、完整设计报告和 Codex 开发方案；与 Markdown 主文档并存，可能含较早版本内容。 |
| [`guides/交付说明.md`](guides/交付说明.md) | 早期设计交付包索引及其关键边界，作为背景材料。 |
| [`guides/Codex工程开发与测试.md`](guides/Codex工程开发与测试.md) | Codex 分阶段开发/测试参考和早期任务记录；不是当前实现状态证明。 |

## API、ADR、图表、测试与运维导航

| 目录 | 内容 |
| --- | --- |
| [`adr/README.md`](adr/README.md) | ADR 目录说明和决策记录约定。 |
| [`api/README.md`](api/README.md) | API/OpenAPI 文档入口；契约源文件位于 `contracts/`。 |
| [`diagrams/README.md`](diagrams/README.md) | 架构和同步图说明；图源及导出图位于 [`diagrams/assets/`](diagrams/assets/)。 |
| [`testing/README.md`](testing/README.md) | 测试文档入口和验证范围。 |
| [`operations/README.md`](operations/README.md) | 本地运行、部署和运维文档入口。 |
| [`prd/README.md`](prd/README.md) | PRD 分类文档入口。 |

## Codex 任务材料

| 文档 | 内容与用途 |
| --- | --- |
| [`guides/codex/AGENTS.md`](guides/codex/AGENTS.md) | 根 `AGENTS.md` 规则的历史模板副本；实际执行以根文件为准。 |
| [`guides/codex/阶段提示词.md`](guides/codex/阶段提示词.md) | 各开发阶段的可复用任务提示词。 |
| [`guides/codex/任务模板.md`](guides/codex/任务模板.md) | Issue/任务背景、范围、风险与验收记录模板。 |

## 模块就近说明（已集中归档）

这些 README 原先与对应源码目录相邻，现归入 `docs/modules/`；按路径中的原仓库位置对应模块说明。它们描述模块边界和预留位置，不代表功能已实现。

| 文档 | 内容与用途 |
| --- | --- |
| [`modules/apps/node-agent/src/api/README.md`](modules/apps/node-agent/src/api/README.md) | Node Agent API 路由、契约和后端 ACL 约束。 |
| [`modules/apps/node-agent/src/app/README.md`](modules/apps/node-agent/src/app/README.md) | Node Agent 启动装配与健康状态。 |
| [`modules/apps/node-agent/src/auth/README.md`](modules/apps/node-agent/src/auth/README.md) | 设备身份、配对、授权和信任模型。 |
| [`modules/apps/node-agent/src/db/README.md`](modules/apps/node-agent/src/db/README.md) | SQLite Repository、迁移、兼容性与备份约束。 |
| [`modules/apps/node-agent/src/jobs/README.md`](modules/apps/node-agent/src/jobs/README.md) | 可恢复后台任务和低资源运行约束。 |
| [`modules/apps/node-agent/src/media/README.md`](modules/apps/node-agent/src/media/README.md) | 只读导入、媒体元数据和独立派生预览。 |
| [`modules/apps/node-agent/src/storage/README.md`](modules/apps/node-agent/src/storage/README.md) | 原图存储、外部只读目录、哈希校验和原子提交。 |
| [`modules/apps/node-agent/src/sync/README.md`](modules/apps/node-agent/src/sync/README.md) | 签名事件、outbox/inbox、P2P 与协议审查。 |
| [`modules/apps/node-agent/test/README.md`](modules/apps/node-agent/test/README.md) | Node Agent Vitest 单元/API 测试和覆盖率要求。 |
| [`modules/packages/api-client-ts/README.md`](modules/packages/api-client-ts/README.md) | 从 OpenAPI 契约生成 TypeScript 客户端。 |
| [`modules/packages/security/README.md`](modules/packages/security/README.md) | 认证、ACL 和审计接口边界。 |
| [`modules/packages/storage-core/README.md`](modules/packages/storage-core/README.md) | 可注入文件系统、路径规范化和内容摘要。 |
| [`modules/packages/sync-core/README.md`](modules/packages/sync-core/README.md) | 事件合并、因果排序与幂等处理。 |
| [`modules/packages/testing/README.md`](modules/packages/testing/README.md) | 跨 workspace 测试夹具与故障注入。 |
| [`modules/packages/ui/README.md`](modules/packages/ui/README.md) | Vue 共用 UI、主题和 i18n 边界。 |
| [`modules/database/migrations/sqlite/README.md`](modules/database/migrations/sqlite/README.md) | SQLite 迁移、ADR、备份与恢复流程。 |
| [`modules/database/migrations/postgres/README.md`](modules/database/migrations/postgres/README.md) | 可选 PostgreSQL 适配器迁移说明。 |
| [`modules/database/seeds/README.md`](modules/database/seeds/README.md) | 仅虚构开发/测试数据的种子约束。 |
| [`modules/deploy/backup/README.md`](modules/deploy/backup/README.md) | 备份与恢复演练边界。 |
| [`modules/deploy/compose/README.md`](modules/deploy/compose/README.md) | 本地单节点/双节点 Compose 环境。 |
| [`modules/deploy/docker/README.md`](modules/deploy/docker/README.md) | 容器镜像、非 root 运行和健康检查。 |
| [`modules/deploy/windows/README.md`](modules/deploy/windows/README.md) | Windows 安装、服务和卸载规划。 |
| [`modules/integrations/mcp-server/README.md`](modules/integrations/mcp-server/README.md) | 受 ACL 约束的 MCP 门面。 |
| [`modules/integrations/sdk-python/README.md`](modules/integrations/sdk-python/README.md) | 根据共享契约生成 Python SDK。 |
| [`modules/integrations/webhook-adapter/README.md`](modules/integrations/webhook-adapter/README.md) | 签名、去重、重试和回放防护。 |
| [`modules/tests/e2e-playwright/README.md`](modules/tests/e2e-playwright/README.md) | 客户端端到端测试位置。 |
| [`modules/tests/fault-injection/README.md`](modules/tests/fault-injection/README.md) | 中断、重复、乱序和异常终止测试位置。 |
| [`modules/tests/fixtures/README.md`](modules/tests/fixtures/README.md) | 合成测试素材与秘密数据禁入要求。 |
| [`modules/tests/migrations/README.md`](modules/tests/migrations/README.md) | 数据库迁移、快照和恢复测试。 |
| [`modules/tests/p2p-two-nodes/README.md`](modules/tests/p2p-two-nodes/README.md) | 两节点独立 DB 与图库的集成测试。 |
| [`modules/tests/performance-100k/README.md`](modules/tests/performance-100k/README.md) | 10 万级性能测试和报告信息要求。 |
| [`modules/workers/ai-worker/README.md`](modules/workers/ai-worker/README.md) | 可关闭的后续 AI worker 与隐私限制。 |
| [`modules/workers/media-worker/README.md`](modules/workers/media-worker/README.md) | 写入隔离派生目录的媒体 worker。 |
| [`modules/workers/plugin-host/README.md`](modules/workers/plugin-host/README.md) | 插件隔离和权限边界。 |

## 图表资产

| 文件 | 内容 |
| --- | --- |
| [`diagrams/assets/节点拓扑.mmd`](diagrams/assets/节点拓扑.mmd)、`.dot`、`.svg`、`.png` | 节点拓扑源图和导出格式。 |
| [`diagrams/assets/ER_元数据模型.mmd`](diagrams/assets/ER_元数据模型.mmd)、`.dot`、`.svg`、`.png` | 元数据实体关系源图和导出格式。 |
| [`diagrams/assets/P2P_同步时序.mmd`](diagrams/assets/P2P_同步时序.mmd)、`.svg`、`.png` | 两节点同步时序源图和导出格式。 |

## 文档维护

新增产品/架构/测试/运维文档放在 `docs/` 合适子目录，并在本文登记用途。根目录只保留 README、AGENTS、贡献、安全和行为准则等仓库标准入口；源码专属说明集中放在 `docs/modules/`。搬移文件时同步更新链接，并检查是否有悬空的旧路径。
