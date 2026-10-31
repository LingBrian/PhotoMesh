# ADR-018：PM-045 虚拟相册同步、授权与墓碑语义

- **状态：** 用户于2026-10-28明确批准以下推荐默认选择；授权在隔离 `feat/pm045-virtual-album-sync` 分支实现协议/API/schema、测试并本地提交。**不授权生产数据库迁移、push、merge 或 release。**
- **日期：** 2026-10-28
- **路线图：** PM-045（虚拟相册成员同步和删除墓碑语义）。
- **依赖：** ADR-002（签名事件、因果 inbox、反熵）；ADR-006（N/N-1）；ADR-016（独立 tag stream、OR-Set、writer grant、author cap）；ADR-017 / PM-044（本地虚拟相册、全局 Idempotency-Key、成员 OR-Set 投影）。

## 背景

PM-044 已在隔离分支 `feat/pm044-server-albums` 提供仅本机管理员可用的服务端相册、成员 OR-Set 投影、不可变 `album_operations`、64 作者上限、全局 UUID 幂等键和 SQLite `0007_virtual_albums`。它不实现 Peer 写授权、跨节点事件、相册级删除状态或 P2P 协议；PM-044 的 SQL 触发器也会拒绝针对当前 tombstone 资产的新本地成员写入。

PM-042 已证明不能把新事件直接混入旧 metadata 作者序列：N-1 peer 对未知事件可能阻塞同一作者后续事件。因此 album sync 需独立协商能力、事件序列与 cursor。ADR-016 同时规定有效的已知 tombstone 资产事件必须保留，投影隐藏，恢复后重显；它不得因到达时资产处于 tombstone 而静默丢弃。

PM-044 的 `album_operations.operation_id` 是全局 HTTP 幂等 ID，成员 add 操作 ID 又用于观察删除关系。将来若和签名 `eventId` 映射，必须明确一对一关联及跨表冲突策略，不能让同 UUID 不同事件覆盖或重复应用。

## 目标

1. 在授权 Peer 间复制相册及成员 OR-Set 变更；重复、乱序、断网、重启与因果缺口下不静默丢操作。
2. 区分 event history 与可见投影：对已知 tombstone 资产的有效远端操作保留并按 OR-Set 应用，成员读取仍隐藏；资产显式恢复后按历史重显。
3. 使用独立的 album capability/transport；不支持 album sync 的旧节点仍可继续 metadata 和 tag sync，album 事件不被误确认或删除。
4. 仅以签名事件作者和明确的 per-library album-write grant 授权；relay、library read grant 或 tag-write grant 不隐式授予 album 写权。
5. 保留 PM-044 的操作历史、global author cap 和备份迁移保护；不静默压缩历史，不物理删除原图或 album event。

## 非目标

- 不做相册 rename；标题仍由 PM-044 创建后不可变。
- 不把旧 Web IndexedDB 的 `{name, tag}` 相册自动转换成共享相册，也不在 PM-045 切换现有 Web 本地 tag-backed album UI 到新服务端模型；客户端迁移另行定界，避免静默改变现有用户语义。
- 不同步原图、物理路径、`storageRef`、EXIF、私有本地身份凭据或无授权图库元数据。
- 不执行生产迁移、push、merge 或 release；即使本 ADR 获批也不包含这些操作。
- 不执行相册、事件或原图的物理/永久清除；PM-045 包含可恢复的 local-only hide 与 global soft-delete/restore，语义见下文。

## 已批准设计

### 1. 独立协议与兼容

