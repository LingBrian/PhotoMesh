# Architecture decision records

当前决策记录位于 `docs/05_ADR_未决决策与风险.md`。新 ADR 在本目录建立并关联现有编号。

- [ADR-011：非破坏式派生媒体版本与编辑](ADR-011-media-versioning-proposal.md) — 已批准并实施；Android 自动化与本地 release 变体验证通过，正式签名及许可证审查仍待完成。
- [ADR-019：PM-046 图库级收藏语义与跨节点同步](ADR-019-pm046-library-favorites.md) — 用户于2026-10-28批准；隔离分支实现与根级 lint/typecheck/test/contracts/build、双节点 LAN/N-1 和 Docker sync smoke 验证通过；未执行生产迁移。
- [ADR-020：PM-047 图库级共享评分与并发冲突](ADR-020-pm047-library-ratings.md) — 用户于2026-10-29批准图库级共享评分、1–5/null、因果多值寄存器与显式冲突解决；隔离分支已提交 `e830517` 并通过根级验证，未执行生产迁移。
- [ADR-021：PM-048 授权图库文件名/路径/日期检索](ADR-021-pm048-authorized-search.md) — 用户于2026-10-29批准的搜索 API/索引方案已在隔离分支实现与验证，含文件型 100k HTTP/WAL 证据；未执行生产迁移。
- [ADR-022：PM-049 日期/类型/来源/可用性组合筛选](ADR-022-pm049-filter-combinations.md) — 组合筛选、v2 条件绑定 cursor 与 append-only 0012 索引迁移已实现；100k 文件型 HTTP/WAL 与契约测试通过；未执行生产迁移。
- [ADR-023：PM-050 Web 搜索状态与键盘体验](ADR-023-pm050-search-experience.md) — 双语、能力门控、键盘操作、空态/重试与查询词隐私保护已实现；根级验证和 23 项 Playwright（含 100k）通过；未 push/merge/release。
- [ADR-024：PM-051 Web 批量选择与可逆元数据操作](ADR-024-pm051-bulk-metadata-operations.md) — 最多 100 项、图库范围清晰、标签/共享收藏逐项可重试，未新增 API/迁移；根级验证与 27 项 Playwright（含 100k 与会话中断处理）通过；未 push/merge/release。
- [ADR-025：PM-052 关键元数据变更审计事件](ADR-025-pm052-metadata-audit-events.md) — 用户已批准；本地 `0013` 审计迁移、SHA-256 标识 digest、scope attribution 与 fail-closed 写入均已实现验证，不授权生产迁移。
- [ADR-026：PM-053 时间线日期来源与时区](ADR-026-pm053-timeline-date-provenance.md) — 用户已批准保守 provenance、floating 时间、系统时区和不做一次性扫描；隔离 worktree 正在实现 `0014` 与可选同步元数据，不授权生产迁移。
