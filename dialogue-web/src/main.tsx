import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { messages, resolveLocale, setLocale, type Locale } from "./i18n";

type View =
  | "chat"
  | "characters"
  | "personas"
  | "scenarios"
  | "greetings"
  | "chats"
  | "new-character"
  | "new-chat"
  | "world"
  | "imports"
  | "memories"
  | "settings"
  | "game";
type Failure = Error & { status?: number; code?: string };
type Draft = { revision: number; text: string | null };
type Bootstrap = {
  csrf: string;
  memoryManagement?: { available: boolean };
  tavern?: { navigation: Array<{ id: string }> };
  companion: { name: string };
  transcript: Array<{ entryId: string; role: "player" | "companion"; text: string }>;
  draft?: Draft;
  worldBook: { worldBookId: string } | null;
};
type Companion = { handle: string; rowRef: string; name: string };
type CompanionDetail = { name: string };
type Chat = { handle: string; title?: string; openingSelection: { kind: string } };
type Catalog = {
  personas: Array<{ handle: string; name: string; description?: string }>;
  scenarios: Array<{ handle: string; name: string; preview: string }>;
  greetings: Array<{ handle: string; variants: Array<{ handle: string; name: string; preview: string }> }>;
};
type WorldView = {
  bindings: Array<{ bindingId: string; label: string; selected: boolean }>;
  activeChat: { chatThreadId: string; chatSurfaceSessionId: string; updatedAtMs: number } | null;
};
type ManagedWorldInfo = {
  revision: number;
  publicTitle: string;
  summary: string;
  entries: Array<{ scope: "companion" | "setting"; publicTitle: string; summary: string }>;
};
type ManagedWorldInfoBindings = {
  items: ManagedWorldInfo[];
  activeChat: { chatThreadId: string; chatSurfaceSessionId: string; updatedAtMs: number } | null;
  selectedPublicTitle: string | null;
};
type ImportResult = {
  candidate: {
    reviewId: string;
    fields: Array<{ reviewKey: string; label: "persona" | "interaction" | "style" | "other"; eligible: boolean }>;
  };
  report: { reviewId: string; dispositions: Array<{ status: "available" | "excluded" | "unavailable" }> };
};
type Bubble = { id: string; text: string; mine: boolean };

