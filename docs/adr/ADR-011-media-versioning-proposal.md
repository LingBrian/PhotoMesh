# ADR-011：非破坏式派生媒体版本与编辑

- **状态：已批准并实施（Node API、SQLite 迁移、服务端派生/校验及 Windows/Android 客户端实现完成；Node/Web/Flutter 自动化检查和本地 Android release 变体验证通过，正式发行签名及许可证审查仍待完成）**
- **日期：** 2026-10-24
- **对应阶段：** M4
- **相关决策：** ADR-001（节点身份与图库授权）、ADR-002（事件同步）、ADR-006（协议兼容）、ADR-009（不可变对象提交）、ADR-010（图库访问与原图读取）

## 背景

M4 需要 Android 与 Windows/Tauri 客户端支持照片预览和编辑。用户已选择编辑结果以“图库中新建版本”的方式保存，而不是覆盖原件。当前接口只提供图库索引与原件读取，没有派生版本模型、版本写入/内容读取接口或 `mediaVersions` 能力协商。现有客户端也不能直接写 Node 数据库或托管文件。

编辑结果一旦持久化，会引入新增 API、数据库记录、对象存储、授权、冲突和兼容语义。依照 ADR-009/010 与项目安全约束，本提案获批准之前不实现版本写入、数据库迁移或协议变更。用户批准后，Node/API、SQLite 迁移及 Android 与 Windows 客户端按本 ADR 实施：原件仍只读，版本创建只能经节点 API。

## 目标与非目标

### 目标

- 将每次编辑保存为同一图库中的**独立、不可变派生版本**，永久保留原件。
- Windows/Tauri 与 Android 使用相同服务端变换规则，并在版本就绪后提供版本列表与预览。
- 对离线、失败、重复请求、并发编辑及未知协议能力给出明确结果；不得静默覆盖或丢失编辑。

### 首版非目标

- 覆盖、原位重编码或自动删除原件；自动删除/垃圾回收任何派生文件。
- 视频编辑、画笔、滤镜、AI 修图、任意变换脚本、自动冲突合并。
- 自动选出共享“当前版本”、跨节点内容一致性承诺或把编辑文件复制到其他节点。

## 已批准方案

1. **首版范围为本地节点、本地图库。** 只在用户当前连接且在线、已授权的 Node 上创建版本；在该节点版本列表中可见。首版不传播版本内容，也不发送可能让其他节点误报可用的同步事件。UI 明示“仅此节点可用”。后续若要 P2P 同步，单独设计元数据事件、能力协商、传输/哈希验证和离线可用状态。
2. **只支持静态照片裁剪和 90° 整数旋转。** 客户端提交标准化变换参数，不提交服务器路径、输出对象键或授权声明。Node 从经过授权的确切源版本读取原件并生成结果；超出边界、像素数/处理时间/文件尺寸限额或不支持的 MIME 一律拒绝。
3. **使用服务器端异步变换。** 新版本先处于 `staging`，输出写入隔离派生目录的临时对象；验证尺寸、格式、SHA-256 后以不覆盖的原子提交发布为 `ready`。任何失败均不得发布成功版本。服务端自行生成对象键；数据库只保存相对引用，不接受任意绝对路径。原件路径和字节永不作为输出目标。
4. **管理员边界保持诚实。** 初版请求沿用当前 Node 管理凭据，并且每个版本列表、写入、元数据及内容请求都由服务端重新验证。此方案只代表“当前 Node 管理员可编辑”，不代表细粒度多用户/资产级 `edit` ACL。若产品要求非管理员编辑、共享设备或不同图库的可区分写权限，则必须先单独批准并实现服务端角色/ACL；不得只在客户端隐藏按钮。
5. **版本列表优先，无共享可变 head。** 不设置 `AssetVersionHead`；原件始终作为稳定资产身份。并发客户端基于同一源提交时保留两条 sibling 版本，不按墙钟/LWW 选胜者。编辑请求绑定明确 `sourceVersionId` 与 `sourceSha256`；源不匹配返回 `409 source_changed`，重复 `idempotencyKey` 返回既有操作。
6. **固定输出与隐私策略。** 首版仅 JPEG/PNG/WebP，输出 MIME 与源格式一致；归一化 EXIF orientation，剥除 EXIF/GPS/设备序列号等元数据并保留 ICC 色彩配置；PNG 保持透明，JPEG/WebP 使用服务端固定质量参数。实现固定 JPEG quality 92、WebP quality 90、PNG compression level 6；客户端不能改变格式或元数据策略。
7. **离线时禁止新建版本。** 创建前及每次内容读取都需要在线授权和源文件可达。版本条目即使同步到其他节点（仅未来提案）也必须将“元数据已知”和“字节可读”分开表达；远端缺少字节不得伪装成 404、原件或 ready。
8. **缓存与退出。** 编辑输入/输出只在内存中短暂存在；关闭编辑器或离开图库时撤销对象 URL/释放客户端缓冲。首版不持久化完整编辑输入或输出到 Android/Web 缓存；当前 Web 已有缩略图缓存的清理与 ACL 撤销窗口仍按 ADR-010 处理，不能承诺物理擦除缓存介质。

