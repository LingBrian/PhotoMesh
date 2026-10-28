# ADR-017：PM-044 服务端虚拟相册与成员关系

- **状态：** 提案，等待用户批准后才修改 Node/SQLite schema 或实现 API。
- **日期：** 2026-10-28
- **路线图：** PM-044（虚拟相册服务端模型/API 与成员关系迁移）。
- **依赖：** PM-041 / ADR-015（SQLite 迁移与图库 ACL）；PM-042 / ADR-016（读授权不得隐式授予写权限、OR-Set 观察删除语义）；PM-043（当前 Web 本地标签/相册行为）。

## 背景

PM-043 将资产标签改为经授权 Node API 持久化，但 `GalleryApp.vue` 的 `albums` 仍是 IndexedDB 中由标签派生的本地筛选器：`{ id, name, tag }`。它不是带独立成员关系的服务端相册。PRD 要求虚拟相册，TDD 已规划 `albums` 与 `album_memberships`；PM-044 应建立 Node 持久化与分页 API，PM-045 再处理跨节点同步和墓碑。把现有 tag-backed 筛选直接视作成员快照可能改变用户语义，所以本提案不自动改写旧浏览器缓存。

## 目标

1. 增加图库范围内、可分页的服务端手动虚拟相册及成员关系；原图、物理路径和资产索引不变。
2. 每个成员变更可幂等识别，并保留 PM-045 所需的 add 操作 ID 与已观察 remove 目标；并发未观察 add 不会被 remove 静默删除。
3. 所有读取和写入在服务端校验实际身份及图库范围；只读图库授权不自动变成写权限。
4. 采用只追加的 SQLite migration，保留现有表、PM-043 IndexedDB 标签及本地相册数据；不触碰生产数据库。

## 非目标

- 本切片不实现 P2P 相册协议、N/N-1 协商、远端写授权或跨节点冲突处理；这些属于 PM-045，不能由读授权推导写权限。
- 不实现智能/规则相册、文件夹相册、公开分享、密码相册、E2EE、相册永久删除或 rename 冲突解决。
- 不自动把 Web 旧 `{name, tag}` 本地相册转换成服务端静态成员；后续客户端切片须单独决定快照还是动态标签查询，并先保留源缓存。
- 不执行生产迁移、push、merge 或 release。

## 提案决策

### 1. 实体与语义

- PM-044 仅提供手动虚拟相册；相册 ID 全局唯一，每条相册和成员记录都显式带 `library_id`。重复标题允许且大小写敏感；除首尾 trim 外，不做 Unicode NFC/NFD 或大小写归一化，保留精确 Unicode 序列。标题规范为 ECMAScript `String.prototype.trim()` 的精确 WhiteSpace/LineTerminator 集（U+0009–000D、0020、00A0、1680、2000–200A、2028、2029、202F、205F、3000、FEFF），去除首尾后按 UTF-8 字节计数 1–256；SQLite 约束必须使用同一字符集校验规范化值，不能仅依赖 SQLite 默认 ASCII `trim()`。
- PM-044 不提供 rename 或相册删除接口；标题创建后不可变。`albums` 当前无删除状态，列表返回所有已创建相册；删除/tombstone 语义专留给 PM-045，不预置无法产生的 `deleted_at` 状态。
- `album_memberships` 是当前活动投影，逻辑键为 `(library, album, asset, authorPeerId)`；成员 API 对多个作者的活动行按 `assetId` 去重。每次改变另保留不可变操作记录。作者为 Node 持久化 `identity.peerId`（不是浏览器 bearer/principal）。每个 `(library, album, asset, authorPeerId)` 最多一个活动 add；活动时重复 add 不新增 token，移除后重新添加使用新 operation ID。PM-045 的同步作者上限提案为每图库最多 64 个 author identities，包含本地 Node author（最多 63 个远端 writer），并须拒绝第 65 个总身份；这与 ADR-016 一致，因此单次 remove 最多观察 64 个 add IDs。超过上限时显式拒绝整项操作，不可截断观察集。PM-044 当前只有本地 Node 身份可写。操作历史将随用户变更增长；PM-045 前不得静默压缩，未来压缩需先定义所有 peer 的安全确认/保留规则。
- 成员只引用 `assetId`；在同一事务中校验相册图库与资产图库一致，并校验资产是可见的本地资产或活动同步投影。SQLite 触发器必须重复校验（不是只信 Repository），且验证墓碑状态；跨库/不存在/已 tombstone 的新增均拒绝。已有成员目标后来 tombstone 时关系与操作记录保留，GET 在分页前过滤它；恢复后可重新显示。成员 API 只返回 allowlist 字段 `{ assetId }`，不返回 `sourcePath`、`storageRef`、原路径、EXIF 或标签；不读取或复制原图。

