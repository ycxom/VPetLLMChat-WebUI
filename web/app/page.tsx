"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { decryptPayload, deriveKeys, encryptPayload, RelayEnvelope } from "./crypto";

type ChatMessage = { id: string; role: "user" | "assistant" | "plugin" | "system"; text: string };
type Status = "initializing" | "need_key" | "connecting" | "waiting" | "online" | "offline" | "error";
type ConnectParams = { room: string; secret: string; server: string };
type PendingInteraction = {
  interactionId: string;
  kind: string;
  source: string;
  title: string;
  message: string;
  defaultValue: string | null;
  choices: string[] | null;
  confirmText: string;
  cancelText: string;
};

function visibleAssistantText(raw: string): string {
  return raw
    .replace(/<\|plugin_[A-Za-z0-9_]+_begin\|>[\s\S]*?<\|plugin_[A-Za-z0-9_]+_end\|>/g, "")
    .replace(/<\|(say|talk)_begin\|>([\s\S]*?)<\|\1_end\|>/g, "$2")
    .replace(/<\|([A-Za-z0-9_]+)_begin\|>[\s\S]*?<\|\1_end\|>/g, "")
    .trim();
}

function validWsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function validParams(p: ConnectParams): boolean {
  return /^[A-Za-z0-9_-]{22,32}$/.test(p.room) && /^[A-Za-z0-9_-]{43}$/.test(p.secret) && validWsUrl(p.server);
}

// 解析插件生成的接入密钥 vpl1_<base64url(server\nroom\nsecret)>。
function parseAccessKey(token: string): ConnectParams | null {
  try {
    const trimmed = token.trim();
    if (!trimmed.startsWith("vpl1_")) return null;
    let b64 = trimmed.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    b64 = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const [server, room, secret] = text.split("\n");
    const params = { server: server ?? "", room: room ?? "", secret: secret ?? "" };
    return validParams(params) ? params : null;
  } catch {
    return null;
  }
}