## 数据模型（M4 首版实施规格）

以 contracts 为唯一事实来源，SQLite 首版实现可增加 `media_versions` 与必要索引：

- `versionId`（服务器 UUID）、`assetId`、`libraryId`、`parentVersionId`（为空表示从原件派生）、`kind = crop_rotate`。
- `sourceSha256`、`outputSha256`、`mimeType`、`byteSize`、`width`、`height`。
- `transform`（有版本号的坐标空间、规范化裁剪矩形、EXIF orientation 归一规则及 0/90/180/270 旋转）。
- `relativeObjectKey`（仅服务端生成）、`createdBy`、`createdAt`（审计显示用，不做并发仲裁）、`operationId/idempotencyKey`、`status = staging|ready|failed`。

资产的原件 ID、库 ID、源节点和原始 SHA-256 不变。MVP 不提供版本删除/tombstone、不自动清理失败或孤儿文件，也不改写现有资产行来假装派生版本是原件。

## API 契约（M4 首版，OpenAPI 中冻结）

- `GET /v1/libraries/{libraryId}/assets/{assetId}/versions`：服务端验证管理员凭据与资产/图库范围，返回版本元数据和可用性。
- `POST /v1/libraries/{libraryId}/assets/{assetId}/versions`：提交 `{sourceVersionId, sourceSha256, transform, idempotencyKey}`；`sourceVersionId: null` 明确表示原件，非空 ID 必须是同一资产下已就绪的派生版本；服务端重新校验授权、源 hash、变换边界和能力，返回 `202` 与 operation/version ID。
- `GET /v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}`：受授权版本元数据/异步状态。
- `GET /v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}/content`：每次访问重新授权、检查就绪状态/文件存在并验证服务端生成的对象键；禁止路径穿越及任意对象读取。原件字节继续走原件端点，派生内容读取失败时不得回退。

### 变换与资源边界

- `crop` 使用整数百万分比 `{x, y, width, height}`；范围为 `[0, 1_000_000]` 且矩形必须非空、完整落在图像内。坐标空间是先按 EXIF orientation 归一后的方向；服务端 `left/top` 向下取整、`right/bottom` 向上取整。再应用 `rotation ∈ {0, 90, 180, 270}`。
- 仅静态 JPEG/PNG/WebP，输出保持源 MIME；固定 JPEG quality 92、WebP quality 90、PNG compression level 6。剥除 EXIF/GPS 等元数据，保留 ICC；不接受用户指定输出格式/路径/编码参数。
- 首版防资源耗尽限制：输入与输出各最多 32 MiB、25 MP、Node 同时处理一个版本任务；超限或解码超时失败，不得进入 `ready`。这些是服务端硬限制，客户端可更早提示但不得放宽。
- Node 端采用锁定版本的 CPU `sharp`/libvips 图像处理依赖；构建与发布需审计目标平台的预编译包/许可证，并以单任务并发与像素上限满足低内存节点约束。

错误至少区分 `401/403`（不得泄露未授权资源是否存在）、`404`、`409 source_changed`、`413`（在异步操作接受前检测到的输入尺寸/像素限制）、`410`（仅未来 tombstone）及 `503`（源/存储/能力暂不可用）。异步处理阶段发现的输出尺寸/超时错误写入版本 `failed` 状态，不误报为同步 HTTP 413。不得通过返回原件字节来降级替代缺失的派生版本。

## 兼容、迁移与回滚

- 变更为 additive：新增可选 API 能力 `mediaVersions`、版本表/索引与独立派生目录；旧资产无需回填，视为隐式原件，不重写媒体文件。
- 服务端/数据库先升级，客户端根据明确能力决定是否显示编辑入口。无能力时只能预览原件，不能将编辑结果降级成原件上传或声称保存成功。兼容承诺为 N/N-1；未知版本 kind/schemaVersion 明确显示 unsupported。
- 迁移使用编号与校验和、事务性建表，部署前备份并演练恢复。代码回滚只关闭写入口，保留新增表、版本文件与事件；不提供会删除非空版本表/对象的自动 down migration。
- 本地-only 方案不增加 P2P 事件。跨节点同步不属于此 ADR 的批准范围。

