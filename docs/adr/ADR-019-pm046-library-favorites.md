# ADR-019：PM-046 图库级收藏语义与跨节点同步

- **状态：用户于 2026-10-28 批准推荐默认。** 仅授权隔离 `feat/pm046-favorites` 分支内的 API/schema/protocol 实现、测试和本地提交。**不授权生产数据库迁移、push、merge 或 release。**
- **日期：** 2026-10-28
- **路线图：** PM-046（收藏语义与持久化）。
- **依赖：** PRD §3.4；ADR-002（签名事件、因果 inbox）；ADR-016（标签 OR-Set 与 writer grant）；ADR-018（独立事件流、持久冲突、全局 UUID namespace）；PM-041/042（服务端标签持久化/同步）；PM-045（服务端虚拟相册与事件同步）。

## 背景

PRD §3.4 要求收藏、标签及相册关系变更通过事件同步；技术架构 §4.4 要求收藏/评分按用户独立保存或检测并发冲突，禁止静默覆盖。当前 HTTP principal 是 `local-admin`，Node Peer ID 代表设备/节点，不代表人类用户；仓库没有已实现的收藏模型、收藏路由或可迁移的旧客户端收藏数据。PM-046 因此必须在“共享图库状态”与“个人偏好”之间明确选择，不能将设备身份冒称为用户身份。

## 目标

1. 在当前单管理员身份模型下定义真实可实现、跨客户端一致的收藏作用域。
2. 持久保存收藏并按 PRD 在获得授权的节点间同步；并发 add/remove 不使用墙钟 LWW，也不静默丢掉未观察的并发操作。
3. 保护图库隔离、远端写权限、原图安全、迁移备份及 N/N-1 共存行为。

## 非目标

- 不声称收藏是人类个人偏好；不新增人类账号或多用户身份模型（由 PM-071/072 规划）。
- 不实现评分（PM-047）、批量收藏 UI、搜索筛选 UI 或旧 IndexedDB 数据导入。
- 不从标签、相册关系或文件名推断收藏；不修改、复制或删除原图。
- 不执行生产迁移、push、merge 或 release。

## 已批准决策（用户批准于 2026-10-28）

用户明确选择“批准图库级共享同步”；以下推荐默认构成 PM-046 实现约束：

### 1. 作用域与用户可见语义

- 采用**图库级共享收藏**：每个 `(libraryId, assetId)` 在已授权节点上收敛为一个共享布尔状态。任何获准的设备都能修改该图库的共享收藏；它不是 per-user bookmark。API/后续 UI 必须说明该状态会同步到授权节点。
- Node Peer ID 仅标识签名事件作者/设备；不作为人类主体或个人收藏 key。未来引入人类身份时，不把现有图库级状态伪迁移成个人状态。
- 一个 Node 上的多客户端通过同一 Node API 读写同一物化状态；跨节点状态通过事件复制。无既有浏览器本地收藏数据需要导入。

### 2. OR-Set 与事件因果

- 使用独立 `asset-favorites-v1` capability 和 libp2p stream `/photomesh/asset-favorites/1.0.0`，独立于 metadata、tag、album 的作者序列与游标；新事件不能阻塞旧共同 streams。
- 事件类型为 `asset.favorite.added` 和 `asset.favorite.removed`。Add 的 `eventId` 是 add token；每个 `(library, asset, author Peer)` 同时最多一个活动 add，重复设为 favorite 是幂等 no-op；取消后重新收藏产生新 add token。
- Remove 携带有序、去重的 `observedAddEventIds`（最多 64 个），且这些 add ID 同时是 causal parents。Remove 只取消其观察到的 add；并发/未观察 add 继续使收藏为 true。没有活动 add 时取消收藏为 no-op，不伪造删除墓碑。
- Add 必须因果引用同库 `asset.indexed` event；缺失依赖时 durable pending，不能 ACK、跳序或丢弃。未知/错误库的已知因果 ID 进入永久 author-stream conflict；超限不得截断。
- 每图库最多 64 个 favorite event authors（含本地 Node，撤权不释放）；默认容量沿用 tag-sync/PM-045 的 256 KiB/event、64-event batch、16 MiB/request、16,384 cursors、64 MiB 全库/8 MiB 单 relay pending inbox；确切值以实现与测试校准。

### 3. 授权与撤权

