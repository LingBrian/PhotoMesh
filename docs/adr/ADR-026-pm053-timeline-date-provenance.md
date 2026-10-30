# ADR-026：PM-053 时间线时区、日期来源置信度与稳定排序

- **状态：** 提案，等待用户批准后再修改数据库 schema、P2P 元数据契约或 API 行为。
- **日期：** 2026-10-30
- **路线图：** PM-053（时间线时区、日期来源置信度与稳定排序）。
- **依赖：** PM-048 授权 Gallery 搜索 API；PM-049 日期筛选与 keyset cursor；现有 `asset.indexed` / `asset.metadata.updated` P2P 事件。

## 背景

本地 `assets.capture_ts` 和 Gallery 响应 `capturedAt` 可表达 UTC 时间，但目前 upload 与外部只读扫描均写入 `NULL`，没有日期来源/置信度字段；同步投影只在 metadata 中可选读取 `capturedAt`。Web 使用浏览器默认时区格式化日期，未显式命名或可选用户时区；`dateFrom`/`dateTo` 在 API 合约中定义为 UTC 日历边界。Gallery 当前按 `captured_at DESC, asset_id COLLATE BINARY DESC` 排序并以时间 + ID 做 keyset cursor，已有稳定排序基础，但尚无相同时间戳跨页专项验收。

## 提案（尚未批准）

### 目标与非目标

- **目标：** 保存日期值的来源与置信度；以明确的时区策略显示时间线；对相同、未知及分页边界时间保证全序、无重复/遗漏。
- **非目标：** 地理位置推断、AI 猜测拍摄日期、手工批量改日期、改变原图、重写历史 P2P wire format、生产图库迁移。

### 日期来源与置信度（推荐）

1. 为每个资产增加 `capture_source`、`capture_confidence`、可选 `capture_local_time` 和 `capture_offset_minutes`。推荐来源枚举为 `exif_offset`、`exif_floating`、`legacy_unknown`、`unknown`；置信度为 `high`、`medium`、`unknown`。
2. EXIF `DateTimeOriginal` 带有效 offset 时，保存规范 UTC `capture_ts`，来源 `exif_offset`、置信度 `high`。
3. EXIF 有 `DateTimeOriginal` 但无 offset 时，保留无时区的本地墙钟值（floating local time），不猜测 UTC 或当前导入节点时区；来源 `exif_floating`、置信度 `medium`。界面显式标注时区未知，并放入独立的 floating-time 分段；UTC 日期筛选不将其伪装成 instant。
4. 推荐不以文件系统 `mtime` 或 upload/import 的 `created_at` 冒充拍摄时间：复制可改变 mtime，创建时间不是拍摄时间；无可验证 EXIF 日期时保持 `NULL/unknown`。若用户希望采用低置信度 mtime 回退，应在实施前另行明确批准。
5. EXIF 读取纳入 PM-053，初始只处理经许可/资源审查的 reader 明确支持的照片格式；unsupported、损坏或超资源边界的文件保持 `unknown`。新写入/扫描读取元数据，不改文件；旧资产标记 `legacy_unknown`，仅在后续正常只读扫描/重新上传时补充来源，不由迁移遍历文件。
6. 对迁移前已有 `capture_ts` 的记录保留原值，但将来源和置信度标为 `legacy_unknown/unknown`；不从旧数据反推来源。

### 时区与排序

- 具有明确 offset 的 instant 以 UTC 存储；展示按客户端 IANA 时区格式化，默认系统时区。是否提供本地时区覆盖由用户确认；floating local time 不经用户时区换算，并标注“时区未知”。
- 既有 API `dateFrom`/`dateTo` 的 UTC 半开语义保持不变，避免改变 v1 搜索边界；浮动本地时间不参与该 UTC instant 筛选。
- Gallery 使用分段的稳定全序：有 UTC instant 的资产按 `capture_ts DESC, asset_id COLLATE BINARY DESC`；其次 floating local 资产按 `capture_local_time DESC, asset_id COLLATE BINARY DESC`；完全未知日期最后按 asset ID 排序。不同段间不伪称可证明的全球时间先后。
- 新 cursor 版本包含分段、该段日期键与 asset ID；接受旧 cursor 的已知 `capturedAt` 位置，旧 null-date cursor 返回可识别的 stale-cursor 结果，由 Web 清空旧页并从头恢复，不混合两种顺序。cursor 仍绑定 library 与 filters；测试相同时间戳、floating/UTC 分段及 NULL 分页无重复/遗漏。

### 兼容、迁移与 P2P

- 如需持久化新增字段，追加 `0014`，不改写 `0001`–`0013`。迁移仅添加字段/派生索引，不触碰媒体字节；验证备份失败闭锁、旧 checksum 不变、迁移原子性、重启持久化和恢复说明。此 ADR 不授权生产数据库迁移。
- 同步日期元数据以可选 `capture` 子对象附加到现有签名 `asset.indexed` payload，不新增事件类型或必需能力；旧事件缺少此对象时新节点回退 `unknown`，旧节点忽略未知可选字段。对旧/新节点 payload 验证行为必须有兼容测试；不得因无日期或版本差异阻断资产索引同步。
- OpenAPI 响应只增加可选 provenance/timezone 字段；现有 `capturedAt` 维持 UTC/`null` 兼容。任何客户端时区偏好只保存在本地，不传输为用户身份或授权数据。

## 风险和待批准选择

- EXIF 无 offset 时，源设备/拍摄地点时区无法从文件确定；本提案推荐保存 floating 值而不猜测，但其与 UTC instant 的相对排序仅为名义顺序。
- 文件 `mtime` 可被复制/编辑改变，故推荐不作拍摄时间回退；部分 RAW/视频容器可能不支持 metadata reader，需要明确 `unknown` 回退，不能静默失败或改写原图。
- SQLite 日期字符串、EXIF offset/DST 边界、旧同步 payload 与 cursor 语义都需要跨时区和分页测试。实现前确定 metadata reader 依赖与资源上限，禁止无界整文件载入。

## 验收计划（待批准后执行）

- 测试带 offset / 无 offset / 非法 EXIF 时间、旧/unknown 日期与置信度映射；验证日期提取只读、不修改文件，并对大文件资源使用有界；无 offset/缺失 EXIF 不得由 mtime 或 ingest 时间伪造拍摄时间。
- 在至少 UTC、Asia/Shanghai、America/Los_Angeles 的时区环境验证显示、跨午夜分组和 DST 边界；floating 值不被错误转换。
- 数据库与 HTTP cursor 测试包含大量相同时间戳、floating/UTC 混合、NULL 日期及页长边界，确认完整遍历无重复/遗漏且 cursor 绑定筛选与图库。
- 验证旧 event 缺日期可应用、新 event 字段可被旧/新版本兼容处理；更新 OpenAPI 测试及 UI 双语/可访问性测试。
- PM-053 完成时运行根级 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm contracts:check`、`pnpm build`；仅临时测试数据库执行迁移。

**审批请求：** 请确认是否批准以上推荐语义，尤其是“EXIF 有 offset 时才作为绝对 UTC；无 offset 保留 floating 值并独立排序；不使用 mtime/ingest 时间回退；系统时区用于显示且 UTC API 日期筛选不变；追加迁移 0014 与可选 P2P 字段”。同时请确认首期是否含新旧资产的 EXIF 读取/补充，以及是否需要本地时区覆盖设置。批准仅覆盖隔离 worktree 的本地实现与测试，不授权生产迁移、push、merge、release 或部署。
