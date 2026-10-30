# 架构决策记录（ADR）与剩余缺口

> 前 30 题足以生成完整可执行设计，无须再反复提问。以下按照“默认建议→需要验证的条件→失败时替代方案”推进，所有条目均为**设计建议，未经安全或性能验证之前不能当作既成事实**。

## ADR-001：去中心化身份及信任恢复

- **状态：** 2026-10-21 用户批准本地身份、短期二维码邀请、双向身份验证、独立图库 ACL、设备撤销和失败关闭密钥存储方案。
- **本次实现决定：** 每个 Node 节点生成 Ed25519 libp2p Peer ID；私钥由 Windows Credential Manager 或 Linux Secret Service 保存，Linux Secret Service 不可用时配对功能关闭，不回退到明文文件/数据库。SQLite 只保存公钥、Peer ID、邀请摘要、可信状态和图库只读授权。
- **传输：** js-libp2p TCP + Noise XX + Yamux；mDNS 只提供不可信地址提示，手动 IP 与二维码地址均限定为明确私有 LAN/回环地址，连接仍须验证二维码中的 Peer ID。
- **邀请：** 32 字节随机秘密仅在二维码载荷中出现；数据库保存 SHA-256 摘要；有效期 2 分钟，SQLite 事务原子消费。兑换前需本地管理员逐设备批准。首次配对不默认授予图库访问；批准时可逐库授予只读权限。
- **撤销：** 撤销状态持久化、关闭当前 P2P 连接，并在每次索引读取时校验可信状态和图库授权。已撤销 Peer ID 不可直接重新信任，应先更换节点身份密钥。
- **原因：** 不依赖公有账号服务器；协议身份验证与人类确认分离；短期邀请不能单独替代 Noise 对端身份；图库授权独立于设备配对。
- **仍需验证：** Windows 与不同 Linux Secret Service 的锁屏/真实故障行为；mDNS 在 VLAN、无线客户端隔离和 Docker 网络下的可用性；密钥备份/恢复和撤销传播策略。
- **PM-037验证记录：** Windows 当前用户的 Credential Manager 已通过跨 Node 进程写入/读取/删除 smoke test，未打印秘密值。锁屏/解锁选项已提供但本次未执行；不可用/权限拒绝由注入测试覆盖，真实 OS 故障注入仍是发布前人工验证项。
- **必须验证：** 丢失唯一管理员设备时的安全恢复、设备盗失、管理员换机、密钥泄露及撤销传播延迟。
- **边界：** E2EE 主密钥完全丢失时，不能承诺无密钥恢复原始加密内容。

## ADR-002：P2P 事件最终一致性

- **选择建议：** 每库授权范围内签名事件日志，outbox/inbox、幂等投递、因果元数据、墓碑、范围对账；不复制完整原图。
- **必须验证：** 双主节点离线并发添加/删除、权限撤销重联、协议 N/N-1。
- **边界：** 网络分区期间只能保证最终收敛，不保证即时一致；跨设备事件永久不丢失需要日志保留策略。

## ADR-003：安全存储与加密

- **选择建议：** 原图不可变；传输认证加密；普通图库 E2EE 可选、密码图库独立密钥和密钥世代；避免跨安全域明文哈希去重泄漏。
- **必须验证：** 分享、失去设备、密钥轮换、AI worker 访问权限及插件安全边界。
- **边界：** 离线已授权设备持有旧密钥与已缓存数据无法瞬间抹除；密钥遗失会导致恢复受限。

## ADR-004：数据库支持 SQLite/PostgreSQL

- **选择建议：** SQLite 默认，以 Repository 接口隔离方言；PG 作为可选部署，提供有验证的离线迁移工具。
- **必须验证：** SQLite/PG 对事件顺序、索引和事务一致性的实现等价；2GB NAS 读写资源限额。
- **边界：** 不做运行时任意“热切换”承诺。

## ADR-005：互联网连接与无中心服务

- **选择建议：** LAN mDNS + 手动配对首发；外网可自行配置 VPN、域名；自动 ICE/STUN/中继后续可选。
- **必须验证：** NAT 组合与 TLS 证书轮换、网络变化恢复。
- **边界：** 完全无公网服务器不等于所有远距离 CGNAT 组合都能自动直连。

## ADR-006：多版本协商与安全降级

- **选择建议：** 独立 `protocolVersion` 范围、`schemaVersion` 与 app SemVer；相邻次版本协议至少在功能降级模式下互通；不识别事件保留或拒绝，不能静默误用。
- **必须验证：** 库迁移和恢复后同一内容 SHA-256 不变；N-1 节点升级顺序。
- **边界：** 不可逆 DB/密钥迁移不得运行旧程序直接读写，需要恢复快照或安全前向修复。

