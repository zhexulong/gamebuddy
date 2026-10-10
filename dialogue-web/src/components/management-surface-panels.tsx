/**
 * The management domain's panels, mounted by BOTH of this product's shells.
 *
 * The standalone management shell (`ManagementApp`) and the composed product
 * shell (`ComposedReferenceGameApp`) are two views of one durable state
 * (design/28 §2, design/104 §2): the composed root serves the same management
 * dispatcher on the same origin, session and CSRF chain, so the Chats, Memory,
 * World Info and Settings surfaces are the management surface's own panels
 * rather than a second, thinner implementation. The read and mutation state
 * machines live here once; each panel takes the management wire client, the
 * broker session's CSRF token and the validated read-back it must show, and
 * calls back for every mutation, exactly like `CharactersPanel`.
 *
 * Capability honesty - and the one place the two mounts genuinely differ:
 *
 * - The management surface reads its own snapshot, whose `operations`, `memory`
 *   and `chat.worldInfo` fields ARE the mounted profile's capability projection,
 *   so it passes those flags in and a control the Host did not publish stays
 *   absent.
 * - The composed shell's Chat projection is the frozen reference Chat contract:
 *   it carries `memory: { readAvailable: false, mutationAvailable: false }`,
 *   `chat.worldInfo: null` and the reference profile's own operation list, and
 *   it is not this profile's snapshot at all (its `build.profileId` is the
 *   reference profile, and it may carry an event stream this wire validator
 *   rejects). A management panel mounted there therefore cannot learn the
 *   management profile's operation availability from that snapshot: it leaves the
 *   flag `undefined`, treats a served read route as the capability, and reports a
 *   rejected mutation instead of hiding the control. That is the same contract
 *   `CharactersPanel` already uses on that surface.
 *
 * A notice is the one owner decision left to the mount: when `onNotice` is given
 * the panel routes every outcome to it (the management shell's one
 * `role="status"` banner); when it is absent the panel renders the outcome
 * itself, so the composed shell's surface reports it in place.
 */
import { Archive, Pencil, Trash2 } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { type Locale, type Messages } from "../i18n";
import {
  type ChatTitleV1,
  createManagementPipelineApi,
  type ManagementPipelineApi,
  type MemoryReadV1,
  TavernProblemError,
  TavernProtocolError,
  type TavernConnectionStateV1,
  type TavernConnectionThinkingLevelV1,
  type TavernConnectionProviderV1,
  type TavernVoiceDevicesV1,
  type WorldInfoStateV1,
} from "../management-pipeline-api";
import {
  companionLocaleForUiLocale,
  ConnectionSettingsPanel,
  type ConnectionForm,
  type ConnectionView,
  connectionProblemText,
  LanguageSettingsPanel,
  type LanguageView,
  MemoryPanel,
  type MemoryView,
  ModelProfilesPanel,
  type ModelProfilesView,
  modelProfileProblemText,
  VoiceSettingsPanel,
  type VoiceView,
  WorldInfoBindingPanel,
} from "./management-panels";

/**
 * The management wire client, re-exported so a shell has one entry point for the
 * management domain (its panels and the client those panels run on) instead of
 * reaching into the management surface's own modules.
 */
export { createManagementPipelineApi };

/**
 * The one closed notice vocabulary both shells already render: `labels.success`
 * on an accepted mutation, `labels.failure` (or the operation's own closed
 * text) on a rejected one. Never a raw problem body.
 */
export type ManagementSurfaceNotice = Readonly<{ kind: "success" | "failure"; text: string }>;

/**
 * `report` sends the outcome to the mount when it owns the banner, and keeps it
 * locally when it does not.
 */
function useSurfaceNotice(
  onNotice: ((notice: ManagementSurfaceNotice) => void) | undefined,
): Readonly<{ inline: ManagementSurfaceNotice | null; report: (notice: ManagementSurfaceNotice) => void }> {
  const [inline, setInline] = useState<ManagementSurfaceNotice | null>(null);
  const report = (notice: ManagementSurfaceNotice): void => {
    if (onNotice !== undefined) {
      onNotice(notice);
      return;
    }
    setInline(notice);
  };
  return { inline, report };
}

function SurfaceNotice({ notice }: Readonly<{ notice: ManagementSurfaceNotice | null }>): ReactElement | null {
  if (notice === null) return null;
  return (
    <p role="status" className={notice.kind === "success" ? "success-banner" : "error-banner"}>
      {notice.text}
    </p>
  );
}

