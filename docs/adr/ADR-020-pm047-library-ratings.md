# ADR-020：PM-047 图库级共享评分与并发冲突

- **状态：用户于 2026-10-29 批准推荐默认。** 仅授权隔离 `feat/pm047-ratings` 分支内的 API/schema/protocol 实现、测试和本地提交。**不授权生产数据库迁移、push、merge、release。**
- **日期：** 2026-10-29
- **路线图：** PM-047（评分字段作用域、并发冲突和持久化）。
- **依赖：** PRD §3.4；架构 §4.4；ADR-019（收藏和设备/人类身份边界）；ADR-016/018（独立元数据流、因果 inbox、全局 UUID namespace）；PM-041/042/044/045/046（持久化 API、标签、相册、收藏及 P2P 同步）。

## 背景

PRD §3.4 要求收藏、标签及相册关系变更经事件同步，并允许同字段并发修改形成待处理冲突；架构 §4.4 要求收藏/评分按用户独立保存，或检测并发并提示，禁止静默覆盖。当前 Node HTTP principal 为 `local-admin`，Node Peer ID 只标识设备/签名作者，不标识人类；多客户端共享同一个 Node principal，不能据此还原个人评分。PM-046 已选择图库级共享收藏，但该决定不自动延伸到评分。

用户于 2026-10-29 明确批准本 ADR 的推荐范围：图库级共享评分、可见并发冲突和显式解决；不得把 Node Peer ID 冒充成用户身份。

## 目标

1. 定义一个跨获准节点收敛且不伪装为个人偏好的评分字段。
2. 对离线并发不同值保留完整候选及历史；不得使用墙钟 LWW 或静默覆盖。
3. 通过持久化 API、独立签名事件流及默认拒绝写授权实现图库/资产隔离、幂等和可恢复同步。
4. 为后续人类身份提供迁移边界，不把当前共享数据伪迁移为个人数据。

## 非目标

- 不实现人类账号、每人私有评分、评分 UI/排序筛选、聚合平均分或旧客户端评分导入。
- 不以 Peer ID、IP、设备名称或 `local-admin` 解释人类偏好。
- 不从收藏、标签或相册关系推导评分；不修改、复制或删除原图。
- 不执行生产迁移、push、merge 或 release。

## 已批准决策

### 1. 作用域、值域与 API 表示

- 采用**图库级共享评分**：每个 `(libraryId, assetId)` 是一个共享字段，在获准节点间同步；它不是个人/设备偏好。API 与未来 UI 必须说明写入会同步到获准节点。
- 评分值为 `null`（未评分）或闭区间 `1..5` 的整数；拒绝小数、字符串、布尔值及范围外整数。任何冲突响应必须显式区分“未评分”和“有冲突”。
- `GET /v1/assets` 每项增加 `rating`、`ratingConflict` 和去重、排序的 `ratingCandidates`。无冲突时 `rating` 为 1..5 或 null、`ratingConflict=false`；多个活动事件含不同值时 `rating=null`、`ratingConflict=true`，候选包含所有不同值（可含 null）。不得向 DTO 添加人类用户标识或签名作者 Peer ID。
- 增加图库/资产 scope 的 `PUT /v1/libraries/{libraryId}/assets/{assetId}/rating`，body `{ "rating": 1..5 | null }`，要求 `Idempotency-Key`。真实变化的 key 同时是事件 ID；no-op key、fingerprint、响应持久占用全局 UUID namespace，不产生事件；同 key 不同请求返回 409。未知、越库、墓碑资产维持 masked 404。

### 2. 并发模型与冲突解决

- 使用**因果多值寄存器（MV-register）**，而不是 LWW 或将收藏 OR-Set 机械复用到评分。每个 `asset.rating.set` 事件携带 rating 值和有序、去重的 `observedRatingEventIds`；它观察并替代本地已观察的同资产活动评分事件。事件 ID 是不可变历史 token。
- 初次非空评分因果引用同库 `asset.indexed` 事件；后续写入引用所观察的活动评分事件。`null` 写入通过同样的因果替代语义清除已观察评分，不物理删除历史。
- 因果先后写入替代已观察值；并发离线写入保留为多个活动候选。候选值相同时可呈现为无冲突单值，但全部事件历史仍保留；不同候选值必须持久并显式呈现冲突。
- 对当前全部活动候选发起新的评分写入，形成可审计的显式解决事件。未观察到的并发事件仍然存活，因此迟到/分区恢复不会被抹掉；解决后再次收到未观察的并发事件时，冲突可以重新出现。
- 活动事件 ID 上限为 64；超限不得截断、猜测或静默折叠，须拒绝新的解决写入并保留现有冲突供恢复。

### 3. 授权与撤权

- 本机 Node admin 可写本机图库。远端事件要求 relay 与签名 author 均受信任、签名 author 有该图库 read 权限，并持有独立、默认拒绝的 per-library `rating-write` grant。`library read`、`favorite-write`、`tag-write`、`album-write` 不隐式授予评分写权限。
- grant/revoke/status 走管理员保护的 pairing API。撤权阻止之后收到的新评分事件；已经通过 ACL 检查并持久接受的 pending 事件按接收时授权结果继续因果处理，历史评分不因撤权自动回滚。
- 只读授权节点可读已授权图库的评分与冲突候选；未授权、越库或不存在资产按现有资源枚举保护返回 masked 404。

### 4. 持久化与独立同步协议

- 新增 append-only `0010_asset_ratings` 迁移：保留不可变事件、幂等操作、因果移除/分辨信息、跨节点 inbox/outbox/cursor/conflict、默认拒绝 grant 及可重建投影；扩展全局 UUID registry/writer guards，沿用备份失败不变性与未知迁移拒绝。不得编辑旧迁移。
- 使用独立 `asset-ratings-v1` capability 和 `/photomesh/asset-ratings/1.0.0` stream，独立于 metadata、tag、album、favorite 的事件作者序列、游标和能力协商；N-1 不阻塞共同 streams。
- 新流沿用已批准 PM-046 的有界事件/请求、durable pending、连续已确认游标、退避重试与冲突冻结原则。拒绝/冲突事件不能通过裸游标删除 outbox。
- Tombstoned 资产隐藏可见评分投影但保留合法事件和冲突历史；恢复后从历史重建。禁止依墙钟决定并发值优先级。

## 兼容、迁移与回滚

- 只追加 `0010_asset_ratings`，不重写 `0001`–`0009`。生产升级尚未授权。
- N-1 节点不协商或拨号新评分 stream；评分 outbox 留存并退避，旧共同同步协议继续工作。
- 实现失败时可在隔离 DB 回滚/重建；不得删除用户原图或对生产库执行迁移。若将来引入真实人类身份，必须另行设计按人迁移及授权方案，不把图库共享评分当作个人数据。

## 验收测试

- 值域/null、幂等重试/复用冲突、masked 404、读授权、默认拒绝/授权/撤权及已接受 pending 恢复。
- 双节点并发离线写入、同值并发、不同值冲突、显式解决、乱序/重复/断线重启；未观察事件不能被解决写入吞并。
- 只读/写 ACL 隔离、跨库 IDOR、签名/因果/序列冲突、超限不截断、游标 ACK 连续性与拒绝重试。
- N-1 不阻塞共享 streams；迁移在旧数据/旧全局 UUID 存在时可升级；备份失败无变更；重启后评分、候选与 outbox 可恢复。
- 契约、lint、typecheck、coverage、build 与双节点 Compose sync 测试；不修改原图。
