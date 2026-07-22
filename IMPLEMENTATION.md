# VPetLLM 远端聊天实施记录与实现说明

## 1. 项目目标

本项目为 VPetLLM 增加远端 Web 聊天能力，使通过配对授权的浏览器可以把文本发送到桌面端 VPetLLM，并获得接近本地聊天的处理效果。

系统由三部分组成：

1. Go WebSocket 中继服务：只负责转发加密信封。
2. Next.js Web UI：负责浏览器端配对、加密、聊天显示和插件执行状态显示。
3. VPetLLM RemoteChatPlugin：负责连接中继、解密远端输入、调用 VPetLLM 内部方法并加密返回处理结果。

端到端加密的范围是：

```text
浏览器 Web UI  <==== AES-256-GCM 密文 ====>  RemoteChatPlugin
                                                |
                                                v
                                  VPetLLM 原有模型请求与本地处理管线
```

## 2. 最终目录结构

```text
VPetLLM-RemoteChat/
├─ server/                 Go WebSocket 中继服务
├─ web/                    Next.js 远端聊天页面
├─ README.md               部署与使用说明
├─ PROTOCOL.md             线协议说明
└─ IMPLEMENTATION.md       本实施记录

VPetLLM/
├─ RemoteChatApi.cs
└─ Core/RemoteChat/
   └─ RemoteChatSessionContext.cs

VPetLLM_Plugin/
└─ RemoteChatPlugin/
   ├─ RemoteChatPlugin.cs
   ├─ RemoteChatConnection.cs
   ├─ ProtocolCrypto.cs
   ├─ WindowsDataProtection.cs
   ├─ RemoteChatSettings.cs
   └─ Checks/
```

编译生成的 `bin/`、`obj/` 和 `plugin/` 目录已加入忽略规则，不属于需要上传的源码内容。

## 3. 完成过程

### 3.1 分析现有项目

首先分析了以下代码：

- VPetLLM 的 `ChatCore`、`TalkBox`、`SmartMessageProcessor` 和 `ActionProcessor`。
- `PluginHandler` 和 `ResultAggregator` 的插件执行与结果回灌流程。
- `VPetLLM_Plugin/OneBotPlugin` 接收外部消息并调用 VPetLLM 的方式。
- VPetLLM 插件加载接口、配置保存方式和卸载流程。

OneBotPlugin 证明外部来源可以通过 `VPetLLM.SendChat` 进入完整聊天流程，但它需要在插件侧读取聊天历史，并针对 OneBot 指令做额外解析。这种方式不适合作为通用远端 Web 接口，因此本项目把正式的远端入口实现到了 VPetLLM 内部。

### 3.2 建立中继服务

Go 服务最初实现了独立 WebSocket 路径，后按需求调整为根端点：

```text
wss://chat.example.com/
```

旧 `/ws` 端点已移除，并增加了回归测试以确认它返回 404。

中继服务具有以下约束：

- 房间只保存在内存中。
- 不保存离线消息。
- 每个房间只允许一个 `browser` 和一个 `plugin` 角色在线。
- 使用配对密钥派生的验证器确认双方属于同一个房间。
- 服务端只能看到房间标识、角色、连接时间、帧尺寸和密文。
- 限制消息尺寸、消息频率和 Origin。
- 生产环境可以强制要求 TLS 反向代理。

### 3.3 构建 Next.js Web UI

Web UI 实现了：

- 从 URL fragment 读取房间、密钥和 WebSocket 服务地址。
- 密钥读取后立即从地址栏和浏览器历史中移除。
- 使用 Web Crypto API 派生密钥并执行 AES-256-GCM 加解密。
- 在页面内存中保存当前聊天，不写入 Cookie 或 localStorage。
- 显示连接状态、助手文本、插件调用参数和插件执行结果。
- 丢弃重复消息、过期消息和认证失败的密文。
- 设置 CSP、Referrer-Policy、禁止 iframe、禁止摄像头和麦克风等安全响应头。

### 3.4 将远端聊天能力加入 VPetLLM

VPetLLM 新增了：

```csharp
Task<RemoteChatResponse> SendRemoteChatAsync(
    string text,
    CancellationToken cancellationToken = default)
```

该方法负责：

1. 验证远端文本非空且不超过 4000 字符。
2. 串行化远端请求，防止多个远端消息同时改变上下文。
3. 建立独立的远端会话事件收集上下文。
4. 调用 VPetLLM 原有 `SendChat`。
5. 等待响应处理器、动作处理器、插件和结果回灌完成。
6. 返回助手输出和插件事件列表。

