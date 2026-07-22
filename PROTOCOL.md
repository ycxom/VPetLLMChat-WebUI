# VPetLLM Remote Chat Protocol v1

服务端只识别 JSON 外层信封，不接触加密载荷。所有字段名和字符串均使用 UTF-8。

## 配对材料

- `room_id`：16 个随机字节的 base64url（无填充）表示，作为不可枚举的房间标识。
- `secret`：32 个随机字节的 base64url（无填充）表示，只存在于插件本机和配对浏览器。
- 浏览器配对链接把三项参数放在 URL fragment：`#room=...&secret=...&server=wss%3A...`。fragment 不会随 HTTP 请求发送。

使用 RFC 5869 HKDF-SHA256 派生两个 32 字节密钥。HKDF 的 `salt` 是 UTF-8 编码的 `room_id`：

```text
encryption_key = HKDF(secret, info="vpetllm-remote-chat/v1/encryption")
auth_key       = HKDF(secret, info="vpetllm-remote-chat/v1/authentication")
verifier       = HMAC-SHA256(auth_key, "vpetllm-remote-chat/v1/server-auth")
```

`verifier` 允许中继校验同房间的双方持有同一配对材料，但 HKDF 的域分离使中继不能用它恢复 `encryption_key`。

## WebSocket

连接 WebSocket 根端点 `/` 后必须首先发送：

```json
{"type":"hello","v":1,"room_id":"...","role":"plugin","verifier":"..."}
```

`role` 只能是 `plugin` 或 `browser`；同一房间每种角色只允许一个在线连接。服务端以 `presence` 控制帧通知对端是否在线：

```json
{"type":"presence","v":1,"peer_online":true}
```

## 加密消息

每条消息生成新的 12 字节随机 `nonce` 和 16 字节随机 `message_id`。采用 AES-256-GCM，认证附加数据为：

```text
vpetllm-remote-chat/v1|{room_id}|{message_id}
```

`ciphertext` 是 `密文 || 16字节GCM标签` 的 base64url 表示：

```json
{"type":"relay","v":1,"room_id":"...","message_id":"...","nonce":"...","ciphertext":"..."}
```

浏览器到插件的明文载荷：

```json
{"type":"chat","request_id":"uuid","sent_at":"RFC3339","text":"你好"}
```

插件到浏览器的明文载荷包含 VPetLLM 本地处理管线产生的事件：

```json
{
  "type":"chat_result",
  "request_id":"uuid",
  "sent_at":"RFC3339",
  "events":[
    {"kind":"assistant","content":"你好呀"},
    {"kind":"plugin_started","plugin_name":"weather","arguments":"city(台北)"},
    {"kind":"plugin_completed","plugin_name":"weather","result":"晴，31℃","success":true}
  ]
}
```

传输或 VPetLLM 处理错误使用 `{"type":"error", ...}`。双方保存最近 512 个 `message_id`，重复值作为重放消息丢弃；双方还会拒绝与本机 UTC 时间相差超过 5 分钟的载荷，以限制跨重启重放窗口。部署机器必须保持时钟同步。

### 交互请求（处理管线中途双向消息）

某些插件（如终端命令、应用启动）在执行前需要用户批准。处理进行中，插件到浏览器发送 `interaction_request`：

```json
{
  "type":"interaction_request",
  "request_id":"uuid",
  "interaction_id":"32位十六进制",
  "sent_at":"RFC3339",
  "kind":"confirm",
  "source":"terminal",
  "title":"终端 - 命令确认",
  "message":"AI 请求执行以下命令…",
  "default_value":"ls -la",
  "choices":null,
  "confirm_text":"执行",
  "cancel_text":"取消"
}
```

`kind` 取值 `confirm` / `input` / `choice` / `warning`。`default_value` 非空表示正文可编辑（如可修改的命令）；`choices` 非空表示单选。浏览器渲染后由用户决定，回送 `interaction_response`：

```json
{"type":"interaction_response","interaction_id":"…","sent_at":"RFC3339","confirmed":true,"value":"编辑后的命令或选中项"}
```

`interaction_id` 关联一次请求与其应答。桌面端为每个挂起交互设有超时（默认 2 分钟，部分插件更短），超时、通道断开或应答缺失一律按“拒绝”处理（安全默认）。等待应答期间远端会话不会被判定为空闲、不会提前收尾。高危插件（终端等）应提供“是否允许远端应答”的开关，默认关闭——持有配对链接者的一次“同意”等同于在本机批准该操作。

## 限制

- WebSocket JSON 帧最大 96 KiB，`ciphertext` 字符串最大 64 KiB。
- 单连接 10 秒内最多 20 条中继消息。
- 聊天文本默认最大 4000 个 UTF-16 字符。
- 中继不存储离线消息；任一端离线时发送的消息会丢弃。
