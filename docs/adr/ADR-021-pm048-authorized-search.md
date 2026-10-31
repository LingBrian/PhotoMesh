# ADR-021：PM-048 授权图库文件名/路径/日期检索

- **状态：用户于 2026-10-29 批准推荐范围。** 仅授权隔离 `feat/pm048-search-api` 分支内的 API/schema/migration 实现、测试与本地提交。**不授权生产数据库迁移、push、merge、release。**
- **日期：** 2026-10-29
- **路线图：** PM-048（授权范围内文件名/路径/日期检索 API）。
- **依赖：** PRD Q11/Q22/Q28、NFR 10 万索引搜索 P95<1 秒；PM-041 Gallery API/ACL 与稳定 keyset 基础；PM-047 的图库/资产 DTO。

## 背景

`GET /v1/assets` 已有 `q`、分页与 `authorizeLibraryRead`，但 `q` 通过 `instr(lower(...))` 扫描文件名、路径、资产 ID 和节点 ID；该搜索不能利用现有 capture-date 索引，查询参数可重复/未知，游标仅保存位置而未绑定图库和查询条件。PM-048 要求授权范围内的文件名/路径/日期检索、有界查询、稳定游标及 10 万条 P95 证据；PM-049 才扩展日期、类型、来源、可用性等组合筛选。

用户于 2026-10-29 批准推荐设计：大小写不敏感的字面子串文件名/路径检索（覆盖本机和同步投影资产）、UTC 日期范围 `[dateFrom,dateTo)`、按图库/规范化条件绑定的 keyset 游标，以及仅在隔离/测试 DB 验证的追加式 SQLite 搜索索引迁移。

## 目标

1. 保持每次请求先执行真实 library-read ACL；过滤、排序、游标和结果均严格限于授权图库。
2. 以 FTS5 trigram 索引支持字面子串文件名/路径检索，并保留现有资产 ID/来源节点 ID 搜索兼容；非空 `q` 至少为 3 个 Unicode code points，短词返回 400，避免未索引全库扫描。
3. 支持可选 UTC ISO 日期边界：`dateFrom` 含当天 UTC 零时，`dateTo` 不含当天 UTC 零时；null/未知 capture time 不匹配非空日期范围。PM-048 不增加类型、来源或可用性过滤。
4. 采用静态数据集上的稳定 keyset 顺序 `capturedAt DESC, assetId DESC`（null 日期最后）；游标绑定图库、规范化 q、日期边界及排序版本。授权在每次分页请求重做；游标不是授权凭据。
5. 为 100,000 项检索记录可复现的机器/SQLite版本、数据分布、查询样本和 P50/P95/P99；正确性和 query-plan 断言可在 CI 稳定运行，普通 CI 不以易波动耗时作为唯一门槛。

## 已批准决策

### 1. API、匹配与访问控制

- 扩展现有 `GET /v1/assets`，参数白名单为 `libraryId`、`q`、`dateFrom`、`dateTo`、`cursor`、`limit`；拒绝未知或重复参数、无效日期/范围、越界 q/cursor/limit。维持 `limit` 1–200、q 最长 256 Unicode code units、cursor 最长 2048 字节。
- `q` 是字面、大小写不敏感的子串，不解释 SQL/FTS 运算符、`%` 或 `_`；不 trim/重写用户词项。非空 `q` 必须至少含 3 个 Unicode code points、最多 256 个 UTF-16 code units。大小写语义采用所运行 SQLite FTS5 trigram tokenizer 的 Unicode folding，不做 locale-specific 或 accent folding。保留已有 asset ID 与 origin Peer ID 匹配，避免破坏既有 API 行为。FTS 输入须转义为短语并绑定。
- `dateFrom`、`dateTo` 格式严格为 `YYYY-MM-DD`，按 UTC 日历边界解释为半开区间；二者都可缺省，但至少一个存在时必须有已知 `capturedAt` 落在区间内。兼容旧版同步投影：若投影没有有效 `capturedAt`，它只参加文本搜索，不参加日期范围匹配。
- 每页最多返回 200 项，先授权再查库，未授权/未知图库返回统一拒绝且不查询结果；禁止跨图库统计、文件路径或资产存在性泄露。响应不新增作者/用户身份；路径字段保持现有受授权 Gallery DTO 的边界，查询词不写应用日志。

### 2. SQLite 索引与游标