远端输入实际经过：

```text
SendRemoteChatAsync
    -> SendChat
    -> ChatCore
    -> ResponseHandler / StreamingCommandProcessor
    -> SmartMessageProcessor
    -> ActionProcessor
    -> PluginHandler
    -> ResultAggregator
    -> 后续模型回复
```

因此远端聊天不是单独调用一次 LLM，而是复用 VPetLLM 本地聊天的上下文、动作和插件处理能力。

### 3.5 收集助手输出

`ChatCoreBase` 的普通响应处理器和流式响应处理器增加了远端会话观察点。

当调用来源属于远端会话时，以下内容会被收集：

- 非流式完整回复。
- 流式输出片段。
- 插件结果回灌后生成的后续回复。

本地聊天没有远端会话上下文，因此正常情况下不会被错误转发到远端浏览器。

### 3.6 收集插件事件

`PluginHandler` 增加了两个远端事件：

```text
plugin_started
plugin_completed
```

事件包含：

- 插件名称。
- 调用参数。
- 返回结果。
- 成功或失败状态。

插件仍由原有 `PluginHandler` 执行，RemoteChatPlugin 不会重复执行插件。`ResultAggregator` 仍会把插件结果回灌给模型，后续助手输出也属于同一个远端会话。

### 3.7 迁移 RemoteChatPlugin

插件最终移动到：

```text
VPetLLM_Plugin/RemoteChatPlugin
```

插件只负责以下工作：

1. 管理服务地址、Web 地址、房间和配对密钥。
2. 连接 Go WebSocket 中继并自动重连。
3. 验证和解密浏览器消息。
4. 调用 `_vpetLLM.SendRemoteChatAsync(text)`。
5. 将助手输出和插件事件加密后发回浏览器。
6. 在卸载时关闭连接并释放密钥材料。

插件不再通过读取聊天历史猜测最终回复，也不再自行解析并执行模型生成的插件指令。

### 3.8 改进本地密钥保护

最初采用 `System.Security.Cryptography.ProtectedData` NuGet 依赖。由于现有插件分发方式通常只下载一个 DLL，这会造成用户安装后缺少依赖程序集。

最终改为通过 P/Invoke 调用 Windows 原生 DPAPI：

```text
CryptProtectData
CryptUnprotectData
```

这样可以：

- 使用当前 Windows 用户身份保护配对密钥。
- 避免明文密钥写入设置数据库。
- 保持 RemoteChatPlugin 单 DLL 分发。
- 避免额外运行库丢失。

`Checks` 项目会真实执行一次 DPAPI 加密和解密，并比较解密结果是否与原始随机数据一致。

## 4. 端到端加密实现

### 4.1 配对材料

插件生成：

- 16 字节随机 `room_id`。
- 32 字节随机 `secret`。

浏览器通过 URL fragment 获取配对材料：

```text
https://chat.example.com/#room=...&secret=...&server=wss%3A%2F%2Fchat.example.com%2F
```

fragment 不会作为 HTTP 请求路径发送给 Web 服务或反向代理。

### 4.2 密钥派生

使用 HKDF-SHA256 从配对密钥派生两个相互隔离的密钥：

```text
encryption_key = HKDF(secret, "vpetllm-remote-chat/v1/encryption")
auth_key       = HKDF(secret, "vpetllm-remote-chat/v1/authentication")
```

`encryption_key` 用于消息加密，`auth_key` 用于生成中继房间验证器。中继知道验证器，但不能由此恢复消息加密密钥。

### 4.3 消息加密

每条消息使用：

- AES-256-GCM。
- 独立的 12 字节随机 nonce。
- 独立的 16 字节随机消息 ID。
- 房间号和消息 ID 组成认证附加数据。

认证附加数据为：

```text
vpetllm-remote-chat/v1|{room_id}|{message_id}
```

修改房间号、消息 ID、nonce、密文或认证标签都会导致解密失败。

### 4.4 重放限制

浏览器和插件分别保存最近 512 个消息 ID，重复消息会被丢弃。加密载荷还包含 UTC 时间，双方拒绝与本机时间相差超过 5 分钟的消息。

## 5. Web UI 接收的事件

VPetLLM 处理结束后，插件发送 `chat_result`：