- 新增独立 capability `virtual-albums-v1` 与 libp2p stream `/photomesh/virtual-albums/1.0.0`，使用既有签名 `EventEnvelope`/Noise 身份，不更改或复用 metadata/tag stream 的 per-author sequence。每图库有独立 author heads、outbox、inbox、peer cursors、pending/unsupported 状态和有界 exchange。
- 事件类型为 `album.created`、`album.member.added`、`album.member.removed`、`album.deleted`、`album.restored`。创建事件携带不可变 `{albumId,title,createdAt}`；成员事件只含 `{albumId,assetId}` 或 `{albumId,assetId,observedAddEventIds}`；local visibility不产生事件；不含物理路径和原图资料。
- 同步 `album.created`，以便其他 Node 能引用 PM-044 创建的随机全局 `albumId`。每个 Node 的 PM-044 HTTP 写 API 仍只接受其本机管理员；每个 Node 对本地共享写操作以 Node Peer ID 签名并同步，接收端以签名 author 的 grant 授权。单一 `album-write` grant 覆盖 `album.created` 与成员 add/remove 全部 event types；不能靠 relay/read grant 推断。
- N-1 没有 `virtual-albums-v1` 时，继续同步双方已有共同 stream；album outbox 保持 pending/unsupported，单独显示状态，不推进 album cursor、不静默 ACK/丢弃。不兼容 album schema/event 保留为 unsupported，待升级重试。

### 2. OR-Set、因果与 rebuild

- 对 `(library, album, asset, authorPeerId)` 最多一个活动 add；活动重复 add 是 no-op，移除后重加需新 operation/event ID。逻辑成员是尚未被任何有效 remove observation 命中的 add 集合；多个作者的活动 adds 在 UI/API 投影按 `assetId` 去重。
- 远端 `album.created` 必须保留 PM-044 对 title 的 trim/UTF-8≤256 bytes 校验；相同 `albumId` 若关联不同 create event 或 title，作为 durable conflict/quarantine，不做覆盖或 LWW。`album.member.added` 的 event ID 是该 add token；事件必须引用同图库相册创建事件和同图库 `asset.indexed` 因果事件。依赖缺失时 durable pending，不得跳过作者序号或 ACK 为 applied。对同一 `(library,album,asset,author)` 已有活动 add 后又出现不同 event ID 的新 add 属 author sequence/projection conflict，不另建token；remove 后新 add 才允许。
- `album.member.removed` payload `observedAddEventIds` 必须有序、去重、最多 64 个 UUID；每个 ID 必须存在、属于同一 library/album/asset 的 `album.member.added`，并同时是 remove 的 causal parent。Remove 只取消列出的 add；并发/未观察 add 保持活动。超限整项拒绝，不截断。
- PM-044 `album_operations` 保持既有不可变 create/member operation history；PM-045 新增 separate immutable `album_lifecycle_operations` 保存 global delete/restore，若支持 local scope则用 `album_visibility_operations` 保存本地overlay的幂等结果。`album_memberships` 是可重建 materialized projection；sync inbox/event application、相应 operation history 与 remove-target更新在单事务内完成。授权的 restore/recovery 可从 immutable history 确定性 rebuild；不得把 projection当唯一事实。
- PM-044 会改变共享状态的 `album.created`、`member.added`、`member.removed` operation ID 同时作为签名 event ID/add token；新 `album_lifecycle_operations.operation_id`（HTTP Idempotency-Key）用于 global delete/restore 并作为对应 event ID。Local visibility operations仅存在于 `album_visibility_operations`，不产生event。`member.add.noop`、`member.remove.noop`、global delete/restore no-op 与 local hide/restore no-op 都保留其幂等记录/响应但不产生同步事件；其 UUID 仍占用全局操作 ID namespace。无状态变化的重放不生成第二个事件。
- 迁移 `0008` 必须建立全局 ID registry，并在启用 album sync 前回填 metadata events、tag events 与**所有** PM-044 operation IDs（包括 no-op keys）；每个 event ID 全局唯一。registry 区分 `operation-only` 与 `operation+event` IDs。同 stream、完全相同规范化签名 envelope digest 的重投递为 duplicate；不同 stream 即使 UUID/内容相同也为 namespace conflict；同 stream 同 ID 不同 digest、同 author+sequence 不同 event ID 均持久化 quarantine，绝不覆盖、应用或越过 cursor。回填发现历史跨表 UUID 冲突时迁移必须事务失败并留在 `0007`，输出不含敏感 payload 的诊断；不自动重写 operation IDs。
- 新 metadata/tag/album event 与 album operation/visibility-idempotency 写入都在同一事务维护 registry，避免后续跨流碰撞。对本地状态变更，operation ID、待签名 draft、author sequence、event registry 与相册投影同事务预留；签名在事务外完成，未签名草稿重启后恢复签名。local-only visibility 操作只在本地operation表和registry持久化，不产生事件。任何冲突均不部分提交。