## ADR-007：首版安全最小闭环

- **选择建议：** 先完成 Windows/NAS/Android LAN，两主节点 P2P、自动备份、原图 SHA-256、安全删除和恢复；全部高级 AI、插件商城、所有互联网 NAT 组合后续上线。
- **必须验证：** 全量用户故事、2GB NAS、100k 文件同步，独立审查前不得正式发布。

## ADR-008：插件与 MCP 沙箱

- **选择建议：** SDK/OpenAPI 首发规范；P2 独立 plugin-host 进程及最小授权；高风险删除/公开分享等需要人类批准。
- **必须验证：** 插件无权读取密钥、密码相册或跨用户资源；插件更新失败不影响主服务。

## 决策优先级及评审对象

| 优先级 | 决策 | 最晚确认点 |
| --- | --- | --- |
| Blocking | 001 身份根、撤销和恢复 | M2 实现前安全设计审查 |
| Blocking | 002 事件结构/幂等/墓碑 | M2 开始前契约冻结 |
| Blocking | 003 原图不可变、密钥边界 | M1 基础导入前，E2EE 细节 M6 前 |
| Blocking | 006 迁移/协商格式 | M2 事件版本控制前 |
| Non-blocking | 004 PostgreSQL Adapter | M6 之前 |
| Non-blocking | 005 高级外网直连 | M6 之前 |
| Non-blocking | 008 插件隔离 | M7 之前 |

## 明确不在首版承诺的事项

- 任意两个 NAT 后的设备在没有 VPN/中继条件下必然直连。
- 低配 2GB NAS 同时执行全部 AI、8K 转码和百万图库即时重索引。
- 严格零知识加密时，未获授权的服务器也能运行照片内容 AI。
- 版本库不可逆迁移之后，随意降级软件仍可无损直接打开该数据库。
- 所有平台的后台自动上传均能在锁屏任意时刻立即执行。

**最终处理建议：** 保留上述 ADR 作为仓库公开决策日志；先落地默认方案，触发重大安全/兼容变更时在 PR 中更新 ADR 并要求人工批准。

## ADR-009：Web 时间线授权缩略图接口（实施决策，资源基准待验证）

- **状态：** 用户已批准实施方向，以下是本次实现的保守资源上限；2GB NAS 的实测峰值仍待基准验证。本项不表示已证明所有图库下都满足内存预算。
- **背景：** 当前只有授权时间线元数据和 `/v1/assets/{assetId}/original` 原图读取接口；Web 没有可安全填充缩略图网格的专用能力。不能让网格静默批量读取或向浏览器传输原图来伪造缩略图。
- **建议接口：** 新增可选的 `GET /v1/libraries/{libraryId}/assets/{assetId}/thumbnail?profile=timeline-192`。认证仅使用 Authorization header；不得把访问令牌放在 URL。该接口只返回 `image/webp` 派生内容，不返回原图字节。
- **授权与隐私：** 每个请求在任何服务端缓存查找前执行真实图库 ACL；缺失资产与未授权返回不可区分的 404。ACL 撤销后，后续请求必须拒绝。响应采用 `Cache-Control: private, no-store` 与 `X-Content-Type-Options: nosniff`。客户端已收到的内存缩略图无法被远程瞬时撤回；关闭会话/切换图库/对象 URL 淘汰时清理，不把网格请求结果写入 IndexedDB。
- **派生与资源边界：** 仅接受静态 JPEG/PNG/WebP；先以元数据拒绝超过 **16 MiB** 的源文件，再对实际读取流逐块计数、超限即销毁流，并校验完整 SHA-256。sharp 解码上限 **12,000,000 像素**，固定 `timeline-192` profile（边长不超过 **192 px**、不放大、自动应用方向），输出固定 WebP 且不保留 EXIF/GPS，编码结果最多 **256 KiB**；动画、多页、HEIC/AVIF 首版拒绝。单次缩略图任务（含源文件打开、完整流读取/哈希及图像处理）最多 **10 秒**；超时取消源读取与 Sharp pipeline、销毁活动流并释放 worker。Node 同时处理 **1** 项、最多排队 **8** 项，队列满返回 **429** 和 `Retry-After: 1`。这些限制高于缓存策略：任何缓存命中也必须先授权并用当前库/资产/源 SHA-256/profile/转换器版本确定键。
- **缓存与 2GB 约束：** Node 使用仅驻留进程内的 LRU，最多 **8 MiB / 128 项**；不写原图存储、不增加磁盘缓存或 DB Schema。Web 仅保留最多 **8 MiB / 128 个** 活跃对象 URL；自动获取的网格缩略图仅在当前会话内存驻留。PM-036 在授权失败、登出、切换节点或图库时清除令牌和内存对象 URL，并中止会话请求；已有“用户明确打开预览后”生成并缓存的 IndexedDB 预览仍按本 ADR 保留，且不得包含访问凭据，可由用户通过清理缓存操作移除。sharp 全局并发保持 1、现有 libvips cache 为 64 MiB；12 MP RGBA 解码缓冲约 48 MiB，连同最多 16 MiB 源缓冲、sharp cache 和单任务限制是设计预算而非进程 RSS 上限，必须在 2GB NAS 基准测试中验证。
- **离线语义：** 若节点当前无源文件，仅当 ACL 已通过且本进程 LRU 中存在与当前源 SHA-256 匹配的派生物时才返回缩略图；缓存未命中返回 `409 source_offline`。绝不回退读取原图给浏览器。
- **兼容性与迁移：** 这是 `/v1` 内向后兼容的可选新增能力；旧客户端继续显示占位图，新客户端只有在 `/v1/health` 宣告 `thumbnails` 能力时才请求。先更新 OpenAPI 并验证合同，再实现 Node 路由与 Web；不增加数据库 Schema、迁移或新的第三方依赖。TS SDK 目录目前没有生成器/源码，本切片不宣称生成 SDK。
- **验收测试：** 覆盖每次请求与缓存命中的 ACL、跨图库隔离、撤权后拒绝、源 SHA 变化失效、离线缓存命中/未命中、哈希不匹配、流与解码像素超限、动画/不支持格式、输出字节上限、超时/并发队列、原图哈希不变，以及 Web 时间线只请求派生路由而不请求原图。还需验证 N/N-1 客户端对可选能力的降级。
- **实现门槛：** 用户已批准上述方向。具体阈值先按本 ADR 执行；由于缺少 2GB NAS 实测，本实现不得宣称已通过该硬件验收，性能基准和阈值调整作为后续验收项。

