import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { applyDocumentLocale, type Locale, messages, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type ChatTitleV1,
  createManagementPipelineApi,
  type MemoryItemV1,
  type MemoryReadV1,
  type TavernConnectionProviderV1,
  type TavernConnectionStateV1,
  type TavernConnectionThinkingLevelV1,
  type TavernConnectionV1,
  type TavernVoicePreferenceV1,
  type TavernVoiceDevicesV1,
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
 *
 * Voice output ordering (frozen): the panel offers the enumerated Windows
 * endpoints plus the always-selectable system default; picking one PUTs
 * `settings.voice-preference` with the current preference `expectedRevision`
 * and the selection is replaced by the validated mutation read-back, so the
 * selector shows the persisted endpoint and never the local choice. One
 * mutation is admitted at a time (a second click would reuse the same
 * `expectedRevision` and manufacture a durable `settings_revision_conflict`),
 * and a rejected mutation re-reads the authoritative preference before the
 * failure is shown.
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

type VoiceView = Readonly<{ kind: "loading" }> | Readonly<{ kind: "unavailable" }> | Readonly<{ kind: "error" }> | Readonly<{ kind: "ready"; preference: TavernVoicePreferenceV1; devices: TavernVoiceDevicesV1 | null; pending: boolean }>;

/**
 * Connection panel state. `pending` is the one-management-mutation-at-a-time
 * guard: the durable document revision every mutation carries as its
 * compare-and-swap would otherwise turn a double click into a conflict.
 */
type ConnectionView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; state: TavernConnectionStateV1; pending: boolean; notice: "activation" | "busy" | "conflict" | null }>;

