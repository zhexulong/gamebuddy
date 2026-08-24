import { useEffect, useRef, useState } from "react";
import { applyDocumentLocale, type Locale, messages, persistLocale, resolveLocale } from "../i18n";
import {
  cancelTurn,
  createTavernEventStream,
  discardDraft,
  fetchChatList,
  type P3Message,
  redeemP3Bootstrap,
  renameChatTitle,
  submitMessage,
} from "../p3-browser-api";
import type {
  ActivePanel,
  ChatSummary,
  CompanionSummary,
  SemanticMemoryItem,
  UserPersona,
  ViewState,
  WorldInfoEntry,
} from "../types";
import { AppBar } from "./AppBar";
import { Composer } from "./Composer";
import { DraftSection } from "./DraftSection";
import { CharactersDrawer } from "./drawers/CharactersDrawer";
import { ChatsDrawer } from "./drawers/ChatsDrawer";
import { MemoryDrawer } from "./drawers/MemoryDrawer";
import { PersonaDrawer } from "./drawers/PersonaDrawer";
import { WorldInfoDrawer } from "./drawers/WorldInfoDrawer";
import { ProblemView } from "./ProblemView";
import { SettingsDrawer } from "./SettingsDrawer";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";

export function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale());
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [activePanel, setActivePanel] = useState<ActivePanel>("none");

  const [transcript, setTranscript] = useState<P3Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeError, setActiveError] = useState<string | null>(null);

  const [companions, setCompanions] = useState<CompanionSummary[]>([]);
  const [activeCompanion, setActiveCompanion] = useState<CompanionSummary>({
    id: "comp-active",
    name: "Companion",
  });
  const [persona, setPersona] = useState<UserPersona>({
    name: "",
    description: "",
  });
  const [worldInfoEntries, setWorldInfoEntries] = useState<WorldInfoEntry[]>([]);
  const [memories, setMemories] = useState<SemanticMemoryItem[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentChatHandle, setCurrentChatHandle] = useState("");

  const initialBootTokenRef = useRef<string | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentDraftRevisionRef = useRef<number>(1);
  const labels = messages(locale);

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  useEffect(() => {
    let isSubscribed = true;

    const hashParams = new URLSearchParams(location.hash.slice(1));
    const rawBoot = hashParams.get("boot");
    initialBootTokenRef.current = rawBoot;

    let bootstrapToken = rawBoot;
    if (bootstrapToken === null && !location.hash.includes("boot=")) {
      bootstrapToken = "dev-demo-token";
    }

    if (bootstrapToken === null) {
      setState({
        kind: "problem",
        disposition: "bootstrap_unavailable",
      });
      return;
    }

    redeemP3Bootstrap(bootstrapToken)
      .then(({ snapshot, draft }) => {
        if (!isSubscribed) return;

        setState({
          kind: "ready",
          snapshot,
          draft,
        });
        currentDraftRevisionRef.current = draft.revision;
        if (draft.text) {
          setInputText(draft.text);
        }
        setTranscript([...snapshot.chat.transcript]);
        const companionName = snapshot.chat.companion.name || "Companion";
        const companionSummary: CompanionSummary = {
          id: "comp-active",
          name: companionName,
        };
        setActiveCompanion(companionSummary);
        setCompanions([companionSummary]);

        const chatHandle = snapshot.selection?.chatHandle ?? "chat-active";
        setCurrentChatHandle(chatHandle);
        setChats([
          {
            chatHandle,
            title: snapshot.chat.title || companionName,
            updatedAtMs: Date.now(),
            messageCount: snapshot.chat.transcript.length,
            managementRevision: 1,
          },
        ]);

        if (snapshot.chat.worldInfo) {
          const wi = snapshot.chat.worldInfo as Record<string, unknown>;
          const rawItems = Array.isArray(wi.items) ? wi.items : Array.isArray(wi.entries) ? wi.entries : [];
          const entries = (rawItems as Array<Record<string, unknown>>).map((e, idx) => ({
            id: String(e.handle ?? e.id ?? `wi-${idx}`),
            key: String(e.handle ?? e.key ?? `entry-${idx + 1}`),
            title: String(e.title ?? e.key ?? `Entry ${idx + 1}`),
            content: String(e.summary ?? e.content ?? ""),
            enabled: Boolean(e.enabled ?? true),
          }));
          setWorldInfoEntries(entries);
        }

        if (snapshot.memory) {
          const mem = snapshot.memory as Record<string, unknown>;
          const rawSummaries = Array.isArray(mem.summaries)
            ? mem.summaries
            : Array.isArray(mem.entries)
              ? mem.entries
              : [];
          const memList = (rawSummaries as Array<Record<string, unknown>>).map((m, idx) => ({
            id: String(m.handle ?? m.id ?? `mem-${idx}`),
            fact: String(m.title ?? m.fact ?? m.text ?? ""),
            status: (m.pinned ? "permanent" : m.status === "permanent" ? "permanent" : "active") as
              | "active"
              | "permanent",
            recordedAtMs: typeof m.recordedAtMs === "number" ? m.recordedAtMs : Date.now(),
          }));
          setMemories(memList);
        }

        const url = new URL(window.location.href);
        url.hash = "";
        window.history.replaceState(null, "", url.toString());

        const queryPanel = url.searchParams.get("panel");
        if (queryPanel === "settings") {
          setActivePanel("settings");
        }
      })
      .catch((error: unknown) => {
        if (!isSubscribed) return;
        const disposition =
          error &&
          typeof error === "object" &&
          "disposition" in error &&
          error.disposition === "temporarily_unavailable"
            ? "temporarily_unavailable"
            : "reconciliation_failed";

        setState({
          kind: "problem",
          disposition,
        });
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  // SSE Live Event Stream Binding
  useEffect(() => {
    if (state.kind !== "ready") return;
    const stream = createTavernEventStream(
      (event) => {
        if (event.event === "message.committed" && event.payload && typeof event.payload.message === "object") {
          const msg = event.payload.message as P3Message;
          setTranscript((prev) => (prev.some((m) => m.handle === msg.handle) ? prev : [...prev, msg]));
        } else if (event.event === "draft.changed" && event.payload && typeof event.payload.revision === "number") {
          currentDraftRevisionRef.current = event.payload.revision as number;
        } else if (event.event === "turn.state_changed") {
          if (
            event.payload &&
            (event.payload.state === "completed" ||
              event.payload.state === "cancelled" ||
              event.payload.state === "failed")
          ) {
            setIsGenerating(false);
          }
        } else if (event.event === "memory.changed" && event.payload && Array.isArray(event.payload.entries)) {
          const memList = (event.payload.entries as Array<Record<string, unknown>>).map((m, idx) => ({
            id: String(m.id ?? `mem-${idx}`),
            fact: String(m.fact ?? m.text ?? ""),
            status: (m.status === "permanent" ? "permanent" : "active") as "active" | "permanent",
            recordedAtMs: typeof m.recordedAtMs === "number" ? m.recordedAtMs : Date.now(),
          }));
          setMemories(memList);
        }
      },
      () => {
        // EventSource stream closed/reconnecting
      },
    );
    return () => {
      stream.close();
    };
  }, [state.kind]);

  // Real Persistent Chat List Sync when opening Chats Drawer
  useEffect(() => {
    if (activePanel === "chats" && state.kind === "ready") {
      fetchChatList()
        .then((list) => {
          if (list.chats && list.chats.length > 0) {
            setChats(
              list.chats.map((c) => ({
                chatHandle: c.handle,
                title: c.title || activeCompanion.name,
                managementRevision: c.managementRevision,
                updatedAtMs: Date.now(),
                messageCount: 0,
              })),
            );
          }
        })
        .catch(() => {
          // Keep local chat list when route is unmounted in profile
        });
    }
  }, [activePanel, state.kind, activeCompanion.name]);

  const handleSelectLocale = (next: Locale) => {
    setLocale(next);
    persistLocale(next);
  };

  const handleOpenPanel = (panel: ActivePanel) => {
    setActivePanel(panel);
    const url = new URL(window.location.href);
    if (panel !== "none") {
      url.searchParams.set("panel", panel);
    } else {
      url.searchParams.delete("panel");
    }
    window.history.pushState(null, "", url.toString());
  };

  const handleClosePanel = () => {
    handleOpenPanel("none");
  };

  const handleSend = async () => {
    if (!inputText.trim() || isGenerating) return;

    const userMessageText = inputText.trim();
    setInputText("");
    setIsGenerating(true);
    setActiveError(null);

    const csrfToken = state.kind === "ready" ? (state.snapshot.csrfToken ?? "") : "";
    const generation = state.kind === "ready" ? (state.snapshot.selection?.generation ?? 1) : 1;

    try {
      const submitResult = await submitMessage(
        {
          text: userMessageText,
          locale,
          selectionGeneration: generation,
        },
        csrfToken,
      );

      if (submitResult.message) {
        setTranscript((prev) => [...prev, submitResult.message]);
      }

      // Discard server draft after successful submission
      discardDraft(generation, currentDraftRevisionRef.current, csrfToken)
        .then((res) => {
          currentDraftRevisionRef.current = res.revision;
        })
        .catch(() => {});
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Message submission failed";
      setActiveError(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStop = async () => {
    if (
      state.kind === "ready" &&
      state.snapshot.chat?.turn &&
      typeof (state.snapshot.chat.turn as Record<string, unknown>).handle === "string"
    ) {
      const turnHandle = (state.snapshot.chat.turn as Record<string, unknown>).handle as string;
      const generation = state.snapshot.selection?.generation ?? 1;
      const csrfToken = state.snapshot.csrfToken ?? "";
      try {
        await cancelTurn(turnHandle, generation, csrfToken);
      } catch (err: unknown) {
        console.error("Failed to cancel turn:", err);
      }
    }
    setIsGenerating(false);
  };

  const handleSelectCompanion = (id: string) => {
    const comp = companions.find((c) => c.id === id);
    if (comp) {
      setActiveCompanion(comp);
      handleClosePanel();
    }
  };

  const handleCreateCompanion = (name: string, p?: string) => {
    const newComp: CompanionSummary = {
      id: `comp-${Date.now()}`,
      name,
      persona: p || "A loyal companion in your journey.",
    };
    setCompanions((prev) => [...prev, newComp]);
    setActiveCompanion(newComp);
    handleClosePanel();
  };

  const handleImportCard = (json: string) => {
    try {
      const parsed = JSON.parse(json);
      const name = parsed.name || parsed.data?.name || "Imported Companion";
      const p = parsed.description || parsed.data?.description || parsed.persona || "";
      handleCreateCompanion(name, p);
    } catch {
      // ignore malformed import in preview
    }
  };

  const handleAddWorldInfo = (key: string, title: string, content: string) => {
    const newEntry: WorldInfoEntry = {
      id: `wi-${Date.now()}`,
      key,
      title,
      content,
      enabled: true,
    };
    setWorldInfoEntries((prev) => [...prev, newEntry]);
  };

  const handleToggleWorldInfo = (id: string, enabled: boolean) => {
    setWorldInfoEntries((prev) => prev.map((e) => (e.id === id ? { ...e, enabled } : e)));
  };

  const handleNewChat = () => {
    const newChatHandle = `chat-${Date.now()}`;
    const newChat: ChatSummary = {
      chatHandle: newChatHandle,
      title: `${activeCompanion.name} Session ${chats.length + 1}`,
      updatedAtMs: Date.now(),
      messageCount: 1,
      managementRevision: 1,
    };
    setChats((prev) => [newChat, ...prev]);
    setCurrentChatHandle(newChatHandle);
    setTranscript([
      {
        handle: `msg-init-${Date.now()}`,
        role: "companion",
        text:
          locale === "zh-CN"
            ? `新会话已开启！我是 ${activeCompanion.name}，今天你想聊点什么？`
            : `New conversation started! I'm ${activeCompanion.name}. What's on your mind today?`,
        locale,
        order: 0,
        revision: 1,
      },
    ]);
    handleClosePanel();
  };

  const handleRenameChat = (handle: string, newTitle: string) => {
    const target = chats.find((c) => c.chatHandle === handle);
    const expectedRevision = target?.managementRevision ?? 1;
    const generation = state.kind === "ready" ? (state.snapshot.selection?.generation ?? 1) : 1;
    const csrfToken = state.kind === "ready" ? (state.snapshot.csrfToken ?? "") : "";

    setChats((prev) => prev.map((c) => (c.chatHandle === handle ? { ...c, title: newTitle } : c)));

    renameChatTitle(handle, newTitle, expectedRevision, generation, csrfToken)
      .then((res) => {
        setChats((prev) =>
          prev.map((c) =>
            c.chatHandle === handle ? { ...c, title: res.title, managementRevision: res.managementRevision } : c,
          ),
        );
      })
      .catch(() => {
        // Rollback / refetch on server conflict
        fetchChatList()
          .then((list) => {
            if (list.chats && list.chats.length > 0) {
              setChats(
                list.chats.map((c) => ({
                  chatHandle: c.handle,
                  title: c.title || activeCompanion.name,
                  managementRevision: c.managementRevision,
                  updatedAtMs: Date.now(),
                  messageCount: 0,
                })),
              );
            }
          })
          .catch(() => {});
      });
  };

  const handleExportChat = (handle: string) => {
    const chat = chats.find((c) => c.chatHandle === handle);
    const exportData = {
      chatTitle: chat?.title || "Exported Chat",
      companion: activeCompanion.name,
      transcript,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `chat-${activeCompanion.name.toLowerCase()}-${Date.now()}.json`;
    link.click();
  };

  const isStrictP3ReadOnly =
    state.kind === "ready" &&
    state.snapshot.build.profileId === "gamebuddy.chat-core.p3" &&
    Boolean(initialBootTokenRef.current);

  return (
    <div className="tavern-app-shell">
      <SkipLink label={labels.skipToChat} />

      {state.kind === "ready" && (
        <AppBar
          companionName={activeCompanion.name}
          activePanel={activePanel}
          onOpenPanel={handleOpenPanel}
          labels={labels}
          settingsButtonRef={settingsButtonRef}
          isReadOnly={isStrictP3ReadOnly}
        />
      )}

      <main id="main-content" className="app-main-content">
        {state.kind === "loading" && (
          <div className="state-placeholder">
            <p className="loading-text">{labels.openingChat}</p>
          </div>
        )}

        {state.kind === "problem" && (
          <ProblemView
            title={
              state.disposition === "bootstrap_unavailable"
                ? labels.problemBootstrapUnavailableTitle
                : state.disposition === "temporarily_unavailable"
                  ? labels.problemTemporarilyUnavailableTitle
                  : labels.problemReconciliationFailedTitle
            }
            detail={
              state.disposition === "bootstrap_unavailable"
                ? labels.problemBootstrapUnavailableDetail
                : state.disposition === "temporarily_unavailable"
                  ? labels.problemTemporarilyUnavailableDetail
                  : labels.problemReconciliationFailedDetail
            }
          />
        )}

        {state.kind === "ready" && (
          <>
            <Timeline
              transcript={transcript}
              companionName={activeCompanion.name}
              chatTitle={state.snapshot.chat.title}
              labels={labels}
            />

            {isStrictP3ReadOnly ? (
              <DraftSection draft={state.draft} labels={labels} />
            ) : (
              <>
                {activeError && (
                  <div className="error-banner" role="alert">
                    {activeError}
                  </div>
                )}
                <Composer
                  value={inputText}
                  onChange={setInputText}
                  onSend={handleSend}
                  onStop={handleStop}
                  isGenerating={isGenerating}
                  labels={labels}
                />
              </>
            )}
          </>
        )}
      </main>

      {/* Drawers */}
      <ChatsDrawer
        isOpen={activePanel === "chats"}
        onClose={handleClosePanel}
        labels={labels}
        chats={chats}
        currentChatHandle={currentChatHandle}
        onSelectChat={(handle) => {
          setCurrentChatHandle(handle);
          handleClosePanel();
        }}
        onNewChat={handleNewChat}
        onExportChat={handleExportChat}
        onRenameChat={handleRenameChat}
      />

      <CharactersDrawer
        isOpen={activePanel === "characters"}
        onClose={handleClosePanel}
        labels={labels}
        activeCompanion={activeCompanion}
        companions={companions}
        onSelectCompanion={handleSelectCompanion}
        onCreateCompanion={handleCreateCompanion}
        onImportCard={handleImportCard}
      />

      <PersonaDrawer
        isOpen={activePanel === "persona"}
        onClose={handleClosePanel}
        labels={labels}
        persona={persona}
        onSavePersona={(p) => setPersona(p)}
      />

      <WorldInfoDrawer
        isOpen={activePanel === "worldInfo"}
        onClose={handleClosePanel}
        labels={labels}
        entries={worldInfoEntries}
        onAddEntry={handleAddWorldInfo}
        onToggleEntry={handleToggleWorldInfo}
      />

      <MemoryDrawer
        isOpen={activePanel === "memory"}
        onClose={handleClosePanel}
        labels={labels}
        memories={memories}
        onRefreshMemory={() => {
          setMemories([...memories]);
        }}
      />

      <SettingsDrawer
        isOpen={activePanel === "settings"}
        onClose={handleClosePanel}
        currentLocale={locale}
        onSelectLocale={handleSelectLocale}
        labels={labels}
        invokerRef={settingsButtonRef}
      />
    </div>
  );
}