## ADR-010：Windows 桌面远端 HTTPS 节点连接

- **状态：** 用户已选择同时支持本机连接与远端 HTTPS 连接；不得将本机明文 HTTP 策略扩展到远端。
- **范围：** Tauri 桌面可使用本机回环 HTTP 或用户明确输入的 HTTPS 节点源；远端 HTTP、嵌入式用户名/密码、URL 路径/查询/片段均拒绝。远端地址变更后必须重新确认信任，再发送当前页面会话内的管理员令牌。
- **TLS 与凭据：** WebView 使用操作系统证书信任，不提供忽略证书错误/自签名绕过；管理员令牌仅发送给用户输入并确认的源，保存在页面内存，不写入 localStorage、日志或 telemetry。UI 明示令牌接收目标和远端风险。
- **CSP/CORS：** Desktop CSP 允许 `https:` API 源，但不开放通用明文 HTTP；Node Agent 默认 CORS 精确支持平台 Tauri 本地源（Windows 生产 `http://tauri.localhost` 仅默认端口、Unix `tauri://localhost`）和 loopback 开发源。其他浏览器 Web 源仍需显式配置为精确 HTTPS origin。CORS 不是授权边界；所有受保护读取继续执行 bearer-token 与后端 ACL 校验。
- **部署边界：** Node Agent 的 HTTP 监听默认保持 loopback；需要远端访问时应使用受控 HTTPS 反向代理（可额外经 VPN 暴露网络可达性），不能将明文管理 API 公开到不可信互联网。无需改变 API/schema/P2P 协议或数据库。
- **验证与回滚：** 覆盖 HTTPS 成功、远端 HTTP 拒绝、未确认目标不发请求、恶意/非默认端口 CORS 来源拒绝及本机回环连接；若证书、CORS 或 CSP 验证失败，可回滚桌面 HTTPS 开放而保留本机修复。远端硬件/TLS 代理未提供时不得宣称真实远端节点验收通过。

## ADR-011：Windows Node Agent 用户级生命周期

