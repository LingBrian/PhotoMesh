# api

当前 Node Agent HTTP 路由实现位于 `apps/node-agent/src/server.ts`，唯一 OpenAPI 契约位于 `contracts/openapi_draft.yaml`（保留历史文件名）。裸 `createNodeAgentServer` 的授权器默认拒绝；Node Agent 启动配置将受保护路由接到本机管理员 Bearer 授权，并在资源访问时执行相应图库/会话授权。

每个响应均回传 `X-Request-ID`；JSON 错误体包含开放式 `error` 与 `requestId` 字段。P2P 同步由 libp2p 内部通道承载，不实现为 REST 路由。直接 HTTP listener 不提供 TLS，远端访问需独立可信 HTTPS 终止代理。