type MemoryView =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "empty"; projectionRevision: string }>
  | Readonly<{ kind: "ready"; rows: readonly MemoryItemV1[]; projectionRevision: string }>;

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
  const [memoryView, setMemoryView] = useState<MemoryView>({ kind: "idle" });
  const [voiceView, setVoiceView] = useState<VoiceView>({ kind: "loading" });
  const voiceLoadedRef = useRef(false);
  const [connectionView, setConnectionView] = useState<ConnectionView>({ kind: "loading" });
  const connectionLoadedRef = useRef(false);
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
        if (!voiceLoadedRef.current) {
          voiceLoadedRef.current = true;
          try {
            const preference = await api.readVoicePreference();
            // Device enumeration is an optional additive read: when the gateway
            // is absent or has no Windows endpoints the panel still offers the
            // Windows default selection through the preference alone.
            let devices: TavernVoiceDevicesV1 | null = null;
            try {
              devices = await api.readVoiceDevices();
            } catch {
              devices = null;
            }
            setVoiceView({ kind: "ready", preference, devices, pending: false });
          } catch {
            // Older management fixtures may not publish the optional voice route.
            setVoiceView({ kind: "unavailable" });
          }
        }
        if (!connectionLoadedRef.current) {
          connectionLoadedRef.current = true;
          try {
            const state = await api.readConnection();
            if (!active) return;
            // The projected readiness IS the durable record's readiness; the
            // panel never derives a ready state from local intent.
            setConnectionView({ kind: "ready", state, pending: false, notice: null });
          } catch {
            // A management profile without the connection extension group does
            // not publish these routes at all.
            setConnectionView({ kind: "unavailable" });
          }
        }
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

  const handleVoiceMutation = async (action: "accept" | "revoke" | "setOutputDevice", outputDevice: string | null = null): Promise<void> => {
    const current = viewRef.current;
    const voice = voiceView;
    if (current.kind !== "ready" || voice.kind !== "ready" || voice.pending) return;
    const command = action === "accept"
      ? { action, expectedRevision: voice.preference.revision, disclosureVersion: "mimo-cloud-tts-v1" as const }
      : action === "setOutputDevice"
        ? { action, expectedRevision: voice.preference.revision, outputDevice }
        : { action, expectedRevision: voice.preference.revision };
    // One in-flight mutation at a time: a second identical action would reuse
    // the same expectedRevision and turn an ordinary double click into a
    // durable revision conflict.
    setVoiceView({ ...voice, pending: true });
    try {
      // The validated mutation response IS the durable read-back (the store
      // re-reads the written file and compares it before projecting), so the
      // selector always shows the persisted selection, never the local choice.
      const preference = await apiRef.current.updateVoicePreference(command, current.session.snapshot.csrfToken);
      setVoiceView({ kind: "ready", preference, devices: voice.devices, pending: false });
      commit({ ...current, notice: { kind: "success", text: labels().success } });
    } catch {
      // A rejection can still hide a committed change (e.g. a same-cookie
      // stale tab hitting settings_revision_conflict), so re-read the
      // authoritative preference before the failure is shown and never keep a
      // local selection the durable store did not accept.
      try {
        const preference = await apiRef.current.readVoicePreference();
        setVoiceView({ kind: "ready", preference, devices: voice.devices, pending: false });
      } catch {
        setVoiceView({ kind: "error" });
      }
      commit({ ...current, notice: { kind: "failure", text: labels().failure } });
    }
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

  const memoryReadAvailable =
    view.kind === "ready" && view.session.snapshot.memory.readAvailable === true;
  const memoryMutationAvailable =
    view.kind === "ready" && view.session.snapshot.memory.mutationAvailable === true;
  const loadMemory = (): void => {
    setMemoryView({ kind: "loading" });
    void (async () => {
      try {
        const result = await apiRef.current.readMemory();
        if (result.memories.length === 0) setMemoryView({ kind: "empty", projectionRevision: result.projectionRevision });
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

  const handleMemoryMutation = (input: { operation: "create"; content: string } | { operation: "update"; handle: string; content: string } | { operation: "archive"; handle: string }): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const projectionRevision = memoryView.kind === "ready" || memoryView.kind === "empty" ? memoryView.projectionRevision : null;
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

  /**
   * One connection mutation at a time; the durable read-back is what the panel
   * then shows. `notice` carries only closed UI categories, and the successful
   * activation notice makes exactly one claim: the selection is durable and
   * takes effect on the next runtime start. It never claims a running
   * conversation was switched.
   */
  const handleConnectionMutation = async (
    action: (
      api: ReturnType<typeof createManagementPipelineApi>,
      csrfToken: string,
    ) => Promise<TavernConnectionStateV1>,
    activation: boolean,
  ): Promise<void> => {
    const current = viewRef.current;
    const connection = connectionView;
    if (current.kind !== "ready" || connection.kind !== "ready" || connection.pending) return;
    setConnectionView({ ...connection, pending: true, notice: null });
    try {
      const state = await action(apiRef.current, current.session.snapshot.csrfToken);
      setConnectionView({ kind: "ready", state, pending: false, notice: activation ? "activation" : null });
      commit({
        ...current,
        notice: activation
          ? { kind: "success", text: labels().connectionActivationNotice }
          : { kind: "success", text: labels().success },
      });
    } catch (error) {
      // A rejection can still hide a committed change or a busy turn, so re-read
      // the authoritative projection before showing the failure and never keep a
      // local selection the durable store did not accept.
      let notice: "busy" | "conflict" | null = null;
      if (error instanceof TavernProblemError && error.code === "dialogue_busy") notice = "busy";
      else if (error instanceof TavernProblemError && error.code === "connection_conflict") notice = "conflict";
      try {
        const state = await apiRef.current.readConnection();
        setConnectionView({ kind: "ready", state, pending: false, notice });
      } catch {
        setConnectionView({ kind: "unavailable" });
      }
      commit({ ...current, notice: { kind: "failure", text: connectionProblemText(error, labels()) } });
    }
  };

  /**
   * Creates the draft record for one catalog entry. The credential is handed
   * straight to the request and is never retained in component state, so a
   * write-only field stays write-only. Creation deliberately does not activate:
   * activation needs a ready record, which requires the player's own test step.
   */
  const handleCreateConnection = async (form: ConnectionForm): Promise<void> => {
    await handleConnectionMutation(async (api, csrfToken) => {
      const connection = connectionView.kind === "ready" ? connectionView.state : null;
      const provider: TavernConnectionProviderV1 | undefined = connection?.providers.find(
        (entry) => entry.providerId === form.providerId,
      );
      if (provider === undefined) throw new TavernProtocolError();
      return await api.createConnection(
        {
          apiVersion: 1,
          providerId: provider.providerId,
          ...(provider.setupFields.includes("apiKey") ? { apiKey: form.apiKey } : {}),
          ...(provider.setupFields.includes("baseUrl") ? { baseUrl: form.baseUrl } : {}),
          ...(form.catalogModelId === "" ? {} : { modelId: form.catalogModelId }),
          ...(provider.setupFields.includes("modelId") ? { modelId: form.modelId } : {}),
        },
        csrfToken,
      );
    }, false);
  };

  const handleTestConnection = async (connectionId: string): Promise<void> => {
    await handleConnectionMutation(async (api, csrfToken) => {
      if (connectionView.kind !== "ready") throw new TavernProtocolError();
      const probe = await api.testConnection(connectionId, connectionView.state.revision, csrfToken);
      return probe.state;
    }, false);
  };

  const handleActivateConnection = async (connectionId: string): Promise<void> => {
    await handleConnectionMutation(async (api, csrfToken) => {
      if (connectionView.kind !== "ready") throw new TavernProtocolError();
      return await api.activateConnection(connectionId, connectionView.state.revision, csrfToken);
    }, true);
  };

  const handleSelectConnectionModel = async (
    connectionId: string,
    modelId: string,
    thinkingLevel: TavernConnectionThinkingLevelV1,
  ): Promise<void> => {
    await handleConnectionMutation(async (api, csrfToken) => {
      if (connectionView.kind !== "ready") throw new TavernProtocolError();
      return await api.selectConnectionModel(
        connectionId,
        { expectedRevision: connectionView.state.revision, modelId, thinkingLevel },
        csrfToken,
      );
    }, false);
  };

  const handleRemoveConnection = async (connectionId: string): Promise<void> => {
    await handleConnectionMutation(async (api, csrfToken) => {
      if (connectionView.kind !== "ready") throw new TavernProtocolError();
      return await api.removeConnection(connectionId, connectionView.state.revision, csrfToken);
    }, false);
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
    view.session.snapshot.operations.some((op) => op.operationId === "draft.save" && op.availability === "available");
  const draftDiscardAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some(
      (op) => op.operationId === "draft.discard" && op.availability === "available",
    );

  const renameAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.rename" && op.availability === "available");

  const worldInfoBindAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat?.worldInfo !== null &&
    view.session.snapshot.operations.some(
      (op) => op.operationId === "world-info.bind" && op.availability === "available",
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
            <VoiceSettingsPanel
              voiceView={voiceView}
              labels={labels()}
              onAccept={() => void handleVoiceMutation("accept")}
              onRevoke={() => void handleVoiceMutation("revoke")}
              onSelectDevice={(deviceId) => void handleVoiceMutation("setOutputDevice", deviceId)}
            />
            {connectionView.kind === "ready" && (
              // The panel is rendered only when the mounted profile actually
              // published the connection routes; a profile without them never
              // shows a control that could not work.
              <ConnectionSettingsPanel
                connectionView={connectionView}
                labels={labels()}
                onCreate={(form) => void handleCreateConnection(form)}
                onTest={(connectionId) => void handleTestConnection(connectionId)}
                onActivate={(connectionId) => void handleActivateConnection(connectionId)}
                onSelectModel={(connectionId, modelId, thinkingLevel) =>
                  void handleSelectConnectionModel(connectionId, modelId, thinkingLevel)
                }
                onRemove={(connectionId) => void handleRemoveConnection(connectionId)}
              />
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

type ConnectionForm = Readonly<{
  providerId: string;
  apiKey: string;
  baseUrl: string;
  /** Player-supplied model id, used only by the escape hatch. */
  modelId: string;
  /** Catalog model selection for every other provider. */
  catalogModelId: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
}>;

function connectionProblemText(error: unknown, labels: ReturnType<typeof messages>): string {
  if (error instanceof TavernProblemError) {
    if (error.code === "dialogue_busy") return labels.connectionBusy;
    if (error.code === "connection_conflict") return labels.connectionRevisionConflict;
    if (error.code === "connection_not_ready") return labels.connectionActivateRequiresReady;
  }
  return labels.failure;
}

function connectionReadinessText(
  readiness: TavernConnectionV1["readiness"],
  labels: ReturnType<typeof messages>,
): string {
  if (readiness === "ready") return labels.connectionReadinessReady;
  if (readiness === "failed") return labels.connectionReadinessFailed;
  if (readiness === "unconfigured") return labels.connectionReadinessUnconfigured;
  return labels.connectionReadinessConfigured;
}

/**
 * Maps one closed probe category to its player notice. The category is the
 * whole vocabulary a failed probe may produce; raw provider text never reaches
 * the browser in the first place.
 */
function connectionFailureText(
  failure: TavernConnectionV1["failure"],
  labels: ReturnType<typeof messages>,
): string | null {
  if (failure === null) return null;
  const suffix = failure
    .split("_")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
  const key = `connectionFailure${suffix}` as
    | "connectionFailureInvalidEndpoint"
    | "connectionFailureNotConfigured"
    | "connectionFailureUnauthorized"
    | "connectionFailureNotFound"
    | "connectionFailureUnreachable"
    | "connectionFailureTimeout"
    | "connectionFailureInvalidResponse";
  return labels[key];
}

function ConnectionSettingsPanel({
  connectionView,
  labels,
  onCreate,
  onTest,
  onActivate,
  onSelectModel,
  onRemove,
}: Readonly<{
  connectionView: Extract<ConnectionView, { kind: "ready" }>;
  labels: ReturnType<typeof messages>;
  onCreate: (form: ConnectionForm) => void;
  onTest: (connectionId: string) => void;
  onActivate: (connectionId: string) => void;
  onSelectModel: (connectionId: string, modelId: string, thinkingLevel: TavernConnectionThinkingLevelV1) => void;
  onRemove: (connectionId: string) => void;
}>): ReactElement {
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [catalogModelId, setCatalogModelId] = useState("");

  const providers = connectionView.state.providers;
  // The escape hatch is a catalog entry like any other; it is preselected only
  // because a player reaching this panel usually has no connection at all.
  const selected =
    providers.find((entry) => entry.providerId === providerId) ??
    providers.find((entry) => entry.escapeHatch) ??
    providers[0];
  const models = selected?.allowedPlayerModels ?? [];
  const chosenModel = models.find((model) => model.modelId === catalogModelId) ?? models[0];

  return (
    <section className="management-settings-section" aria-label={labels.connectionSettings} data-connection-settings>
      <h2>{labels.connectionSettings}</h2>
      <>
          <dl className="management-settings-details" data-connection-active>
            <div>
              <dt>{labels.connectionActiveLabel}</dt>
              <dd data-connection-active-value>
                {connectionView.state.active === null ? labels.connectionNoneActive : connectionView.state.active.label}
              </dd>
            </div>
          </dl>
          {connectionView.state.active === null && <p data-connection-no-selection>{labels.connectionNoSelectionNotice}</p>}
          {connectionView.notice === "activation" && <p data-connection-activated>{labels.connectionActivationNotice}</p>}
          {connectionView.notice === "busy" && <p data-connection-busy>{labels.connectionBusy}</p>}
          {connectionView.notice === "conflict" && <p data-connection-conflict>{labels.connectionRevisionConflict}</p>}

          <form
            className="connection-form"
            data-connection-form
            onSubmit={(event) => {
              event.preventDefault();
              if (selected === undefined) return;
              onCreate({
                providerId: selected.providerId,
                apiKey,
                baseUrl,
                modelId,
                catalogModelId: chosenModel?.modelId ?? catalogModelId,
                thinkingLevel: chosenModel?.defaultThinkingLevel ?? "high",
              });
            }}
          >
            <label htmlFor="connection-provider">{labels.connectionProvider}</label>
            <select
              id="connection-provider"
              className="form-select"
              disabled={connectionView.pending}
              value={selected?.providerId ?? ""}
              onChange={(event) => {
                setProviderId(event.target.value);
                setCatalogModelId("");
              }}
            >
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.escapeHatch ? labels.connectionEscapeHatch : provider.label}
                  {provider.environmentManaged ? ` — ${labels.connectionEnvironmentManaged}` : ""}
                </option>
              ))}
            </select>
            {selected?.escapeHatch === true && <p className="field-hint">{labels.connectionEscapeHatchHint}</p>}

            {selected?.setupFields.includes("baseUrl") === true && (
              <>
                <label htmlFor="connection-base-url">{labels.connectionBaseUrl}</label>
                <input
                  id="connection-base-url"
                  className="form-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connectionView.pending}
                  placeholder={labels.connectionBaseUrlHint}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </>
            )}

            {selected?.setupFields.includes("apiKey") === true && (
              <>
                <label htmlFor="connection-api-key">{labels.connectionApiKey}</label>
                <input
                  id="connection-api-key"
                  className="form-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connectionView.pending}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="field-hint">{labels.connectionApiKeyWriteOnly}</p>
              </>
            )}

            {selected?.escapeHatch === true ? (
              <>
                <label htmlFor="connection-model-id">{labels.connectionModelId}</label>
                <input
                  id="connection-model-id"
                  className="form-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connectionView.pending}
                  placeholder={labels.connectionModelIdHint}
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                />
              </>
            ) : (
              <>
                <label htmlFor="connection-model">{labels.connectionModel}</label>
                <select
                  id="connection-model"
                  className="form-select"
                  disabled={connectionView.pending || models.length === 0}
                  value={chosenModel?.modelId ?? ""}
                  onChange={(event) => setCatalogModelId(event.target.value)}
                >
                  {models.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.modelLabel}
                    </option>
                  ))}
                </select>
              </>
            )}

            <div className="composer-actions">
              <button type="submit" className="small-button" disabled={connectionView.pending}>
                {labels.connectionSave}
              </button>
            </div>
          </form>

          {connectionView.state.connections.length > 0 && (
            <div data-connection-list>
              <h3>{labels.connectionListTitle}</h3>
              <ul className="connection-rows">
                {connectionView.state.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.connectionId}
                    connection={connection}
                    pending={connectionView.pending}
                    labels={labels}
                    onTest={onTest}
                    onActivate={onActivate}
                    onSelectModel={onSelectModel}
                    onRemove={onRemove}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
    </section>
  );
}

/**
 * One saved connection. `connectionId` is never rendered: every control keys
 * off it, but the player reads the provider label, the model and their own
 * base URL (design/28 §1, §5.1).
 */
function ConnectionRow({
  connection,
  pending,
  labels,
  onTest,
  onActivate,
  onSelectModel,
  onRemove,
}: Readonly<{
  connection: TavernConnectionV1;
  pending: boolean;
  labels: ReturnType<typeof messages>;
  onTest: (connectionId: string) => void;
  onActivate: (connectionId: string) => void;
  onSelectModel: (connectionId: string, modelId: string, thinkingLevel: TavernConnectionThinkingLevelV1) => void;
  onRemove: (connectionId: string) => void;
}>): ReactElement {
  const failure = connectionFailureText(connection.failure, labels);
  const levels: readonly TavernConnectionThinkingLevelV1[] = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return (
    <li className="connection-row" data-connection-row data-readiness={connection.readiness}>
      <dl className="management-settings-details">
        <div><dt>{labels.connectionProvider}</dt><dd>{connection.providerLabel}</dd></div>
        <div><dt>{labels.connectionModel}</dt><dd>{connection.modelLabel}</dd></div>
        {connection.baseUrl !== null && (
          <div><dt>{labels.connectionBaseUrl}</dt><dd data-connection-base-url>{connection.baseUrl}</dd></div>
        )}
        <div><dt>{labels.connectionReadiness}</dt><dd>{connectionReadinessText(connection.readiness, labels)}</dd></div>
        {failure !== null && <div><dt>—</dt><dd data-connection-failure>{failure}</dd></div>}
      </dl>
      <div className="composer-actions">
        <label className="visually-hidden-input-label" htmlFor={`connection-level-${connection.connectionId}`}>
          {labels.connectionThinkingLevel}
        </label>
        <select
          id={`connection-level-${connection.connectionId}`}
          className="form-select"
          disabled={pending}
          value={connection.thinkingLevel}
          onChange={(event) =>
            onSelectModel(
              connection.connectionId,
              connection.modelId,
              event.target.value as TavernConnectionThinkingLevelV1,
            )
          }
        >
          {levels.map((level) => (
            <option key={level} value={level}>
              {
                {
                  low: labels.connectionLevelLow,
                  medium: labels.connectionLevelMedium,
                  high: labels.connectionLevelHigh,
                  xhigh: labels.connectionLevelXHigh,
                  max: labels.connectionLevelMax,
                }[level]
              }
            </option>
          ))}
        </select>
        <button
          type="button"
          className="small-button"
          disabled={pending}
          onClick={() => onTest(connection.connectionId)}
        >
          {labels.connectionTest}
        </button>
        <button
          type="button"
          className="small-button"
          disabled={pending || connection.readiness !== "ready" || connection.active}
          title={connection.readiness === "ready" ? undefined : labels.connectionActivateRequiresReady}
          onClick={() => onActivate(connection.connectionId)}
        >
          {labels.connectionActivate}
        </button>
        <button
          type="button"
          className="small-button"
          disabled={pending || connection.active}
          title={connection.active ? labels.connectionRemoveActiveRefused : undefined}
          onClick={() => onRemove(connection.connectionId)}
        >
          {labels.connectionRemove}
        </button>
      </div>
    </li>
  );
}

function VoiceSettingsPanel({
  voiceView,
  labels,
  onAccept,
  onRevoke,
  onSelectDevice,
}: Readonly<{
  voiceView: VoiceView;
  labels: ReturnType<typeof messages>;
  onAccept: () => void;
  onRevoke: () => void;
  onSelectDevice: (deviceId: string | null) => void;
}>): ReactElement {
  return (
    <section className="management-settings-section" aria-label={labels.voiceSettings} data-voice-settings>
      <h2>{labels.voiceSettings}</h2>
      <p>{labels.voiceDisclosure}</p>
      {voiceView.kind === "loading" && <p>{labels.openingChat}</p>}
      {voiceView.kind === "unavailable" && <p>{labels.voiceSettingsUnavailable}</p>}
      {voiceView.kind === "error" && <p>{labels.failure}</p>}
      {voiceView.kind === "ready" && (
        <>
          <dl className="management-settings-details">
            <div><dt>{labels.voiceConsent}</dt><dd>{labels[`voiceConsent${voiceView.preference.consent[0].toUpperCase()}${voiceView.preference.consent.slice(1)}` as "voiceConsentUndecided" | "voiceConsentAccepted" | "voiceConsentRevoked"]}</dd></div>
            <div><dt>{labels.voiceDisclosureVersion}</dt><dd>{voiceView.preference.disclosureVersion ?? "—"}</dd></div>
          </dl>
          <div className="composer-actions">
            <button type="button" className="small-button" onClick={onAccept} disabled={voiceView.pending || voiceView.preference.consent === "accepted"}>{labels.voiceAccept}</button>
            <button type="button" className="small-button" onClick={onRevoke} disabled={voiceView.pending || voiceView.preference.consent === "revoked"}>{labels.voiceRevoke}</button>
          </div>
          <div className="voice-device-selector">
            <label htmlFor="voice-output-device">{labels.voiceOutputDevice}</label>
            <select
              id="voice-output-device"
              className="form-select"
              disabled={voiceView.pending}
              value={voiceView.preference.outputDevice ?? ""}
              onChange={(event) => onSelectDevice(event.target.value === "" ? null : event.target.value)}
            >
              {/* The Windows default endpoint is always selectable and maps
                  to `outputDevice: null` (resolve at each open), so a pinned
                  endpoint can always be released — even when enumeration
                  currently returns nothing. */}
              <option value="">{labels.voiceDefaultOutput}</option>
              {(voiceView.devices?.devices ?? []).map((device) => (
                <option key={device.id} value={device.id}>{device.name}</option>
              ))}
              {voiceView.preference.outputDevice !== null &&
                !(voiceView.devices?.devices ?? []).some((device) => device.id === voiceView.preference.outputDevice) && (
                  // The persisted pin outlives one enumeration (endpoint
                  // unplugged or the gateway is temporarily unavailable). The
                  // effective selection must stay visible instead of silently
                  // rendering an empty select; it is shown, not re-offered.
                  <option key={voiceView.preference.outputDevice} value={voiceView.preference.outputDevice} disabled>
                    {labels.voicePinnedOutputUnlisted}
                  </option>
                )}
            </select>
          </div>
        </>
      )}
    </section>
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
}>): ReactElement | null {
  if (worldInfo === null) return null;
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
  onMutate: (input: { operation: "create"; content: string } | { operation: "update"; handle: string; content: string } | { operation: "archive"; handle: string }) => void;
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
      {mutationAvailable && <MemoryCreateForm label={labels.create} onCreate={(content) => onMutate({ operation: "create", content })} />}
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

function MemoryCreateForm({ label, onCreate }: Readonly<{ label: string; onCreate: (content: string) => void }>): ReactElement {
  const [content, setContent] = useState("");
  return (
    <div className="composer-actions">
      <textarea aria-label="Memory content" className="form-textarea" value={content} onChange={(event) => setContent(event.target.value)} rows={2} />
      <button type="button" className="small-button" disabled={content.trim().length === 0} onClick={() => { onCreate(content.trim()); setContent(""); }}>
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
      {editing ? <textarea aria-label={`${labels.memoryContent}: ${item.title}`} className="form-textarea" value={content} onChange={(event) => setContent(event.target.value)} rows={2} /> : <p>{item.content}</p>}
      {mutationAvailable && item.status !== "archived" && (
        <div className="composer-actions">
          {editing ? (
            <button type="button" className="small-button" disabled={content.trim().length === 0} onClick={() => { onUpdate(content.trim()); setEditing(false); }}>
              {labels.save}
            </button>
          ) : (
            <button type="button" className="small-button" onClick={beginEditing}>{labels.editMemory}</button>
          )}
          <button type="button" className="small-button" onClick={onArchive}>{labels.archiveMemory}</button>
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