- **状态：** PM-034 先采用显式用户级前台生命周期；不引入后台 Windows 服务、登录自启、计划任务、防火墙规则或远端监听。Desktop 与 Node Agent 仍为独立安装单元。
- **启动/停止：** 用户显式运行安装器或版本目录中的 `start.bat`；Agent 在可见前台窗口运行，默认只绑定 `127.0.0.1:8443`，按 `Ctrl+C` 停止。启动前检查同一 Node Agent 安装根下的运行时进程，避免重复实例/端口冲突。管理员令牌的生成、确认、重启输入、轮换和恢复遵循 PM-035 / ADR-012；令牌不由 PM-034 写入普通文件、命令行或日志。
- **安装/升级：** 以 SemVer 版本目录并排安装；下载包先校验 SHA-256，再对 ZIP 路径、扩展大小/条目数、重复/非法条目及链接属性做校验，解压到 install-root 下新建 `.stage-*`，检查所需文件和包版本后原子移动到版本目录。拒绝覆盖已安装版本；升级保留旧版本供手动回滚。若检测到旧版仍运行，安装新版本但不启动第二个监听实例。
- **卸载/数据保留：** `uninstall.bat`/`uninstall.ps1` 只删除用户确认的一个版本目录；新版本脚本可用 `-Version <version>` 明确选择旧版。若该版本的打包 `runtime\node.exe` 仍在运行则拒绝卸载，提示在前台按 `Ctrl+C`。目标必须是 `%LOCALAPPDATA%\Programs\PhotoMesh\NodeAgent` 的版本子目录；安装链/待删树遇到 reparse point 则失败关闭，并校验 Node Agent 包名与 `package.json` 版本和目录版本一致（兼容旧包）。始终保留 `%LOCALAPPDATA%\PhotoMesh\data`、外部照片路径与防火墙状态；用户外部保存的管理员令牌由用户自行管理，卸载器不访问或删除；不清理其他版本。
- **依赖与边界：** 登录自启/服务式优雅停止需要可靠的停止通道和 Windows Credential Manager 方案，留给 PM-037；不得将管理员令牌持久化到普通配置/环境文件。此 ADR 不改变 Node API、数据库、schema 或 P2P 协议。
- **验证：** Windows CI 对恶意 ZIP 路径/链接、阶段目录、进程身份、重复版本、失败升级回滚、`-WhatIf`、显式确认与数据留存运行 hermetic 测试；该测试不替代干净 Windows 用户账户下的真实安装/重启/卸载 E2E，未完成前不得宣称 PM-034 全部验收。

## ADR-012：Windows Node Agent 管理员令牌生命周期（PM-035）

- **状态：** PM-035 实施决策；仅限用户显式启动的 Windows 前台 Agent。不增加后台服务、远端重置接口、数据库状态或跨平台 token vault。
- **格式与生成：** 令牌由 Windows CSPRNG 生成 32 字节，并以规范 Base64 表示。启动器只接受可解码为 32 字节的规范令牌；不符合格式时提示用户显式轮换，避免静默降级到弱口令。
- **首次设置与展示：** Agent 不知道令牌是否已存在，因为它不持久化该秘密。用户在普通启动中留空后必须键入 `ROTATE`，或用 `start.bat -RotateAdminToken` 并确认；生成的新令牌在本地前台输出一次，要求用户键入 `SAVED` 后才启动。用户自行把令牌保存到密码管理器；PhotoMesh 不保存、恢复或记录其明文。
- **重启与恢复：** 普通重启要求用户在 SecureString 提示中输入同一令牌，保持服务端授权在重启后有效；空输入不会自动换令牌。若令牌遗失，用户先按 `Ctrl+C` 停止 Agent，再从该用户的版本目录显式轮换；新进程只接受新令牌，旧令牌失效，客户端需重新连接。恢复权限属于拥有本机用户账户并能运行该 Agent 的主体，不提供远程绕过。
- **秘密边界：** 不把令牌放入命令行、磁盘配置、日志、Git 或 telemetry。启动器忽略并警告任何继承的 `PHOTOMESH_ADMIN_TOKEN`，随后仅把交互输入的令牌暂存于 PowerShell/Node 进程环境内存；`start.bat` 只允许无参数或固定 `-RotateAdminToken` 开关，不转发任意参数。同一用户的本机进程可能访问运行中进程环境；用户自行开启终端 transcript/输出重定向可捕获一次性展示内容，应只在可信本机控制台操作。
- **兼容性：** 不改 HTTP API、OpenAPI、数据库 schema 或 P2P 密钥格式；环境变量接口保持不变。PM-037 处理节点身份密钥的 Credential Manager 生命周期，本 ADR 不把管理员令牌存入该 vault。
- **验证：** 自动测试覆盖规范 Base64/32-byte 生成、SecureString 转换后清除 BSTR、弱/非规范令牌拒绝、轮换确认失败关闭、保存确认门、重启同 token 与轮换后旧 token 拒绝，并检查启动脚本语法/固定开关。首次设置/重启/轮换的干净 Windows 用户交互 E2E，以及 transcript/输出重定向边界，仍须实机验证。