- 仅追加迁移 `0011_gallery_search_index`：新增每个可见图库资产恰一行的搜索内容投影、带 `(library_id,captured_at,asset_id)` 的日期/keyset索引、FTS5 `trigram` 虚拟表及维护触发器；为现有本机资产和可见同步投影回填索引，之后由资产/文件位置/同步投影变更触发器维护。若本地资产与投影同 ID，本地优先；投影 `tombstone_event_id IS NOT NULL` 时本地/投影都隐藏，恢复以 `tombstone_event_id IS NULL` 决定可见性。
- 本地文件位置复用 Gallery 的规范来源规则：限定 `node_id=origin_node_id`，优先 online、再 cached、最后其他，并以 `location_id COLLATE BINARY` 稳定打破平手；无 location 时文件名回退 asset ID、路径为空。同步投影使用其 `filename`/`sourcePath` 元数据并按 asset ID 回退。时间戳只接受 SQLite 可规范为固定宽度 UTC `YYYY-MM-DDTHH:mm:ss.sssZ` 的值；无效/缺失值索引为 null。不得修改 `0001`–`0010`、原图或原图存储引用。
- 非空 q 达到 3 个 Unicode code points 后才可查询，并使用 FTS5 trigram；更短项明确返回 400，不允许走无索引全库扫描。FTS5 不可用时迁移必须失败关闭，不静默退化成无索引的全量路径。
- 游标为规范 base64url JSON，不是 ACL token；包含格式版本、`libraryId`、对已验证规范化 q/日期条件的 SHA-256 指纹、排序版本及最后一个 `(capturedAt,assetId)`。复用到其他图库/条件时返回 400。游标只承诺数据未变化时的稳定 keyset 分页，不承诺跨并发写入快照；每次翻页重新执行 ACL。
- API 从 `/v1/assets` 返回既有 DTO，不添加原图读写、路径字段或搜索命中原因。新字段仍由 PM-049 另行设计。

## 兼容、迁移与回滚

- 新增 append-only `0011_gallery_search_index`；迁移只建立/回填 SQLite 派生索引，不读写/重排/删除媒体原图。迁移前备份门、备份失败不变性、全量回填、触发器更新/删除/恢复、FTS 可用性与重启恢复均须在隔离 SQLite 验证。
- 新版接受现有 q（非空至少3个 Unicode code points）及图库/分页调用；旧版本不理解 `dateFrom/dateTo`，客户端需先探测新搜索能力或在收到参数错误时禁用新筛选，不能静默把未过滤结果当成成功。1–2 code points 的 q 在新版明确返回 400。新增能力应由 Node health/diagnostics 暴露。
- 旧二进制遇到未知 `0011` 必须遵循现有 fail-closed 策略。回滚测试使用迁移前备份重建隔离 DB；不得通过删除迁移行或回退生产数据库来降级。生产迁移仍未授权。

## 验收测试

- 子串大小写/Unicode/引号/FTS 运算符、特殊字面字符、短词、文件名与路径、本地/同步投影、捕获日期 UTC 半开边界与 null 日期。
- 跨图库/跨查询/跨日期范围游标拒绝；静态数据集多页无重复/遗漏；同 capture time 与 null 日期排序；未知/重复参数、超长输入、反向日期区间返回 400。
- 未授权、缺失图库、越库 cursor 的 API 负测；授权发生在 repository 查询前且错误响应不含数据。
- `EXPLAIN QUERY PLAN` 证明日期/keyset走复合索引，含 3+ 字符文本查询走 FTS 虚拟表；迁移回填/触发器/tombstone恢复与旧 checksum 保持。
- 100,000 项真实 HTTP API 基准使用临时文件型 SQLite/WAL（非纯内存微基准），覆盖多 origin/kind、固定比例空日期、多样文件名/路径及次级位置；记录 OS/CPU/RAM、Node/SQLite、page cache/OS cache条件、DB/WAL大小、查询类/原始样本与 P50/P95/P99。`PRAGMA shrink_memory` 不代表 OS 文件缓存清空，须如实标注。CI 运行确定性 query-plan/ACL/分页断言，不依赖脆弱的墙钟门槛；在记录机器上验证 P95<1 秒。
- 根级 install/lint/typecheck/test/contracts/build；不运行生产迁移、不改动原图、不 push/merge/release。

## PM-048 实施证据

- 100,000 资产真实 HTTP API 基准使用临时文件型 SQLite/WAL，数据包含 4 个 origin、3 种 kind、约 1/37 未知拍摄时间、每 20 项一个文件位置及每 1,000 项一个次级位置；查询固定 limit=50，重复 1,000 次混合选择性词项，再测 100 次 `nas-node` + 7 日日期范围。原始 1,100 个测量样本见 [`gallery-100k.json`](../../artifacts/performance/gallery-100k.json)；可用 `pnpm test:e2e --grep "virtual timeline pages"` 重现。
- 基准机 Windows 11 23H2、AMD Ryzen 7 6800H、16 逻辑线程、15,613 MiB RAM、Node v24.13.1、SQLite 3.53.4；DB 72,364,032 bytes、WAL 73,183,592 bytes，峰值 RSS 181 MiB。混合搜索 P50/P95/P99=19.33/95.63/145.28 ms；日期搜索 P50/P95/P99=55.33/78.19/85.51 ms；阈值 P95<1,000 ms 通过。首次请求前调用 `PRAGMA shrink_memory` 的耗时 406.83 ms；OS 文件缓存未清空，报告不将其声称为冷启动。
- `pnpm test:sync-compose` 双节点断网恢复回归通过（恢复 10.712 秒）；2 GiB NAS 容器峰值 74 MiB，原图 SHA-256 全部匹配且仍 node-local。
