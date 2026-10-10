import { useCallback, useEffect, useRef, useState } from "react";
import { applyDocumentLocale, type Locale, messages, persistLocale, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type ChatTitleV1,
  type TavernStateSnapshotV1,
  TavernProblemError,
  TavernProtocolError,
} from "../management-pipeline-api";
import {
  createManagementPipelineSession,
  type ManagementPipelineSession,
  ManagementPipelineSessionError,
} from "../management-pipeline-session";
import { CharactersPanel } from "./CharactersPanel";
import { ChatsDrawer } from "./drawers/ChatsDrawer";
import {
  ChatsSurfacePanel,
  createManagementPipelineApi,
  type ManagementSurfaceNotice,
  MemorySurfacePanel,
  SettingsSurfacePanel,
  WorldInfoSurfacePanel,
  type WorldInfoSurfaceSource,
} from "./management-surface-panels";
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
 * export operations, so those controls are absent (never fake): the Chats
 * drawer renders only list rows and the API-backed rename.
 *
 * The management domain's panels - Chats, Memory, World Info and Settings - are
 * `management-surface-panels.tsx`, the same components the composed product
 * shell mounts, so the read and mutation state machines exist once. This shell
 * owns what is genuinely its own: the mounted session and draft, the one
 * `role="status"` banner the panels report their outcomes to, the profile's
 * capability flags it passes into the panels, and the drawer/panel chrome.
 *
 * Rename ordering (frozen, in `ChatsSurfacePanel`): current entry
 * managementRevision from the last validated list -> PUT /chat/title with exact
 * selectionGeneration + handle -> validated durable read-back replaces the entry.
 * This shell additionally folds that read-back into its mounted session, so the
 * transcript heading follows the rename. Any problem re-reads the list; nothing
 * is ever appended or guessed locally.
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


export function ManagementApp() {
  const apiRef = useRef(createManagementPipelineApi(fetch, (observation) => {
    if (new URLSearchParams(location.hash.slice(1)).get("record") !== "operations") return;
    const key = "gamebuddy.tavern.ui.operation-observations";
    const current = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    sessionStorage.setItem(key, JSON.stringify([...current, observation]));
  }));
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  // The Characters surface is mounted by a read-probe, mirroring the settings
  // panel: a profile without the Character routes answers `unavailable`, so the
  // UI never shows controls that could not work.
  const [charactersAvailable, setCharactersAvailable] = useState(false);
  const charactersProbeRef = useRef(false);
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

  /**
   * The one banner this surface renders. Every management panel reports its
   * outcome here, so a panel body stays shared while the surface still shows one
   * closed success/failure line instead of a notice per panel.
   */
  const handleNotice = useCallback((notice: ManagementSurfaceNotice): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    commit({ ...current, notice });
  }, [commit]);

  /**
   * Folds the validated rename read-back into the mounted session, so this
   * surface's transcript heading follows the rename exactly as the panel's list
   * does. The panel already shows the read-back itself; a session whose identity
   * moved on keeps its own snapshot instead of adopting a mismatched one.
   */
  const handleRenamedTitle = useCallback((handle: string, result: ChatTitleV1): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    try {
      commit({ ...current, session: current.session.applyRenamedTitle(handle, result) });
    } catch {
      // The panel's list is authoritative for what it shows.
    }
  }, [commit]);

  /**
   * The World Info revision this surface shows and re-reads. The mounted
   * snapshot IS this profile's authority for it (and the read that makes a lost
   * revision conflict visible), so the panel reads through here rather than
   * through the dedicated route; a mismatched-identity re-read propagates as the
   * bind failure it is.
   */
  const readMountedWorldInfo = useCallback(async (): Promise<WorldInfoSurfaceSource> => {
    const current = viewRef.current;
    const snapshot = await apiRef.current.readState();
    if (current.kind === "ready") commit({ ...current, session: current.session.applySnapshot(snapshot) });
    return {
      worldInfo: snapshot.chat?.worldInfo ?? null,
      selectionGeneration: snapshot.selection?.generation ?? 0,
    };
  }, [commit]);

  /**
   * Writes the UI's own display language. This is the interface's language, not the
   * companion's: it changes what the player reads here (and the document locale).
   * The companion language keeps its own choice, seeded once by the settings panel
   * if the player never made one.
   */
  const handleUiLanguageMutation = useCallback((locale: Locale): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    localeRef.current = locale;
    persistLocale(locale);
    applyDocumentLocale(locale);
    commit({ ...current, locale, notice: null });
  }, [commit]);

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

  useEffect(() => {
    if (view.kind !== "ready" || charactersProbeRef.current) return;
    charactersProbeRef.current = true;
    void (async () => {
      try {
        await apiRef.current.listCompanions();
        setCharactersAvailable(true);
      } catch {
        setCharactersAvailable(false);
      }
    })();
  }, [view]);

  const memoryReadAvailable =
    view.kind === "ready" && view.session.snapshot.memory.readAvailable === true;
  const memoryMutationAvailable =
    view.kind === "ready" && view.session.snapshot.memory.mutationAvailable === true;

  const handleToggleMemory = (): void => {
    if (!memoryReadAvailable) return;
    setMemoryOpen((open) => !open);
  };

  const operationAvailable = (operationId: string): boolean =>
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) => op.operationId === operationId && op.availability === "available",
    );
  const renameAvailable = operationAvailable("chat.rename");
  const retentionAvailable = operationAvailable("chat.archive");
  const worldInfoBindAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat?.worldInfo !== null &&
    operationAvailable("world-info.bind");

  const draftSaveAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some((op) => op.operationId === "draft.save" && op.availability === "available");
  const draftDiscardAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) => op.operationId === "draft.discard" && op.availability === "available",
    );

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
              <button
                type="button"
                className="small-button"
                onClick={() => setDrawerOpen(true)}
                title={labels().chats}
              >
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
            <SettingsSurfacePanel
              api={apiRef.current}
              csrfToken={view.session.snapshot.csrfToken}
              labels={labels()}
              uiLocale={view.locale}
              onSelectUiLocale={handleUiLanguageMutation}
              onNotice={handleNotice}
            />
            {charactersAvailable && (
              <CharactersPanel api={apiRef.current} csrfToken={view.session.snapshot.csrfToken} labels={labels()} />
            )}
            {worldInfoBindAvailable && (
              <WorldInfoSurfacePanel
                api={apiRef.current}
                csrfToken={view.session.snapshot.csrfToken}
                labels={labels()}
                read={readMountedWorldInfo}
                onNotice={handleNotice}
              />
            )}
            {memoryOpen ? (
              <MemorySurfacePanel
                api={apiRef.current}
                csrfToken={view.session.snapshot.csrfToken}
                labels={labels()}
                locale={view.locale}
                mutationAvailable={memoryMutationAvailable}
                onNotice={handleNotice}
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
          <ChatsDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} labels={labels()}>
            <ChatsSurfacePanel
              api={apiRef.current}
              csrfToken={view.session.snapshot.csrfToken}
              labels={labels()}
              selectionGeneration={view.session.snapshot.selection?.generation ?? 0}
              currentChatHandle={view.session.snapshot.selection?.chatHandle ?? ""}
              renameAvailable={renameAvailable}
              retentionAvailable={retentionAvailable}
              onRenamedTitle={handleRenamedTitle}
              onNotice={handleNotice}
            />
          </ChatsDrawer>
        </>
      )}
    </div>
  );
}


function draftProblemText(error: unknown, fallback: string): string {
  if (error instanceof TavernProblemError && (error.code === "draft_conflict" || error.code === "selection_conflict"))
    return fallback;
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
