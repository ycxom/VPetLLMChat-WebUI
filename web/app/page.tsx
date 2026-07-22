"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { decryptPayload, deriveKeys, encryptPayload, RelayEnvelope } from "./crypto";

type ChatMessage = { id: string; role: "user" | "assistant" | "plugin" | "system"; text: string };
type Status = "initializing" | "connecting" | "waiting" | "online" | "offline" | "error";
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

export default function ChatPage() {
  const [status, setStatus] = useState<Status>("initializing");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
  const [interactionValue, setInteractionValue] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const roomRef = useRef("");
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get("room") ?? "";
    const secret = params.get("secret") ?? "";
    const server = params.get("server") ?? "";
    if (!/^[A-Za-z0-9_-]{22,32}$/.test(room) || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !validWsUrl(server)) {
      setStatus("error");
      setMessages([{ id: "setup", role: "system", text: "配对链接无效。请在 VPetLLM 的 remote_chat 插件中重新复制配对链接。" }]);
      return;
    }

    // Remove the secret from the address bar and browser history as soon as it is consumed.
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${encodeURIComponent(room)}`);
    roomRef.current = room;
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
        } else if ((payload.type === "reply" || payload.type === "error") && typeof payload.text === "string") {
          setMessages((current) => [...current, { id: frame.message_id as string, role: "assistant", text: payload.text as string }]);
        }
      } catch {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: "收到无法验证的消息，已丢弃。" }]);
      }
    }

    return () => {
      disposed = true;
      socketRef.current?.close();
      keyRef.current = null;
    };
  }, []);

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