## ADR-013：Node 组件健康与就绪诊断（PM-038）

- **状态：** 用户已批准新增受保护诊断接口；保留现有公开 `/v1/health` 行为和结构。
- **接口：** 新增 `GET /v1/diagnostics`，复用本机管理员 Bearer 授权。响应分开列出 API、数据库、存储和身份组件的固定状态及枚举能力，并设置 `Cache-Control: no-store`。旧客户端无需升级。
- **探针与就绪语义：** API 状态仅表示诊断路由可响应；数据库用无用户数据的 `SELECT 1` 检查；存储检查数据目录读写访问；身份能力取自已加载的节点身份、事件签名与 LAN 配对状态。API/DB/存储是核心就绪条件；身份能力缺失或部分可用时整体降级，但不阻断图库 API。
- **隐私边界：** 不返回异常详情、绝对路径、Peer ID、记录数、文件名、原图信息或任何密钥；仅允许 OpenAPI 枚举状态/能力，未知能力被丢弃，响应不缓存。未授权请求在运行探针前即拒绝。
- **兼容性与数据影响：** 仅为 `/v1` 增加可选接口与 schema；不修改现有 `/v1/health`、P2P 协议或数据库 schema，无迁移。旧客户端不受影响。
- **验证限制：** `SELECT 1` 不等同于 SQLite 完整性检查；目录访问检查不写入文件，不能发现磁盘已满等写入故障。该接口是低开销状态提示，不替代维护诊断、DB integrity 或实际存储写入测试。

## ADR-014：PM-040 已实现 Node HTTP API 契约对齐

- **状态：** 用户已批准实施；只描述当前 Node Agent HTTP 服务已实现的行为，不新增 HTTP 能力，也不修改服务端运行时路由、授权判定、状态码、错误体或数据格式。
- **契约范围：** OpenAPI 作为已实现 Node HTTP API 的唯一契约来源。移除尚无 HTTP 路由实现的 `/v1/sync/hello`；P2P 版本协商仍经已认证的内部 libp2p 通道，不伪装成 REST 接口。架构文档把其余未实现的规划接口标为规划项。
- **错误与兼容：** 用开放式 `{ error: string, requestId: string }` 描述实际 JSON 错误体，允许将来出现未知错误码/附加字段；逐路由记录当前真实 HTTP 状态码，不把当前只返回 403 的授权拒绝改写成 401，也保留用于避免资源枚举的 404。此工作不改变旧客户端实际观察到的行为；删除的 OpenAPI 路由当前服务本来就返回 404，仓库 Web 客户端未调用它。外部生成 SDK 如曾依草案生成该未实现方法，需要重新生成契约客户端。
- **授权与响应头：** 文档化当前启动配置下的 Node 管理员 Bearer 授权、公开 health 例外、错误中的 requestId，以及实际存在的 `X-Request-ID`、ETag、Cache-Control、Content-Disposition、X-Content-Type-Options、Retry-After 等逐响应头；不声明未实现的头或能力。
- **迁移与回滚：** 不修改数据库、P2P wire protocol 或 HTTP runtime，无数据迁移、生产数据影响或服务端升级步骤。可通过回退 OpenAPI、契约测试和本文档恢复原草案；已生成的外部客户端按契约重生成即可。
- **传输安全限制：** Node Agent 使用 `node:http`，进程本身不终止 TLS；默认 API 绑定 loopback。虽然配置允许指定私有 LAN 地址，但绑定私网不提供加密。PM-040 不改变此行为，也不把明文远端连接称为安全通过；远端须经独立可信 HTTPS 终止代理。PM-033 的远端 HTTPS 实机验收仍需单独核验。
- **验证：** OpenAPI schema 验证；以实际 `createNodeAgentServer` 发送请求、逐一覆盖契约列出的 HTTP 操作及代表性授权错误，核对实际状态码、错误 schema、Request-ID 和路由安全头；再执行 Node Agent 单测、根 lint/typecheck/test/contracts/build。测试说明替代不了外部客户端升级验证。

## ADR-015：Node 服务端标签持久化与 SQLite 迁移（PM-041）