export default function ChatPage() {
  const [status, setStatus] = useState<Status>("initializing");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
  const [interactionValue, setInteractionValue] = useState("");
  const [connectParams, setConnectParams] = useState<ConnectParams | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const roomRef = useRef("");
  const seenRef = useRef(new Set<string>());
  const historyRequestedRef = useRef(false);

  // 挂载时解析接入参数：优先 URL 中的 key/room 片段；否则进入手动输入密钥界面。
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const key = params.get("key");
    if (key) {
      const parsed = parseAccessKey(key);
      if (parsed) {
        history.replaceState(null, "", `${location.pathname}${location.search}`);
        setConnectParams(parsed);
        return;
      }
    }
    const legacy: ConnectParams = {
      room: params.get("room") ?? "",
      secret: params.get("secret") ?? "",
      server: params.get("server") ?? "",
    };
    if (validParams(legacy)) {
      history.replaceState(null, "", `${location.pathname}${location.search}#room=${encodeURIComponent(legacy.room)}`);
      setConnectParams(legacy);
      return;
    }
    setStatus("need_key");
  }, []);

  // 有了接入参数后建立加密连接。
  useEffect(() => {
    if (!connectParams) return;
    const { room, secret, server } = connectParams;
    let disposed = false;
    roomRef.current = room;
    historyRequestedRef.current = false;
    seenRef.current = new Set<string>();
    setStatus("connecting");

    void deriveKeys(secret, room).then(({ encryptionKey, verifier }) => {
      if (disposed) return;
      keyRef.current = encryptionKey;
      const ws = new WebSocket(server);
      socketRef.current = ws;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "hello", v: 1, room_id: room, role: "browser", verifier }));
        setStatus("waiting");
      });
      ws.addEventListener("message", (event) => void handleFrame(event.data));
      ws.addEventListener("close", () => !disposed && setStatus("offline"));
      ws.addEventListener("error", () => !disposed && setStatus("error"));
    }).catch(() => setStatus("error"));

    async function handleFrame(raw: unknown) {
      if (typeof raw !== "string" || disposed) return;
      try {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type === "presence" && typeof frame.peer_online === "boolean") {
          setStatus(frame.peer_online ? "online" : "waiting");
          if (frame.peer_online) void requestHistory();
          return;
        }
        if (frame.type !== "relay" || !keyRef.current || frame.room_id !== room || typeof frame.message_id !== "string") return;
        if (seenRef.current.has(frame.message_id)) return;
        seenRef.current.add(frame.message_id);
        if (seenRef.current.size > 512) seenRef.current.delete(seenRef.current.values().next().value!);
        const payload = await decryptPayload(keyRef.current, room, frame as unknown as RelayEnvelope) as Record<string, unknown>;
        const sentAt = typeof payload.sent_at === "string" ? Date.parse(payload.sent_at) : Number.NaN;
        if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) return;
        if (payload.type === "chat_result" && Array.isArray(payload.events)) {
          const rendered: ChatMessage[] = [];
          payload.events.slice(0, 64).forEach((item, index) => {
            if (!item || typeof item !== "object") return;
            const event = item as Record<string, unknown>;
            if (event.kind === "assistant" && typeof event.content === "string") {
              const text = visibleAssistantText(event.content);
              if (text) rendered.push({ id: `${frame.message_id}-${index}`, role: "assistant", text });
            } else if (event.kind === "plugin_started" && typeof event.plugin_name === "string") {
              const args = typeof event.arguments === "string" && event.arguments.trim() ? `\n${event.arguments}` : "";
              rendered.push({ id: `${frame.message_id}-${index}`, role: "plugin", text: `正在调用插件：${event.plugin_name}${args}` });
            } else if (event.kind === "plugin_completed" && typeof event.plugin_name === "string") {
              const result = typeof event.result === "string" && event.result.trim() ? `\n${event.result}` : "";
              rendered.push({ id: `${frame.message_id}-${index}`, role: "plugin", text: `${event.success === false ? "插件调用失败" : "插件调用完成"}：${event.plugin_name}${result}` });
            }
          });
          if (rendered.length === 0) rendered.push({ id: frame.message_id as string, role: "system", text: "VPetLLM 已完成处理。" });
          setMessages((current) => [...current, ...rendered]);
        } else if (payload.type === "interaction_request" && typeof payload.interaction_id === "string") {
          const choices = Array.isArray(payload.choices)
            ? (payload.choices as unknown[]).filter((c): c is string => typeof c === "string")
            : null;
          const defaultValue = typeof payload.default_value === "string" ? payload.default_value : null;
          setInteractionValue(choices?.[0] ?? defaultValue ?? "");
          setInteraction({
            interactionId: payload.interaction_id,
            kind: typeof payload.kind === "string" ? payload.kind : "confirm",
            source: typeof payload.source === "string" ? payload.source : "",
            title: typeof payload.title === "string" ? payload.title : "确认请求",
            message: typeof payload.message === "string" ? payload.message : "",
            defaultValue,
            choices: choices && choices.length > 0 ? choices : null,
            confirmText: typeof payload.confirm_text === "string" ? payload.confirm_text : "确定",
            cancelText: typeof payload.cancel_text === "string" ? payload.cancel_text : "取消",
          });
        } else if (payload.type === "history_snapshot" && Array.isArray(payload.messages)) {
          const history: ChatMessage[] = [];
          payload.messages.slice(0, 100).forEach((item, index) => {
            if (!item || typeof item !== "object") return;
            const m = item as Record<string, unknown>;
            const role: ChatMessage["role"] = m.role === "assistant" ? "assistant" : "user";
            let text = typeof m.content === "string" ? m.content : "";
            if (role === "assistant") text = visibleAssistantText(text);
            text = text.trim();
            if (text) history.push({ id: `hist-${index}`, role, text });
          });
          // 历史置于顶部；不覆盖本会话已产生的实时消息。
          setMessages((current) => [...history, ...current.filter((x) => !x.id.startsWith("hist-"))]);
        } else if (payload.type === "disconnect") {
          const reset = payload.reason === "key_reset";
          setMessages((current) => [...current, {
            id: crypto.randomUUID(), role: "system",
            text: reset ? "桌面端已断开此接入并重置了密钥，需要新的接入密钥才能再次连接。" : "桌面端已断开此接入。",
          }]);
          disposed = true;
          socketRef.current?.close();
          setStatus("offline");
        } else if ((payload.type === "reply" || payload.type === "error") && typeof payload.text === "string") {
          setMessages((current) => [...current, { id: frame.message_id as string, role: "assistant", text: payload.text as string }]);
        }
      } catch {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: "收到无法验证的消息，已丢弃。" }]);
      }
    }

    async function requestHistory() {
      if (historyRequestedRef.current) return;
      const ws = socketRef.current;
      const key = keyRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !key) return;
      historyRequestedRef.current = true;
      const frame = await encryptPayload(key, roomRef.current, {
        type: "history_request",
        sent_at: new Date().toISOString(),
      });
      ws.send(JSON.stringify(frame));
    }

    return () => {
      disposed = true;
      socketRef.current?.close();
      keyRef.current = null;
    };
  }, [connectParams]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    const ws = socketRef.current;
    const key = keyRef.current;
    if (!text || text.length > 4000 || status !== "online" || !ws || ws.readyState !== WebSocket.OPEN || !key) return;
    setInput("");
    const requestId = crypto.randomUUID();
    setMessages((current) => [...current, { id: requestId, role: "user", text }]);
    const frame = await encryptPayload(key, roomRef.current, {
      type: "chat",
      request_id: requestId,
      sent_at: new Date().toISOString(),
      text,
    });
    ws.send(JSON.stringify(frame));
  }

  function connectWithKey(event: FormEvent) {
    event.preventDefault();
    const parsed = parseAccessKey(keyInput);
    if (!parsed) {
      setKeyError("接入密钥无效。请在 VPetLLM 的 remote_chat 插件中「复制接入密钥」后粘贴。");
      return;
    }
    setKeyError("");
    setKeyInput("");
    setStatus("connecting");
    setConnectParams(parsed);
  }

  async function respondInteraction(confirmed: boolean) {
    const current = interaction;
    const ws = socketRef.current;
    const key = keyRef.current;
    setInteraction(null);
    if (!current || !ws || ws.readyState !== WebSocket.OPEN || !key) return;
    const value = confirmed
      ? (current.choices ? interactionValue : current.defaultValue !== null ? interactionValue : undefined)
      : undefined;
    const frame = await encryptPayload(key, roomRef.current, {
      type: "interaction_response",
      interaction_id: current.interactionId,
      sent_at: new Date().toISOString(),
      confirmed,
      value,
    });
    ws.send(JSON.stringify(frame));
  }

  const label: Record<Status, string> = {
    initializing: "正在初始化",
    need_key: "请输入接入密钥",
    connecting: "正在连接",
    waiting: "等待 VPetLLM 上线",
    online: "端到端加密已连接",
    offline: "连接已断开",
    error: "连接失败",
  };

  return (
    <main>
      <section className="chat" aria-label="VPetLLM 远端聊天">
        <header>
          <div>
            <h1>VPetLLM</h1>
            <p>远端聊天</p>
          </div>
          <span className={`status ${status}`}>{label[status]}</span>
        </header>
        <div className="notice">消息只在浏览器内解密，不保存聊天记录。关闭页面即清除本次会话。</div>
        {status === "need_key" ? (
          <form className="keyform" onSubmit={connectWithKey}>
            <p className="empty">粘贴 VPetLLM 的 remote_chat 插件生成的接入密钥以连接。</p>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="vpl1_…"
              aria-label="接入密钥"
              autoComplete="off"
            />
            {keyError && <p className="key-error">{keyError}</p>}
            <button type="submit" disabled={!keyInput.trim()}>连接</button>
          </form>
        ) : (
          <>
            <div className="messages" aria-live="polite">
              {messages.length === 0 && <p className="empty">连接桌面上的 VPetLLM 后即可开始聊天。</p>}
              {messages.map((message) => <div key={message.id} className={`message ${message.role}`}>{message.text}</div>)}
            </div>
            <form onSubmit={submit}>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                maxLength={4000}
                placeholder={status === "online" ? "输入消息…" : "等待安全连接…"}
                disabled={status !== "online"}
                aria-label="聊天消息"
              />
              <button type="submit" disabled={status !== "online" || !input.trim()}>发送</button>
            </form>
          </>
        )}
      </section>
      {interaction && (
        <div className="interaction-overlay" role="dialog" aria-modal="true" aria-label={interaction.title}>
          <div className="interaction-card">
            <h2>{interaction.title}</h2>
            {interaction.source && <p className="interaction-source">来自插件：{interaction.source}</p>}
            {interaction.message && <p className="interaction-message">{interaction.message}</p>}
            {interaction.choices ? (
              <select value={interactionValue} onChange={(e) => setInteractionValue(e.target.value)} aria-label="选择项">
                {interaction.choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : interaction.defaultValue !== null ? (
              <textarea
                value={interactionValue}
                onChange={(e) => setInteractionValue(e.target.value)}
                rows={4}
                aria-label="可编辑内容"
              />
            ) : null}
            <div className="interaction-actions">
              <button type="button" className="secondary" onClick={() => void respondInteraction(false)}>
                {interaction.cancelText}
              </button>
              <button type="button" onClick={() => void respondInteraction(true)}>
                {interaction.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