```json
{
  "type": "chat_result",
  "request_id": "uuid",
  "sent_at": "RFC3339",
  "events": [
    {
      "kind": "assistant",
      "content": "我来查询天气。"
    },
    {
      "kind": "plugin_started",
      "plugin_name": "weather",
      "arguments": "city(台北)"
    },
    {
      "kind": "plugin_completed",
      "plugin_name": "weather",
      "result": "晴，31℃",
      "success": true
    }
  ]
}
```

整个 `chat_result` 是 AES-GCM 加密载荷的一部分，中继无法读取插件参数或插件结果。

为了控制帧尺寸，单次返回最多转发 64 个事件，并对助手内容、插件参数和插件结果设置长度上限。

## 6. 配置和配对流程

保存公开端点：

```text
<|plugin_remote_chat_begin|>
action(configure), server(wss://chat.example.com/), web(https://chat.example.com)
<|plugin_remote_chat_end|>
```

复制配对链接：

```text
<|plugin_remote_chat_begin|>
action(pair)
<|plugin_remote_chat_end|>
```

配对链接只写入本机剪贴板，不会作为插件返回文本交给 LLM。剪贴板内容如果没有发生变化，会在两分钟后自动清除。

其他操作：

- `action(status)`：查看连接状态。
- `action(reconnect)`：重新连接中继。
- `action(rotate)`：撤销旧密钥并生成新的配对链接。

## 7. 验证过程

完成实现后执行了以下检查：

### Go 服务

```powershell
go test ./...
go vet ./...
```

覆盖内容包括：

- Hello 信封校验。
- 房间验证器校验。
- 密文原样转发。
- 跨房间消息拒绝。
- 根路径 `/` WebSocket 连接。
- 旧 `/ws` 路径返回 404。

### Next.js Web UI

```powershell
npm audit --audit-level=moderate
npm run lint
npm run build
```

结果：类型检查和生产构建通过，依赖审计为 0 个已知漏洞。

### VPetLLM 与插件

```powershell
dotnet build VPetLLM.csproj -c Release
dotnet build RemoteChatPlugin.csproj -c Release
dotnet run --project Checks/RemoteChatPlugin.Checks.csproj -c Release
```

结果：

- VPetLLM 核心构建通过。
- RemoteChatPlugin 构建通过。
- Windows DPAPI 往返检查通过。
- VPetLLM 原有插件回归检查通过。

## 8. 当前能力

目前支持：

- 远端纯文本聊天。
- VPetLLM 原有上下文和聊天历史策略。
- 普通回复和流式模型输出采集。
- 本地动作处理管线。
- 模型触发 VPetLLM 插件。
- 插件参数、结果和失败状态转发到 Web UI。
- 插件结果回灌模型后的后续回复。
- 浏览器到插件之间的端到端加密。
- 自动重连、速率限制、尺寸限制和基础重放限制。

## 9. 当前边界

当前尚未把所有桌面状态同步到 Web UI，例如：

- TTS 播放进度。
- 当前动画和动画进度。
- 桌宠属性和实时状态。
- 本地气泡逐字打印状态。
- 图片、音频和文件消息。
- 主动从桌面端推送的非聊天事件。

远端配对者能够向本地完整聊天管线发送内容，并可能诱导模型调用已经启用的插件。因此配对链接应被视为高权限凭证，不应交给不受信任的人。

## 10. 主要源码入口

- Go 中继：`VPetLLM-RemoteChat/server/main.go`
- Web 页面：`VPetLLM-RemoteChat/web/app/page.tsx`
- 浏览器加密：`VPetLLM-RemoteChat/web/app/crypto.ts`
- VPetLLM 远端入口：`VPetLLM/RemoteChatApi.cs`
- 远端事件上下文：`VPetLLM/Core/RemoteChat/RemoteChatSessionContext.cs`
- 插件事件捕获：`VPetLLM/Handlers/Actions/PluginHandler.cs`
- 插件入口：`VPetLLM_Plugin/RemoteChatPlugin/RemoteChatPlugin.cs`
- WebSocket 与消息处理：`VPetLLM_Plugin/RemoteChatPlugin/RemoteChatConnection.cs`
- 插件加密：`VPetLLM_Plugin/RemoteChatPlugin/ProtocolCrypto.cs`
- Windows DPAPI：`VPetLLM_Plugin/RemoteChatPlugin/WindowsDataProtection.cs`