/** The metadata-only Chat list row the `chat.list` route projects (design/26 §4.3). */
type ChatListEntry = Readonly<{
  handle: string;
  title: string | null;
  managementRevision: number;
  isSelected: boolean;
}>;

type ChatListView = readonly ChatListEntry[] | "loading" | "error";

function chatListRows(view: ChatListView): readonly ChatListEntry[] {
  return view === "loading" || view === "error" ? [] : view;
}

/**
 * The Chats panel: the metadata-only list, the exact rename and the retention
 * transitions, over the mounted profile's own routes.
 *
 * Rename ordering (frozen): the entry's managementRevision from the last
 * validated list -> PUT /chat/title with the exact selectionGeneration and
 * handle -> the validated durable read-back replaces the entry, so the list
 * never shows a guessed revision or title; any rejection re-reads the
 * authoritative list before the failure is reported.
 *
 * `renameAvailable`/`retentionAvailable` are the mount's capability flags: a
 * management profile that publishes no `chat.rename` passes `false` and the
 * control is absent; `undefined` means this mount cannot see that projection and
 * the served list is the capability (see the file header).
 */
export function ChatsSurfacePanel({
  api,
  csrfToken,
  labels,
  selectionGeneration,
  currentChatHandle,
  renameAvailable,
  retentionAvailable,
  onRenamedTitle,
  onNotice,
}: Readonly<{
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  /** The mounted selection's generation: every rename and lifecycle CAS carries it. */
  selectionGeneration: number;
  currentChatHandle: string;
  renameAvailable?: boolean;
  retentionAvailable?: boolean;
  /** Lets the mount fold the validated rename read-back into its own mounted session. */
  onRenamedTitle?: (handle: string, result: ChatTitleV1) => void;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement {
  const [list, setList] = useState<ChatListView>("loading");
  const [editing, setEditing] = useState<Readonly<{ handle: string; title: string }> | null>(null);
  const { inline, report } = useSurfaceNotice(onNotice);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const read = await api.listChats();
        if (active) setList(read.chats);
      } catch {
        if (active) setList("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const reread = async (): Promise<void> => {
    try {
      const read = await api.listChats();
      setList(read.chats);
    } catch {
      setList("error");
    }
  };

  const rename = (handle: string, title: string): void => {
    setEditing(null);
    const entry = chatListRows(list).find((chat) => chat.handle === handle);
    if (entry === undefined) {
      report({ kind: "failure", text: labels.failure });
      return;
    }
    void (async () => {
      try {
        const result = await api.renameChatTitle(
          {
            apiVersion: 1,
            selectionGeneration,
            chatHandle: handle,
            expectedManagementRevision: entry.managementRevision,
            title,
          },
          csrfToken,
        );
        onRenamedTitle?.(handle, result);
        setList((current) =>
          chatListRows(current).map((chat) =>
            chat.handle === handle
              ? { ...chat, title: result.title, managementRevision: result.managementRevision }
              : chat,
          ),
        );
        report({ kind: "success", text: labels.success });
      } catch {
        // Every rejection re-reads the durable list so the panel never shows a
        // stale revision; the problem is then player-visible.
        await reread();
        report({ kind: "failure", text: labels.failure });
      }
    })();
  };

  const transition = (handle: string, operation: "archive" | "trash"): void => {
    const entry = chatListRows(list).find((chat) => chat.handle === handle);
    if (entry === undefined) {
      report({ kind: "failure", text: labels.chatRetentionFailed });
      return;
    }
    void (async () => {
      try {
        await api.transitionChatLifecycle(handle, operation, selectionGeneration, entry.managementRevision, csrfToken);
        // The transition removed the chat from the active list (metadata-only
        // mutation), so reconcile against the durable list.
        await reread();
        report({ kind: "success", text: labels.success });
      } catch {
        await reread();
        report({ kind: "failure", text: labels.chatRetentionFailed });
      }
    })();
  };

  if (list === "loading" || list === "error") {
    return (
      <>
        <SurfaceNotice notice={inline} />
        <p className="empty-subtle">{list === "error" ? labels.failure : labels.loading}</p>
      </>
    );
  }

  return (
    <>
      <SurfaceNotice notice={inline} />
      <div className="chat-list" role="list">
        {list.length === 0 ? (
          <p className="empty-subtle">{labels.noChats}</p>
        ) : (
          list.map((chat) => {
            const isSelected = chat.handle === currentChatHandle;
            return (
              <div
                key={chat.handle}
                role="listitem"
                className={`chat-item-card ${isSelected ? "selected" : ""}`}
              >
                {editing !== null && editing.handle === chat.handle && renameAvailable !== false ? (
                  <>
                    <input
                      type="text"
                      className="form-input"
                      aria-label={labels.renameChat}
                      value={editing.title}
                      onChange={(event) => setEditing({ handle: chat.handle, title: event.target.value })}
                      autoFocus
                    />
                    <div className="button-group">
                      <button
                        type="button"
                        className="small-button primary"
                        onClick={() => {
                          const next = editing.title.trim();
                          if (next.length > 0) rename(chat.handle, next);
                          else setEditing(null);
                        }}
                      >
                        {labels.save}
                      </button>
                      <button type="button" className="small-button" onClick={() => setEditing(null)}>
                        {labels.close}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="chat-item-main">
                    <div className="chat-item-title">{chat.title ?? labels.untitledChat}</div>
                    <div className="chat-item-actions">
                      {renameAvailable !== false && (
                        <button
                          type="button"
                          className="icon-button-small"
                          title={labels.renameChat}
                          onClick={() => setEditing({ handle: chat.handle, title: chat.title ?? "" })}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      )}
                      {retentionAvailable !== false && isSelected && (
                        <>
                          <button
                            type="button"
                            className="icon-button-small"
                            title={labels.chatRetentionArchive}
                            aria-label={labels.chatRetentionArchive}
                            onClick={() => transition(chat.handle, "archive")}
                          >
                            <Archive size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button-small"
                            title={labels.chatRetentionTrash}
                            aria-label={labels.chatRetentionTrash}
                            onClick={() => transition(chat.handle, "trash")}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}


function memoryViewOf(result: MemoryReadV1): MemoryView {
  return result.memories.length === 0
    ? { kind: "empty", projectionRevision: result.projectionRevision }
    : { kind: "ready", rows: result.memories, projectionRevision: result.projectionRevision };
}

/**
 * The Memory panel: the player's authoring surface over `memory.mutate`.
 *
 * Every mutation carries the projection revision of the last validated read as
 * its compare-and-swap, and the validated response IS the durable read-back the
 * panel then shows (create/update/archive), so a rejected mutation can never be
 * shown as saved: a rejection re-reads the authoritative projection first and
 * only then reports the failure.
 *
 * `mutationAvailable` is the mount's durable flag where it has one; `undefined`
 * means the served read route is the capability (see the file header).
 */
export function MemorySurfacePanel({
  api,
  csrfToken,
  labels,
  locale,
  mutationAvailable,
  onNotice,
}: Readonly<{
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  /** The player's UI language, which is the language the Memory rows are labelled in. */
  locale: Locale;
  mutationAvailable?: boolean;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement {
  const [view, setView] = useState<MemoryView>({ kind: "loading" });
  const { inline, report } = useSurfaceNotice(onNotice);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await api.readMemory();
        if (active) setView(memoryViewOf(result));
      } catch {
        if (active) setView({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const refresh = (): void => {
    setView({ kind: "loading" });
    void (async () => {
      try {
        setView(memoryViewOf(await api.readMemory()));
      } catch {
        setView({ kind: "error" });
      }
    })();
  };

  const mutate = (
    input:
      | Readonly<{ operation: "create"; content: string }>
      | Readonly<{ operation: "update"; handle: string; content: string }>
      | Readonly<{ operation: "archive"; handle: string }>,
  ): void => {
    const projectionRevision = view.kind === "ready" || view.kind === "empty" ? view.projectionRevision : null;
    if (projectionRevision === null) return;
    void (async () => {
      try {
        const result = await api.mutateMemory(
          { apiVersion: 1, expectedProjectionRevision: projectionRevision, ...input },
          csrfToken,
        );
        setView(memoryViewOf(result));
        report({ kind: "success", text: labels.success });
      } catch {
        // The rejection may still hide a committed change (a same-cookie stale
        // tab hits the projection conflict), so the authoritative projection is
        // re-read BEFORE the failure is reported: a rejected write never appears
        // as saved.
        try {
          setView(memoryViewOf(await api.readMemory()));
        } catch {
          setView({ kind: "error" });
        }
        report({ kind: "failure", text: labels.failure });
      }
    })();
  };

  return (
    <>
      <SurfaceNotice notice={inline} />
      <MemoryPanel
        memoryView={view}
        labels={labels}
        locale={locale}
        onRefresh={refresh}
        mutationAvailable={mutationAvailable ?? (view.kind === "ready" || view.kind === "empty")}
        onMutate={mutate}
      />
    </>
  );
}

/**
 * The exact World Info revision one mount shows, plus the selection generation
 * its bind CAS must carry.
 */
export type WorldInfoSurfaceSource = Readonly<{
  worldInfo: WorldInfoStateV1 | null;
  selectionGeneration: number;
}>;

type WorldInfoView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; worldInfo: WorldInfoStateV1 }>;

/**
 * The World Info panel: attach/remove over `world-info.bind`.
 *
 * The mount owns the read, because the two shells serve different snapshots: the
 * management surface's `/state` carries its World Info revision, while the
 * composed shell's Chat projection hard-codes `worldInfo: null` and a profile
 * identity this wire validator rejects, so that mount reads the dedicated
 * `GET /world-info` route instead. Only the read differs; the bind ordering
 * below is one implementation on both.
 *
 * Bind ordering (frozen): `world-info.bind` with the exact selectionGeneration
 * and expectedRevision -> the service result is deliberately NOT applied
 * locally -> both success and failure re-read the authoritative revision before
 * the outcome is reported, so a lost revision conflict is visible as the newer
 * binding rather than as a stale selection.
 */
export function WorldInfoSurfacePanel({
  api,
  csrfToken,
  labels,
  read,
  bindAvailable,
  onNotice,
}: Readonly<{
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  /** The mount's authoritative reader for the exact World Info revision it shows. */
  read: () => Promise<WorldInfoSurfaceSource>;
  bindAvailable?: boolean;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement | null {
  const [view, setView] = useState<WorldInfoView>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  const { inline, report } = useSurfaceNotice(onNotice);

  const readOnce = async (): Promise<WorldInfoView> => {
    try {
      const source = await read();
      setGeneration(source.selectionGeneration);
      return source.worldInfo === null ? { kind: "unavailable" } : { kind: "ready", worldInfo: source.worldInfo };
    } catch {
      return { kind: "error" };
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await readOnce();
      if (active) setView(next);
    })();
    return () => {
      active = false;
    };
    // The reader is the mount's own authority for its World Info revision and is
    // stable for the life of the surface; a re-read is driven by the bind below,
    // never by a prop change.
  }, []);

  const bind = (sourceHandle: string | null): void => {
    if (view.kind !== "ready") return;
    const expectedRevision = view.worldInfo.revision;
    void (async () => {
      let failed = false;
      try {
        await api.setWorldInfoBinding(
          { apiVersion: 1, selectionGeneration: generation, expectedRevision, sourceHandle },
          csrfToken,
        );
      } catch {
        failed = true;
      }
      const next = await readOnce();
      setView(next);
      report(
        failed
          ? { kind: "failure", text: labels.worldInfoBindingFailure }
          : { kind: "success", text: labels.success },
      );
    })();
  };

  if (bindAvailable === false) return null;
  if (view.kind === "loading") return null;
  if (view.kind !== "ready") {
    return (
      <>
        <SurfaceNotice notice={inline} />
        <p className="state-placeholder">{view.kind === "unavailable" ? labels.worldInfoUnavailable : labels.failure}</p>
      </>
    );
  }
  return (
    <>
      <SurfaceNotice notice={inline} />
      <WorldInfoBindingPanel worldInfo={view.worldInfo} labels={labels} onBind={bind} />
    </>
  );
}

/**
 * The Settings panel: the companion language, the voice consent/devices, the
 * connection records and the two model profiles - the four field groups the
 * management surface shows, in the same order, over the same routes.
 *
 * The companion language and the voice preference live in ONE Host-owned record,
 * so they share one revision here (`settingsRevisionRef`): a panel-local counter
 * would let one group's write silently discard the other's. Every mutation is
 * admitted one at a time, shows only the validated read-back, and re-reads the
 * authority on rejection before the failure is reported.
 *
 * The interface's own language is the mount's, not this panel's: the mount owns
 * `uiLocale` and persists it, because that is the shell's display language
 * rather than a Host setting (see `onSelectUiLocale`).
 */
export function SettingsSurfacePanel({
  api,
  csrfToken,
  labels,
  uiLocale,
  onSelectUiLocale,
  onNotice,
}: Readonly<{
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  uiLocale: Locale;
  onSelectUiLocale: (locale: Locale) => void;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement {
  const [languageView, setLanguageView] = useState<LanguageView>({ kind: "loading" });
  const [voiceView, setVoiceView] = useState<VoiceView>({ kind: "loading" });
  const [connectionView, setConnectionView] = useState<ConnectionView>({ kind: "loading" });
  const [modelProfilesView, setModelProfilesView] = useState<ModelProfilesView>({ kind: "loading" });
  // The one Host-owned preference record's revision, shared by both settings
  // field groups (see the header).
  const settingsRevisionRef = useRef(0);
  // The display language the surface was mounted with, used once to seed a
  // never-configured companion language. Later display-language changes are the
  // mount's own concern and never re-run this load.
  const mountUiLocaleRef = useRef(uiLocale);
  const { inline, report } = useSurfaceNotice(onNotice);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const preference = await api.readVoicePreference();
        // Device enumeration is an optional additive read: when the gateway is
        // absent or has no Windows endpoints the panel still offers the Windows
        // default selection through the preference alone.
        let devices: TavernVoiceDevicesV1 | null = null;
        try {
          devices = await api.readVoiceDevices();
        } catch {
          devices = null;
        }
        if (!active) return;
        settingsRevisionRef.current = preference.revision;
        setVoiceView({ kind: "ready", preference, devices, pending: false });
      } catch {
        // A mounted profile without the voice extension group does not publish
        // these routes at all.
        if (active) setVoiceView({ kind: "unavailable" });
      }
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
              {
                expectedRevision: settingsRevisionRef.current,
                locale: companionLocaleForUiLocale(mountUiLocaleRef.current),
              },
              csrfToken,
            );
            if (!active) return;
            settingsRevisionRef.current = written.revision;
            setLanguageView({ kind: "ready", locale: written.locale, pending: false });
          } catch {
            // A lost race (another tab chose first) is not a panel failure: the
            // read-back on the next load carries the winner.
            if (active) setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
          }
        } else {
          settingsRevisionRef.current = preference.revision;
          setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
        }
      } catch {
        // A mounted profile without the language extension group does not
        // publish these routes at all.
        if (active) setLanguageView({ kind: "unavailable" });
      }
      try {
        const state = await api.readConnection();
        // The projected readiness IS the durable record's readiness; the panel
        // never derives a ready state from local intent.
        if (active) setConnectionView({ kind: "ready", state, pending: false, notice: null });
      } catch {
        if (active) setConnectionView({ kind: "unavailable" });
      }
      try {
        // The read-probe is how the panel learns whether the mounted profile
        // published the model-profile routes: an absent route must not render an
        // editor the Host cannot serve.
        const profiles = await api.readModelProfiles();
        if (active) setModelProfilesView({ kind: "ready", profiles, pending: null, notice: null });
      } catch {
        if (active) setModelProfilesView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, csrfToken]);

  /**
   * Writes the companion language. It is the player's own BCP-47 tag, so nothing
   * here maps it onto the UI's language: the panel shows the tag, confirms it
   * against the durable record, and the UI keeps whatever display language the
   * player chose.
   */
  const mutateCompanionLanguage = (tag: string): void => {
    if (languageView.kind !== "ready" || languageView.pending) return;
    setLanguageView({ ...languageView, pending: true });
    void (async () => {
      try {
        // The validated response IS the durable read-back, so the control always
        // shows what the store holds.
        const written = await api.updateLanguagePreference(
          { expectedRevision: settingsRevisionRef.current, locale: tag },
          csrfToken,
        );
        settingsRevisionRef.current = written.revision;
        setLanguageView({ kind: "ready", locale: written.locale, pending: false });
        report({ kind: "success", text: labels.success });
      } catch {
        // A rejection can still hide a committed change (a same-cookie stale tab
        // hits the revision conflict), so re-read the authority before reverting.
        try {
          const preference = await api.readLanguagePreference();
          settingsRevisionRef.current = preference.revision;
          setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
        } catch {
          setLanguageView({ kind: "error" });
        }
        report({ kind: "failure", text: labels.failure });
      }
    })();
  };

  /** The mount's display language, plus the one-time seed the companion language needs. */
  const selectUiLocale = (locale: Locale): void => {
    onSelectUiLocale(locale);
    if (languageView.kind === "ready" && languageView.locale === null) {
      mutateCompanionLanguage(companionLocaleForUiLocale(locale));
    }
  };

  const mutateVoice = (action: "accept" | "revoke" | "setOutputDevice", outputDevice: string | null = null): void => {
    if (voiceView.kind !== "ready" || voiceView.pending) return;
    const voice = voiceView;
    // The record's one revision, shared with the language group: a stale value
    // here is a real conflict, never a second counter that lets this write
    // silently discard the other group's.
    const expectedRevision = settingsRevisionRef.current;
    const command =
      action === "accept"
        ? { action, expectedRevision, disclosureVersion: "mimo-cloud-tts-v1" as const }
        : action === "setOutputDevice"
          ? { action, expectedRevision, outputDevice }
          : { action, expectedRevision };
    // One in-flight mutation at a time: a second identical action would reuse the
    // same expectedRevision and turn an ordinary double click into a durable
    // revision conflict.
    setVoiceView({ ...voice, pending: true });
    void (async () => {
      try {
        // The validated mutation response IS the durable read-back (the store
        // re-reads the written file and compares it before projecting), so the
        // selector always shows the persisted selection, never the local choice.
        const preference = await api.updateVoicePreference(command, csrfToken);
        settingsRevisionRef.current = preference.revision;
        setVoiceView({ kind: "ready", preference, devices: voice.devices, pending: false });
        report({ kind: "success", text: labels.success });
      } catch {
        // A rejection can still hide a committed change (e.g. a same-cookie stale
        // tab hitting settings_revision_conflict), so re-read the authoritative
        // preference before the failure is shown and never keep a local selection
        // the durable store did not accept.
        try {
          const preference = await api.readVoicePreference();
          settingsRevisionRef.current = preference.revision;
          setVoiceView({ kind: "ready", preference, devices: voice.devices, pending: false });
        } catch {
          setVoiceView({ kind: "error" });
        }
        report({ kind: "failure", text: labels.failure });
      }
    })();
  };

  /**
   * One connection mutation at a time; the durable read-back is what the panel
   * then shows. The successful activation notice makes exactly one claim: the
   * selection is durable and takes effect on the next runtime start. It never
   * claims a running conversation was switched.
   */
  const mutateConnection = async (
    action: (api: ManagementPipelineApi, csrfToken: string) => Promise<TavernConnectionStateV1>,
    activation: boolean,
  ): Promise<boolean> => {
    if (connectionView.kind !== "ready" || connectionView.pending) return false;
    const connection = connectionView;
    setConnectionView({ ...connection, pending: true, notice: null });
    try {
      const state = await action(api, csrfToken);
      setConnectionView({ kind: "ready", state, pending: false, notice: activation ? "activation" : null });
      report({
        kind: "success",
        text: activation ? labels.connectionActivationNotice : labels.success,
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
        const state = await api.readConnection();
        setConnectionView({ kind: "ready", state, pending: false, notice });
      } catch {
        setConnectionView({ kind: "unavailable" });
      }
      report({ kind: "failure", text: connectionProblemText(error, labels) });
      return false;
    }
  };

  /**
   * Creates the draft record for one catalog entry. The credential is handed
   * straight to the request and is never retained in component state, so a
   * write-only field stays write-only. Creation deliberately does not activate:
   * activation needs a ready record, which requires the player's own test step.
   */
  const createConnection = async (form: ConnectionForm): Promise<boolean> => {
    return await mutateConnection(async (client, token) => {
      const connection = connectionView.kind === "ready" ? connectionView.state : null;
      const provider: TavernConnectionProviderV1 | undefined = connection?.providers.find(
        (entry) => entry.providerId === form.providerId,
      );
      if (provider === undefined) throw new TavernProtocolError();
      return await client.createConnection(
        {
          apiVersion: 1,
          providerId: provider.providerId,
          ...(provider.setupFields.includes("apiKey") ? { apiKey: form.apiKey } : {}),
          ...(provider.setupFields.includes("baseUrl") ? { baseUrl: form.baseUrl } : {}),
          ...(provider.setupFields.includes("apiShape") ? { apiShape: form.apiShape } : {}),
          ...(form.catalogModelId === "" ? {} : { modelId: form.catalogModelId }),
          ...(provider.setupFields.includes("modelId") ? { modelId: form.modelId } : {}),
        },
        token,
      );
    }, false);
  };

  /**
   * One model-profile mutation at a time. The Host owns both the durable record
   * and the validation, so the panel sends exactly what the player typed and
   * adopts the validated read-back as the only thing it shows; a rejected write
   * re-reads the authority before the failure notice appears.
   */
  const mutateModelProfile = (surface: "chat" | "game", modelId: string, thinkingLevel: string): void => {
    if (modelProfilesView.kind !== "ready" || modelProfilesView.pending !== null) return;
    const profiles = modelProfilesView;
    setModelProfilesView({ ...profiles, pending: surface, notice: null });
    void (async () => {
      try {
        const written = await api.updateModelProfile(
          {
            apiVersion: 1,
            surface,
            expectedRevision: profiles.profiles[surface].revision,
            modelId,
            thinkingLevel,
          },
          csrfToken,
        );
        setModelProfilesView({ kind: "ready", profiles: written, pending: null, notice: null });
        report({ kind: "success", text: labels.modelProfilesApplied });
      } catch (error) {
        // A rejection can still hide a committed change (a same-cookie stale tab
        // hits settings_revision_conflict), so re-read the authority before the
        // failure is shown and never keep a local value the store did not accept.
        const notice =
          error instanceof TavernProblemError && error.code === "settings_revision_conflict" ? ("conflict" as const) : null;
        try {
          const restated = await api.readModelProfiles();
          setModelProfilesView({ kind: "ready", profiles: restated, pending: null, notice });
        } catch {
          setModelProfilesView({ kind: "error" });
        }
        report({ kind: "failure", text: modelProfileProblemText(error, labels) });
      }
    })();
  };

  return (
    <>
      <SurfaceNotice notice={inline} />
      <LanguageSettingsPanel
        languageView={languageView}
        uiLocale={uiLocale}
        labels={labels}
        onSelectLanguage={mutateCompanionLanguage}
        onSelectUiLanguage={selectUiLocale}
      />
      <VoiceSettingsPanel
        voiceView={voiceView}
        labels={labels}
        onAccept={() => mutateVoice("accept")}
        onRevoke={() => mutateVoice("revoke")}
        onSelectDevice={(deviceId) => mutateVoice("setOutputDevice", deviceId)}
      />
      {connectionView.kind === "ready" && (
        // Rendered only when the mounted profile actually published the
        // connection routes; a profile without them never shows a control that
        // could not work.
        <ConnectionSettingsPanel
          connectionView={connectionView}
          labels={labels}
          onCreate={createConnection}
          onTest={(connectionId) => void mutateConnection(async (client, token) => {
            if (connectionView.kind !== "ready") throw new TavernProtocolError();
            const probe = await client.testConnection(connectionId, connectionView.state.revision, token);
            return probe.state;
          }, false)}
          onActivate={(connectionId) => void mutateConnection(async (client, token) => {
            if (connectionView.kind !== "ready") throw new TavernProtocolError();
            return await client.activateConnection(connectionId, connectionView.state.revision, token);
          }, true)}
          onSelectModel={(connectionId, modelId, thinkingLevel: TavernConnectionThinkingLevelV1) =>
            void mutateConnection(async (client, token) => {
              if (connectionView.kind !== "ready") throw new TavernProtocolError();
              return await client.selectConnectionModel(
                connectionId,
                { expectedRevision: connectionView.state.revision, modelId, thinkingLevel },
                token,
              );
            }, false)
          }
          onRemove={(connectionId) => void mutateConnection(async (client, token) => {
            if (connectionView.kind !== "ready") throw new TavernProtocolError();
            return await client.removeConnection(connectionId, connectionView.state.revision, token);
          }, false)}
        />
      )}
      {modelProfilesView.kind === "ready" && (
        // Rendered only when the mounted profile published the model-profile
        // routes; a profile without them never shows an editor it cannot serve.
        <ModelProfilesPanel
          view={modelProfilesView}
          labels={labels}
          onSave={(surface, modelId, thinkingLevel) => mutateModelProfile(surface, modelId, thinkingLevel)}
        />
      )}
    </>
  );
}