#### 已有 PM-044 历史 bootstrap

- `0007` 已有 operation history 必须在首次发送 `virtual-albums-v1` 前逐条幂等 bootstrap：`album.created` → `album.created`；有效 `member.added` → `album.member.added`；有效 `member.removed` → `album.member.removed`，remove payload 从不可变 remove-target 表读取确切 observed add IDs，不重新推断当前活动状态。历史 `member.add.noop` / `member.remove.noop` 仅保留全局幂等 ID，不生成状态 event。重复 API replay 不重复 bootstrap。
- 对每个 author，按 operation dependency 做确定性拓扑排序（album create、被 remove 引用的 add 必须在前）；无因果关系的同层以 operation ID 的二进制字典序稳定排序，不用 `created_at` 作为顺序/冲突依据。既有 add 的 event ID 必须是历史 operation ID，以保持 PM-044 remove targets；每个 event 的签名 draft、author sequence 和 mapping 在同一事务预留，重启后只恢复未签名 draft，不重复分配序号。
- 依赖的 `asset.indexed` parent 尚不存在时，将该 operation 留在 durable bootstrap-pending；先等待现有 metadata index event，不伪造资产事件/路径，不发出缺父 album event。完成所有基线 bootstrap 并签名 ready 前不发送本地 album stream；恢复后继续从持久状态。已知本地事件历史顺序仅由操作依赖及稳定 ID tie-breaker 构造。

#### 因果缺口、unsupported 与冲突后的恢复

- Inbox 明确区分 `missing_parent`（补齐父事件后自动重试）、`unsupported`（软件升级后以原 envelope 重试）、`unauthorized`（album stream 不 ACK；发送端保留outbox；grant/trust恢复后原样重传）和 `conflict/invalid`（持久隔离，需 operator 处理）。只对每 author 连续 applied 前缀发 ACK/推进 cursor；各状态均不可越过失败序号，后续同 author 事件保持 pending；不同作者及 metadata/tag streams 可继续。此 album-specific revoke/retry 行为与当前 tag-sync 对部分撤权 pending 的处置不同，须在 PM-045 独立实现和测试。
- Conflict/invalid 不自动“跳序”或删除。管理员只能查看固定错误码、author/sequence/event ID并修复可修复的信任/父事件后重试；若签名/事件本身无法修复，该 author 的 album stream永久阻塞。当前提案的人工恢复路径是管理员停止/撤销旧 Peer、通过既有配对流程建立新 Peer ID/new grant，再显式重建需要的 album state；旧日志仍隔离保留，不自动迁移、修补或跳过其操作。这是有数据/运营影响的手工恢复，不是内置恢复功能；新 identity不能让旧 author历史自动继续。任何 sequence-skip/rebase/历史迁移协议需独立 ADR；不得隐式推进。
- Pending/unsupported/quarantine durable inbox 上限为全库 **64 MiB**、单 relay **8 MiB**；单 batch 最多64个事件，总请求最多16 MiB。达到上限时整批拒绝并返回 backpressure，发送端保留 outbox；不部分应用、不删除 pending。正式实现须用低内存测试验证这些上限，历史 applied log 不自动压缩。

### 3. Tombstone 资产交互

