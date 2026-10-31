# PhotoMesh Node HTTP API

OpenAPI 唯一源位于 [`contracts/openapi_draft.yaml`](../../contracts/openapi_draft.yaml)（历史文件名保留）。它描述当前 Node Agent 已实现的 HTTP 路由、状态码、开放式 `{error, requestId}` 错误 envelope、`X-Request-ID` 及逐路由响应头；不是全部规划 API 的实现承诺。

P2P 版本协商和同步消息走独立的认证 libp2p 通道，不是 `/v1/sync/*` HTTP API。Node Agent 直接监听 HTTP，默认只绑定 loopback；远端访问必须经独立可信 HTTPS 终止代理。私有 LAN 地址绑定本身不提供 TLS。