### 2. API 与授权

建议在现有 `/v1` 中增加：

- `GET /v1/libraries/{libraryId}/albums?cursor&limit`：按 `albumId` keyset 顺序分页返回相册；默认 `limit=50`、最大 `200`。PM-044 没有相册删除状态，列表包括所有已创建相册。
- `POST /v1/libraries/{libraryId}/albums`：创建手动相册；响应包含服务端 album ID、规范化标题和创建时间。
- `GET /v1/libraries/{libraryId}/albums/{albumId}/members?cursor&limit`：按 `assetId` keyset 顺序分页；只返回 `{ assetId }`，不返回总数。先做活动成员/资产可见性过滤，再取 `limit+1` 判断下一页，避免墓碑行泄露页大小或游标间隙。
- `PUT /v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}`：添加/确认成员；同一作者重复添加保持一个活动 add token，移除后重新添加产生新 token。
- `DELETE /v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}`：在单个事务中捕获并移除当前已观察的 add IDs；并发后到的、未观察 add 必须仍活动。

所有变更请求要求 `Idempotency-Key`（UUID）；它作为全局唯一 operation ID，跨图库、相册和操作类型不得复用。请求指纹包含认证 principal、HTTP method、规范化资源路径、规范化且校验后的 JSON body/API 版本；键和原响应永久保留以供幂等重放和 PM-045 事件映射。相同 principal/指纹返回原响应；同键不同 principal 或指纹一律返回无细节 `409 idempotency_conflict`，不泄露原请求。键记录、操作日志、成员投影和 remove targets 必须在同一事务提交；崩溃前未提交则全部回滚。永久记录增长作为明确的数据/资源成本，不得静默过期或压缩。

分页仅允许 `cursor`、`limit`，重复/未知参数及无效 limit/cursor 返回 `400`；cursor 上限 2048 字节，版本化编码并校验库 ID、相册 ID/集合、排序版本和最后 ID。排序为 `albumId > lastAlbumId` 或 `assetId > lastAssetId`；每页重新校验授权，不承诺总数，不用 offset。Cursor 是 keyset continuation 而非 MVCC 快照：未变化的记录不会因 offset 位移而重复/漏页；并发新增/删除按每页当前状态体现，若新增排序键早于游标，客户端须从首屏刷新才能看到。墓碑过滤始终先于 page-size/nextCursor 计算。

当前 `apps/node-agent/src/index.ts` 将 `authorizeLibraryRead`/`authorizeLibraryList` 与管理员 Bearer 都接到本机 `authorizePairingAdmin`，成功回传 principal `'local-admin'`，并不检查 `libraryId`；HTTP 尚无 Peer 读取/写入令牌，所以 PM-044 API 当前仅本机管理员可访问，不宣称 Peer 可读。每个路由先校验管理员身份（失败统一 `403 forbidden`），再调用 `authorizeLibraryRead(token, libraryId)`（成功表示 callback 认可的 principal，不表示图库存在），并通过 gallery library index 独立确认 `libraryId` 已存在；写路由同时要求 `authorizePairingAdmin` 和 library authorization。管理员有效但 callback 拒绝、图库未知/无权、相册缺失、album-library 不符、资产缺失/跨库/墓碑时，相关 list/member/write 路由统一返回同一 `404 not_found` 状态/封套，不暴露具体资源或数量。逐路由契约测试分别覆盖无效管理员、已认证但 callback 拒绝、未知图库、有效空相册列表、无相册/跨库相册、无资产/跨库/墓碑资产，证明不混淆且不枚举。未来若暴露 Peer API，必须实现真正的 library-scoped read ACL；Peer 写入还需单独 album-write grant、撤权及事件作者校验，不能复用 `library_grants.permission='read'` 或 PM-042 的 tag-write grant。OpenAPI 要明确每条路由的 schema、状态码、错误、响应头和 cursor 约束，先验证契约再实现。

### 3. SQLite migration、兼容与恢复

