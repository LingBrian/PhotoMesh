# Node agent event sync

协议设计见已批准的 [ADR-002](../../../../docs/adr/ADR-002-p2p-event-sync.md)。当前实现使用 Ed25519 节点身份签署 RFC 8785 canonical JSON；`sync_event_log` 保留不可变事件，outbox/inbox、作者序号、因果父事件和逐作者游标支持重试与反熵。版本 1 事件只同步图库索引和元数据，不含原图字节、外部路径或凭据。

上传完成与外部目录扫描会在各自的 SQLite 写事务内创建待签名事件草稿。之后使用系统密钥存储完成签名并投递 outbox。若签名过程中进程退出，节点启动时会从 SQLite 恢复草稿；签名私钥不进入数据库或日志。只有签名完成的事件可进入游标或被发送。

同步服务只向已建立信任的 Peer 交换事件，并在两端检查当前图库授权。接收方按签名身份、幂等事件 ID、作者序号和因果父事件应用 inbox；缺失因果事件会保持 pending。单值元数据冲突会保留候选并以 `(authorPeerId, eventId)` 决定显示值；壁钟时间不参与冲突排序。删除用墓碑表示，恢复需引用墓碑，原图不会因事件而删除或复制。

N-1 节点通过 Hello 中的协议、Schema 和能力交集协商；未知版本/事件会安全保留但不应用，也不推进作者游标。LAN pairing 成功后自动尝试同步，已信任节点会每 10 秒进行一次重试/对账；mDNS 仅提供地址发现，手动 IP 也必须匹配被签名认证的 Peer ID。

关键验证：

```powershell
pnpm --filter @photomesh/node-agent test
pnpm --filter @photomesh/node-agent typecheck
pnpm test:sync-compose
```

双节点容器与模拟限制见 [`deploy/compose/README.md`](../../../../deploy/compose/README.md)。