- 本机 Node admin 可写本机图库。接收远端事件时，relay 与签名 author 分别校验 trusted/read 权限；签名 author 还必须持有独立、默认拒绝的 per-library `favorite-write` grant。`library read`、`tag-write`、`album-write` 不隐式授予收藏写权限。
- grant/revoke/status 通过管理员保护的 pairing API 管理；授权撤销阻止新事件，已持久接受的 pending 事件仍按接收时授权结果处理，历史收藏不因撤权自动回滚。
- 只读授权节点可读取并接收已授权图库的共享收藏；未授权、越库或不存在资产按现有资源枚举保护返回 masked 404。

### 4. 持久化/API 与墓碑

- 为本地资产和 `sync_asset_projection` 资产维护可重建的收藏投影及不可变 event/operation history；`GET /v1/assets` 的每资产 DTO 增加 `favorite: boolean`。
- 提供图库/资产 scope 的 `PUT /v1/libraries/{libraryId}/assets/{assetId}/favorite`，body `{ "favorite": boolean }`，带 `Idempotency-Key`。真实状态变更的 key 同时是事件 ID；no-op key/fingerprint/响应也持久且占全局 UUID namespace，不产生 event；同 key 不同请求返回 409。响应不包含用户身份或敏感文件信息。
- Tombstoned/未知/越库资产的本机写入维持 masked 404。授权且因果有效的远端事件必须保留历史；tombstone 期间隐藏投影，资产恢复后按 OR-Set 历史重建。不得因 tombstone 清除 favorite event 或原图。
- favorite 只描述“此图库共享状态”；不新增物理删除、资产状态或原图行为。

### 5. 迁移、全局 ID 与兼容

- 新增 append-only `0009_asset_favorites`，不得修改 `0001`–`0008` SQL/checksum。必须在隔离 SQLite 验证非空 PM-045 数据库升级、备份失败无变更、旧二进制拒绝未知 migration、历史 UUID registry 回填/冲突失败和重启恢复。
- 扩展全局 UUID registry 以登记 `asset-favorites-v1`，并同步更新所有现有事件/operation writer guard，使 metadata/tag/album/favorite 之间跨流 UUID 重用失败关闭；不得通过跳过 registry 规避表约束。
- N-1 不支持 favorite capability 时继续同步共同 streams；favorite outbox 明确保持 pending/unsupported，不能推进 favorite cursor，也不能丢弃。升级后原事件可重试。
- 不运行生产 migration；回滚需恢复迁移前 DB 备份并承认迁移后新增收藏事件不可由旧版直接读取。

## 主要风险

- 图库级共享收藏会让任一获准 writer 的取消操作影响所有节点；这与个人收藏不同，必须在 API/UI 中清楚标示。若产品要求个人偏好，应先完成稳定的人类身份/ACL，而不是用 Peer ID 代替。
- 新事件 stream 与全局 ID registry 扩展涉及较高迁移/兼容风险，必须审查所有 writer、历史 UUID 回填和 N-1 边界。
- OR-Set 的“并发且未观察的 add 保留”不同于传统最后写入者胜出；需要通过实际双节点离线测试说明，并允许用户同步后再显式取消。

## 验收计划

1. 开始前根级 frozen install、lint、typecheck、test、contracts、build；所有旧迁移 checksum 不变。
2. populated `0008` 升级、备份失败无变更、旧 binary 安全拒绝、registry 回填无冲突/冲突原子失败、重启与 durable signing draft 恢复。
3. 同一 Node 两个客户端共享可见状态；两 Node 同步 add/remove/re-add；重复/乱序/离线/重启/并发 add-remove 的 OR-Set 结果确定，未观察 add 不被错误移除。
4. 正反向 ACL：无 trusted relay、无 library read、无 favorite-write、仅 tag/album grant、撤权后新事件均拒绝且不前移 cursor；恢复授权后原 outbox 重试；跨库 IDOR masked 404。
5. 本地 tombstone 拒绝写入；远端有效 tombstone 事件留历史并隐藏；asset restore 后正确重建；不清除原图，前后 SHA-256 保持一致。
6. N/N-1 favorite protocol 单独协商，不阻塞 metadata/tag/album；unknown schema/event 不应用、不 ACK；资源上限/backpressure 整批拒绝。
7. 根级回归与 `pnpm test:sync-compose` 双节点测试；独立安全审查无阻断后本地 Conventional Commit。绝不执行生产迁移、push、merge 或 release。

## 批准边界

仅覆盖上述图库级共享收藏语义、新独立 favorite event stream、API/schema/migration、隔离测试与本地提交。若将来改为 per-user 或 local-only，需另行调整本 ADR；local-only 还须先显式修订 PRD §3.4 的跨节点同步要求。生产迁移、push、merge、release 始终另行授权。
