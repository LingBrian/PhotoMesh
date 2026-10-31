# LAN 安全配对

PhotoMesh 节点之间通过 TCP + libp2p Noise XX 加密通道进行身份双向验证。整个流程不使用公网服务。mDNS 与手动 IP 只提供地址；节点信任来自 Noise 握手中的 Ed25519 Peer ID 和短期邀请，不来自 IP、主机名或广播内容。

## 威胁与边界

- 防止局域网监听、伪造 mDNS、冒充 IP、邀请码重放、未授权图库索引读取和撤销后的新请求。
- 邀请秘密为 32 字节随机值，有效期 2 分钟且只能原子消费一次；数据库仅存 SHA-256 摘要。
- Host 必须本地审批新设备。配对本身不授予图库访问，审批只授予用户明确选择的图库只读权限。
- 撤销后关闭与该 Peer ID 的活跃连接。之后每次图库索引请求仍检查设备状态和图库授权。
- 私钥只存 Windows Credential Manager 或 Linux Secret Service。Linux Secret Service 不可用时配对关闭，不写入 SQLite、明文文件或日志。
- 节点仅绑定明确配置的私有 LAN/ULA/回环地址，拒绝通配地址和公网地址。已授权设备可能保留此前缓存的数据；撤销不能远程擦除副本。

## Linux / NAS 配置

先确保运行 Node agent 的用户可访问已解锁的 Secret Service（例如 GNOME Keyring 或 KWallet），然后仅填入节点本机的私有 LAN 地址：

```sh
export PHOTOMESH_DATA_DIR=/var/lib/photomesh
export PHOTOMESH_ADMIN_TOKEN="$(openssl rand -base64 32)"
export PHOTOMESH_LAN_BIND_ADDRESSES=192.168.1.20
export PHOTOMESH_P2P_PORT=40443
pnpm --filter @photomesh/node-agent start
```

`PHOTOMESH_ADMIN_TOKEN` 只用于绑定在 `127.0.0.1` 的管理 API。不要放入源码、容器镜像或日志；通过本机配置管理器注入。主机防火墙只需允许 TCP `40443` 来自家庭/办公 LAN；mDNS 需要本地 UDP `5353` 多播。若系统网络隔离多播，使用二维码中地址或手动 IP。

创建二维码邀请并查看待审批设备：

```sh
curl -sS -X POST http://127.0.0.1:8443/v1/pairing/invitations \
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN" > /tmp/photomesh-invite.json
curl -sS http://127.0.0.1:8443/v1/pairing/peers \
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN"
```

响应包含 `qrDataUrl`（PNG）和用于二维码扫码器的 JSON 载荷；载荷含一次性秘密，应像临时凭据一样处理。Host 审核 `pending` 中的 `peerId` 和公钥指纹后确认：

```sh
curl -sS -X POST http://127.0.0.1:8443/v1/pairing/peers/<peer-id>/approval \
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"approved":true,"label":"Living room NAS","libraryIds":["family"]}'
```

如暂不授予图库权限，省略 `libraryIds`；之后可单独授予：

```sh
curl -sS -X PUT http://127.0.0.1:8443/v1/pairing/peers/<peer-id>/libraries/family \
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN"
```

撤销设备：

```sh
curl -sS -X DELETE http://127.0.0.1:8443/v1/pairing/peers/<peer-id> \
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN"
```

客户端扫描二维码后，把二维码 JSON 交给本机管理 API 的 `POST /v1/pairing/join`；若 mDNS 不可用，可以在请求中附上已发现的私有 IP 和端口。客户端仍以二维码中的 Peer ID 校验 Noise 对端：

```sh
curl -sS -X POST http://127.0.0.1:8443/v1/pairing/join \\
  -H "Authorization: Bearer $PHOTOMESH_ADMIN_TOKEN" -H 'Content-Type: application/json' \\
  --data-binary "$(jq -c --arg label 'My laptop' '{invite: del(.qrDataUrl), label: $label}' photomesh-invite.json)"
```

二维码邀请响应还含 `qrDataUrl`；请求将其去掉，并可附 `manualIp`。发现广播节点不会自动配对或读取数据。

## Windows PowerShell / NTFS 节点

使用本机内网 IPv4 地址；防火墙规则限定到 Private profile 与 LocalSubnet：

```powershell
$env:PHOTOMESH_DATA_DIR = 'D:\PhotoMesh\agent-data'
$env:PHOTOMESH_ADMIN_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:PHOTOMESH_LAN_BIND_ADDRESSES = '192.168.1.30'
$env:PHOTOMESH_P2P_PORT = '40443'
New-NetFirewallRule -DisplayName 'PhotoMesh LAN pairing' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 40443 -RemoteAddress LocalSubnet -Profile Private
New-NetFirewallRule -DisplayName 'PhotoMesh mDNS discovery' -Direction Inbound -Action Allow `
  -Protocol UDP -LocalPort 5353 -RemoteAddress LocalSubnet -Profile Private
