# VPetLLM Remote Chat

这是一个给 VPetLLM 使用的远端聊天实现，包含 Go WebSocket 密文中继、Next.js 浏览器客户端和 .NET 8 VPetLLM 插件。中继没有数据库和消息队列，聊天正文采用 AES-256-GCM 端到端加密。

## 目录

```text
VPetLLM-RemoteChat/
├─ server/    Go WebSocket 密文中继
├─ web/       Next.js 浏览器聊天页
└─ PROTOCOL.md
```

插件源码位于同级仓库目录 `VPetLLM_Plugin/RemoteChatPlugin`；VPetLLM 内部远端聊天入口位于 `VPetLLM/RemoteChatApi.cs`。

## 本地运行

```powershell
# 终端 1
cd server
go run .

# 终端 2
cd web
npm install
npm run dev
```

也可以在本目录运行 `docker compose up --build`。默认仅绑定宿主机 `127.0.0.1:3000` 和 `127.0.0.1:8787`。

构建插件：

```powershell
cd ..\VPetLLM_Plugin\RemoteChatPlugin
dotnet build -c Release
```

将 `VPetLLM_Plugin/RemoteChatPlugin/plugin/RemoteChatPlugin.dll` 复制到“我的文档/VPetLLM/Plugin”。插件要求配套使用包含 `SendRemoteChatAsync` 的新版 VPetLLM。

## 配置与配对

插件不会在聊天文本、日志或服务端配置中打印密钥。通过插件调用先保存公开端点：

```text
<|plugin_remote_chat_begin|>
action(configure), server(wss://chat.example.com/), web(https://chat.example.com)
<|plugin_remote_chat_end|>
```

然后调用 `action(pair)`。插件只会把私人配对链接写入本机剪贴板，不会把链接作为插件结果返回；如果剪贴板内容没有变化，两分钟后会自动清除。把链接粘贴到需要远端聊天的浏览器即可。浏览器派生密钥后会立即从地址栏和浏览器历史中删除 `secret`。

其他操作：

- `action(status)`：查看连接状态和脱敏后的房间前缀。
- `action(reconnect)`：重新连接中继。
- `action(rotate)`：撤销旧配对链接、生成新密钥并把新链接复制到本机剪贴板。

## 生产部署

必须在 Go 服务和 Next.js 服务前部署 HTTPS 反向代理，并确保 WebSocket 转发保留 Upgrade 头。生产环境建议：

```text
ALLOWED_ORIGINS=https://chat.example.com
REQUIRE_TLS=true
ADDR=0.0.0.0:8787
```

不要把 `ALLOWED_ORIGINS` 设置为 `*`。反向代理必须把外部 HTTPS 协议写入 `X-Forwarded-Proto: https`。建议同时在入口层设置连接数限制、IP 限流和请求体上限。

## 安全边界

可以保证的内容：

- 中继只看到随机房间号、角色、时序、帧大小和密文，看不到聊天正文。
- 服务端不落盘、不缓存离线消息，默认日志不记录房间号、验证器或消息载荷。
- 配对密钥在 Windows 端使用当前用户 DPAPI 加密后保存；浏览器端只保存在当前页面内存。
- AES-GCM 同时提供机密性和篡改检测；房间号与消息 ID 被绑定为认证附加数据。
- 插件和网页都有消息长度、帧大小、速率与重放限制。
- 网络上的端到端加密范围是浏览器到 VPetLLM 插件；VPetLLM 仍按用户原有配置请求 LLM，不尝试把模型请求改造成不可解密格式。

无法由此项目隐藏的内容：

- VPetLLM 配置的 LLM 服务商必须看到用户正文才能生成回复；若使用云端模型，正文仍会发送给该服务商。需要避免第三方看到正文时，应在 VPetLLM 中使用本地 Ollama/LM Studio 等本地模型。
- 远端消息进入 VPetLLM 的标准聊天管线，是否写入本机聊天历史由 VPetLLM 的历史设置决定。配对者等同于受信任的本机聊天用户，也可能诱导模型调用已启用插件；不要把配对链接交给不信任的人。
- Web 端会收到经过同一条加密通道发送的助手输出、插件调用参数以及插件执行结果，以接近本地聊天的控制体验。
- 已被恶意软件控制的浏览器或 VPetLLM 主机可以在加密前读取正文；端到端加密不能保护失陷的端点。
- 网络观察者仍可看到连接时间和密文长度。TLS 与 E2EE 都不隐藏这些流量元数据。

详细线格式见 [PROTOCOL.md](./PROTOCOL.md)，完整开发过程和内部实现见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)。
