# Architecture decision records

当前决策记录位于 `docs/05_ADR_未决决策与风险.md`。新 ADR 在本目录建立并关联现有编号。

- [ADR-011：非破坏式派生媒体版本与编辑](ADR-011-media-versioning-proposal.md) — 已批准并实施；Android 自动化与本地 release 变体验证通过，正式签名及许可证审查仍待完成。
- [ADR-019：PM-046 图库级收藏语义与跨节点同步](ADR-019-pm046-library-favorites.md) — 用户于2026-10-28批准；隔离分支实现与根级 lint/typecheck/test/contracts/build、双节点 LAN/N-1 和 Docker sync smoke 验证通过；未执行生产迁移。
- [ADR-020：PM-047 图库级共享评分与并发冲突](ADR-020-pm047-library-ratings.md) — 用户于2026-10-29批准图库级共享评分、1–5/null、因果多值寄存器与显式冲突解决；隔离分支已提交 `e830517` 并通过根级验证，未执行生产迁移。
- [ADR-021：PM-048 授权图库文件名/路径/日期检索](ADR-021-pm048-authorized-search.md) — 用户于2026-10-29批准的搜索 API/索引方案已在隔离分支实现与验证，含文件型 100k HTTP/WAL 证据；未执行生产迁移。