- 本机 HTTP add/remove 对未知、越库或当前 tombstone 资产继续返回 masked `404`，不得借同步能力绕过用户本地可见性/ACL。
- 已知、签名与 ACL 有效、因果关系正确的远端 add/remove 即使抵达时资产已 tombstone，也必须在 immutable event/operation history 与 remove-target history 中留存；tag sync 相同规则见 ADR-016。对该资产的列表必须在分页前过滤；asset `asset.restored` 后按全部历史重建当前成员关系。PM-044 已存在的 membership projection 行可保留但仍不可见；tombstone 期间新到的远端 add 只写验证后的 operation/event history，不新建 `album_memberships` projection；remove 可记录 target 并删除已有 projection。恢复投影时仅重建未被有效 remove 观察的 add。这样不会把隐藏 event 当成当前可见关系，也不会在恢复后丢掉有效的并发 add/remove。
- PM-044 `0007` 触发器目前要求成员 operation/projection 对应可见资产。PM-045 新迁移只能让经签名、grant、causality 验证且已有匹配 album inbox event 的远端历史操作绕过 visibility 条件；不得全局放宽 SQL guard。新本地 HTTP 仍在数据库事务内拒绝 tombstone 资产。触发器必须校验 library/album/asset/author/operation/event ID 对齐；restore rebuild 只读历史重新生成投影。测试须覆盖 local API 拒绝、合法 remote tombstone event 保留但无新 projection、有效 remove 精确记录 targets、invalid remote event 拒绝、恢复后重显/不重显。

### 4. Album-level delete/restore（已批准 local/global scope）

为兑现 PRD Q09“本地/全局范围可设”，PM-045 纳入两种独立软删除语义；均不物理删除数据：

- **Local scope（本节点隐藏）：** `album_visibility_operations` 是不可变的 Idempotency-Key/fingerprint/response 操作日志；`album_local_visibility` 是每图库/相册当前隐藏状态的本机物化 overlay。两者在同一事务更新；不产生签名事件、不传播给 Peer。`scope=local` 的 restore 只清除此 Node overlay。Local hide/restore 与 global tombstone 独立：恢复一个 scope 不清除另一个 scope，远端同步到的成员关系持续更新但被本地隐藏过滤。
- **Global scope（图库共享墓碑）：** 新增签名 `album.deleted`/`album.restored`，在拥有权限的 Peer 间同步。它隐藏该图库所有节点上的 album 与 members，但不从 `albums`、`album_operations`、成员历史或 asset 表物理删除任何行；原图/资产完全不受影响。活动 album list/member 路由隐藏全局 tombstoned album；本机管理员可通过 recycle-bin 列表发现/恢复。
- API 契约：`POST /v1/libraries/{libraryId}/albums/{albumId}/deletion`（JSON `{scope:'local'|'global'}`，`Idempotency-Key`，本机管理员，返回204）；`GET /v1/libraries/{libraryId}/albums/deleted?scope=all|local|global&cursor&limit`（private/no-store，cursor绑定scope）；`POST /v1/libraries/{libraryId}/albums/{albumId}/restore`（JSON `{scope:'local'|'global'}`，`Idempotency-Key`，本机管理员，返回204）。全局 event 的 `scope` 固定为 global，不接受客户端伪造字段。
- **No-op与幂等：** 有状态变化的全局 delete/restore operation 的 Idempotency-Key 同时是 event ID/tombstone token；有效 operation 写入不可变 `album_lifecycle_operations` 与 event log。Local visibility hide/restore 写入 `album_visibility_operations` 与本地 overlay。重复 delete、local overlay 已隐藏时再次 local delete、local restore 无 overlay、global restore 观察到零个 active delete IDs，均把 no-op Idempotency-Key、fingerprint 和原响应写入相应 operation 表与全局 ID registry，不生成同步事件，返回204。重用同 key 的不同scope/body仍为409。No-op keys不释放、不覆盖其他 operation/event ID。
- 每个 author 对每个 album 最多一个活动 global delete token；本机已观察到任一活动 global token 时，再次本地 global delete 是 no-op（不论token作者），restore移除所有已观察token后可新建token。分区节点在各自尚未观察delete时可并发创建独立 token。Global album 被隐藏当且仅当至少一个 delete token 尚未由有效 restore 移除。`album.restored` 携带其本地已观察的 `observedDeleteEventIds`（有序、去重、最多64，逐项是 causal parents）；只取消这些token。若没有可观察token，restore为上述 no-op；并发/未观察 delete 到达后 album 继续隐藏，用户同步后可再显式 restore。无墙钟仲裁。
- 全局 DELETE/restore event 仅由本机管理员操作发起；远端 author 还需独立默认deny `album-delete` grant（不隐含于 `album-write`）。`album-write` 只覆盖 create/member add/remove。Local-only overlay 无 Peer grant需求。撤权后拒绝新的远端 delete/restore events，既有 tombstone 不回滚。
- Global album tombstone 隐藏而不清空成员 OR-Set。删除期间收到的有效 member events仍进入历史；恢复后按 remove targets 重建当前关系（包含未观察的并发 add），不得自动删除任何资产。若 local overlay 仍隐藏，global restore 后该 Node 继续隐藏。
- 远端 `album.deleted` 必须因果引用 album.created；restore 必须引用观察到的 delete event IDs。迁移新增不可变 global delete/restore operation 与 target投影，并新增local overlay表；`0007` albums immutability guard保留，活动/删除状态由 global tombstone与local overlay派生。API契约、authz、keyset cursor scope、DTO/OpenAPI和双节点测试均纳入PM-045。
- 永久清除 tombstone/event/album row 不在本 ADR，不授权清理用户数据。Q09 retention duration 与到期可见性列入现有 PM-061；若未来批准 album/global event 的物理 purge，权限、备份和二次确认列入 PM-063 独立 ADR/审批。PM-045 只实现可恢复软墓碑，不声称完成 Q09 的保留期/永久删除要求。

