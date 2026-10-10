import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { applyDocumentLocale, type Locale, messages, persistLocale, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type ChatTitleV1,
  CONNECTION_API_SHAPES,
  createManagementPipelineApi,
  type MemoryItemV1,
  type MemoryReadV1,
  type TavernConnectionApiShapeV1,
  type TavernConnectionProviderV1,
  type TavernConnectionStateV1,
  type TavernConnectionThinkingLevelV1,
  type TavernConnectionV1,
  type TavernModelProfileV1,
  type TavernModelProfilesV1,
  type TavernRecommendedModelV1,
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
import { CharactersPanel } from "./CharactersPanel";
import { ChatsDrawer } from "./drawers/ChatsDrawer";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";
import {
  COMPANION_LANGUAGE_SUGGESTIONS,
  companionLocaleForUiLocale,
  ConnectionSettingsPanel,
  ConnectionForm,
  connectionProblemText,
  type ConnectionView,
  LanguageSettingsPanel,
  type LanguageView,
  MemoryPanel,
  type MemoryView,
  ModelProfilesPanel,
  modelProfileProblemText,
  type ModelProfilesView,
  VoiceSettingsPanel,
  type VoiceView,
  WorldInfoBindingPanel,
} from "./management-panels";

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
  const [languageView, setLanguageView] = useState<LanguageView>({ kind: "loading" });
  const voiceLoadedRef = useRef(false);
  const languageLoadedRef = useRef(false);
  // The one Host-owned preference record's revision, shared by both settings
  // panels. The language and voice field groups live in a single record, so a
  // panel-local counter would let one panel's write be silently overwritten by
  // the other's; both read it here and both advance it from the response.
  const settingsRevisionRef = useRef(0);
  const [connectionView, setConnectionView] = useState<ConnectionView>({ kind: "loading" });
  const connectionLoadedRef = useRef(false);
  const [modelProfilesView, setModelProfilesView] = useState<ModelProfilesView>({ kind: "loading" });
  const modelProfilesLoadedRef = useRef(false);
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
            settingsRevisionRef.current = preference.revision;
            setVoiceView({ kind: "ready", preference, devices, pending: false });
          } catch {
            // Older management fixtures may not publish the optional voice route.
            setVoiceView({ kind: "unavailable" });
          }
        }
        if (!languageLoadedRef.current) {
          languageLoadedRef.current = true;
            try {
              const preference = await api.readLanguagePreference();
              if (!active) return;
              // The durable preference is the authority for what the companion speaks.
              // When the player has never chosen, the panel records the language it is
              // already showing, so the companion speaks what the player sees from the
              // first reply on. Once a choice exists it is taken as-is: the companion
              // language and the UI's own language are separate choices, so reading one
              // never rewrites the other.
              if (preference.locale === null) {
                settingsRevisionRef.current = preference.revision;
                try {
                  const written = await api.updateLanguagePreference(
                    { expectedRevision: settingsRevisionRef.current, locale: companionLocaleForUiLocale(localeRef.current) },
                    snapshot.csrfToken,
                  );
                  settingsRevisionRef.current = written.revision;
                  setLanguageView({ kind: "ready", locale: written.locale, pending: false });
                } catch {
                  // A lost race (another tab chose first) is not a panel failure: the
                  // read-back on the next load carries the winner.
                  setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
                }
              } else {
                settingsRevisionRef.current = preference.revision;
                setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
              }
          } catch {
            // A management profile without the language extension group does not
            // publish these routes at all.
            setLanguageView({ kind: "unavailable" });
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
        if (!modelProfilesLoadedRef.current) {
          modelProfilesLoadedRef.current = true;
          try {
            // The read-probe is how the panel learns whether the mounted profile
            // published the model-profile routes: an absent route must not render
            // an editor the Host cannot serve.
            const profiles = await api.readModelProfiles();
            if (!active) return;
            setModelProfilesView({ kind: "ready", profiles, pending: null, notice: null });
          } catch {
            setModelProfilesView({ kind: "unavailable" });
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

  /**
 * Writes the companion language. It is the player's own BCP-47 tag, so nothing here
 * maps it onto the UI's language: the panel shows the tag, confirms it against the
 * durable record, and the UI keeps whatever display language the player chose.
 */
const handleLanguageMutation = async (tag: string): Promise<void> => {
  const current = viewRef.current;
  const language = languageView;
  if (current.kind !== "ready" || language.kind !== "ready" || language.pending) return;
  setLanguageView({ ...language, pending: true });
  try {
    // The validated response IS the durable read-back, so the control always
    // shows what the store holds.
    const written = await apiRef.current.updateLanguagePreference(
      { expectedRevision: settingsRevisionRef.current, locale: tag },
      current.session.snapshot.csrfToken,
    );
    settingsRevisionRef.current = written.revision;
    setLanguageView({ kind: "ready", locale: written.locale, pending: false });
    commit({ ...current, notice: { kind: "success", text: labels().success } });
  } catch {
    // A rejection can still hide a committed change (a same-cookie stale tab
    // hits the revision conflict), so re-read the authority before reverting.
    try {
      const preference = await apiRef.current.readLanguagePreference();
      settingsRevisionRef.current = preference.revision;
      setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
    } catch {
      setLanguageView({ kind: "error" });
    }
    commit({ ...current, notice: { kind: "failure", text: labels().failure } });
  }
};

/**
 * Writes the UI's own display language. This is the interface's language, not the
 * companion's: it changes what the player reads here (and the document locale). The
 * companion language keeps its own choice, seeded once if the player never made one.
 */
const handleUiLanguageMutation = async (locale: Locale): Promise<void> => {
  const current = viewRef.current;
  if (current.kind !== "ready") return;
  localeRef.current = locale;
  persistLocale(locale);
  applyDocumentLocale(locale);
  commit({ ...current, locale, notice: null });
  const language = languageView;
  if (language.kind === "ready" && language.locale === null) await handleLanguageMutation(companionLocaleForUiLocale(locale));
};

  const handleVoiceMutation = async (action: "accept" | "revoke" | "setOutputDevice", outputDevice: string | null = null): Promise<void> => {
    const current = viewRef.current;
    const voice = voiceView;
    if (current.kind !== "ready" || voice.kind !== "ready" || voice.pending) return;
    // The record's one revision, shared with the language panel: a stale value
    // here is a real conflict, never a second counter that lets this write
    // silently discard the other panel's.
    const expectedRevision = settingsRevisionRef.current;
    const command = action === "accept"
      ? { action, expectedRevision, disclosureVersion: "mimo-cloud-tts-v1" as const }
      : action === "setOutputDevice"
        ? { action, expectedRevision, outputDevice }
        : { action, expectedRevision };
    // One in-flight mutation at a time: a second identical action would reuse
    // the same expectedRevision and turn an ordinary double click into a
    // durable revision conflict.
    setVoiceView({ ...voice, pending: true });
    try {
      // The validated mutation response IS the durable read-back (the store
      // re-reads the written file and compares it before projecting), so the
      // selector always shows the persisted selection, never the local choice.
      const preference = await apiRef.current.updateVoicePreference(command, current.session.snapshot.csrfToken);
      settingsRevisionRef.current = preference.revision;
      setVoiceView({ kind: "ready", preference, devices: voice.devices, pending: false });
      commit({ ...current, notice: { kind: "success", text: labels().success } });
    } catch {
      // A rejection can still hide a committed change (e.g. a same-cookie
      // stale tab hitting settings_revision_conflict), so re-read the
      // authoritative preference before the failure is shown and never keep a
      // local selection the durable store did not accept.
      try {
        const preference = await apiRef.current.readVoicePreference();
        settingsRevisionRef.current = preference.revision;
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

  const handleTransitionChat = async (handle: string, operation: "archive" | "trash"): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.snapshot.selection === null) return;
    const entry = current.session.chatList?.chats.find((chat) => chat.handle === handle);
    if (entry === undefined) {
      commit({ ...current, notice: { kind: "failure", text: labels().failure } });
      return;
    }
    try {
      await apiRef.current.transitionChatLifecycle(
        handle,
        operation,
        current.session.snapshot.selection.generation,
        entry.managementRevision,
        current.session.snapshot.csrfToken,
      );
      // The transition removed the chat from the active list (metadata-only
      // mutation); reconcile so the drawer matches the durable list.
      const session = await reconcileList(current);
      commit({ ...current, session, notice: { kind: "success", text: labels().success } });
    } catch {
      try {
        const session = await reconcileList(current);
        commit({ ...current, session, notice: { kind: "failure", text: labels().chatRetentionFailed } });
      } catch {
        commit({ ...current, notice: { kind: "failure", text: labels().chatRetentionFailed } });
      }
    }
  };

  const [draftText, setDraftText] = useState("");
  // The Characters surface is mounted by a read-probe, mirroring the
  // connection panel: a profile without the Character routes answers
  // `unavailable`, so the UI never shows controls that could not work.
  const [charactersAvailable, setCharactersAvailable] = useState(false);
  const charactersProbeRef = useRef(false);

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
  ): Promise<boolean> => {
    const current = viewRef.current;
    const connection = connectionView;
    if (current.kind !== "ready" || connection.kind !== "ready" || connection.pending) return false;
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
      return true;
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
      return false;
    }
  };

  /**
   * Creates the draft record for one catalog entry. The credential is handed
   * straight to the request and is never retained in component state, so a
   * write-only field stays write-only. Creation deliberately does not activate:
   * activation needs a ready record, which requires the player's own test step.
   */
  const handleCreateConnection = async (form: ConnectionForm): Promise<boolean> => {
    return await handleConnectionMutation(async (api, csrfToken) => {
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
          ...(provider.setupFields.includes("apiShape") ? { apiShape: form.apiShape } : {}),
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

  /**
   * One model-profile mutation at a time. The Host owns both the durable record
   * and the validation, so the panel sends exactly what the player typed and
   * adopts the validated read-back as the only thing it shows; a rejected write
   * re-reads the authority before the failure notice appears.
   */
  const handleModelProfileMutation = async (
    surface: "chat" | "game",
    modelId: string,
    thinkingLevel: string,
  ): Promise<void> => {
    const current = viewRef.current;
    const profiles = modelProfilesView;
    if (current.kind !== "ready" || profiles.kind !== "ready" || profiles.pending !== null) return;
    setModelProfilesView({ ...profiles, pending: surface, notice: null });
    try {
      const written = await apiRef.current.updateModelProfile(
        {
          apiVersion: 1,
          surface,
          expectedRevision: profiles.profiles[surface].revision,
          modelId,
          thinkingLevel,
        },
        current.session.snapshot.csrfToken,
      );
      setModelProfilesView({ kind: "ready", profiles: written, pending: null, notice: null });
      commit({ ...current, notice: { kind: "success", text: labels().modelProfilesApplied } });
    } catch (error) {
      // A rejection can still hide a committed change (a same-cookie stale tab
      // hits settings_revision_conflict), so re-read the authority before the
      // failure is shown and never keep a local value the store did not accept.
      const notice = error instanceof TavernProblemError && error.code === "settings_revision_conflict"
        ? ("conflict" as const)
        : null;
      try {
        const restated = await apiRef.current.readModelProfiles();
        setModelProfilesView({ kind: "ready", profiles: restated, pending: null, notice });
      } catch {
        setModelProfilesView({ kind: "error" });
      }
      commit({ ...current, notice: { kind: "failure", text: modelProfileProblemText(error, labels()) } });
    }
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
  const retentionAvailable =
    view.kind === "ready" &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.archive" && op.availability === "available");

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
              <LanguageSettingsPanel
              languageView={languageView}
              uiLocale={view.locale}
              labels={labels()}
              onSelectLanguage={(locale) => void handleLanguageMutation(locale)}
              onSelectUiLanguage={(locale) => void handleUiLanguageMutation(locale)}
            />
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
                onCreate={(form) => handleCreateConnection(form)}
                onTest={(connectionId) => void handleTestConnection(connectionId)}
                onActivate={(connectionId) => void handleActivateConnection(connectionId)}
                onSelectModel={(connectionId, modelId, thinkingLevel) =>
                  void handleSelectConnectionModel(connectionId, modelId, thinkingLevel)
                }
                onRemove={(connectionId) => void handleRemoveConnection(connectionId)}
              />
            )}
            {modelProfilesView.kind === "ready" && (
              // Rendered only when the mounted profile published the model-profile
              // routes; a profile without them never shows an editor it cannot serve.
              <ModelProfilesPanel
                view={modelProfilesView}
                labels={labels()}
                onSave={(surface, modelId, thinkingLevel) =>
                  void handleModelProfileMutation(surface, modelId, thinkingLevel)
                }
              />
            )}
            {charactersAvailable && (
              <CharactersPanel api={apiRef.current} csrfToken={view.session.snapshot.csrfToken} labels={labels()} />
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
            onTransitionChat={retentionAvailable ? (handle, operation) => void handleTransitionChat(handle, operation) : undefined}
          />
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