## 安全与测试验收

- ACL/API：匿名、错误 token、未授权图库/资产、IDOR、源版本读/写、内容重放与撤权后请求；每个接口逐次服务端授权。
- 原件不变：成功、失败、并发及进程崩溃后验证原件 SHA-256/大小不变，且没有写入原件路径；M4 无服务端取消 API。
- 变换：EXIF 方向/裁剪边界/越界/90°旋转维度、透明度、ICC、格式 MIME、确定性与跨平台一致性。
- 文件安全：解压炸弹/超大像素、畸形图片、路径穿越、Unicode 混淆、symlink、磁盘满、权限错误、提交中断；失败版本不得变 ready。
- 幂等/并发：同 key 重试只生成一个操作；双客户端同源并发生成两条 sibling；源 hash 不匹配返回 409；没有时钟胜者或静默覆盖。
- Android/Windows：双语、键盘/屏幕阅读器、异步进度与失败反馈；关闭编辑器只停止客户端轮询并清理预览 URL/图像缓冲，不承诺取消服务端任务（M4 不提供取消 API），也不删除 staging/版本文件；离线时不得伪称 ACL 已校验。
- 迁移/兼容：空库与现有库、重复启动、N/N-1、未知能力、备份恢复和代码回滚；任何步骤不触碰原图。

## 批准记录

用户于 2026-10-24 明确选择并批准全部建议默认值：

1. 首版仅在当前 Node 本地保存版本，不做 P2P 元数据/字节同步。
2. 首版只支持裁剪与 90° 整数旋转，由 Node 服务端生成派生版本。
3. 仅当前 Node 管理员凭据可写；不宣称细粒度多用户/资产级 ACL。
4. 仅 JPEG/PNG/WebP；归一化 EXIF orientation，剥除 EXIF/GPS，保留 ICC。
5. 不设共享 head；并发创建 sibling；离线不可写；不提供版本删除或自动 GC。

该批准允许按本 ADR 继续实现 additive API、SQLite 迁移和客户端编辑器；它不批准覆盖/删除原件、P2P 同步、生产迁移或绕过 Node API 的直接文件/数据库访问。

## 实施记录与运维约束（2026-10-24）

- 已实现编号迁移 `0004_media_versions`，仅新增不可变版本表、索引、触发器及独立派生存储引用；无自动 down migration。升级前应停 Node Agent 并备份 SQLite 数据库及其托管媒体目录。代码回滚时保留迁移后的数据库与所有派生对象；不要手动删除表、触发器或 `derived/` 文件。
- 处理和内容读取都由 Node API 完成。派生内容在大小与 SHA-256 校验通过前不返回；源/存储暂时故障保留 staging 记录供重试/重启恢复。客户端重试相同请求复用幂等键，客户端关闭只停止轮询，不会撤销或删除已排队任务。
- Windows 共享图库编辑器已由 Playwright 端到端验证（能力关闭、裁剪/旋转提交、从派生版本再编辑、版本轮询和内容预览）；Node 套件 130 项通过，分支覆盖率 82.45%，Flutter analyze 无问题且 Flutter 测试 30 项通过；全仓 lint、typecheck、unit test、契约检查、build 及 Playwright 4 项均通过。
- 本地 Android API 35 Pixel 模拟器已安装并启动 `org.photomesh.mobile` 的 release 变体，无 AndroidRuntime fatal exception。APK 放在被 `/release/` 忽略的本地目录，使用该 worktree 的默认 Android Debug 证书签名，仅供本地测试/安装，不是可分发的正式签名版本；正式签名必须使用受保护的发布密钥。
- `sharp@0.35.5` 本体声明 Apache-2.0；当前 Windows 预编译包 `@img/sharp-win32-x64@0.35.5` 声明 `Apache-2.0 AND LGPL-3.0-or-later`。正式分发前需完成目标平台 SBOM、第三方许可证/通知及 LGPL 共享库替换要求审查。
- 文件系统读取和写入会拒绝托管根目录内的符号链接并验证真实路径，但基于路径的 `lstat`/`realpath` 与后续打开之间仍存在可移植的 TOCTOU 窗口；当前测试不覆盖并发符号链接替换。
