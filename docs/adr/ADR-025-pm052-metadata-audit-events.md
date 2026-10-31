# ADR-025：PM-052 关键元数据变更审计事件

- **状态：** 用户已于 2026-10-30 批准推荐范围与迁移方案；本地实现与验证已完成，限于隔离 worktree/分支。此批准不授权生产迁移、push、merge、release 或部署。
- **日期：** 2026-10-30
- **路线图：** PM-052（actor/request/time 可追踪；不记录 token、路径或相片明文）。
- **依赖：** PM-041/043 标签写入；PM-044/045 虚拟相册；PM-046 收藏；PM-047 评分；PM-051 Web 单项批量调用。

## 背景

架构文档提出概念 `audit_logs(actor, action, resource, outcome, request_id, created_at)`，但现有 `events` 与各 P2P 同步事件日志不是 HTTP 审计记录：它们不关联本地请求 ID 或当前认证主体。Node 已有请求 ID，但目前可直接采用调用方 `X-Request-ID`；当前授权主体为 `local-admin`，不能据此声称识别了具体人或设备。

## 决策（用户已批准）

1. **本地审计表与字段。** 追加迁移 `0013_metadata_audit_events`，不改写历史迁移。字段为递增记录 ID、固定 actor、action、resource type、domain-separated SHA-256 library/resource ID digests（album-member 记录 asset 与 album 的独立 digest）、删除/恢复的 `local/global` scope、outcome、validated request ID、Node 生成的 UTC 时间；只建关联查询所需索引。只提供事务内写入/测试直接查 DB，不新增 HTTP 读取 API、UI、导出或 P2P 同步。
2. **审计范围。** 记录经认证且通过图库授权的本地写请求：单项标签添加/移除、收藏设定、评分设定/清除，以及虚拟相册创建、成员添加/移除、删除/恢复（现有 API 无相册改名端点）。PM-051 批量操作按逐资产 HTTP 请求形成多条记录。不记录读取、预览/下载、入站 P2P 投影事件或配对信任/授权 grant 等控制面变更；这些需另行批准。
3. **actor 与 outcome。** `actor='local-admin'` 只表示当前认证主体类别，不识别人名、设备或 peer。仅对被授权且成功提交的写请求记录 `applied`、`unchanged` 或幂等重放 `replayed`；不记录未认证、授权拒绝、验证失败、业务失败或未提交的服务端错误。在上述批准范围内，每个已授权且成功提交的写请求各记一条审计记录，不含业务值或 HTTP 错误正文。
4. **事务与失败闭锁。** 每条业务变更与其审计行必须在同一 SQLite 写事务中提交；审计插入失败时业务变更必须回滚/不生效。不能在业务提交后才做 best-effort 日志。需在实际 repository/service 事务边界证明此保证；可按需重构入口，但不得弱化原有 outbox/同步原子性。
5. **请求 ID 规则。** 只接受恰好一个原始 `X-Request-ID` header，且值完整匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（1–64 ASCII 字符，不 trim、不接受空白、逗号或 CR/LF）。通过 `rawHeaders` 识别重复字段；缺失、无效或重复时忽略来值并生成 Node UUID，继续处理请求。选定的唯一 ID 必须在响应头与审计行一致；不回显或存储被忽略的原始值。它仅作关联字段，不作为 actor 或授权凭证。
6. **隐私、完整性与保留。** 不存 token、其他请求头/请求体、路径、文件名、标签/评分/收藏值、照片字节或媒体明文。库/资源标识按字段做 domain-separated SHA-256 digest 后入库，支持稳定关联但不保留原始路径样式；album-member 对 asset 与关联 album 分别摘要。digest 仍可被比对/猜测，故表仅本地保存，不提供网络查询/导出。无限期保留且不自动删除；明确接受本地数据库无界增长，后续保留/清理策略需另行批准。所谓“append-only”仅是应用层不提供更新/删除路径；不抵抗可直接修改 SQLite 文件的本机管理员，不承诺防篡改、签名链或防篡改证据。
7. **兼容与恢复。** 迁移为 append-only 0013；迁移前必须有可验证备份，并测试失败原子性与重启持久化。不提供破坏性“降级迁移”；旧版遇到未知 schema version 按现有策略拒绝启动，回滚依赖恢复迁移前备份。此 ADR 不授权在生产图库执行迁移。

## 批准记录

用户已明确批准上述推荐默认值用于隔离 worktree 内的本地实现，包括：

- 仅覆盖已列出的标签、收藏、评分、虚拟相册写入；排除配对/授权 grant、未认证/拒绝/验证失败/业务失败请求及入站 P2P 投影。
- `local-admin` 仅代表认证主体类别；严格 request ID 校验，缺失/非法/重复时生成 UUID；响应头与审计行复用唯一选定 ID。
- 仅本地保存 domain-separated SHA-256 resource-ID digests，不提供网络读取/导出；无限期保留、无自动清理；应用层 append-only 不提供防篡改保证。
- 审计插入失败时必须回滚同一事务内的业务变更；追加 `0013` 并在迁移前备份，旧版本拒绝未知 schema，回滚依赖恢复迁移前备份。

该批准限于本地源码实现、测试与隔离分支提交；不授权针对生产图库/数据执行迁移，不授权 push、merge、release 或部署。

## 验收结果（2026-10-30）

- `0013` 追加迁移、旧 checksum 不变、迁移前备份成功/失败闭锁、文件型 DB 关闭重开持久性均有测试覆盖。
- request ID 校验覆盖 1/64 边界、缺失/非法/重复 raw headers；真实 HTTP 重复头验证响应头与错误体使用同一个新 UUID。收藏/评分/标签/虚拟相册路由控制器测试确认 request ID 传播。
- 标签、收藏、评分、虚拟相册创建/成员/本地及全局删除恢复覆盖 `applied/unchanged/replayed`，并区分本地/全局 scope；插入审计失败时分别验证业务表、同步事件草稿与生命周期写入回滚。protocol-valid 路径样式 ID 仅存 domain-separated digest；schema 白名单无请求正文、路径、文件名或媒体数据列。
- Node Agent 全量：40 个测试文件、357 项通过；行覆盖 90.53%、分支覆盖 81.37%。根级 `install --frozen-lockfile`、lint、typecheck、test、contracts:check、build 均通过；未更改 P2P wire protocol，不需要额外双节点迁移测试。

**实施边界：** 本地迁移代码、审计存储与 request-ID 校验已获批准；实际生产数据库迁移、push、merge、release 或 deploy 始终需要各自单独的明确授权。
