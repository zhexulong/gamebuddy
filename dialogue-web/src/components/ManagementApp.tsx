import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { applyDocumentLocale, type Locale, messages, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type ChatTitleV1,
  createManagementPipelineApi,
  type MemoryItemV1,
  type MemoryReadV1,
  TavernProblemError,
  TavernProtocolError,
  type TavernStateSnapshotV1,
} from "../management-pipeline-api";
import {
  createManagementPipelineSession,
  type ManagementPipelineSession,
  ManagementPipelineSessionError,
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
 *
 * Draft ordering (frozen): save/discard PUT/DELETE /draft with the mounted
 * expectedRevision -> validated durable read-back replaces the draft. Any
 * rejected mutation re-reads the authoritative durable draft before the
 * failure notice is shown, so a stale local textarea (e.g. a 409 from a
 * same-cookie stale tab) can never survive the conflict.
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

type MemoryView =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "empty"; projectionRevision: string }>
  | Readonly<{ kind: "ready"; rows: readonly MemoryItemV1[]; projectionRevision: string }>;

export function ManagementApp() {
  const apiRef = useRef(createManagementPipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryView>({ kind: "idle" });
  const localeRef = useRef<Locale>(resolveLocale());
  const cancelledRef = useRef(false);

  const commit = useCallback((next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

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
  }, [commit]);

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
      const result =
        kind === "save"
          ? await apiRef.current.saveDraft(
              command as { apiVersion: 1; selectionGeneration: number; expectedRevision: number; text: string },
              current.session.snapshot.csrfToken,
            )
          : await apiRef.current.discardDraft(command, current.session.snapshot.csrfToken);
      const session = current.session.applyDraft(result);
      commit({ ...current, session, draft: result, notice: { kind: "success", text: labels().success } });
      setDraftText(result.text ?? "");
    } catch (error) {
      // A rejected draft mutation means the durable draft may no longer match
      // this mounted revision (e.g. a stale tab hitting a 409 draft/selection
      // conflict): re-read the authoritative durable draft before showing the
      // failure so the textarea and session reflect the server read-back and
      // the stale local value can never survive the conflict.
      try {
        const draft = await apiRef.current.readDraft();
        let session = current.session;
        try {
          session = session.applyDraft(draft);
        } catch {
          // Read-back revision is not newer than the mounted snapshot: keep
          // the mounted snapshot (fail closed); the read-back still drives the
          // editor, discarding the stale local value.
        }
        commit({
          ...current,
          session,
          draft,
          notice: { kind: "failure", text: draftProblemText(error, labels().failure) },
        });
        setDraftText(draft.text ?? "");
      } catch {
        commit({ ...current, notice: { kind: "failure", text: draftProblemText(error, labels().failure) } });
      }
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

  const memoryReadAvailable = view.kind === "ready" && view.session.snapshot.memory.readAvailable === true;
  const memoryMutationAvailable = view.kind === "ready" && view.session.snapshot.memory.mutationAvailable === true;
  const loadMemory = (): void => {
    setMemoryView({ kind: "loading" });
    void (async () => {
      try {
        const result = await apiRef.current.readMemory();
        if (result.memories.length === 0)
          setMemoryView({ kind: "empty", projectionRevision: result.projectionRevision });
        else setMemoryView({ kind: "ready", rows: result.memories, projectionRevision: result.projectionRevision });
      } catch {
        setMemoryView({ kind: "error" });
      }
    })();
  };

  const replaceMemory = (result: MemoryReadV1): void => {
    if (result.memories.length === 0) setMemoryView({ kind: "empty", projectionRevision: result.projectionRevision });
    else setMemoryView({ kind: "ready", rows: result.memories, projectionRevision: result.projectionRevision });
  };

  const handleMemoryMutation = (
    input:
      | { operation: "create"; content: string }
      | { operation: "update"; handle: string; content: string }
      | { operation: "archive"; handle: string },
  ): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const projectionRevision =
      memoryView.kind === "ready" || memoryView.kind === "empty" ? memoryView.projectionRevision : null;
    if (projectionRevision === null) return;
    void (async () => {
      try {
        const result = await apiRef.current.mutateMemory(
          { apiVersion: 1, expectedProjectionRevision: projectionRevision, ...input },
          current.session.snapshot.csrfToken,
        );
        replaceMemory(result);
        commit({ ...current, notice: { kind: "success", text: labels().success } });
      } catch {
        try {
          replaceMemory(await apiRef.current.readMemory());
        } catch {
          setMemoryView({ kind: "error" });
        }
        commit({ ...current, notice: { kind: "failure", text: labels().failure } });
      }
    })();
  };

  const handleToggleMemory = (): void => {
    if (!memoryReadAvailable) return;
    if (memoryOpen) {
      setMemoryOpen(false);
      setMemoryView({ kind: "idle" });
      return;
    }
    setMemoryOpen(true);
    loadMemory();
  };

  const handleWorldInfoBinding = async (sourceHandle: string | null): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const selection = current.session.snapshot.selection;
    const chat = current.session.snapshot.chat;
    if (selection === null || chat === null || chat.worldInfo === null) return;

    const worldInfo = chat.worldInfo;
    let mutationFailed = false;
    try {
      await apiRef.current.setWorldInfoBinding(
        {
          apiVersion: 1,
          selectionGeneration: selection.generation,
          expectedRevision: worldInfo.revision,
          sourceHandle,
        },
        current.session.snapshot.csrfToken,
      );
    } catch {
      mutationFailed = true;
    }

    // The service result is deliberately not applied locally. Both success and
    // failure re-read the authoritative mounted snapshot; applySnapshot keeps
    // the exact Chat identity check at the browser boundary.
    try {
      const snapshot = await apiRef.current.readState();
      const session = current.session.applySnapshot(snapshot);
      commit({
        ...current,
        session,
        notice: mutationFailed
          ? { kind: "failure", text: labels().worldInfoBindingFailure }
          : { kind: "success", text: labels().success },
      });
    } catch {
      commit({ ...current, notice: { kind: "failure", text: labels().worldInfoBindingFailure } });
    }
  };

  const draftSaveAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        (op as Readonly<Record<string, unknown>>).operationId === "draft.save" &&
        (op as Readonly<Record<string, unknown>>).availability === "available",
    );
  const draftDiscardAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        (op as Readonly<Record<string, unknown>>).operationId === "draft.discard" &&
        (op as Readonly<Record<string, unknown>>).availability === "available",
    );

  const renameAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        (op as Readonly<Record<string, unknown>>).operationId === "chat.rename" &&
        (op as Readonly<Record<string, unknown>>).availability === "available",
    );

  const worldInfoBindAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat?.worldInfo !== null &&
    view.session.snapshot.operations.some(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        (op as Readonly<Record<string, unknown>>).operationId === "world-info.bind" &&
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
            <div className="app-bar-actions">
              <button type="button" className="small-button" onClick={() => setDrawerOpen(true)} title={labels().chats}>
                {labels().chats}
              </button>
              {memoryReadAvailable && (
                <button type="button" className="small-button" onClick={handleToggleMemory} title={labels().memory}>
                  {labels().memory}
                </button>
              )}
            </div>
          </header>
          <main id="main-content" className="app-main-content">
            {view.notice !== null && (
              <div className={`error-banner ${view.notice.kind === "success" ? "success-banner" : ""}`} role="status">
                {view.notice.text}
              </div>
            )}
            {worldInfoBindAvailable && view.session.snapshot.chat.worldInfo !== null && (
              <WorldInfoBindingPanel
                worldInfo={view.session.snapshot.chat.worldInfo}
                labels={labels()}
                onBind={(handle) => void handleWorldInfoBinding(handle)}
              />
            )}
            {memoryOpen ? (
              <MemoryPanel
                memoryView={memoryView}
                labels={labels()}
                locale={view.locale}
                onRefresh={loadMemory}
                mutationAvailable={memoryMutationAvailable}
                onMutate={handleMemoryMutation}
              />
            ) : (
              <>
                <Timeline
                  transcript={view.session.snapshot.chat.transcript}
                  companionName={view.session.snapshot.chat.companion.name}
                  chatTitle={view.session.snapshot.chat.title}
                  labels={labels()}
                />
                <section className="reference-draft-section" aria-label={labels().savedDraft}>
                  <textarea
                    aria-label={labels().savedDraft}
                    className="form-textarea"
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                    placeholder={labels().noSavedDraft}
                    rows={3}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={!draftSaveAvailable || draftText.trim().length === 0}
                      onClick={() => void handleDraftMutation("save")}
                    >
                      {labels().save}
                    </button>
                    <button
                      type="button"
                      className="small-button"
                      disabled={!draftDiscardAvailable || view.draft.text === null}
                      onClick={() => void handleDraftMutation("discard")}
                    >
                      {labels().discard}
                    </button>
                  </div>
                </section>
              </>
            )}
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

function WorldInfoBindingPanel({
  worldInfo,
  labels,
  onBind,
}: Readonly<{
  worldInfo: NonNullable<TavernStateSnapshotV1["chat"]>["worldInfo"] & {};
  labels: ReturnType<typeof messages>;
  onBind: (sourceHandle: string | null) => void;
}>): ReactElement {
  if (worldInfo === null) return <></>;
  const controlsLocked = worldInfo.state === "locked" || worldInfo.state === "unavailable";
  const hasItems = worldInfo.items.length > 0;
  return (
    <section className="reference-draft-section" aria-label={labels.worldInfoBindingTitle} data-world-info-binding>
      <h2>{labels.worldInfoBindingTitle}</h2>
      {worldInfo.state === "unavailable" ? (
        <p>{labels.worldInfoUnavailable}</p>
      ) : !hasItems ? (
        <p>{labels.worldInfoEmpty}</p>
      ) : (
        <div role="list">
          {worldInfo.items.map((item) => (
            <div key={item.handle} role="listitem">
              <strong>{item.title}</strong>
              {item.summary !== null && <p>{item.summary}</p>}
              <div className="composer-actions">
                {item.selected ? (
                  <button
                    type="button"
                    className="small-button"
                    disabled={controlsLocked}
                    onClick={() => onBind(null)}
                    aria-label={`${labels.worldInfoUnbind}: ${item.title}`}
                  >
                    {labels.worldInfoUnbind}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="small-button"
                    disabled={controlsLocked}
                    onClick={() => onBind(item.handle)}
                    aria-label={`${labels.worldInfoBind}: ${item.title}`}
                  >
                    {labels.worldInfoBind}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {worldInfo.state === "locked" && <p>{labels.worldInfoLocked}</p>}
    </section>
  );
}

function draftProblemText(error: unknown, fallback: string): string {
  if (error instanceof TavernProblemError && (error.code === "draft_conflict" || error.code === "selection_conflict"))
    return fallback;
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

const MEMORY_STATUS_LABELS: Readonly<Record<string, { en: string; zh: string }>> = {
  active: { en: "Active", zh: "活跃" },
  permanent: { en: "Permanent", zh: "长期" },
  archived: { en: "Archived", zh: "已归档" },
};

function MemoryPanel({
  memoryView,
  labels,
  locale,
  onRefresh,
  mutationAvailable,
  onMutate,
}: Readonly<{
  memoryView: MemoryView;
  labels: ReturnType<typeof messages>;
  locale: Locale;
  onRefresh: () => void;
  mutationAvailable: boolean;
  onMutate: (
    input:
      | { operation: "create"; content: string }
      | { operation: "update"; handle: string; content: string }
      | { operation: "archive"; handle: string },
  ) => void;
}>): ReactElement {
  const statusText = (status: string, pinned: boolean): string => {
    const base = MEMORY_STATUS_LABELS[status]?.[locale === "zh-CN" ? "zh" : "en"] ?? status;
    const pinnedLabel = locale === "zh-CN" ? "固定" : "Pinned";
    return pinned ? `${base} · ${pinnedLabel}` : base;
  };
  return (
    <section className="tavern-memory-section" aria-label={labels.semanticMemory} data-memory-panel>
      <div className="tavern-memory-header">
        <h2 className="tavern-memory-title">{labels.semanticMemory}</h2>
        <button type="button" className="small-button" onClick={onRefresh} title={labels.refreshMemory}>
          {labels.refreshMemory}
        </button>
      </div>
      {memoryView.kind === "loading" && (
        <div className="state-placeholder" data-memory-state="loading">
          <p className="loading-text">{labels.openingChat}</p>
        </div>
      )}
      {memoryView.kind === "unavailable" && (
        <div className="state-placeholder" data-memory-state="unavailable">
          <p className="loading-text">{labels.noMemories}</p>
        </div>
      )}
      {memoryView.kind === "error" && (
        <div className="state-placeholder" data-memory-state="error">
          <p className="loading-text">{labels.failure}</p>
        </div>
      )}
      {mutationAvailable && (
        <MemoryCreateForm label={labels.create} onCreate={(content) => onMutate({ operation: "create", content })} />
      )}
      {memoryView.kind === "empty" && (
        <div className="state-placeholder" data-memory-state="empty">
          <p className="loading-text">{labels.noMemories}</p>
        </div>
      )}
      {memoryView.kind === "ready" && (
        <div className="memory-list" role="list" data-memory-state="ready">
          {memoryView.rows.map((item) => (
            <MemoryRow
              key={item.handle}
              item={item}
              statusText={statusText(item.status, item.pinned)}
              labels={labels}
              mutationAvailable={mutationAvailable}
              onUpdate={(content) => onMutate({ operation: "update", handle: item.handle, content })}
              onArchive={() => onMutate({ operation: "archive", handle: item.handle })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MemoryCreateForm({
  label,
  onCreate,
}: Readonly<{ label: string; onCreate: (content: string) => void }>): ReactElement {
  const [content, setContent] = useState("");
  return (
    <div className="composer-actions">
      <textarea
        aria-label="Memory content"
        className="form-textarea"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={2}
      />
      <button
        type="button"
        className="small-button"
        disabled={content.trim().length === 0}
        onClick={() => {
          onCreate(content.trim());
          setContent("");
        }}
      >
        {label}
      </button>
    </div>
  );
}

function MemoryRow({
  item,
  statusText,
  labels,
  mutationAvailable,
  onUpdate,
  onArchive,
}: Readonly<{
  item: MemoryItemV1;
  statusText: string;
  labels: ReturnType<typeof messages>;
  mutationAvailable: boolean;
  onUpdate: (content: string) => void;
  onArchive: () => void;
}>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(item.content);
  const beginEditing = (): void => {
    // A conflict replaces the item with the authoritative reread. Reset this
    // local draft at the transition into edit mode so a previous rejected
    // value can never be submitted against the fresh projection revision.
    setContent(item.content);
    setEditing(true);
  };
  return (
    <div className="memory-item-card" role="listitem">
      <div className="memory-header">
        <span className="memory-item-title">{item.title}</span>
        <span className="memory-item-meta">{statusText}</span>
      </div>
      {editing ? (
        <textarea
          aria-label={`${labels.memoryContent}: ${item.title}`}
          className="form-textarea"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={2}
        />
      ) : (
        <p>{item.content}</p>
      )}
      {mutationAvailable && item.status !== "archived" && (
        <div className="composer-actions">
          {editing ? (
            <button
              type="button"
              className="small-button"
              disabled={content.trim().length === 0}
              onClick={() => {
                onUpdate(content.trim());
                setEditing(false);
              }}
            >
              {labels.save}
            </button>
          ) : (
            <button type="button" className="small-button" onClick={beginEditing}>
              {labels.editMemory}
            </button>
          )}
          <button type="button" className="small-button" onClick={onArchive}>
            {labels.archiveMemory}
          </button>
        </div>
      )}
    </div>
  );
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
  if (
    error instanceof TavernProblemError ||
    error instanceof ManagementPipelineSessionError ||
    error instanceof TavernProtocolError
  ) {
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