- 追加 `0007_virtual_albums`，不得修改 `0001`–`0006` checksum。仅新增 `albums`、`album_operations`（全局 operation ID、principal、请求指纹、原响应/作者与 add/remove/create 操作历史）、按作者记录活动关系的 `album_memberships` 投影、`album_membership_remove_targets` 及索引/失败关闭触发器；数据库复合约束和触发器都校验 library/album/asset/author 一致，remove target 必须指向同一关系的 add op。操作请求去重记录与业务投影在同一事务写入。PM-044 不创建 album-delete tombstone/字段，不物理删除成员操作历史。
- migration 测试必须从已应用 `0001`–`0006` 且有资产、同步投影、标签与 tag-event 数据的 SQLite DB 升级；断言 `0001`–`0006` migration source/checksum 不变，`0007` 表/约束正确。备份失败测试断言无 `0007` 表/版本记录且旧数据字节/行数不变。旧二进制面对未知 `0007` 必须拒绝启动；不允许就地降级。回滚只能恢复 migration 前备份，明确承认快照之后创建/编辑的相册及成员操作会丢失。
- 迁移不扫描/改写用户资产、不重写 `asset_tags`、不导入/删除 IndexedDB、不更改既有同步事件。非空 DB 依赖现有启动器迁移前备份和备份失败拒绝启动；本 ADR 不授权或执行生产迁移。
- 迁移测试使用临时/内存 SQLite；不得打开用户生产数据库。完整前向/回滚策略和 PostgreSQL 适配不在本 ADR 范围。

## 验收计划

1. 从含数据的最新 `0006_asset_tag_sync` 数据库升级；证明 `0001`–`0006` checksum 不变、`0007` 约束/触发器成立、重启持久化；注入备份失败并验证 schema/data 未变；测试旧程序拒绝未知 migration。记录恢复迁移前备份会丢失快照之后相册操作的回滚后果。
2. OpenAPI HTTP 合约覆盖每个路径、query/body/header、响应 schema/status/request ID、安全头；limit 0/201、重复或未知参数、畸形/越库/跨 album cursor 均拒绝。Cursor keyset 绑定 library/collection/order/last ID，稳定 ID 顺序，无 total count；并发插入下一页不重复/跳过已有记录，墓碑/撤权发生在两页间不泄露条数、ID 或摘要。只返回明确 allowlist `{ assetId }`。
3. 标题测试 exact trim 字符集、纯空白拒绝、UTF-8 256 字节边界/257 拒绝、重复标题规则。创建/列表、请求同键重放（含重启后）、同键改 body/跨 endpoint/跨 principal 冲突、操作 ID 全局唯一、写入事务中途故障回滚全部 dedupe/log/projection/targets。
4. PM-044 单节点成员重复 add、remove、retry 及故障重试：同一 Node 作者仅一个活动 add；remove 只删其事务原子捕获的 observed IDs；构造 >64 次 add/remove 历史后仍正确重建活动成员，验证历史操作 ID 不复用。PM-045 必须在 Peer 写入前实现/测试每库 64 个 author identities 上限（含本地 Node、最多 63 个远端 writer）并拒绝第 65 个总身份，避免 remove payload 超过 64 observed IDs；绝不截断。过量历史的 DB 体积记录为资源风险，不允许 silent compaction。
5. 未授权主体、未知/越库图库、猜测 album/asset ID、跨库路径均验证统一 `403`（无效 admin）或掩蔽 `404 not_found`（身份通过后资源范围错误），响应体不泄露资源是否存在。写操作需同时通过管理员与 library scope 检查；只读身份不能变成写授权。
6. 本地资产、活动同步投影、缺失/跨库/tombstone 资产的 SQL 约束与 API 拒绝测试；已存在成员随 asset tombstone 隐藏、恢复后重现；拒绝新增到 tombstone；源字节 SHA-256 与现有 IndexedDB 标签/相册值不变。
7. 先验证 OpenAPI，再跑根级 install-frozen/lint/typecheck/test/contracts/build；不把生产迁移、P2P、多用户远端写、硬件验证记为通过。

## 待批准范围

请批准上述 PM-044 范围和授权边界后再开始 schema/API 实现；如需允许只读 Peer 修改相册、自动迁移本地 tag-backed 相册、加入 rename/delete、或采用不同并发语义，必须先修订本 ADR。即使批准本 ADR，也不授权生产数据库迁移、push、merge 或 release。