**获批范围：** 同时支持 local-only overlay 与 global shared tombstone/restore；global tombstone 是跨节点 soft-delete，local overlay 永不传播。

### 5. Trust、album-write grant 与撤权

- relay 必须 trusted 且具有当前 library sync/read grant；event author 必须是 trusted peer 并拥有该 library 的独立、默认 deny grant：`album.created`/member events 需 `album-write`；`album.deleted`/`album.restored` 需另行 `album-delete`。分别校验 relay 与 author；签名、公钥、Peer ID、作者 sequence、library/album/asset 因果均验证后才能应用。
- `album-write` 与 `library_grants.permission='read'`、PM-042 `tag-write` 分离；`album-delete` 不由 `album-write` 隐式授予。若用户选择拆分 create/member grants，接收端按事件类型只检查对应 grant，不做 fallback。新增受本机管理员保护的 grant/revoke API 与 operator-visible 状态；本机管理员写入不依赖 Peer grant。远端只接受签名者本人作为作者，不能由 relay 代签或改作者。
- grant 撤销后拒绝该作者的新事件；已经复制的历史/投影不因撤权而回滚，离线/分区期间的即时撤权保证不可能；重连后按当前 grant 重新检查。撤权不释放 author slot。

### 6. 作者、载荷与资源上限