- **状态：** 用户已批准设计；批准仅覆盖隔离分支 PM-041 的 API/schema 实现与测试，不授权生产数据库迁移、push、merge 或 release。详细决策见 [`docs/adr/ADR-015-server-tag-persistence.md`](adr/ADR-015-server-tag-persistence.md)。
- **接口：** 为 `GET /v1/assets` 增加每资产 `tags` 数组；逐标签 `PUT`/`DELETE /v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}`，按当前 Node 管理员 Bearer 和图库 ACL 授权。元素操作幂等；大小写敏感，仅 trim；暂定单标签 UTF-8 ≤128 字节、每资产 ≤64 标签。
- **数据与迁移：** 追加 `0005_asset_tags`，不改既有 migration checksum；为本地资产及活动同步投影持久化，tombstone 隐藏但不删除标签。迁移为空表、已有非空 DB 需启动器先备份；不导入浏览器 IndexedDB，也不产生 P2P 事件。PM-042 负责跨节点事件，PM-043 负责 Web 接入及旧本地标签的幂等合并。
- **回滚限制：** 旧版 Node Agent 拒绝数据库中的未知 migration ID；回滚需恢复迁移前数据库备份，且会丢失迁移后新增标签。此分支不执行用户数据库迁移；生产迁移须另行审批、备份校验和恢复演练。

## ADR-016：PM-042 标签 OR-Set 事件同步、授权与兼容性

- **状态：** 用户于 2026-10-27 批准 ADR-016；仅覆盖隔离分支 PM-042 的协议/API/schema/UI 实现、测试及本地提交，不授权生产迁移、push、merge 或 release。详见 [`ADR-016`](adr/ADR-016-pm042-asset-tag-sync.md)。
- **决定：** 标签用 observed-remove set；remove 只移除已观察 add ID，未观察的并发 add 保留；PM-041 标签以本地签名事件幂等引导；原 `asset_tags` 为物化视图。
- **安全/兼容：** 现有 read grant 仍只读，逐图库 tag-write 默认拒绝；采用独立 `asset-tags-v1` 事件流，N-1 节点仍可同步旧元数据，并明确显示未同步标签操作。
- **容量澄清（用户批准）：** 每个写入者每资产最多64个活动标签；每图库最多64个唯一标签事件作者（含本机，撤权不释放名额）；OR-Set 合并集及 `Asset.tags` 契约上限为4096。
- **回滚：** `0006` 为追加迁移；旧二进制需恢复迁移前备份。生产迁移和发布必须另行审批。

## ADR-018：PM-045 虚拟相册同步与删除范围

- **状态：** 用户于2026-10-28批准 ADR-018 推荐默认项1–11；仅限隔离分支协议/API/schema实现、测试和本地提交。详见 [`ADR-018`](adr/ADR-018-pm045-virtual-album-sync.md)。生产迁移、push、merge、release未获授权。
- **批准重点：** 独立 `virtual-albums-v1` stream；历史操作 bootstrap/no-op/key namespace；独立 album-write/album-delete grants；tombstone asset 的 history/projection 分离；local-only 与 global shared soft delete；N/N-1与错误序列恢复有界策略。
- **剩余边界：** Q09 的回收站保留期限/到期可见性由PM-061设计；永久 purge/审批另由PM-063处理。PM-045不做物理清除，也不授权生产迁移/push/merge/release。

## ADR-019：PM-046 图库级收藏语义与跨节点同步

- **状态：** 用户于2026-10-28批准推荐默认。详见 [`ADR-019`](adr/ADR-019-pm046-library-favorites.md)。当前 Node principal 是 `local-admin`，Peer ID 是设备身份而非人类用户；不将其伪装成个人身份。
- **决定：** 采用图库级共享收藏以保留 PRD §3.4 的事件同步要求；独立 `asset-favorites-v1` capability/stream；OR-Set observed-remove；新增默认拒绝 `favorite-write` grant；远端撤权拒绝新事件、已经持久接受的 pending event 按接收时授权继续；PM-047 单独处理评分。
- **兼容/迁移：** append-only `0009_asset_favorites`，扩展全局 UUID registry 及所有 writer guards；N-1 不阻塞共同 streams；隔离 SQLite 做备份失败、历史 ID 冲突、旧 binary 和恢复测试。
- **边界：** 批准仅限隔离 PM-046 分支的协议/API/schema实现、测试及本地提交；不运行生产迁移、不 push/merge/release。若将来改选个人收藏，须先补稳定的人类身份/ACL；改选 local-only 须先修订 PRD §3.4。

## ADR-020：PM-047 图库级共享评分与并发冲突

