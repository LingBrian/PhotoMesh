# ADR-002：签名事件日志与双节点最终一致性

- **状态：已批准，实施中**
- **日期：** 2026-10-21
- **相关决策：** ADR-001（已批准的节点身份和图库 ACL）、ADR-006（事件/协议版本协商）
- **对应阶段：** M2-B

## 背景

M2-A 已建立 Ed25519/libp2p 节点身份、Noise 加密通道和逐图库只读授权。当前仅能读取单个节点索引，尚无可持久恢复、可审计、可反熵修复的同步事件协议。各节点必须独立持有 SQLite 数据库和原图；同步只传输已授权的元数据事件，不默认传输原图字节。

本提案满足：断网、重复、乱序、进程重启和 N/N-1 版本条件下不静默丢事件；跨节点壁钟时间不能决定冲突胜负；删除标记不能触发原图删除。

## 决策提案

### 1. 签名 EventEnvelope

每条事件包含以下不可变字段：

```json
{
  "eventId": "UUID",
  "libraryId": "library id",
  "protocolVersion": 1,
  "schemaVersion": 1,
  "authorPeerId": "libp2p peer id",
  "authorSequence": 42,
  "causalParents": ["parent event UUID"],
  "eventType": "asset.indexed | asset.metadata.updated | asset.tombstoned | asset.restored",
  "payload": {},
  "createdAt": "RFC 3339 informational timestamp",
  "signature": "base64url Ed25519 signature"
}
```

- 签名身份使用 ADR-001 的 Ed25519 私钥，调用现有 `@libp2p/crypto` key API；不创建第二套节点密钥。
- 签名输入为域分离前缀 `PhotoMesh.EventEnvelope.v1\n` 加 RFC 8785 JSON Canonicalization Scheme 编码的 `signature` 字段之外的 envelope。重复字段、非规范数值、超限 payload 一律拒绝。验证密钥必须来自当前仍可信的 Peer ID 记录，Peer ID、公钥和签名均须匹配。
- `authorSequence` 在 `(libraryId, authorPeerId)` 范围单调递增，并由 SQLite 事务分配；唯一约束阻止同作者同序号的两种事件。不得用 `createdAt` 或其他壁钟字段排序或解决冲突。
- 每条事件至少引用作者在该图库上的前一事件；同时引用创建该操作所依赖的已知因果前沿。父事件集合排序、去重并限制数量；缺失父事件的 inbox 记录保持待应用状态。
- 不认识的 `schemaVersion` 或 `eventType` 可以作为不透明字节安全保留并报告不兼容，但不得应用、转发为已确认或静默丢弃。

### 2. Outbox、inbox 和幂等应用

- 新增只追加的 `sync_event_log`、`sync_outbox`、`sync_inbox`、`sync_peer_cursors`、`sync_author_heads`、`sync_conflicts` 表；不改写 M0/M1 已发布迁移。新增 `0003_sync_event_log` 仅做加表、索引和约束。
- 本地业务写入、未签名事件草稿和作者序号预留在同一 SQLite 事务提交；Ed25519 签名在事务外调用系统密钥存储，签名完成后再用事务标记事件 ready 并写入 outbox。签名中断时草稿保留、作者游标不前移，启动后使用本地密钥恢复签名；上传接口在签名完成前返回失败，客户端重试可安全补齐。M2 接入上传完成和外部扫描索引变更；业务事务失败时源记录和草稿一并回滚。
- 从 M1 升级的本地资产会在身份可用后按资产逐条幂等重放 `asset.indexed`，不改变旧文件记录或原图内容；事件只携带必要索引字段，不包含来源路径。
- Outbox 按目标 Peer 持久化待确认事件，发送采用有限退避。接收方在单事务内验证信任/图库 ACL/签名/版本，按 `eventId` 去重写入 inbox，再应用满足因果条件的事件并更新作者前沿和确认游标。重复事件返回原确认结果；相同作者序号对应不同事件视为协议冲突并隔离。
- 事件历史在本阶段不做自动清理；由历史日志支持离线节点恢复和反熵。撤销设备会停止该设备的后续传输，但不删除日志、原图或其他来源记录。

### 3. 双主、因果冲突与 tombstone

- 同一作者按 `authorSequence` 串行；跨作者的因果关系由 `causalParents` 判断。互不为祖先的操作视为并发，不使用事件时间戳仲裁。
- 标签集合以元素级 add/remove 操作合并；单值元数据采用多值寄存器：保留并显示并发候选，投影到单值 UI 时用 `(authorPeerId, eventId)` 字典序作仅为显示的确定性选择，同时保留冲突记录。后续显式解决事件必须因果引用所有冲突候选。
- `asset.tombstoned` 是图库/资产索引范围内的逻辑删除墓碑。墓碑优先于与之并发的普通更新；恢复必须是明确的 `asset.restored` 事件，并因果引用墓碑。历史事件不被物理删除。
- 墓碑只改变同步索引/materialized state，不调用托管对象或外部目录文件删除接口；本地释放空间、删除全局原图和清理外部文件不属于本 ADR。

### 4. 授权过滤、游标与反熵

