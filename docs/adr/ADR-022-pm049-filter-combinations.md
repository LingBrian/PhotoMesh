# ADR-022：PM-049 日期/类型/来源/可用性组合筛选

- **状态：** 已在隔离 `feat/pm049-asset-filters` 分支实现并通过本节验证，已用 Conventional Commit 记录在本地；未推送/合并/发布，也未执行生产迁移。**不授权生产迁移、push、merge、release。**
- **日期：** 2026-10-29
- **路线图：** PM-049（图库筛选组合）。
- **依赖：** ADR-021 / PM-048 的授权搜索、日期语义、统一可见资产投影与 cursor 基础。

## 背景与目标

PM-048 已实现授权图库的 q 与 UTC 半开日期筛选。PM-049 为同一 API 增加 kind、source kind、availability 条件组合，保证静态数据集 keyset 分页正确、cursor 与完整筛选条件绑定，并确保任何过滤都受当前图库 ACL 限制。`gallery_search_content`（0011）已投影这三个字段，本 ADR 不改变既有本地/同步可见性或 Gallery DTO。

## 决策

1. 扩展 `GET /v1/assets`，可选参数为 `kind`、`sourceKind`、`availability`。每个参数只接受一个精确枚举值；不支持重复值或逗号列表。参数间以及 q/date 与新参数之间均按 AND 组合；重复或未知参数、无效枚举返回 400。
2. 枚举为：`kind = photo | video | live_photo`；`sourceKind = upload | import`；`availability = online | cached | offline | missing`。local asset 沿用 0011 的 Gallery 规范来源位置规则；缺失来源时 `sourceKind` 回退 `import`、`availability` 回退 `missing`。同步投影读取规范化 metadata；没有远端位置证据时 `availability=missing`。这些筛选与返回 DTO 的值一致，不额外推断来源或可达性。
3. 既有 q、日期、排序和权限语义不变：日期仍为 UTC `[dateFrom,dateTo)`；capture time 未知时不匹配非空日期条件；先逐请求执行 library-read ACL，再访问 repository。分页仍按 `capturedAt DESC, assetId DESC`，只承诺数据未变化时稳定，不承诺并发写入快照。
4. 完整规范化筛选对象（q、日期、kind、sourceKind、availability）纳入 cursor filter fingerprint。没有三个新参数的旧筛选继续生成/接受 v1 cursor；任何新维度参与时生成 v2 cursor；服务端接受 v1 cursor 仅当新维度均未使用。跨图库或跨任一筛选的 cursor 返回 400。
5. health/diagnostics 新增 `galleryFilters` 能力标志，使 PM-048 客户端可在向旧版节点发送新参数前探测；旧版对未知参数仍按 fail-closed 处理。
6. 追加迁移 `0012_gallery_filter_indexes`，只新增 `(library_id, dimension, captured_at DESC, asset_id COLLATE BINARY DESC)` 的 kind/source_kind/availability 三个索引，复用 0011 的派生投影和维护触发器。迁移保持 backup-before-upgrade、事务原子性和旧二进制未知迁移拒绝；不修改 `0001`–`0011`，不读写原图。索引大小/写放大和过滤查询计划纳入验证。

## 兼容、隐私与安全

- 新参数均为可选，旧 q/date 调用及 v1 cursor 不变；新客户端先检查 `galleryFilters`，未发现该能力时不得静默忽略筛选或把未过滤结果当成功。
- 每个请求/分页请求重做 library ACL；cursor 只是位置与条件指纹，不是访问令牌。SQL 所有筛选值绑定参数；不记录 q 或其他搜索条件。
- source/availability 仅反映 0011 已定义的投影，不把 missing/offline 误判为删除，不暴露跨库计数。
- 生产升级/回滚未授权；仅在隔离数据库验证备份门、回填前后、索引计划和旧二进制 fail-closed。

## 验收测试

- 每个枚举的有效/无效值、单独/多维 AND 组合、与 q/date 组合；本机与同步投影、tombstone 可见性保持不变。
- 多页、同 capture time 与 null capture 排序；cursor 跨 library/q/date/kind/sourceKind/availability 拒绝；无筛选旧 cursor 兼容。
- HTTP 400/重复/未知参数、ACL 先行、health capability、private/no-store 与 OpenAPI 契约。
- `EXPLAIN QUERY PLAN` 验证各维度索引及 keyset/date 计划；100k HTTP 搜索对最稀疏组合验证正确性与性能；根级 install/lint/typecheck/test/contracts/build。

## 实施与验证记录

- 已实现 `/v1/assets` 三个枚举筛选、AND 组合、v1/v2 cursor 条件范围、`galleryFilters` 健康能力，以及 append-only `0012_gallery_filter_indexes`；未改动旧迁移或 Gallery DTO。
- PM-049 100k 文件型 SQLite/WAL Playwright 证据位于 [`gallery-100k-pm049.json`](../../artifacts/performance/gallery-100k-pm049.json)：共 1,000 次混合搜索、100 次日期搜索、100 次 q/date/kind/sourceKind/availability 联合筛选；联合筛选 P50/P95/P99 为 **12.16/15.12/18.86 ms**，日期筛选 P95 为 **65.98 ms**，混合搜索 P95 为 **70.28 ms**。所有三类 P95 均低于 1,000 ms 阈值。
- 环境：Windows 11 23H2、Node v24.13.1、SQLite 3.53.4、AMD Ryzen 7 6800H；SQLite `shrink_memory` 不控制/清除 OS 文件缓存，不能将该样本称为冷 OS cache。
- 回归结果：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm contracts:check`、`pnpm build` 均通过；Node Agent 338 tests passed，覆盖率 statements 89.27%、branches 81.34%；`pnpm test:e2e --grep "virtual timeline pages"` 通过 1 项 100k Playwright 测试；`git diff --check` 通过。
