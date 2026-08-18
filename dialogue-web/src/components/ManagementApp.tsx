import { useEffect, useRef, useState } from "react";
import { applyDocumentLocale, messages, resolveLocale, type Locale } from "../i18n";
import {
  createManagementPipelineApi,
  TavernProblemError,
  TavernProtocolError,
  type BrowserDraftV1,
  type ChatListV1,
  type ChatTitleV1,
  type TavernStateSnapshotV1,
} from "../management-pipeline-api";
import {
  createManagementPipelineSession,
  ManagementPipelineSessionError,
  type ManagementPipelineSession,
} from "../management-pipeline-session";
import type { ChatSummary } from "../types";
import { ChatsDrawer } from "./drawers/ChatsDrawer";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";

/**
 * tavern_management browser shell (design/78 P9 Chat list + title rename
 * micro-pipeline): renders one exact mounted Chat read-only, plus the real
 * metadata-only Chat list and exact rename through the mounted
 * `gamebuddy.tavern-management.chat-list-title` profile.
 *
 * The profile mounts no chat.submit, no selection/switch, no New Chat and no
 * export operations, so those controls are absent (never fake): the drawer
 * renders only list rows and the API-backed rename.
 *
 * Rename ordering (frozen): current entry managementRevision from the last
 * validated list -> PUT /chat/title with exact selectionGeneration + handle ->
 * validated durable read-back replaces the entry (and the mounted snapshot
 * title when the handle is the mounted one). Any problem re-reads the list;
 * nothing is ever appended or guessed locally.
 */

type ReadyView = Readonly<{
  kind: "ready";
  session: ManagementPipelineSession;
  locale: Locale;
  draft: BrowserDraftV1;
  notice: Readonly<{ kind: "success" | "failure"; text: string }> | null;
}>;
type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string }>;
type ViewState = Readonly<{ kind: "loading" }> | ReadyView | ProblemViewState;