- 发送端和接收端都依据已认证 Peer ID 的当前图库只读授权过滤事件；无授权或已撤销身份默认拒绝。路径、凭据和原图内容不进入默认事件 payload。
- Hello 协商成功后交换每个授权图库、每个作者的连续序号游标及缺口摘要。双方从对方缺失序号请求有界事件批次；再交换游标摘要可重复对账。游标只在 inbox 事务成功后前移，存在因果缺口时不得越过未应用序号确认。
- 重连时运行反熵对账；mDNS 仅用于发现，不作为信任或权限依据。无需中心数据库、账号服务、Redis 或公网服务器。

### 5. 协议兼容（ADR-006 提案）

- Hello 携带 `protocolMin`、`protocolMax`、支持的 `schemaVersions`、功能能力及游标摘要。双方取共同协议版本；无交集时拒绝同步并保留本地 outbox，不降级为未签名消息。
- 首个事件协议/Schema 为版本 1。模拟的 N-1 节点支持版本 1 但不支持新增可选事件能力；双方以共同能力子集同步。未知事件必须保留并标记不可应用。对不支持的必需事件类型，协商/传输返回结构化不兼容错误，不能推进该库游标。
- 数据库变更仅新增 0003 表；M1 的 `assets`、`asset_files`、`file_locations`、`jobs`、`events` 和 0001/0002 checksums 保持不变。旧二进制可忽略新表，但不得在新同步启用期间用旧二进制回写/删除新协议状态。迁移前按仓库规则备份非空生产数据库；此实现只在测试隔离数据库迁移，不触碰用户数据。

### 6. 双节点集成环境

- 增加仅用于测试的 Docker Compose 环境：`windows-sim` 与 `nas-sim` 各运行独立 Node agent、独立 SQLite 和独立原图卷；模拟 NTFS 大小写规则与 Linux/NAS 文件规则。该 Windows 模拟容器表达 Windows 路径/大小写语义，不冒充真实 Windows 内核测试。
- 两节点通过 Compose 私有网络直连；无中心数据库、协调服务、强制公网依赖。测试脚本可断开/恢复网络、停止/重启单节点，并在重启后读取各自卷验证 outbox/inbox/游标恢复。
- 集成矩阵至少覆盖：重复投递、乱序/缺失父事件、作者序号冲突、双主并发元数据与标签变更、墓碑/恢复、图库 ACL 拒绝、撤销、断网补偿、任一节点重启、N/N-1 共通协议及无版本交集拒绝、两份原图仍独立且 SHA-256 未改变。

## 兼容性与迁移

- **向前：** 支持版本 1 的新节点可读取并忽略未知可选能力；未知必需事件保留但不应用，阻止对应游标确认。
- **向后：** 当前 M1/M2-A 节点不实现同步协议，连接后不能协商同步；它们保留自身既有表和原图，不因新表存在而重写旧数据。新同步节点不把协议事件投递给未通过兼容协商的旧节点。
- **数据库：** 只追加迁移 0003，不修改既有 migration checksum；无自动 downgrade。回滚应用版本时，先停止同步并恢复迁移前数据库备份，不允许旧版本在新事件状态上写入。
- **数据：** M1 现有资产不会凭空改写或上传原图；开启同步后按既有索引生成幂等 `asset.indexed` 初始事件。初始重放按图库 ACL 分批进行。

## 风险和缓解

- 事件保留会增长 SQLite：M2 不做自动压缩/清理，单独计量数据库增长；达到容量阈值停止接受新同步事件并报告，不删历史。
- 乱序与缺父事件会占用 inbox：限制单帧、批大小、每库待处理字节/数量并提供重试/告警；不越过缺口确认。
- 并发值展示结果可能与用户直觉不同：保留冲突候选和显式解决事件，时间戳只用于显示。
- 账号撤销和 ACL 变更可能与网络断开同时发生：发送和应用均检查当前授权；恢复连接后重新协商授权，撤权后不补发权限外事件。
- Docker 模拟不替代 Windows/macOS/NAS 实机、Secret Service 和文件系统行为验收。

## 实施与验收计划

1. 批准本 ADR 与 ADR-006 兼容策略后，在 `feature/m2-event-sync` worktree 按 TDD 实施。
2. 实现事件 canonicalization/sign/verify、SQLite 0003 迁移、事务化 outbox/inbox/去重/因果等待/墓碑/冲突投影、授权同步协议与反熵游标。
3. 将上传和外部扫描索引提交连接到本地事件事务；保持外部源只读，墓碑路径不得触达文件删除实现。
4. 实现 Docker Compose 双节点 fixtures 和断网/重启/N-1 故障脚本。
5. 运行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm contracts:check`、`pnpm build` 及仓库实际存在的 Compose 集成命令；新代码覆盖率门槛严格大于 80%。

## 已批准的具体决定

1. Ed25519 签名覆盖 RFC 8785 JCS 的 envelope（排除 signature 字段），并采用 RFC 8785 兼容 canonicalizer。
2. 元数据并发采用保留冲突的多值寄存器；仅展示投影用作者 Peer ID 与 eventId 字典序，不用壁钟时间。
3. 墓碑优先于并发普通更新；恢复必须显式引用墓碑；墓碑永不删除原图。
4. N/N-1 仅对有共同协议版本/能力的消息同步；不支持的必需事件阻止游标推进并保留数据。
5. 按上述只追加 0003 迁移和双独立卷 Docker Compose 模拟实施。

## 参考

- RFC 8785，JSON Canonicalization Scheme：<https://www.rfc-editor.org/rfc/rfc8785>
- 现有密钥体系：`@libp2p/crypto` 与 `@libp2p/peer-id`（ADR-001）。