- **状态：** 用户于2026-10-29批准推荐默认。详见 [`ADR-020`](adr/ADR-020-pm047-library-ratings.md)。Node Peer ID 仅标识设备/签名作者，不代表人类用户。
- **决定：** 图库级共享评分；值为整数1–5或null；独立 `asset-ratings-v1` stream 与默认拒绝 `rating-write` grant；基于因果多值寄存器保存并发候选，冲突可见、仅由显式解决事件消解，不采用墙钟 LWW。
- **兼容/迁移：** 仅追加 `0010_asset_ratings`；N-1 不阻塞共同 streams；持久化幂等操作、因果 inbox/outbox、连续接受游标、冲突历史和可重建投影；只在隔离 DB 运行备份失败与升级/恢复测试。
- **边界：** 批准仅限隔离 PM-047 分支的 API/schema/protocol实现、测试及本地提交；不运行生产迁移、不 push/merge/release。真实 per-user rating 等到稳定的人类身份/ACL 已有独立方案后另行决定。

## ADR-021：PM-048 授权图库文件名/路径/日期检索

- **状态：** 用户于2026-10-29批准推荐范围。详见 [`ADR-021`](adr/ADR-021-pm048-authorized-search.md)；PM-048 已在隔离分支实现并验证，生产迁移未授权。
- **决定：** `GET /v1/assets` 使用大小写不敏感字面子串检索文件名/路径，保留资产 ID/来源节点 ID 搜索；非空 q 至少3个 Unicode code points（更短返回400）；可选 UTC `dateFrom`/`dateTo` 半开区间；本机及同步投影均参与文本检索。未授权请求在查库前拒绝；不新增路径/用户归属字段。
- **兼容/迁移：** append-only `0011_gallery_search_index` 维护 FTS5 trigram 派生索引与图库/拍摄日期分页索引；query/cursor 参数有界、唯一且允许字段明确，keyset 游标绑定图库和规范化搜索条件。旧二进制拒绝未知迁移；仅隔离 DB 测试备份、索引回填/恢复。
- **边界：** PM-048 不做类型、来源、可用性等组合筛选（PM-049）；排序只保证静态数据集稳定分页，不承诺并发写入快照；不运行生产迁移、不 push/merge/release。

## ADR-022：PM-049 日期/类型/来源/可用性组合筛选

- **状态：** 用户于2026-10-29批准范围；详见 [`ADR-022`](adr/ADR-022-pm049-filter-combinations.md)。隔离分支实现与测试通过，未执行生产迁移。
- **决定：** `GET /v1/assets` 增加 kind/sourceKind/availability 精确枚举筛选，与 q/UTC 半开日期按 AND 组合；筛选绑定分页 cursor，旧无新维度 cursor 保持 v1；新增 `galleryFilters` 能力标志。
- **兼容/迁移：** 只追加 `0012_gallery_filter_indexes` 三个维度/图库/拍摄时间索引，不改写 `0001`–`0011`；隔离数据库验证备份失败原子性、旧二进制拒绝和索引查询计划。
- **验证：** 单测/HTTP/OpenAPI 契约、根级 lint/typecheck/test/contracts/build 与 100k 文件型 HTTP/WAL 日期+三维组合筛选均通过；详见 [ADR-022](adr/ADR-022-pm049-filter-combinations.md) 及 [100k 基准报告](../artifacts/performance/gallery-100k-pm049.json)。
- **边界：** 仅限隔离分支与本地提交；不运行生产迁移、不 push/merge/release。

## ADR-023：PM-050 Web 搜索状态与键盘体验

- **状态：** PM-050 已在隔离分支按批准的开发范围完成；详见 [`ADR-023`](adr/ADR-023-pm050-search-experience.md)。无 API、OpenAPI 或数据库变更。
- **决定：** Web 仅在 Node 健康能力声明 `gallerySearch` 时启用搜索；修剪后的非空词不足 3 个 Unicode code points 时在本地指导且不发请求，输入长度上限 256 UTF-16 code units。250ms 防抖；Enter 立即提交、Escape 清空、`/` 和 Ctrl/Cmd+K 聚焦；结果仅使用服务端分页，避免本地二次过滤造成 asset ID 等命中丢失。双语状态/空态和失败重试不回显查询词。
- **隐私/兼容：** 搜索词仅随当前授权请求作为 `/v1/assets` 的 `q` 参数发送；不写地址栏、浏览器存储、console 或应用日志。未声明能力的旧 Node 禁用搜索并显示兼容提示，时间线其他功能保持可用；无 schema 或迁移影响。
- **验证：** 根级 lint/typecheck/test/contracts/build 通过；Playwright 全套 23 项通过（含 PM-050 搜索状态和 100k server-pagination 回归）。测试核对 location/localStorage/sessionStorage/console 中不含搜索词；截图见 [PM-050 搜索界面](screenshots/pm050-search-ux.png)。
- **边界：** 仅限隔离 worktree 与本地 Conventional Commit；不 push、merge、release、部署或执行生产迁移。