export function ManagementApp() {
  const apiRef = useRef(createManagementPipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const localeRef = useRef<Locale>(resolveLocale());
  const cancelledRef = useRef(false);

  const commit = (next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  };

  const labels = () => {
    const locale = view.kind === "ready" ? view.locale : localeRef.current;
    return messages(locale);
  };

  useEffect(() => {
    applyDocumentLocale(localeRef.current);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      const api = apiRef.current;
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const bootToken = params.get("boot");
        let snapshot: TavernStateSnapshotV1;
        if (bootToken !== null) {
          snapshot = await api.bootstrap(bootToken);
          // Strip the one-time boot but keep the immutable profile marker in
          // the fragment: reloads re-read state through the session cookie.
          const url = new URL(window.location.href);
          url.hash = "profile=management";
          window.history.replaceState(null, "", url.toString());
        } else {
          snapshot = await api.readState();
        }
        if (snapshot.selection === null || snapshot.chat === null) {
          throw new ManagementPipelineSessionError("state_reconciliation_required");
        }
        const list = await api.listChats();
        const draft = await api.readDraft();
        if (snapshot.chat.draft.revision !== draft.revision || snapshot.chat.draft.present !== (draft.text !== null)) {
          throw new ManagementPipelineSessionError("state_reconciliation_required");
        }
        let session = createManagementPipelineSession(snapshot);
        session = session.withChatList(list);
        if (!active) return;
        setDraftText(draft.text ?? "");
        commit({ kind: "ready", session, draft, locale: localeRef.current, notice: null });
      } catch (error) {
        if (!active) return;
        commit(problemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, []);

  const reconcileList = async (current: ReadyView): Promise<ManagementPipelineSession> => {
    const list = await apiRef.current.listChats();
    return current.session.withChatList(list);
  };

  const handleDraftMutation = async (kind: "save" | "discard"): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.snapshot.selection === null) return;
    try {
      const command = {
        apiVersion: 1 as const,
        selectionGeneration: current.session.snapshot.selection.generation,
        expectedRevision: current.draft.revision,
        ...(kind === "save" ? { text: draftText.trim() } : {}),
      };
      const result = kind === "save"
        ? await apiRef.current.saveDraft(command as { apiVersion: 1; selectionGeneration: number; expectedRevision: number; text: string }, current.session.snapshot.csrfToken)
        : await apiRef.current.discardDraft(command, current.session.snapshot.csrfToken);
      const session = current.session.applyDraft(result);
      commit({ ...current, session, draft: result, notice: { kind: "success", text: labels().success } });
      setDraftText(result.text ?? "");
    } catch (error) {
      commit({ ...current, notice: { kind: "failure", text: draftProblemText(error, labels().failure) } });
    }
  };

  const handleRenameChat = async (handle: string, newTitle: string): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.snapshot.selection === null) return;
    const entry = current.session.chatList?.chats.find((chat) => chat.handle === handle);
    if (entry === undefined) {
      commit({ ...current, notice: { kind: "failure", text: labels().failure } });
      return;
    }
    try {
      const result: ChatTitleV1 = await apiRef.current.renameChatTitle(
        {
          apiVersion: 1,
          selectionGeneration: current.session.snapshot.selection.generation,
          chatHandle: handle,
          expectedManagementRevision: entry.managementRevision,
          title: newTitle,
        },
        current.session.snapshot.csrfToken,
      );
      const session = current.session.applyRenamedTitle(handle, result);
      commit({ ...current, session, notice: { kind: "success", text: labels().success } });
    } catch (error) {
      // Every rejection re-reads the durable list so the drawer never shows a
      // stale revision; the problem is then player-visible.
      try {
        const session = await reconcileList(current);
        commit({
          ...current,
          session,
          notice: { kind: "failure", text: renameProblemText(error, labels().failure) },
        });
      } catch {
        commit({ ...current, notice: { kind: "failure", text: labels().failure } });
      }
    }
  };

  const [draftText, setDraftText] = useState("");

  const draftSaveAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some((op) => typeof op === "object" && op !== null && (op as Readonly<Record<string, unknown>>).operationId === "draft.save" && (op as Readonly<Record<string, unknown>>).availability === "available");
  const draftDiscardAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some((op) => typeof op === "object" && op !== null && (op as Readonly<Record<string, unknown>>).operationId === "draft.discard" && (op as Readonly<Record<string, unknown>>).availability === "available");

  const renameAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        (op as Readonly<Record<string, unknown>>).operationId === "chat.rename" &&
        (op as Readonly<Record<string, unknown>>).availability === "available",
    );

  const chats: ChatSummary[] =
    view.kind === "ready" && view.session.chatList !== null
      ? view.session.chatList.chats.map((chat) => ({
          chatHandle: chat.handle,
          title: chat.title ?? labels().untitledChat,
        }))
      : [];

  return (
    <div className="tavern-app-shell" data-profile="management">
      <SkipLink label={labels().skipToChat} />

      {view.kind === "loading" && (
        <main id="main-content" className="app-main-content">
          <div className="state-placeholder">
            <p className="loading-text">{labels().openingChat}</p>
          </div>
        </main>
      )}

      {view.kind === "problem" && <ProblemView title={view.title} detail={view.detail} />}

      {view.kind === "ready" && view.session.snapshot.chat !== null && (
        <>
          <header className="app-bar">
            <div className="app-bar-title">{view.session.snapshot.chat.companion.name}</div>
            <button
              type="button"
              className="small-button"
              onClick={() => setDrawerOpen(true)}
              title={labels().chats}
            >
              {labels().chats}
            </button>
          </header>
          <main id="main-content" className="app-main-content">
            {view.notice !== null && (
              <div className={`error-banner ${view.notice.kind === "success" ? "success-banner" : ""}`} role="status">
                {view.notice.text}
              </div>
            )}
            <Timeline
              transcript={view.session.snapshot.chat.transcript}
              companionName={view.session.snapshot.chat.companion.name}
              chatTitle={view.session.snapshot.chat.title}
              labels={labels()}
            />
            <section className="reference-draft-section" aria-label={labels().savedDraft}>
              <textarea
                aria-label={labels().savedDraft}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                placeholder={labels().noSavedDraft}
                rows={3}
              />
              <div className="composer-actions">
                <button type="button" className="small-button" disabled={!draftSaveAvailable || draftText.trim().length === 0} onClick={() => void handleDraftMutation("save")}>
                  {labels().save}
                </button>
                <button type="button" className="small-button" disabled={!draftDiscardAvailable || view.draft.text === null} onClick={() => void handleDraftMutation("discard")}>
                  {labels().discard}
                </button>
              </div>
            </section>
          </main>
          <ChatsDrawer
            isOpen={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            labels={labels()}
            chats={chats}
            currentChatHandle={view.session.snapshot.selection?.chatHandle ?? ""}
            onRenameChat={renameAvailable ? (handle, title) => void handleRenameChat(handle, title) : undefined}
          />
        </>
      )}
    </div>
  );
}

function draftProblemText(error: unknown, fallback: string): string {
  if (error instanceof TavernProblemError && (error.code === "draft_conflict" || error.code === "selection_conflict")) return fallback;
  return fallback;
}

function renameProblemText(error: unknown, fallback: string): string {
  if (error instanceof TavernProblemError) {
    // Existing revision-CAS problem semantics: the list was already
    // re-read; the frozen codes surface the generic failure text.
    if (error.code === "selection_conflict" || error.code === "draft_conflict") return fallback;
  }
  return fallback;
}

function problemView(error: unknown, labels: ReturnType<typeof messages>): ProblemViewState {
  if (
    error instanceof TavernProblemError &&
    (error.retryable || error.code === "runtime_unavailable" || error.code === "storage_unavailable")
  ) {
    return {
      kind: "problem",
      title: labels.problemTemporarilyUnavailableTitle,
      detail: labels.problemTemporarilyUnavailableDetail,
    };
  }
  if (error instanceof TavernProblemError || error instanceof ManagementPipelineSessionError || error instanceof TavernProtocolError) {
    return {
      kind: "problem",
      title: labels.problemReconciliationFailedTitle,
      detail: labels.problemReconciliationFailedDetail,
    };
  }
  return {
    kind: "problem",
    title: labels.problemReconciliationFailedTitle,
    detail: labels.problemReconciliationFailedDetail,
  };
}