function App() {
  const [locale, setUiLocale] = useState<Locale>(() => resolveLocale());
  // UI chrome language is deliberately independent of message/presentation
  // language. This hint is captured once and never changes when the player
  // switches the Tavern interface between English and Chinese.
  const messageLocale = useRef(navigator.language || "en-US");
  const t = useMemo(() => messages(locale), [locale]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  // A refresh can reopen the same thread or activate a different exact thread.
  // It is intentionally an opaque UI generation: title metadata is scoped by
  // the Host's active selection and must never survive either transition.
  const [chatGeneration, setChatGeneration] = useState(0);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  // Explicit player permission for the immediately submitted turn only.
  const [allowInferredMemory, setAllowInferredMemory] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState("connecting");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [worldDraftDirty, setWorldDraftDirty] = useState(false);
  const worldDraftDirtyRef = useRef(false);
  const csrf = useRef("");
  const draftRevision = useRef(0);
  const started = useRef(false);
  const panelButton = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelCloseButton = useRef<HTMLButtonElement>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("boot");
    const request =
      token === null
        ? get<Bootstrap>("/refresh")
        : fetch("/bootstrap", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: location.origin },
            body: JSON.stringify({ token }),
          }).then(readResponse<Bootstrap>);
    void request
      .then((value) => connect(value, token !== null))
      .catch((error: unknown) => setStatus((error as Failure).status === 401 ? "offline" : "error"));
  }, []);
  function connect(value: Bootstrap, removeBootToken = false) {
    csrf.current = value.csrf;
    draftRevision.current = value.draft?.revision ?? 0;
    setChatGeneration((generation) => generation + 1);
    setBoot(value);
    setStatus("connected");
    setDraft(value.draft?.text ?? "");
    setDraftConflict(false);
    setBubbles(
      value.transcript.map((entry) => ({ id: entry.entryId, text: entry.text, mine: entry.role === "player" })),
    );
    if (removeBootToken) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    restorePanelFromLocation();
    eventsRef.current?.close();
    const events = new EventSource("/events");
    eventsRef.current = events;
    events.addEventListener("presentation_text", (event) => {
      if (eventsRef.current !== events) return;
      const item = JSON.parse((event as MessageEvent<string>).data) as { expressionId: string; text: string };
      setBubbles((old) => [...old, { id: item.expressionId, text: item.text, mine: false }]);
    });
    events.addEventListener("turn_started", () => {
      if (eventsRef.current === events) {
        setSending(false);
        setStatus("generating");
      }
    });
    events.addEventListener("turn_completed", () => {
      if (eventsRef.current === events) {
        setSending(false);
        setStatus("connected");
      }
    });
    events.addEventListener("turn_cancelled", () => {
      if (eventsRef.current === events) {
        setSending(false);
        setStatus("stopped");
      }
    });
    events.addEventListener("turn_failed", () => {
      if (eventsRef.current === events) {
        setSending(false);
        setStatus("error");
      }
    });
    events.onerror = () => {
      if (eventsRef.current === events) setStatus("offline");
    };
  }
  useEffect(() => {
    if (!panelOpen) return;
    const panel = panelRef.current;
    const closeButton = panelCloseButton.current;
    if (!panel || !closeButton) return;
    // Strict Mode can replay effects around the drawer mount; defer until this
    // instance is connected so opening focus is deterministic in real browsers.
    const focusFrame = requestAnimationFrame(() => {
      if (closeButton.isConnected) closeButton.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(panel);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      panel.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);
  useEffect(() => {
    worldDraftDirtyRef.current = worldDraftDirty;
  }, [worldDraftDirty]);
  useEffect(() => {
    const onPopState = () => {
      if (panelFromLocation() === null && worldDraftDirtyRef.current && !confirm(t.discardWorldInfoDraft)) {
        history.forward();
        return;
      }
      if (panelFromLocation() === null) setWorldDraftDirty(false);
      restorePanelFromLocation();
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, [t.discardWorldInfoDraft]);
  function panelFromLocation(): View | null {
    const candidate = new URL(location.href).searchParams.get("panel");
    if (candidate === "memories" && boot?.memoryManagement?.available !== true) return null;
    return candidate === "characters" ||
      candidate === "personas" ||
      candidate === "scenarios" ||
      candidate === "greetings" ||
      candidate === "chats" ||
      candidate === "new-character" ||
      candidate === "new-chat" ||
      candidate === "world" ||
      candidate === "imports" ||
      candidate === "memories" ||
      candidate === "settings" ||
      candidate === "game" ||
      candidate === "chat"
      ? candidate
      : null;
  }
  function restorePanelFromLocation() {
    const next = panelFromLocation();
    setView(next ?? "chat");
    setPanelOpen(next !== null);
    if (next === null) {
      const target = panelOpener.current?.isConnected
        ? panelOpener.current
        : panelButton.current?.isConnected
          ? panelButton.current
          : document.getElementById("main-content");
      requestAnimationFrame(() => target?.focus());
    }
  }
  function panelUrl(next: View | null): string {
    const url = new URL(location.href);
    if (next === null) url.searchParams.delete("panel");
    else url.searchParams.set("panel", next);
    return `${url.pathname}${url.search}`;
  }
  function openPanel(next: View) {
    if (view === "world" && next !== "world" && worldDraftDirtyRef.current && !confirm(t.discardWorldInfoDraft)) return;
    if (view === "world" && next !== "world") setWorldDraftDirty(false);
    const opening = !panelOpen;
    if (opening)
      panelOpener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : panelButton.current;
    history[opening ? "pushState" : "replaceState"]({ tavernPanel: next }, "", panelUrl(next));
    setView(next);
    setPanelOpen(true);
  }
  function togglePanel() {
    if (panelOpen) {
      closePanel();
      return;
    }
    openPanel("chat");
  }
  async function persistDraft(): Promise<boolean> {
    if (sending) return false;
    if (draft === "") return true;
    try {
      const value = await put<Draft>(
        "/chat-draft",
        { expectedRevision: draftRevision.current, text: draft },
        csrf.current,
      );
      draftRevision.current = value.revision;
      setDraft(value.text ?? "");
      setDraftConflict(false);
      return true;
    } catch (failure) {
      if ((failure as Failure).status === 409) setDraftConflict(true);
      else setNotice(t.failedDraftSave);
      return false;
    }
  }
  async function discardDraft() {
    if (switching || sending) return;
    try {
      const value = await del<Draft>("/chat-draft", { expectedRevision: draftRevision.current }, csrf.current);
      draftRevision.current = value.revision;
      setDraft("");
      setDraftConflict(false);
    } catch (failure) {
      if ((failure as Failure).status === 409) setDraftConflict(true);
      else setNotice(t.failedDraftSave);
    }
  }
  async function reloadDraft() {
    try {
      const value = await get<Draft>("/chat-draft");
      draftRevision.current = value.revision;
      setDraft(value.text ?? "");
      setDraftConflict(false);
    } catch {
      setNotice(t.failedLoad);
    }
  }
  async function send() {
    const line = draft.trim();
    if (!boot || !line || sending || switching || draftConflict || status === "generating") return;
    setSending(true);
    try {
      const result = await post<{ accepted: boolean; duplicate: boolean; clearToken?: string }>(
        "/message",
        {
          clientMessageId: crypto.randomUUID(),
          text: line,
          locale: messageLocale.current,
          ...(allowInferredMemory ? { memoryDelegation: true } : {}),
        },
        csrf.current,
      );
      if (result.accepted && result.clearToken) {
        setBubbles((old) => [...old, { id: crypto.randomUUID(), text: line, mine: true }]);
        const cleared = await del<Draft>(
          "/chat-draft",
          { expectedRevision: draftRevision.current, clearToken: result.clearToken },
          csrf.current,
        );
        draftRevision.current = cleared.revision;
        setDraft("");
        setAllowInferredMemory(false);
        setStatus("generating");
      } else {
        setNotice(t.failure);
      }
    } catch {
      setNotice(t.failedSend);
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    try {
      await post("/stop", { clientStopId: crypto.randomUUID() }, csrf.current);
      setStatus("stopped");
    } catch {
      setNotice(t.failure);
    }
  }
  async function reconnect() {
    try {
      connect(await get<Bootstrap>("/refresh"));
    } catch {
      setNotice(t.failedLoad);
    }
  }
  const statusText =
    status === "connected"
      ? t.connected
      : status === "generating"
        ? t.generating
        : status === "stopped"
          ? t.stopped
          : status === "offline"
            ? t.offline
            : status === "connecting"
              ? t.connecting
              : t.failure;
  function closePanel() {
    if (worldDraftDirtyRef.current && !confirm(t.discardWorldInfoDraft)) return;
    setWorldDraftDirty(false);
    if (panelFromLocation() !== null && history.state?.tavernPanel !== undefined) {
      history.back();
      return;
    }
    history.replaceState(history.state, "", panelUrl(null));
    setPanelOpen(false);
    setView("chat");
    const target = panelOpener.current?.isConnected
      ? panelOpener.current
      : panelButton.current?.isConnected
        ? panelButton.current
        : document.getElementById("main-content");
    requestAnimationFrame(() => target?.focus());
  }
  return (
    <div className="app-shell">
      <header className="app-bar">
        <button className="brand-button" onClick={() => openPanel("chat")} aria-label={t.chat}>
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <span>{t.appName}</span>
        </button>
        <div className="active-character">
          <span className="avatar avatar-small" aria-hidden="true">
            {boot?.companion.name.slice(0, 1) ?? "?"}
          </span>
          <strong>{boot?.companion.name ?? t.noCharacter}</strong>
        </div>
        <div className="bar-actions">
          <span className={`status status-${status}`}>
            <i aria-hidden="true" />
            <span role="status" aria-live="polite">
              {statusText}
            </span>
          </span>
          <button
            ref={panelButton}
            className="bar-button"
            onClick={togglePanel}
            aria-expanded={panelOpen}
            aria-label={t.menu}
          >
            {t.more}
          </button>
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <IconButton label={t.close} onClick={() => setNotice("")} icon="close" />
        </div>
      )}
      <a className="skip-link" href="#main-content">
        {locale === "zh-CN" ? "跳转到聊天" : "Skip to chat"}
      </a>
      <main className="main-content" id="main-content" tabIndex={-1}>
        {!boot ? (
          <Empty
            title={status === "offline" ? t.offline : t.loading}
            body={status === "offline" ? t.reconnect : ""}
            action={
              status === "offline" ? (
                <button className="primary-button" onClick={() => void reconnect()}>
                  {t.reconnect}
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ChatTitle key={chatGeneration} csrf={csrf.current} t={t} />
            <Chat
              bubbles={bubbles}
              draft={draft}
              setDraft={setDraft}
              allowInferredMemory={allowInferredMemory}
              setAllowInferredMemory={setAllowInferredMemory}
              sending={sending || switching || status === "generating"}
              draftConflict={draftConflict}
              onDiscard={() => void discardDraft()}
              onReload={() => void reloadDraft()}
              onSend={send}
              onStop={stop}
              onExport={() =>
                download("/interchange/chat/export", "chat.json", csrf.current).catch(() => setNotice(t.failure))
              }
              t={t}
            />
          </>
        )}
      </main>
      {panelOpen && boot && (
        <div
          className="panel-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePanel();
          }}
        >
          <aside
            ref={panelRef}
            className="context-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t.more}
            tabIndex={-1}
            data-testid="context-panel"
          >
            <div className="panel-header">
              <h2>
                {view === "chat"
                  ? t.characterContext
                  : view === "characters"
                    ? t.characters
                    : view === "personas"
                      ? t.personaManager
                      : view === "scenarios"
                        ? t.scenarioManager
                        : view === "greetings"
                          ? t.greetingManager
                          : view === "chats"
                            ? t.chatHistory
                            : view === "world"
                              ? t.worldInfo
                              : view === "memories"
                                ? "Memory"
                                : view === "new-chat"
                                  ? t.newChat
                                  : view === "new-character"
                                    ? t.newCharacter
                                    : view === "settings"
                                      ? t.settings
                                      : view === "game"
                                        ? t.gameStatus
                                        : t.importCard}
              </h2>
              <IconButton
                buttonRef={panelCloseButton}
                className="close-button"
                label={t.close}
                onClick={closePanel}
                icon="close"
              />
            </div>
            <PanelNav
              view={view}
              onSelect={openPanel}
              memoryManagementAvailable={boot.memoryManagement?.available === true}
              t={t}
            />
            <div className="panel-body">
              {view === "characters" && <Characters onNotice={setNotice} t={t} />}
              {view === "personas" && <PersonaManager csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "scenarios" && <ScenarioManager csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "greetings" && <GreetingManager csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "chats" && (
                <Chats
                  csrf={csrf.current}
                  onNotice={setNotice}
                  beforeOpen={async () => {
                    if (switching || sending) return false;
                    setSwitching(true);
                    try {
                      return await persistDraft();
                    } finally {
                      setSwitching(false);
                    }
                  }}
                  onOpened={(next) => {
                    connect(next);
                    setPanelOpen(false);
                    setView("chat");
                    setNotice(t.opened);
                  }}
                  t={t}
                />
              )}
              {view === "new-chat" && (
                <NewChat
                  csrf={csrf.current}
                  onNotice={setNotice}
                  beforeOpen={async () => {
                    if (switching || sending) return false;
                    setSwitching(true);
                    try {
                      return await persistDraft();
                    } finally {
                      setSwitching(false);
                    }
                  }}
                  onOpened={(next) => {
                    connect(next);
                    setPanelOpen(false);
                    setView("chat");
                    setNotice(t.opened);
                  }}
                  t={t}
                />
              )}
              {view === "world" && (
                <World csrf={csrf.current} onNotice={setNotice} onDirtyChange={setWorldDraftDirty} t={t} />
              )}
              {view === "imports" && <Imports csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "memories" && <Memories csrf={csrf.current} />}
              {view === "new-character" && <NewCharacter csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "settings" && <Settings csrf={csrf.current} onNotice={setNotice} t={t} />}
              {view === "game" && <GameStatus onNotice={setNotice} t={t} />}
              {view === "chat" && <CharacterContext boot={boot} t={t} />}
            </div>
            <div className="panel-footer">
              <label>
                {t.language}
                <select value={locale} onChange={(event) => setUiLocale(event.target.value as Locale)}>
                  <option value="en">{t.english}</option>
                  <option value="zh-CN">{t.chinese}</option>
                </select>
              </label>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function PanelNav({
  view,
  onSelect,
  memoryManagementAvailable,
  t,
}: {
  view: View;
  onSelect: (view: View) => void;
  memoryManagementAvailable: boolean;
  t: Record<string, string>;
}) {
  const items = [
    ["characters", t.characters, "characters"],
    ["personas", t.personaManager, "personas"],
    ["scenarios", t.scenarioManager, "scenarios"],
    ["greetings", t.greetingManager, "greetings"],
    ["new-character", t.newCharacter, "new-character"],
    ["chats", t.chatHistory, "chats"],
    ["new-chat", t.newChat, "new-chat"],
    ["world", t.worldInfo, "world"],
    ["imports", t.importCard, "imports"],
    ...(memoryManagementAvailable ? [["memories", "Memory", "memories"]] : []),
    ["settings", t.settings, "settings"],
    ["game", t.gameStatus, "game"],
  ] as const;
  return (
    <nav className="panel-nav" aria-label={t.more} data-testid="panel-navigation">
      {items.map(([id, label, target]) => (
        <button key={id} className={view === target ? "selected" : ""} onClick={() => onSelect(target as View)}>
          {label}
        </button>
      ))}
    </nav>
  );
}
function ChatTitle({ csrf, t }: { csrf: string; t: Record<string, string> }) {
  type Title = { title: string | null; revision: number };
  const [metadata, setMetadata] = useState<Title | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const value = await get<Title>("/chat-management");
      setMetadata(value);
      setDraft(value.title ?? "");
    } catch {
      setMetadata(null);
      setEditing(false);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => input.current?.focus());
  }, [editing]);
  async function save() {
    if (!metadata || saving) return;
    setSaving(true);
    setError(false);
    try {
      const updated = await put<Title>(
        "/chat-management/title",
        { title: draft, expectedRevision: metadata.revision },
        csrf,
      );
      setMetadata(updated);
      setDraft(updated.title ?? "");
      setEditing(false);
    } catch (failure) {
      if ((failure as Failure).status === 409) {
        const rejectedDraft = draft;
        await load();
        setDraft(rejectedDraft);
      }
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  const title = loading ? t.loading : metadata?.title || t.untitledChat;
  return (
    <div className="chat-title" data-testid="active-chat-title">
      <strong>{title}</strong>
      {!editing ? (
        <button
          className="text-button"
          disabled={loading || metadata === null}
          onClick={() => {
            setDraft(metadata?.title ?? "");
            setEditing(true);
          }}
        >
          {t.renameChat}
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {t.chatTitle}
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={128}
              disabled={saving}
            />
          </label>
          <button className="small-button" disabled={!draft.trim() || saving}>
            {saving ? t.saving : t.save}
          </button>
          <button
            className="text-button"
            type="button"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setError(false);
            }}
          >
            {t.cancel}
          </button>
        </form>
      )}
      {loadFailed && (
        <p role="status">
          {t.failedLoad}{" "}
          <button className="text-button" type="button" onClick={() => void load()}>
            {t.retryTitleLoad}
          </button>
        </p>
      )}
      {error && (
        <p role="alert">
          {t.failedSave}{" "}
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setError(false);
              void save();
            }}
          >
            {t.tryAgain}
          </button>
        </p>
      )}
    </div>
  );
}
function Chat({
  bubbles,
  draft,
  setDraft,
  allowInferredMemory,
  setAllowInferredMemory,
  sending,
  draftConflict,
  onDiscard,
  onReload,
  onSend,
  onStop,
  onExport,
  t,
}: {
  bubbles: Bubble[];
  draft: string;
  setDraft: (v: string) => void;
  allowInferredMemory: boolean;
  setAllowInferredMemory: (value: boolean) => void;
  sending: boolean;
  draftConflict: boolean;
  onDiscard: () => void;
  onReload: () => void;
  onSend: () => void;
  onStop: () => void;
  onExport: () => void;
  t: Record<string, string>;
}) {
  return (
    <section className="chat-view">
      <div className="timeline">
        {bubbles.length === 0 && <Empty title={t.blankChat} body={t.blankChatBody} />}
        {bubbles.map((bubble) => (
          <article className={`message ${bubble.mine ? "player" : "companion"}`} key={bubble.id}>
            {!bubble.mine && (
              <span className="avatar avatar-message" aria-hidden="true">
                G
              </span>
            )}
            <div className="message-body">
              <span className="message-author">{bubble.mine ? t.you : t.companion}</span>
              <p>{bubble.text}</p>
            </div>
          </article>
        ))}
      </div>
      {draftConflict && (
        <p className="draft-conflict" role="alert">
          {t.draftConflict}{" "}
          <button type="button" className="text-button" onClick={onReload}>
            {t.reload}
          </button>
        </p>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="composer-top">
          <label htmlFor="message-input">{t.compose}</label>
          <div>
            <button type="button" className="text-button" onClick={onExport} disabled={sending}>
              {t.exportChat}
            </button>
            <button type="button" className="text-button" onClick={onDiscard} disabled={sending || !draft}>
              {t.discardDraft}
            </button>
            <button type="button" className="text-button" onClick={onStop} disabled={sending}>
              {t.stop}
            </button>
          </div>
        </div>
        <label className="check composer-memory-delegation">
          <input
            type="checkbox"
            checked={allowInferredMemory}
            disabled={sending}
            onChange={(event) => setAllowInferredMemory(event.target.checked)}
          />
          Allow the companion to save one inferred semantic memory from this turn.
        </label>
        <div className="composer-row">
          <textarea
            id="message-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t.placeholder}
            maxLength={4000}
            disabled={sending}
          />
          <button className="send-button" type="submit" disabled={!draft.trim() || sending}>
            {sending ? t.generating : t.send}
          </button>
        </div>
      </form>
    </section>
  );
}
function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-line" aria-hidden="true" />
      <h1>{title}</h1>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
function CharacterContext({ boot, t }: { boot: Bootstrap; t: Record<string, string> }) {
  return (
    <section className="character-context">
      <div className="avatar avatar-large" aria-hidden="true">
        {boot.companion.name.slice(0, 1)}
      </div>
      <h3>{boot.companion.name}</h3>
      <p>{t.currentChat}</p>
      {boot.worldBook && (
        <p className="subtle">
          {t.worldInfo}: {t.inChat}
        </p>
      )}
    </section>
  );
}
function Characters({ onNotice, t }: { onNotice: (v: string) => void; t: Record<string, string> }) {
  const [items, setItems] = useState<Companion[] | null>(null);
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [loadingHandle, setLoadingHandle] = useState<string | null>(null);
  const [failedRowRef, setFailedRowRef] = useState<string | null>(null);
  const detailBackButton = useRef<HTMLButtonElement>(null);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  const detailOpenerRowRef = useRef<string | null>(null);
  const load = async (): Promise<Companion[] | null> => {
    setItems(null);
    try {
      const value = await get<{ companions: Companion[] }>("/library");
      setItems(value.companions);
      setFailedRowRef(null);
      return value.companions;
    } catch {
      onNotice(t.failedLoad);
      return null;
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (detail !== null) requestAnimationFrame(() => detailBackButton.current?.focus());
  }, [detail]);
  async function open(item: Companion, refreshHandle = false) {
    if (loadingHandle !== null) return;
    let target = item;
    if (refreshHandle) {
      setLoadingHandle(item.handle);
      const refreshed = await load();
      const replacement = refreshed?.find((candidate) => candidate.rowRef === item.rowRef);
      // A fresh projection that cannot prove the same row is never retried by
      // a player-readable name; selecting another same-name character is unsafe.
      if (replacement === undefined) {
        setFailedRowRef(item.rowRef);
        setLoadingHandle(null);
        return;
      }
      target = replacement;
    }
    setLoadingHandle(target.handle);
    setFailedRowRef(null);
    detailOpenerRowRef.current = target.rowRef;
    try {
      const value = await get<CompanionDetail>(`/library/${encodeURIComponent(target.handle)}`);
      setDetail(value);
    } catch {
      setFailedRowRef(target.rowRef);
    } finally {
      setLoadingHandle(null);
    }
  }
  if (detail !== null)
    return (
      <section className="character-detail" aria-label={t.characterDetails} data-testid="character-detail">
        <button
          ref={detailBackButton}
          className="text-button"
          type="button"
          onClick={() => {
            setDetail(null);
            requestAnimationFrame(() => detailOpener.current?.isConnected && detailOpener.current.focus());
          }}
        >
          {t.back}
        </button>
        <h3>{detail.name}</h3>
      </section>
    );
  return (
    <>
      {items === null ? (
        <p>{t.loading}</p>
      ) : items.length === 0 ? (
        <Empty title={t.noCharacters} body={t.noCharactersBody} />
      ) : (
        <div className="list">
          {items.map((item) => {
            const loading = loadingHandle === item.handle;
            const failed = failedRowRef === item.rowRef;
            return (
              <article className="list-row" key={item.rowRef}>
                <span className="avatar avatar-small" aria-hidden="true">
                  {item.name.slice(0, 1)}
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <p>{t.characters}</p>
                  {failed && (
                    <p className="inline-error" role="alert">
                      {t.failedCharacterDetails}
                    </p>
                  )}
                </div>
                <button
                  ref={item.rowRef === detailOpenerRowRef.current ? detailOpener : undefined}
                  className="small-button"
                  type="button"
                  disabled={loadingHandle !== null}
                  onClick={() => void open(item, failed)}
                >
                  {loading ? t.loading : failed ? t.tryAgain : t.details}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
function Chats({
  csrf,
  onNotice,
  onOpened,
  beforeOpen,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  onOpened: (v: Bootstrap) => void;
  beforeOpen: () => Promise<boolean>;
  t: Record<string, string>;
}) {
  const [data, setData] = useState<{ chats: Chat[]; activeHandle: string | null } | null>(null);
  const [openingHandle, setOpeningHandle] = useState<string | null>(null);
  const [failedHandle, setFailedHandle] = useState<string | null>(null);
  useEffect(() => {
    void get<typeof data>("/manage-chats")
      .then(setData)
      .catch(() => onNotice(t.failedLoad));
  }, []);
  async function open(chat: Chat) {
    if (openingHandle !== null) return;
    setFailedHandle(null);
    setOpeningHandle(chat.handle);
    try {
      if (!(await beforeOpen())) {
        setFailedHandle(chat.handle);
        return;
      }
      await post("/open-chat", { chatHandle: chat.handle }, csrf);
      const refreshed = await get<Bootstrap>("/refresh");
      onOpened(refreshed);
      onNotice(t.opened);
    } catch {
      setFailedHandle(chat.handle);
      onNotice(t.failedOpen);
    } finally {
      setOpeningHandle(null);
    }
  }
  return (
    <>
      {data === null ? (
        <p>{t.loading}</p>
      ) : data.chats.length === 0 ? (
        <Empty title={t.noHistory} body={t.noHistoryBody} />
      ) : (
        <div className="list">
          {data.chats.map((chat) => {
            const active = data.activeHandle === chat.handle;
            const opening = openingHandle === chat.handle;
            const failed = failedHandle === chat.handle;
            return (
              <article className="list-row" key={chat.handle}>
                <div>
                  <strong>{chat.title ?? (chat.openingSelection.kind === "blank" ? t.blankOpening : t.newChat)}</strong>
                  <p>{t.chat}</p>
                  {failed && (
                    <p className="inline-error" role="alert">
                      {t.failedOpen}
                    </p>
                  )}
                </div>
                <button
                  className="small-button"
                  disabled={active || openingHandle !== null}
                  onClick={() => void open(chat)}
                >
                  {active ? t.current : opening ? t.openingChat : failed ? t.tryAgain : t.open}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
function NewChat({
  csrf,
  onNotice,
  onOpened,
  beforeOpen,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  onOpened: (value: Bootstrap) => void;
  beforeOpen: () => Promise<boolean>;
  t: Record<string, string>;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [personaHandle, setPersonaHandle] = useState("");
  const [scenarioHandle, setScenarioHandle] = useState("");
  const [opening, setOpening] = useState("blank");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void get<Catalog>("/new-chat/selections")
      .then(setCatalog)
      .catch(() => onNotice(t.failedLoad));
  }, []);
  async function create() {
    if (creating) return;
    setCreating(true);
    const body: Record<string, unknown> = { opening: { kind: "blank" } };
    if (personaHandle) body.personaHandle = personaHandle;
    if (scenarioHandle) body.scenarioHandle = scenarioHandle;
    if (opening !== "blank") body.opening = { kind: "greeting", greetingHandle: opening };
    try {
      if (!(await beforeOpen())) return;
      const created = await post<{ chat: { handle: string } }>("/new-chat", body, csrf);
      await post("/open-chat", { chatHandle: created.chat.handle }, csrf);
      onOpened(await get<Bootstrap>("/refresh"));
    } catch {
      onNotice(t.failedNewChat);
    } finally {
      setCreating(false);
    }
  }
  return (
    <div className="form-stack">
      {catalog === null ? (
        <p>{t.loading}</p>
      ) : (
        <>
          <Select
            label={t.persona}
            value={personaHandle}
            onChange={setPersonaHandle}
            options={catalog.personas.map((x) => [x.handle, x.name, x.description])}
            t={t}
          />
          <Select
            label={t.scenario}
            value={scenarioHandle}
            onChange={setScenarioHandle}
            options={catalog.scenarios.map((x) => [x.handle, t.scenario, x.preview])}
            t={t}
          />
          <Select
            label={t.opening}
            value={opening}
            onChange={setOpening}
            options={[
              ["blank", t.blankOpening, ""],
              ...catalog.greetings.flatMap((x) =>
                x.variants.map((v, index): [string, string, string] => [
                  v.handle,
                  index === 0 ? t.firstMessage : `${t.alternative} ${index}`,
                  v.preview,
                ]),
              ),
            ]}
            t={t}
          />
          <button className="primary-button" disabled={creating} onClick={() => void create()}>
            {creating ? t.openingChat : t.create}
          </button>
        </>
      )}
    </div>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
  t,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string, string?]>;
  t: Record<string, string>;
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t.notSelected}</option>
        {options.map(([id, name]) => (
          <option value={id} key={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
function World({
  csrf,
  onNotice,
  onDirtyChange,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  t: Record<string, string>;
}) {
  type Entry = ManagedWorldInfo["entries"][number];
  const [data, setData] = useState<WorldView | null>(null);
  const [managed, setManaged] = useState<ManagedWorldInfoBindings | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [editing, setEditing] = useState<ManagedWorldInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [bindingLocked, setBindingLocked] = useState(false);
  const dirty =
    editing === null
      ? title !== "" || summary !== "" || entries.length > 0
      : title !== editing.publicTitle ||
        summary !== editing.summary ||
        JSON.stringify(entries) !== JSON.stringify(editing.entries);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const load = () => {
    void get<WorldView>("/worldbook")
      .then(setData)
      .catch(() => onNotice(t.failedLoad));
    void get<ManagedWorldInfoBindings>("/managed-world-info/bindings")
      .then((value) => {
        setManaged(value);
        setBindingLocked(false);
      })
      .catch(() => setManaged({ items: [], activeChat: null, selectedPublicTitle: null }));
  };
  useEffect(load, []);
  function resetDraft() {
    setTitle("");
    setSummary("");
    setEntries([]);
    setEditing(null);
    setConflict(false);
  }
  function edit(item: ManagedWorldInfo) {
    setEditing(item);
    setTitle(item.publicTitle);
    setSummary(item.summary);
    setEntries(item.entries.map((entry) => ({ ...entry })));
    setConflict(false);
  }
  async function toggle(bindingId: string | null) {
    if (!data?.activeChat || bindingLocked) return;
    try {
      await post(
        "/worldbook",
        {
          chatThreadId: data.activeChat.chatThreadId,
          chatSurfaceSessionId: data.activeChat.chatSurfaceSessionId,
          expectedUpdatedAtMs: data.activeChat.updatedAtMs,
          bindingId,
        },
        csrf,
      );
      load();
    } catch (error) {
      if ((error as Failure).status === 409) setBindingLocked(true);
      else onNotice(t.failure);
    }
  }
  async function attach(publicTitle: string | null) {
    if (!managed?.activeChat || bindingLocked) return;
    try {
      await post(
        "/managed-world-info/attach",
        {
          chatThreadId: managed.activeChat.chatThreadId,
          chatSurfaceSessionId: managed.activeChat.chatSurfaceSessionId,
          expectedUpdatedAtMs: managed.activeChat.updatedAtMs,
          publicTitle,
        },
        csrf,
      );
      load();
    } catch (error) {
      if ((error as Failure).status === 409) setBindingLocked(true);
      else onNotice(t.failure);
    }
  }
  async function save() {
    if (!title.trim() || !summary.trim() || saving) return;
    setSaving(true);
    setConflict(false);
    const document = { publicTitle: title.trim(), summary: summary.trim(), entries };
    try {
      if (editing === null) await post<{ item: ManagedWorldInfo }>("/managed-world-info", document, csrf);
      else
        await put<{ item: ManagedWorldInfo }>(
          `/managed-world-info/${encodeURIComponent(editing.publicTitle)}`,
          { ...document, expectedRevision: editing.revision },
          csrf,
        );
      resetDraft();
      load();
    } catch (error) {
      if ((error as Failure).status === 409) setConflict(true);
      else onNotice(t.failedWorldInfoSave);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {data === null || managed === null ? (
        <p>{t.loading}</p>
      ) : (
        <>
          <p className="subtle">{t.worldInfoDescription}</p>
          {data.bindings.map((item) => (
            <article className="world-row" key={item.bindingId}>
              <div>
                <strong>{item.label}</strong>
                <p>{item.selected ? t.inChat : t.available}</p>
              </div>
              <button
                className="small-button"
                disabled={!data.activeChat || bindingLocked}
                onClick={() => void toggle(item.selected ? null : item.bindingId)}
              >
                {item.selected ? t.removeWorldInfo : t.useWorldInfo}
              </button>
            </article>
          ))}
          <section className="managed-world-info" data-testid="managed-world-info">
            <h3>{t.managedWorldInfo}</h3>
            {bindingLocked && (
              <p role="alert" className="inline-error">
                {t.worldInfoLocked}{" "}
                <button className="text-button" onClick={load}>
                  {t.reload}
                </button>
              </p>
            )}
            {managed.items.map((item) => (
              <article className="world-row" key={item.publicTitle}>
                <div>
                  <strong>{item.publicTitle}</strong>
                  <p>{item.summary}</p>
                </div>
                <button
                  className="small-button"
                  disabled={!managed.activeChat || bindingLocked}
                  onClick={() =>
                    void attach(managed.selectedPublicTitle === item.publicTitle ? null : item.publicTitle)
                  }
                >
                  {managed.selectedPublicTitle === item.publicTitle ? t.removeWorldInfo : t.useWorldInfo}
                </button>
                <button className="text-button" disabled={saving} onClick={() => edit(item)}>
                  {t.editWorldInfo}
                </button>
              </article>
            ))}
            <div className="form-stack" aria-label={editing === null ? t.createWorldInfo : t.editWorldInfo}>
              <label className="field">
                {t.worldInfoTitle}
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={128}
                  disabled={saving}
                />
              </label>
              <label className="field">
                {t.worldInfoSummary}
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  maxLength={4000}
                  disabled={saving}
                />
              </label>
              <fieldset className="world-info-entries">
                <legend>{t.worldInfoEntries}</legend>
                {entries.map((entry, index) => (
                  <div className="entry-form" key={index}>
                    <label className="field">
                      {t.worldInfoEntryScope}
                      <select
                        value={entry.scope}
                        disabled={saving}
                        onChange={(event) =>
                          setEntries((old) =>
                            old.map((candidate, i) =>
                              i === index ? { ...candidate, scope: event.target.value as Entry["scope"] } : candidate,
                            ),
                          )
                        }
                      >
                        <option value="companion">{t.companionEntry}</option>
                        <option value="setting">{t.settingEntry}</option>
                      </select>
                    </label>
                    <label className="field">
                      {t.worldInfoEntryTitle}
                      <input
                        value={entry.publicTitle}
                        maxLength={128}
                        disabled={saving}
                        onChange={(event) =>
                          setEntries((old) =>
                            old.map((candidate, i) =>
                              i === index ? { ...candidate, publicTitle: event.target.value } : candidate,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      {t.worldInfoEntrySummary}
                      <textarea
                        value={entry.summary}
                        maxLength={4000}
                        disabled={saving}
                        onChange={(event) =>
                          setEntries((old) =>
                            old.map((candidate, i) =>
                              i === index ? { ...candidate, summary: event.target.value } : candidate,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      onClick={() => setEntries((old) => old.filter((_, i) => i !== index))}
                    >
                      {t.removeEntry}
                    </button>
                  </div>
                ))}
              </fieldset>
              <button
                type="button"
                className="text-button"
                disabled={saving || entries.length >= 32}
                onClick={() => setEntries((old) => [...old, { scope: "setting", publicTitle: "", summary: "" }])}
              >
                {t.addEntry}
              </button>
              {conflict && (
                <p role="alert" className="inline-error">
                  {t.worldInfoConflict}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      resetDraft();
                      load();
                    }}
                  >
                    {t.reload}
                  </button>
                </p>
              )}
              <button
                className="primary-button"
                disabled={
                  !title.trim() ||
                  !summary.trim() ||
                  entries.some((entry) => !entry.publicTitle.trim() || !entry.summary.trim()) ||
                  saving
                }
                onClick={() => void save()}
              >
                {saving ? t.saving : editing === null ? t.createWorldInfo : t.saveWorldInfo}
              </button>
              {editing !== null && (
                <button type="button" className="text-button" disabled={saving} onClick={resetDraft}>
                  {t.cancel}
                </button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
function Memories({ csrf }: { csrf: string }) {
  type MemoryStatus = "active" | "permanent" | "archived";
  type Memory = {
    stateToken: string;
    category: "semantic" | "interaction";
    content: string;
    sourceRefs?: string[];
    status: MemoryStatus;
  };
  type MemoriesResponse = { memories: Memory[] };
  type Filter = "all" | MemoryStatus;
  const [items, setItems] = useState<Memory[] | null>(null);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<Memory["category"]>("semantic");
  const [filter, setFilter] = useState<Filter>("active");
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const statusOf = (memory: Memory): MemoryStatus => memory.status;
  const memoryKey = (memory: Memory) => memory.stateToken;
  const load = async (clearError = true) => {
    try {
      setItems((await get<MemoriesResponse>("/memories")).memories);
      if (clearError) setError("");
    } catch {
      setItems(null);
      setError("Couldn’t load memories. Please try again.");
    }
  };
  useEffect(() => {
    void load();
  }, []);
  async function operation(
    operation: string,
    memory: Memory | null,
    extras: { content?: string; sourceRef?: string; targetStateToken?: string } = {},
    optimistic?: (old: Memory[]) => Memory[],
  ) {
    if (pending) return;
    const key = memory ? memoryKey(memory) : "create";
    setPending(key);
    setError("");
    if (optimistic) setItems((old) => (old === null ? old : optimistic(old)));
    try {
      const path =
        operation === "create_semantic" || operation === "create_interaction"
          ? "/memories"
          : operation === "delete"
            ? "/memories/delete-entry"
            : operation === "exclude_source"
              ? "/memories/exclude-source"
              : `/memories/${operation}`;
      const body =
        operation === "create_semantic" || operation === "create_interaction"
          ? { content: extras.content, category: operation === "create_semantic" ? "semantic" : "interaction" }
          : {
              stateToken: memory!.stateToken,
              ...(extras.content === undefined ? {} : { content: extras.content }),
              ...(extras.sourceRef === undefined ? {} : { sourceRef: extras.sourceRef }),
              ...(extras.targetStateToken === undefined ? {} : { targetStateToken: extras.targetStateToken }),
            };
      await postMemoryOperation(path, body, csrf);
      if (operation === "create_semantic" || operation === "create_interaction") setContent("");
      setEditing(null);
      await load();
    } catch {
      setError("Couldn’t update memory. The latest saved memories have been reloaded.");
      await load(false);
    } finally {
      setPending(null);
    }
  }
  function create() {
    if (content.trim())
      void operation(category === "semantic" ? "create_semantic" : "create_interaction", null, {
        content: content.trim(),
      });
  }
  function saveEdit(memory: Memory) {
    const next = editContent.trim();
    if (next)
      void operation("update", memory, { content: next }, (old) =>
        old.map((item) => (memoryKey(item) === memoryKey(memory) ? { ...item, content: next } : item)),
      );
  }
  function merge(memory: Memory) {
    const target = items?.find((candidate) => memoryKey(candidate) !== memoryKey(memory));
    if (
      !target ||
      !confirm(`Merge this memory into “${target.content.slice(0, 80)}”? The current entry will be archived.`)
    )
      return;
    void operation("merge", memory, { targetStateToken: memoryKey(target) }, (old) =>
      old.filter((item) => memoryKey(item) !== memoryKey(memory)),
    );
  }
  function mutate(memory: Memory, operationName: "archive" | "restore" | "pin" | "unpin" | "delete") {
    const nextStatus: MemoryStatus | null =
      operationName === "archive"
        ? "archived"
        : operationName === "restore" || operationName === "unpin"
          ? "active"
          : operationName === "pin"
            ? "permanent"
            : null;
    void operation(operationName, memory, {}, (old) =>
      operationName === "delete"
        ? old.filter((item) => memoryKey(item) !== memoryKey(memory))
        : old.map((item) =>
            memoryKey(item) === memoryKey(memory)
              ? { ...item, status: nextStatus!, pinned: nextStatus === "permanent" }
              : item,
          ),
    );
  }
  const visible = items?.filter((item) => filter === "all" || statusOf(item) === filter) ?? [];
  return (
    <section className="memories-view" data-testid="memories-panel">
      <p className="subtle">Save useful context for future conversations.</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}{" "}
          {!pending && (
            <button className="text-button" type="button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </p>
      )}
      <fieldset className="memory-filters">
        <legend>Show memories</legend>
        {(["active", "permanent", "archived", "all"] as Filter[]).map((value) => (
          <label className="check" key={value}>
            <input
              type="radio"
              name="memory-filter"
              checked={filter === value}
              onChange={() => setFilter(value)}
              disabled={pending !== null}
            />
            {value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}
          </label>
        ))}
      </fieldset>
      {items === null ? (
        !error && <p>Loading…</p>
      ) : visible.length === 0 ? (
        <p className="subtle">No {filter === "all" ? "" : `${filter} `}memories saved yet.</p>
      ) : (
        <div className="memory-list">
          {visible.map((item) => {
            const key = memoryKey(item);
            const status = statusOf(item);
            const busy = pending === key;
            const isEditing = editing === key;
            const mutable = true;
            return (
              <article className="memory-row" key={key} aria-busy={busy}>
                <div className="memory-row-heading">
                  <strong>{item.category === "semantic" ? "Semantic" : "Interaction Episode"}</strong>
                  <small>{status}</small>
                </div>
                {isEditing ? (
                  <form
                    className="memory-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveEdit(item);
                    }}
                  >
                    <label className="field">
                      Memory
                      <textarea
                        value={editContent}
                        disabled={busy}
                        maxLength={4000}
                        onChange={(event) => setEditContent(event.target.value)}
                      />
                    </label>
                    <button className="small-button" disabled={!editContent.trim() || busy}>
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button className="text-button" type="button" disabled={busy} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p>{item.content}</p>
                )}
                {item.sourceRefs?.length ? (
                  <div className="memory-sources">
                    <small>Sources</small>
                    {item.sourceRefs.map((sourceRef) => (
                      <div key={sourceRef}>
                        <small>{sourceRef}</small>
                        <button
                          className="text-button"
                          type="button"
                          disabled={busy || !mutable}
                          onClick={() => void operation("exclude_source", item, { sourceRef })}
                        >
                          Exclude source
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="memory-actions">
                  {!isEditing && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy || !mutable}
                      onClick={() => {
                        setEditing(key);
                        setEditContent(item.content);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {status === "archived" ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy || !mutable}
                      onClick={() => mutate(item, "restore")}
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy || !mutable}
                        onClick={() => mutate(item, "archive")}
                      >
                        Archive
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy || !mutable}
                        onClick={() => mutate(item, status === "permanent" ? "unpin" : "pin")}
                      >
                        {status === "permanent" ? "Unpin" : "Pin"}
                      </button>
                    </>
                  )}
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy || !mutable || (items?.length ?? 0) < 2}
                    onClick={() => merge(item)}
                  >
                    Merge
                  </button>
                  <button
                    className="text-button memory-delete"
                    type="button"
                    disabled={busy || !mutable}
                    onClick={() => {
                      if (confirm("Delete this memory? This only deletes the memory entry, not its source history."))
                        mutate(item, "delete");
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <form
        className="form-stack memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label className="field">
          Category
          <select
            value={category}
            disabled={pending !== null}
            onChange={(event) => setCategory(event.target.value as Memory["category"])}
          >
            <option value="semantic">Semantic</option>
            <option value="interaction">Interaction Episode</option>
          </select>
        </label>
        <label className="field">
          Memory
          <textarea
            value={content}
            disabled={pending !== null}
            maxLength={4000}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <button className="primary-button" disabled={!content.trim() || pending !== null}>
          {pending === "create" ? "Saving…" : "Save memory"}
        </button>
      </form>
    </section>
  );
}
function Settings({ onNotice, t }: { csrf: string; onNotice: (v: string) => void; t: Record<string, string> }) {
  type Profile = { modelId: "deepseek-v4-flash"; thinkingLevel: "high" };
  const [profiles, setProfiles] = useState<{ chat: Profile; game: Profile } | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void get<{ chat: Profile; game: Profile }>("/settings/profiles")
      .then(setProfiles)
      .catch(() => onNotice(t.failedLoad));
  }, [onNotice, t.failedLoad]);
  // This is a read-only projection of the Host's single fixed configuration.
  // Credential, provider, endpoint, activation, and runtime controls never
  // reach this browser surface.
  const facts = (profile: Profile) => (
    <>
      <p>
        {t.model}: {profile.modelId}
      </p>
      <p>
        {t.thinking}: {profile.thinkingLevel}
      </p>
    </>
  );
  return (
    <div className="settings-view">
      {profiles === null ? (
        <p>{t.loading}</p>
      ) : (
        <>
          <section aria-label={t.chat} className="settings-region">
            <h3>{t.chat}</h3>
            {facts(profiles.chat)}
          </section>
          <section aria-label={t.game} className="settings-region">
            <h3>{t.game}</h3>
            {facts(profiles.game)}
          </section>
        </>
      )}
    </div>
  );
}
function GameStatus({ onNotice, t }: { onNotice: (v: string) => void; t: Record<string, string> }) {
  type Status = {
    availability: "available" | "unavailable";
    label: string;
    freshnessLabel: string;
    availableCapabilityCount: number;
    activeExecutionCategory: "none" | "active";
    latestAuthoritativeReceiptOutcome: "none" | "succeeded" | "not_succeeded";
  };
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    void get<Status>("/game/status")
      .then(setStatus)
      .catch(() => onNotice(t.failedLoad));
  }, [onNotice, t.failedLoad]);
  if (status === null) return <p>{t.loading}</p>;
  return (
    <section className="game-status-view" aria-label={t.gameStatus} data-testid="game-status">
      <h3>{status.label}</h3>
      <p>{status.freshnessLabel}</p>
      <p>
        {t.availableCapabilities}: {status.availableCapabilityCount}
      </p>
      <p>{status.activeExecutionCategory === "active" ? t.gameActionRunning : t.noGameActionRunning}</p>
      <p>
        {t.latestReceipt}:{" "}
        {status.latestAuthoritativeReceiptOutcome === "succeeded"
          ? t.receiptSucceeded
          : status.latestAuthoritativeReceiptOutcome === "not_succeeded"
            ? t.receiptNotSucceeded
            : t.noReceipt}
      </p>
    </section>
  );
}
function PersonaManager({
  csrf,
  onNotice,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  t: Record<string, string>;
}) {
  type Persona = { revision: number; name: string; description?: string };
  const [persona, setPersona] = useState<Persona | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () =>
    void get<{ persona: Persona | null }>("/persona-management")
      .then((value) => setPersona(value.persona))
      .catch(() => {
        setPersona(null);
        onNotice(t.failedLoad);
      });
  useEffect(load, []);
  async function create() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const value = await post<{ persona: Persona }>(
        "/persona-management",
        { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
        csrf,
      );
      setPersona(value.persona);
      setName("");
      setDescription("");
    } catch (error) {
      onNotice((error as Failure).status === 409 ? t.personaExists : t.failedPersonaSave);
    } finally {
      setSaving(false);
    }
  }
  if (persona === undefined) return <p>{t.loading}</p>;
  if (persona !== null)
    return (
      <section className="persona-manager" data-testid="persona-manager">
        <p className="subtle">{t.personaManagerDescription}</p>
        <strong>{persona.name}</strong>
        {persona.description && <p>{persona.description}</p>}
        <p className="subtle">{t.personaSaved}</p>
      </section>
    );
  return (
    <section className="persona-manager" data-testid="persona-manager">
      <p className="subtle">{t.personaManagerDescription}</p>
      <div className="form-stack">
        <label className="field">
          {t.personaName}
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
        </label>
        <label className="field">
          {t.personaDescription}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4096} />
        </label>
        <button className="primary-button" disabled={!name.trim() || saving} onClick={() => void create()}>
          {saving ? t.saving : t.createPersona}
        </button>
      </div>
    </section>
  );
}
function ScenarioManager({
  csrf,
  onNotice,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  t: Record<string, string>;
}) {
  type Scenario = { revision: number; name: string; description: string; preview: string };
  const [scenario, setScenario] = useState<Scenario | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void get<{ scenario: Scenario | null }>("/scenario-management")
      .then((value) => setScenario(value.scenario))
      .catch(() => {
        setScenario(null);
        onNotice(t.failedLoad);
      });
  }, []);
  async function create() {
    if (!name.trim() || !description.trim() || saving) return;
    setSaving(true);
    try {
      setScenario(
        (
          await post<{ scenario: Scenario }>(
            "/scenario-management",
            { name: name.trim(), description: description.trim() },
            csrf,
          )
        ).scenario,
      );
    } catch (error) {
      onNotice((error as Failure).status === 409 ? t.scenarioExists : t.failedScenarioSave);
    } finally {
      setSaving(false);
    }
  }
  if (scenario === undefined) return <p>{t.loading}</p>;
  if (scenario !== null)
    return (
      <section className="content-manager" data-testid="scenario-manager">
        <p className="subtle">{t.scenarioManagerDescription}</p>
        <strong>{scenario.name}</strong>
        <p>{scenario.description}</p>
      </section>
    );
  return (
    <section className="content-manager" data-testid="scenario-manager">
      <p className="subtle">{t.scenarioManagerDescription}</p>
      <div className="form-stack">
        <label className="field">
          {t.scenarioName}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        </label>
        <label className="field">
          {t.scenarioDescription}
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8192} />
        </label>
        <button
          className="primary-button"
          disabled={!name.trim() || !description.trim() || saving}
          onClick={() => void create()}
        >
          {saving ? t.saving : t.createScenario}
        </button>
      </div>
    </section>
  );
}
function GreetingManager({
  csrf,
  onNotice,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  t: Record<string, string>;
}) {
  type Greeting = { revision: number; label: string; variants: Array<{ label: string; text: string }> };
  const [greetingSet, setGreetingSet] = useState<Greeting | null | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void get<{ greetingSet: Greeting | null }>("/greeting-management")
      .then((value) => setGreetingSet(value.greetingSet))
      .catch(() => {
        setGreetingSet(null);
        onNotice(t.failedLoad);
      });
  }, []);
  async function create() {
    if (!label.trim() || !text.trim() || saving) return;
    setSaving(true);
    try {
      setGreetingSet(
        (
          await post<{ greetingSet: Greeting }>(
            "/greeting-management",
            { label: label.trim(), variants: [{ label: t.firstMessage, text: text.trim() }] },
            csrf,
          )
        ).greetingSet,
      );
    } catch (error) {
      onNotice((error as Failure).status === 409 ? t.greetingExists : t.failedGreetingSave);
    } finally {
      setSaving(false);
    }
  }
  if (greetingSet === undefined) return <p>{t.loading}</p>;
  if (greetingSet !== null)
    return (
      <section className="content-manager" data-testid="greeting-manager">
        <p className="subtle">{t.greetingManagerDescription}</p>
        <strong>{greetingSet.label}</strong>
        {greetingSet.variants.map((item, index) => (
          <article key={index}>
            <strong>{item.label}</strong>
            <p>{item.text}</p>
          </article>
        ))}
      </section>
    );
  return (
    <section className="content-manager" data-testid="greeting-manager">
      <p className="subtle">{t.greetingManagerDescription}</p>
      <div className="form-stack">
        <label className="field">
          {t.greetingName}
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={128} />
        </label>
        <label className="field">
          {t.greetingText}
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={8192} />
        </label>
        <button
          className="primary-button"
          disabled={!label.trim() || !text.trim() || saving}
          onClick={() => void create()}
        >
          {saving ? t.saving : t.createGreeting}
        </button>
      </div>
    </section>
  );
}
function NewCharacter({
  csrf,
  onNotice,
  t,
}: {
  csrf: string;
  onNotice: (v: string) => void;
  t: Record<string, string>;
}) {
  const [name, setName] = useState("");
  async function create() {
    try {
      await post("/new-companion", { name: name.trim() }, csrf);
      onNotice(t.createdCharacter);
      setName("");
    } catch {
      onNotice(t.failure);
    }
  }
  return (
    <div className="form-stack">
      <label className="field">
        {t.characters}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
      </label>
      <button className="primary-button" disabled={!name.trim()} onClick={() => void create()}>
        {t.create}
      </button>
    </div>
  );
}
function Imports({ csrf, onNotice, t }: { csrf: string; onNotice: (v: string) => void; t: Record<string, string> }) {
  const [card, setCard] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  async function importCard() {
    try {
      setResult(await post<ImportResult>("/imports", { importId: crypto.randomUUID(), card }, csrf));
      setCard("");
      setSelected([]);
      setReviewed(false);
    } catch {
      onNotice(t.failure);
    }
  }
  async function review() {
    if (!result || !selected.length) return;
    try {
      await post(
        `/imports/${encodeURIComponent(result.report.reviewId)}/review`,
        { reviewedFields: selected, approvedAtMs: Date.now() },
        csrf,
      );
      setReviewed(true);
    } catch {
      onNotice(t.failure);
    }
  }
  async function confirm() {
    if (!result || !reviewed) return;
    try {
      await post(`/imports/${encodeURIComponent(result.report.reviewId)}/confirm-new-companion`, {}, csrf);
      onNotice(t.createdCharacter);
    } catch {
      onNotice(t.failure);
    }
  }
  const eligible = result?.candidate.fields.filter((x) => x.eligible) ?? [];
  return (
    <div className="form-stack">
      <p className="subtle">{t.importHint}</p>
      <label className="field">
        {t.cardJson}
        <textarea value={card} onChange={(e) => setCard(e.target.value)} />
      </label>
      <button className="primary-button" disabled={!card.trim()} onClick={() => void importCard()}>
        {t.import}
      </button>
      {result && (
        <section className="review-section">
          <h3>{t.review}</h3>
          <div className="import-dispositions" aria-label={t.importDetails}>
            {result.report.dispositions.map((item, index) => (
              <p key={`${item.status}-${index}`} className={item.status === "available" ? "accepted" : "not-used"}>
                <strong>
                  {item.status === "available" ? t.accepted : item.status === "excluded" ? t.notExecuted : t.notUsed}
                </strong>
              </p>
            ))}
          </div>
          {eligible.map((field) => (
            <label className="check" key={field.reviewKey}>
              <input
                type="checkbox"
                checked={selected.includes(field.reviewKey)}
                onChange={() =>
                  setSelected((old) =>
                    old.includes(field.reviewKey)
                      ? old.filter((x) => x !== field.reviewKey)
                      : [...old, field.reviewKey],
                  )
                }
              />
              {field.label === "persona"
                ? t.persona
                : field.label === "interaction"
                  ? t.interaction
                  : field.label === "style"
                    ? t.style
                    : t.details}
            </label>
          ))}
          {!reviewed ? (
            <button className="small-button" disabled={!selected.length} onClick={() => void review()}>
              {t.save}
            </button>
          ) : (
            <>
              <p className="success-text">{t.reviewSaved}</p>
              <button className="primary-button" onClick={() => void confirm()}>
                {t.confirmCharacter}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
function IconButton({
  label,
  onClick,
  icon,
  className,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  icon: "close";
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={buttonRef} className={className} type="button" title={label} aria-label={label} onClick={onClick}>
      {icon === "close" && (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ].filter((element) => !element.hidden && element.getClientRects().length > 0);
}
async function get<T>(path: string): Promise<T> {
  return fetch(path).then(readResponse<T>);
}
async function put<T>(path: string, body: unknown, csrf: string): Promise<T> {
  return fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf, Origin: location.origin },
    body: JSON.stringify(body),
  }).then(readResponse<T>);
}
async function del<T>(path: string, body: unknown, csrf: string): Promise<T> {
  return fetch(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf, Origin: location.origin },
    body: JSON.stringify(body),
  }).then(readResponse<T>);
}
async function post<T>(path: string, body: unknown, csrf: string): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf, Origin: location.origin },
    body: JSON.stringify(body),
  }).then(readResponse<T>);
}
async function postMemoryOperation(path: string, body: unknown, csrf: string): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GameBuddy-CSRF": csrf, Origin: location.origin },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status }) as Failure;
  // Lifecycle responses may carry a refreshed memory or intentionally return 204.
  if (response.status !== 204) await response.json();
}
async function download(path: string, filename: string, csrf: string) {
  const value = await post<{ document: unknown }>(path, {}, csrf);
  const url = URL.createObjectURL(new Blob([JSON.stringify(value.document)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status }) as Failure;
  return response.json() as Promise<T>;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
