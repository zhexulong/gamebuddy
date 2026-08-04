import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Bubble = { id: string; text: string; mine: boolean };
type Bootstrap = { csrf: string; companion: { name: string; profileId: string; revision: number }; session: { id: string; surface: "chat" }; continuity: { id: string | null }; transcript: Array<{ entryId: string; role: "player" | "companion"; text: string }>; worldBook: { worldBookId: string; revision: number } | null };

function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("正在连接…");
  const csrf = useRef("");
  const bootstrapStarted = useRef(false);

  useEffect(() => {
    // React StrictMode deliberately re-runs effects in development. The
    // bootstrap capability is single-use, so only one effect may consume it.
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("boot");
    if (!token) { setStatus("需要从 GameBuddy 启动此页面。"); return; }
    void fetch("/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (response) => response.ok ? response.json() as Promise<Bootstrap> : Promise.reject())
      .then((value) => {
        csrf.current = value.csrf; setBoot(value); setBubbles(value.transcript.map((entry) => ({ id: entry.entryId, text: entry.text, mine: entry.role === "player" }))); history.replaceState(null, "", "/"); setStatus("已连接");
        const events = new EventSource("/events");
        events.addEventListener("presentation_text", (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as { expressionId: string; text: string };
          setBubbles((old) => [...old, { id: data.expressionId, text: data.text, mine: false }]);
        });
        events.addEventListener("turn_started", () => setStatus("正在回应…"));
        events.addEventListener("turn_completed", () => setStatus("已连接"));
        events.addEventListener("turn_cancelled", () => setStatus("已停止"));
        events.addEventListener("turn_failed", () => setStatus("暂时无法回复，请重试。"));
        events.onerror = () => setStatus("连接已断开");
        return () => events.close();
      })
      .catch(() => setStatus("无法建立对话连接。"));
  }, []);

  async function send() {
    const line = text.trim();
    if (!boot || line.length === 0) return;
    const id = crypto.randomUUID();
    setBubbles((old) => [...old, { id, text: line, mine: true }]); setText(""); setStatus("正在发送…");
    const response = await fetch("/message", { method: "POST", headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf.current }, body: JSON.stringify({ clientMessageId: id, text: line, locale: "zh-CN" }) });
    if (!response.ok) setStatus("暂时无法发送这条消息。");
  }
  async function stop() {
    if (!boot) return;
    await fetch("/stop", { method: "POST", headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf.current }, body: JSON.stringify({ clientStopId: crypto.randomUUID() }) });
  }
  return <main className="app"><aside><div className="orb">✦</div><h1>{boot?.companion.name ?? "GameBuddy"}</h1><p>{boot ? `Profile · ${boot.companion.profileId} v${boot.companion.revision}` : ""}</p><p className="surface">{boot ? "聊天" : ""}</p>{boot?.worldBook && <p className="worldbook">WorldBook · {boot.worldBook.worldBookId} v{boot.worldBook.revision}</p>}<small>{status}</small></aside><section><header><span>聊天</span><button onClick={() => void stop()} disabled={!boot}>停止</button></header><div className="messages">{bubbles.length === 0 && <div className="welcome">从一句话开始吧。</div>}{bubbles.map((bubble) => <article className={bubble.mine ? "bubble mine" : "bubble"} key={bubble.id}>{bubble.text}</article>)}</div><form onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入消息…" maxLength={4000} disabled={!boot} /><button type="submit" disabled={!boot || text.trim().length === 0}>发送</button></form></section></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