- 沿用 ADR-017：每 library 最多 64 个 distinct album event authors，计入本地 Node，最多 63 个 remote identities；按 `album_operations` 与 `album_lifecycle_operations`不可变事件历史的并集计数，撤权后不回收槽位。本地 visibility overlay不贡献 remote author slot。PM-044 Repository/DB trigger 已约束 create/member authors；PM-045 需更新受限trigger使生命周期事件也共享同一cap，远端应用走同一限制。
- 采用 `MAX_EVENT_BYTES = 256 KiB`、album sync batch ≤64 events、cursor ≤16,384、总 request ≤16 MiB；member remove / album restore observed IDs 各≤64。Durable pending/unsupported/conflict inbox 上限全库≤64 MiB、单 relay≤8 MiB；达到任一上限时拒绝整个新 batch、保留 sender outbox 并报告 backpressure，不部分提交、不删历史。所有上限/超限行为须以实现配置、协议 schema 与测试一致验证，不可静默截断。
- Applied Event/history 长期增长是已知资源成本；不做无协议确认的压缩/删除。提供 pending/unsupported/conflict 和 storage-health 可观测状态。

### 7. 迁移、兼容与回滚

- 新增 append-only migration `0008_virtual_album_sync`，不得修改 `0001`–`0007` SQL/checksum；迁移验证只针对隔离/测试 SQLite，绝不运行于生产 DB。对非空 DB 使用既有迁移前备份门；备份失败不得创建任一新表或改旧数据。旧 binary 碰到 `0008` 必须拒绝启动，不自动降级。
- Migration 新增 album-write/album-delete grants、global event-ID/operation-key registry（与 metadata/tag/album event writers 在事务内维护，并从既有 event logs 与所有 PM-044 operation IDs 回填）、event/outbox/inbox/author-head/cursor/pending/conflict 状态、受限 tombstone history/projection guard、immutable `album_lifecycle_operations`/restore targets，以及 `album_visibility_operations`/`album_local_visibility` projection。历史 UUID 冲突须在事务内失败并保持0007可用，不做自动 ID remap。具体 normalized schema 属实现细节，但历史bootstrap操作映射、no-op不生成event、签名恢复与 sequence/cursor 规则如上为契约，必须有 populated-0007、备份失败、重启重签、旧 binary、ID冲突和全历史 rebuild 测试。
- 本 ADR 不授权在生产 Node DB 执行迁移；实现提交后另行要求 operator 明确批准生产迁移、备份与恢复演练。

## 验收计划

1. 两个独立 Node/SQLite：populated-0007 中的有效 create/add/remove 按依赖幂等 bootstrap（no-op不生成event），签名中断后重启不重分序号/不重复事件；bootstrap完成后同步create与member add/remove/re-add并收敛。重复、乱序、重放、崩溃重启、缺失causal parent、同作者序号冲突均有确定状态；未观察并发add在remove后仍活动。local hide不传播、remote node仍显示；local/global restore互不清除；global deletion/restore、并发未观察delete保持隐藏、同步后可重复restore、成员history不清空；重复/空restore no-op key仍持久且无新event。
2. ACL：有 `album-write` grant 的 author 可发起批准范围内的 create/member events；无 trusted relay、relay 无 library grant、作者未 trusted、作者只有 read grant、作者只有 tag-write、作者 grant 撤销后的新事件不ACK/前移cursor、撤权期间 sender outbox 保留并在重新授权后原样重传成功、伪造 event author、签名无效、跨库 event 均拒绝且不泄露或前移 cursor。独立 `album-delete` 允许 delete/restore，只有 `album-write` 或只有 `album-delete` 均不得越权另一类。
3. N/N-1：不支持 album capability 的 peer 仍同步 metadata/tag；album event 保留 pending 并报告；升级后重试；未知 schema/event 不 applied、不 ACK/丢弃。支持与否不能混合推进 cursor。
4. Asset tombstone：本地 API 对隐藏资产保持 404；有效远端 add/remove 在 tombstone 到达时被保留但不显示；restore 后符合 OR-Set 重显；无效/跨库/无授权事件仍拒绝。Cursor、page size/asset ID 不因隐藏行泄露。
5. Author/event bounds：64 author 含本地 Node，第65身份显式拒绝；member remove 及 global album restore 各64个 observed IDs不截断、65个拒绝；大事件/批/游标/持久pending额度越界整批拒绝并保留发送方outbox；global ID registry拒绝跨stream UUID复用，只允许同stream同digest event重放。
6. 从 populated `0007` 升级到新迁移，保留旧 checksum、操作和 asset bytes；验证历史bootstrap/sequence/cursor、全局ID registry回填与历史冲突迁移失败不变更；migration backup failure/no mutation、old-binary unknown migration、unsigned event draft restart/resign、隐藏history及restore projection rebuild全覆盖。
7. 运行根级 frozen install/lint/typecheck/test/contracts/build，并运行仓库现有 `pnpm test:sync-compose` 双节点隔离同步矩阵；Docker 不可用则记录 blocked，不得冒称通过。不得执行生产 migration、push、merge、release。