## ADR-024：PM-051 Web 批量选择与可逆元数据操作

- **状态：** PM-051 已在隔离 worktree 实现并验证；详见 [ADR-024](adr/ADR-024-pm051-bulk-metadata-operations.md)。不改变 Node API、OpenAPI、数据库或迁移。
- **决定：** 当前图库已加载资产逐项勾选，每批最多 100 项；数量、图库和排除未加载/其他匹配项的范围在提交前显示。仅提供添加/移除单一标签、设置共享收藏/取消收藏；收藏按图库共享并在获授权节点同步。无批量删除/永久删除。
- **安全/恢复：** 使用现有单项授权 API，串行提交并逐项记录成功/失败；只重试失败项，收藏重用每资产 UUID `Idempotency-Key`，标签依赖既有幂等 PUT/DELETE。能力缺失时禁用相应操作；选择和批次仅在内存，搜索/图库/会话变化会清除选择。会话重置时保留仅含计数的中断摘要，区分已确认、失败、结果未知与未启动项；不把旧批次自动重放到新会话。
- **验证：** 根级依赖安装、lint、typecheck、test、contracts:check、build 通过；Playwright 全套 27/27（含 100k 分页和会话切换时在途操作状态摘要）通过；界面截图见 [PM-051 批量操作](screenshots/pm051-bulk-operations.png)。
- **边界：** 仅隔离 worktree 与本地 Conventional Commit；不 push、merge、release、部署或执行生产迁移。

## ADR-025：PM-052 关键元数据变更审计事件（已批准）

- **状态：** 用户已于 2026-10-30 批准推荐范围与迁移方案；隔离 worktree 本地实现/验证已完成，记录于 [ADR-025](adr/ADR-025-pm052-metadata-audit-events.md)；不授权生产迁移。
- **决定：** 仅对授权成功的标签、收藏、评分与虚拟相册写请求记录 `applied/unchanged/replayed`；排除拒绝/失败请求及配对/授权控制面。`local-admin` 仅是主体类别；request ID 使用严格 1–64 ASCII 校验，缺失/非法/重复时生成 UUID。只存本地 domain-separated SHA-256 库/资源 ID digest 与 action/scope/outcome/request/time，不存原始 ID、token、请求体、路径、文件名、元数据值或照片明文；不新增读取 API/UI/P2P 同步。
- **完整性/保留：** 无限期保留（接受无界磁盘增长、无自动清理），append-only 仅是应用层保证，本机数据库所有者仍可篡改；ID 仍可关联资产，故仅本地保存、不网络暴露。
- **兼容/恢复：** 追加迁移 `0013_metadata_audit_events`，审计写失败必须导致业务写事务回滚；不改写旧迁移，迁移前备份和恢复验证必需。旧版本拒绝未知 schema，回滚需恢复备份；未授权执行生产迁移。
- **权限边界：** 可在隔离分支完成本地源码、测试和 Conventional Commit；生产迁移、push、merge、release、deploy 各自仍需明确授权。

## ADR-026：PM-053 时间线时区、日期来源置信度与稳定排序（待批准）

- **状态：** [ADR-026 提案](adr/ADR-026-pm053-timeline-date-provenance.md)；本地/远端日期来源的置信度、无时区 EXIF 处理、时区偏好与 cursor 兼容待用户确认。批准前不改 DB schema、P2P 元数据契约或 API 行为。
- **现状：** 上传/外部只读扫描不写拍摄时间；Gallery 不保存来源/置信度；UI 跟随运行时默认时区，API 日期区间固定 UTC；分页已按时间+asset ID 排序但未专项覆盖大量相同时间戳。
- **推荐范围：** EXIF 有明确 offset 时保存 UTC instant/high；无 offset 时保留 floating local time/medium 并在独立分段显示，不猜当前节点时区；不将文件 mtime 或 ingest 时间冒充拍摄时间；旧行来源标记 `legacy_unknown`。可选 P2P 字段必须保持旧 event 兼容。
- **数据/恢复风险：** 可能追加 `0014`；必须备份前置、追加式迁移、旧 checksum 不变与失败原子性验证；不由迁移遍历媒体或改写原图。生产迁移未授权。
- **批准后验收：** IANA 时区跨日/DST、EXIF offset/无 offset/错误值、源置信度、N/N-1 事件兼容、cursor tie/NULL/分段全遍历无重复遗漏；根级检查及临时 DB 恢复测试。
