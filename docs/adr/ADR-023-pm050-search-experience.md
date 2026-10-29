# ADR-023：PM-050 Web 搜索状态与键盘体验

- **状态：** PM-050 已在隔离 `feat/pm050-search-ux` worktree 实现并完成验证；改动仅涉及 Web 搜索交互、无障碍文案、测试和本地提交。不涉及 API/数据库协议变化。
- **日期：** 2026-10-29
- **路线图：** PM-050（Web 搜索状态、键盘交互、空态和错误恢复）。
- **依赖：** PM-048 搜索 API 与 `gallerySearch` 能力，PM-049 筛选组合 API。

## 决策

1. 客户端检查 `/v1/health` 的 `gallerySearch` 能力；未声明时禁用搜索输入并给出双语说明，不尝试发送不受支持的 `q`。断线时沿用 offline 状态，不把断线误报为能力不支持。
2. 查询继续由用户当前已授权 Node API 执行，非空输入按 250ms 防抖；按 Enter 立即提交，Escape 清除并回到未筛选时间线，`/` 与 Ctrl/Cmd+K 在非编辑控件中聚焦搜索框。空白查询重新加载时间线。
3. 字符数校验在请求前执行：修剪后非空查询至少 3 个 Unicode code points，输入最多 256 UTF-16 code units。无效短词保留在输入框并展示指导，不发网络请求；服务端仍负责最终校验。
4. 搜索结果只使用服务端分页，不再对当前页做第二次本地字符串筛选；这样避免漏掉按 asset ID 命中的结果。现有本地虚拟相册筛选语义保持不变。
5. 私有查询不写浏览器地址栏、localStorage/sessionStorage、console 或应用日志；查询仅作为授权 `/v1/assets` 请求参数传给 Node。状态、空结果、服务不支持和错误信息均不回显查询词，错误时提供当前词重试。
6. 状态与空态使用简中/英文消息和 polite live region；连接/授权错误沿用现有会话安全处理，搜索错误保留通用 `{HTTP status}` 信息，不暴露服务端响应内容。

## 验收

- Playwright 覆盖能力缺失禁用、短词本地拒绝、`/` 与 Ctrl/Cmd+K 聚焦、Enter/Escape、按 asset ID 搜索、无结果说明、失败重试及查询词不进入 location/storage/console；完整 23 项 Playwright 回归通过（含 100k server-pagination）。
- 根级 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm contracts:check`、`pnpm build` 均通过；Web 26 tests、Node Agent 338 tests、contracts 16 tests。截图：[PM-050 搜索界面](../screenshots/pm050-search-ux.png)。