pnpm --filter @photomesh/node-agent start
```

Windows Credential Manager 保存节点私钥。源码运行示例中的管理员令牌只设置在当前 PowerShell 会话；打包版请用 `start.bat` 的安全提示，不要在机器/用户级环境变量或普通配置中持久化令牌。首次/遗失时的显式本机轮换步骤见仓库 README。不要把令牌贴入工单、命令历史或 transcript。

#### Windows Credential Manager 生命周期检查

从仓库根目录运行下列命令，可在当前 Windows 用户下创建随机临时凭据、由独立 Node 进程读取并自动删除；脚本不打印秘密值，也不会覆盖节点身份条目：

```powershell
pnpm --filter @photomesh/node-agent test:windows-credential-manager
```

可选地验证同一用户锁屏并解锁后仍可重新读取 Credential Manager 凭据：

```powershell
pnpm --filter @photomesh/node-agent test:windows-credential-manager -- --pause-for-unlock
```

按提示使用 `Win+L` 锁定并以同一 Windows 用户解锁，然后回到终端按 Enter。不要结束等待中的进程。该流程检查同一用户的跨进程持久性及解锁后重读，不检验锁屏期间另一个进程的读取行为，也不改写节点身份或数据库。若显示清理失败，请按脚本输出的服务名/条目名从 Windows Credential Manager 删除临时条目。不可用或拒绝访问由自动故障注入测试验证；不要为测试手动删除真实节点身份凭据或改变系统 ACL。任何存储失败都应关闭配对，而不是写入明文文件/数据库。

打包版在另一个 PowerShell 窗口执行管理请求时，令牌不会出现在该窗口的环境变量中。用安全提示读取令牌，不要把令牌字面量写进命令行：

```powershell
$secureToken = Read-Host 'Node administrator token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $adminToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secureToken.Dispose()
}
$headers = @{ Authorization = "Bearer $adminToken" }
try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:8443/v1/pairing/peers' -Headers $headers
} finally {
  $headers = $null
  $adminToken = $null
}
```

## Linux Docker Compose 示例

下面示例使用 host networking，以便 mDNS 和显式主机 LAN 地址一致；仅适用于 Linux Docker 主机。容器必须运行在能访问**专用、已解锁 Secret Service** 的可信环境中。没有该服务时，配对会关闭；程序不会降级到明文密钥文件。不要为了配对把宿主机完整 D-Bus 会话总线暴露给不受信任容器。

```yaml
services:
  node-agent:
    image: photomesh/node-agent:local
    network_mode: host
    environment:
      PHOTOMESH_DATA_DIR: /data
      PHOTOMESH_ADMIN_TOKEN: ${PHOTOMESH_ADMIN_TOKEN:?set a local admin token}
      PHOTOMESH_LAN_BIND_ADDRESSES: 192.168.1.40
      PHOTOMESH_P2P_PORT: "40443"
    volumes:
      - photomesh-data:/data
      - /srv/photos:/external/photos:ro
    read_only: true
    tmpfs:
      - /tmp
volumes:
  photomesh-data:
```

Host networking 让 NAS/主机上的 mDNS multicast 可以工作；Docker Desktop for Windows 不支持这套 host 网络语义，Windows 上直接运行 Node agent 或使用明确的端口映射与可路由私有地址，并改用手动 IP。容器文件系统只读，图库目录以只读卷挂载；原图不参与配对或授权写入。

## 接口与本地管理

- `POST /v1/pairing/invitations`：创建 2 分钟邀请，返回二维码 PNG 数据 URL。
- `POST /v1/pairing/join`：用扫码得到的一次性邀请经 Noise 完成双向身份验证。
- `GET /v1/pairing/peers`：可信/已撤销设备与待审批请求。
- `POST /v1/pairing/peers/{peerId}/approval`：批准/拒绝；可附显式只读图库列表。
- `PUT /v1/pairing/peers/{peerId}/libraries/{libraryId}`：后续单库只读授权。
- `DELETE /v1/pairing/peers/{peerId}`：撤销并断开连接。
- `GET /v1/pairing/discovered`、`POST /v1/pairing/manual-discovery`：列出 mDNS 地址提示或认证手动 IP；发现不改变信任状态。

这些管理路由只接受 `PHOTOMESH_ADMIN_TOKEN`。图库索引读接口和 Noise 私有协议每次都再执行节点信任与图库 ACL 检查；未配置访问授权器时 HTTP 索引读默认拒绝。