## 已批准决策（用户批准于2026-10-28）

用户明确选择“Approve all recommended defaults”；下列推荐选择获批并构成实现约束：

1. **同步范围：** 同步 `album.created` 与成员 OR-Set；随机 `albumId` 不另做共享 ID bootstrap。
2. **Grant 权限范围：** 单一独立 `album-write` grant 授权签名 Peer 创建相册及修改成员；本地 HTTP 写仍只接受本机管理员。
3. **Album 删除范围：** 同时支持 local-only hide/restore overlay 与 global shared soft tombstone/restore；无物理清除，不传播 local-only 操作。
4. **授权/撤权：** per-library、default-deny `album-write`，另有 default-deny 独立 `album-delete`；本机管理员管理 grants；撤权不回滚已复制历史，拒绝未来事件，离线已送达数据不可瞬时撤回。
5. **作者上限：** 每 library 64 total album operation authors（本地计入，最多63远端，撤权不释放槽位），与 tag-sync 64 author cap 独立。
6. **Tombstoned asset：** 有效远端 event history 保留；隐藏投影，asset restore 后重建/重显；本地 HTTP 仍 masked 404。与 ADR-016 对齐。
7. **兼容性：** 独立 `virtual-albums-v1` capability/stream；旧 Peer 不阻塞共同 streams，album events pending/可见、不得 ACK/drop。
8. **ID/no-op：** 有效 create/member add/remove/global delete/restore 的 Idempotency-Key 同时是 event ID（add 同时是 add token）；local visibility 与所有 no-op keys 保留 operation/response 但不产生 event，均占全局 UUID namespace。Global restore 无 observed IDs 时 no-op/204；仅同 stream、同 ID、同签名 digest 是 duplicate，跨 stream UUID 复用冲突；0008 历史冲突失败关闭、不自动重写。
9. **容量：** 256 KiB/event、64-event batch、16 MiB/request、16,384 cursors、64 MiB 全库/8 MiB 单 relay durable pending，remove/restore 各64 observed IDs；超限整批拒绝且 sender 保留 outbox。
10. **PM-044 bootstrap：** 既有 create/add/remove 依 causal dependency 幂等映射，no-op 不生成 event；同层按 operation ID 稳定排序、不用墙钟；缺 asset-index parent 时等待；基线事件签名 ready 前不发送本地 album stream。
11. **序列故障恢复：** missing-parent/unsupported/unauthorized 按第2节重试；invalid/conflict 永不自动跳序并永久阻塞该 author album stream。无自动 repair/rebase；人工恢复需停用旧 Peer、用新 Peer ID/grant 重新配对并手工重建所需状态，旧历史不会自动迁移——用户已批准这一运营影响；sequence-skip/rebase 需另行 ADR。

**批准边界：**仅限在隔离 `feat/pm045-virtual-album-sync` 实现上述协议/API/schema、测试及本地提交。明确不包括生产数据库迁移、push、merge 或 release。Q09 retention 由 PM-061、永久 purge 的独立审批/ADR 由 PM-063 负责；PM-045 不清除历史、album row 或资产。任何新增授权范围、事件类型或 sequence-skip 规则都需另行 ADR 与批准。
