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
import { Archive, Pencil, Sparkles, Trash2 } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Locale, Messages } from "../i18n";
import { ContextDrawer } from "./ContextDrawer";
import { MarkdownMessage } from "./MarkdownMessage";
import { openingVariantWords } from "./opening-variant-labels";
import {
  type ChatTitleV1,
  createManagementPipelineApi,
  type ManagementPipelineApi,
  type MemoryReadV1,
  problemTextWithCode,
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
  /** The Host's durable last-activity time for the thread. */
  updatedAtMs: number;
  /** Plain-text last-message preview the Host already stripped and bounded. */
  preview: string | null;
}>;

type ChatListView = readonly ChatListEntry[] | "loading" | "error";

function chatListRows(view: ChatListView): readonly ChatListEntry[] {
  return view === "loading" || view === "error" ? [] : view;
}

/**
 * What the chooser shows for one opening: the line the player chooses on, and the
 * stage direction that precedes it when the opening opens on a beat.
 *
 * A real card's opening opens on `*…*` - a rainy roof, a hand on the kettle -
 * before the companion says anything, and a chooser between openings reads the
 * line SHE says: showing the leading beat shows the player the scenery instead of
 * the character, and printing it raw showed her the asterisks. So the first
 * non-beat line is the option's text, and a leading beat is kept beside it as the
 * option's own action line. Both are rendered through `MarkdownMessage`, the same
 * renderer the transcript uses, so `*…*` is the transcript's own
 * `<em class="message-action">` and never literal stars.
 */
function openingPreview(text: string): Readonly<{ action: string | null; spoken: string }> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const isBeat = (line: string): boolean => {
    const normalized = line.replace(/＊/gu, "*");
    return normalized.length > 2 && normalized.startsWith("*") && normalized.endsWith("*");
  };
  const first = lines[0] ?? "";
  if (!isBeat(first)) return { action: null, spoken: first };
  return { action: first, spoken: lines.find((line) => !isBeat(line)) ?? first };
}

/**
 * The row's own last-activity stamp: the catalogue's two relative words for today
 * and yesterday, and the platform's own short numeric date beyond them. The
 * granularity is a calendar day, which is the truth the Host records but cannot
 * separate two Chats opened the same day; the row's own name is what tells those
 * two apart, and this line and the preview are the row's facts about itself.
 */
function chatRowStamp(updatedAtMs: number, labels: Messages, nowMs: number): string {
  const updated = new Date(updatedAtMs);
  const now = new Date(nowMs);
  const startedAt = (value: Date): Date => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const updatedDay = startedAt(updated).getTime();
  const today = startedAt(now).getTime();
  if (updatedDay === today) return labels.chatRowToday;
  if (updatedDay === startedAt(new Date(today - 86_400_000)).getTime()) return labels.chatRowYesterday;
  return updated.toLocaleDateString();
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
  createAvailable,
  selectAvailable,
  onRenamedTitle,
  onChatSwitched,
  onMountedChatChosen,
  onCurrentChatRemoved,
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
  /**
   * New Chat (design/26 §4.4). `false` means the mount knows the Host published no
   * `chat.create` route and the control is absent; `undefined` means this mount cannot see that
   * projection and the served route is the capability, exactly like `renameAvailable`.
   */
  createAvailable?: boolean;
  /**
   * Chat selection (ADR 0009). `false` means the mount knows the Host published no `chat.select`
   * route and the rows are not selectable; `undefined` means the served route is the capability.
   */
  selectAvailable?: boolean;
  /** Lets the mount fold the validated rename read-back into its own mounted session. */
  onRenamedTitle?: (handle: string, result: ChatTitleV1) => void;
  /**
   * Fires after the Host committed an in-process switch to another Chat. The opening index is the
   * opening a creation asked for, if any - the shell holds the successor mount's generation, so it
   * is where that opening is committed (see `createChat`).
   */
  onChatSwitched?: (openingTargetIndex?: number) => void;
  /**
   * Fires when the player chose the Chat that is already mounted. That is not a
   * selection - there is nothing to switch to and no `chat/select` is issued - but
   * it is the player asking for that conversation, so the mount shows the surface
   * the conversation lives on.
   */
  onMountedChatChosen?: () => void;
  /**
   * Fires after a retention transition removed the mounted Chat from the active
   * list. The shell owns the selection, so the panel reports the removal instead
   * of only refreshing its own list: the mounted conversation no longer exists in
   * the active list and the shell must move its selection and its live cursor off
   * the dead thread.
   */
  onCurrentChatRemoved?: (handle: string) => void;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement {
  const [list, setList] = useState<ChatListView>("loading");
  const [editing, setEditing] = useState<Readonly<{ handle: string; title: string }> | null>(null);
  // The exact durable opening of the Chat this panel just created: design/26 §4.4 renders the
  // greeting message 0 before it claims success, and the created Chat is NOT the mounted one.
  const [created, setCreated] = useState<Readonly<{ opening: string }> | null>(null);
  const [creating, setCreating] = useState(false);
  // The companion's own greeting set, as `greeting.read` publishes it. `null` is "there is nothing
  // here to choose" - the companion has no record, the read failed, or she has exactly one opening -
  // and the New Chat control then stays the single button it has always been: an affordance with one
  // option is worse than none.
  const [openings, setOpenings] = useState<
    readonly Readonly<{ label: string | null; text: string; optionId: string }>[] | null
  >(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The control that opens the picker; focus returns here when it closes. */
  const newChatRef = useRef<HTMLButtonElement>(null);
  // The Chat whose switch is in flight. Switching another Chat is a focus transfer, so this is
  // never a refusal: the row stays selectable and this only marks the request that is out, so a
  // click during a generating turn does not look ignored while the Host aborts and switches.
  const [selecting, setSelecting] = useState<string | null>(null);
  // The row's destructive action is a deliberate one: the first click only arms
  // this, and the request waits for the confirm button. Same shape as the Game
  // surface's endgame block, so the product has one vocabulary for it.
  const [confirmation, setConfirmation] = useState<Readonly<{
    handle: string;
    operation: "archive" | "trash";
    selectedAtArm: string;
  }> | null>(null);
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

  // The companion's own greeting set, from the route that already serves it: the same record a new
  // Chat opens on and the same set `chat.opening` pages through, so the picker can never name an
  // opening the Host would not commit. A set with one entry is not a choice, and an unreadable one is
  // not inventable: both leave the New Chat control exactly as it is.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const greeting = await api.readGreeting();
        if (active)
          setOpenings(
            greeting.present && greeting.variants.length > 1
              ? greeting.variants.map((variant, position) => ({ ...variant, optionId: `opening-${position}` }))
              : null,
          );
      } catch {
        if (active) setOpenings(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  // An armed confirmation is armed against one exact row: the same discipline the
  // endgame block uses, so a stale arm cannot fire an action on a row the player
  // is no longer looking at (the list re-reads on every mutation and rejection).
  // The arm names the mounted selection it was taken under as well as the row, so
  // moving to another Chat drops it instead of leaving a destructive action primed
  // behind the player's back.
  useEffect(() => {
    if (confirmation === null) return;
    if (
      confirmation.selectedAtArm !== currentChatHandle ||
      !chatListRows(list).some((chat) => chat.handle === confirmation.handle)
    )
      setConfirmation(null);
  }, [confirmation, list, currentChatHandle]);

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
      } catch (error) {
        // Every rejection re-reads the durable list so the panel never shows a
        // stale revision; the problem is then player-visible.
        await reread();
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
      }
    })();
  };

  /**
   * New Chat (design/26 §4.4): one creation at a time, then the durable list is re-read, so the
   * panel only ever shows Chats the store actually holds. Creation is followed by the **same**
   * selection a row click makes: a conversation the player has just created and then has to find in
   * the list and click again is a conversation they have not started, and the surface already knows
   * how to land in one (`onChatSwitched` adopts the mount and moves the region). The creation itself
   * claims only that the Chat exists - the switch is what moves the player, and it is reported only
   * when the mounted identity really changed.
   *
   * `openingTargetIndex` is the opening the player picked in the catalogue. It is carried to the
   * shell rather than committed here: `chat.opening` addresses the MOUNTED Chat under the selection
   * generation of that mount, and a settled switch is what mounts this Chat and mints its
   * generation - so the shell, holding the fresh read, is the only caller that can name it.
   */
  const createChat = (openingTargetIndex?: number): void => {
    if (creating) return;
    setCreating(true);
    void (async () => {
      try {
        const result = await api.createChat({ apiVersion: 1, selectionGeneration }, csrfToken);
        setCreated(result.opening === null ? null : { opening: result.opening });
        await reread();
        // The created Chat's own handle, from the Host's own read-back - never an
        // identity composed here.
        const selected = await requestSelection(result.chat.handle, openingTargetIndex);
        // The Chat is durable in every outcome; what a chosen opening adds is a second thing that
        // can fail, and it fails alone: the Chat exists on the default opening, and that is what
        // the player is told instead of a generic failure.
        const unset = selected === "in_flight" && openingTargetIndex !== undefined;
        report({
          kind: unset ? "failure" : "success",
          text: unset
            ? labels.chatCreatedWithDefaultOpening
            : selected === "in_flight"
              ? labels.chatSelectTurnNotAbortable
              : labels.success,
        });
      } catch (error) {
        // A rejection may still hide a committed creation, so the authoritative
        // list is re-read BEFORE the failure is reported.
        await reread();
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
      } finally {
        setCreating(false);
      }
    })();
  };

  /**
   * Chat selection (ADR 0009 / ADR-0010). Selecting another Chat is a focus transfer, so the
   * request is never refused for a generating turn: the Host aborts the mounted turn through the
   * same cancel path an explicit Stop uses - a turn whose attempt had not started included - lets
   * that abort settle, releases the runtime and mounts the target, then answers `switched` - the
   * surface re-reads the authoritative list and the shell reloads the target's transcript.
   * `turn_in_flight` is only the fail-closed answer for a mounted turn that path could not abort:
   * the runtime deliberately stayed where it was, and the recorded selection is durable. A bounded
   * refusal (`selection_conflict`) re-reads the durable list before it is reported.
   */
  /**
   * One selection request, shared by the row click and by creation.
   *
   * It returns what actually happened rather than reporting it, because the two callers may claim
   * different things: a click may say it switched, while creation must still say the Chat was made
   * when the mounted turn refused to move. `turn_in_flight` is the one refusal that leaves the
   * mount exactly where it was - the recorded selection is durable either way.
   *
   * A committed switch hands the opening the player picked to the shell's own follow-through, which
   * is the only place that holds the successor mount's selection generation (see `createChat`).
   */
  const requestSelection = async (
    handle: string,
    openingTargetIndex?: number,
  ): Promise<"switched" | "in_flight" | "mounted"> => {
    // The mounted Chat is not a switch: the Host has nothing to switch to and no selection may be
    // admitted. The click is still the player choosing that conversation, so the mount is told to
    // show it - a silent no-op would leave the one gesture the row's title offers unanswered.
    if (handle === currentChatHandle) {
      onMountedChatChosen?.();
      return "mounted";
    }
    const result = await api.selectChat({ apiVersion: 1, selectionGeneration, chatHandle: handle }, csrfToken);
    await reread();
    if (result.status === "turn_in_flight") return "in_flight";
    // The mounted identity itself changed, so the shell must replace its session from the new
    // snapshot and restart its live cursor on the target conversation.
    onChatSwitched?.(openingTargetIndex);
    return "switched";
  };

  const selectChat = (handle: string): void => {
    if (selectAvailable === false || selecting !== null) return;
    setSelecting(handle);
    void (async () => {
      try {
        const outcome = await requestSelection(handle);
        if (outcome === "in_flight") {
          report({ kind: "success", text: labels.chatSelectTurnNotAbortable });
          return;
        }
        report({ kind: "success", text: labels.chatSelectSwitchedNotice });
      } catch (error) {
        await reread();
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
      } finally {
        setSelecting(null);
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
        // When the removed chat WAS the mounted one, the shell's selection no
        // longer names a chat the list holds: the mount owns the selection and the
        // live cursor, so it is told before its stream is left on a dead thread.
        if (handle === currentChatHandle) onCurrentChatRemoved?.(handle);
        report({ kind: "success", text: labels.success });
      } catch (error) {
        await reread();
        report({ kind: "failure", text: problemTextWithCode(labels.chatRetentionFailed, error) });
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

  /**
   * The rows as displayed, each with the name it shows.
   *
   * A Chat the player never renamed has no title of its own to read: its preview
   * is the card's own opening line and its stamp is a calendar day, so two Chats
   * opened the same day rendered as the same row twice. The catalogue's fallback
   * word therefore carries a number - 1-based, in the order this list displays its
   * unnamed rows - which distinguishes them without a wire field, a contract
   * change or a clock: the number is counted here, from the list, and a row that
   * has a title shows its title and is never numbered. Renaming a row, or a
   * removal from the list, renumbers the ones below it, because the number is a
   * reading of the list rather than a fact about the Chat.
   */
  let unnamedRows = 0;
  const rows = chatListRows(list).map((chat) => {
    if (chat.title !== null) return { chat, name: chat.title };
    unnamedRows += 1;
    return { chat, name: labels.untitledChat.replace("{{index}}", String(unnamedRows)) };
  });

  return (
    <>
      <SurfaceNotice notice={inline} />
      {createAvailable !== false && (
        <div className="button-group">
          {/* One control, two jobs, decided by the catalogue: a companion with openings to choose
              from gets the picker, and one without gets the same immediate New Chat as before. */}
          <button
            ref={newChatRef}
            type="button"
            className="small-button"
            data-testid="new-chat"
            onClick={() => {
              if (openings === null) createChat();
              else setPickerOpen(true);
            }}
            disabled={creating}
          >
            {labels.newChat}
          </button>
        </div>
      )}
      {pickerOpen && openings !== null && (
        <ContextDrawer
          title={labels.openingPickerTitle}
          closeLabel={labels.close}
          onClose={() => setPickerOpen(false)}
          testId="opening-picker"
          icon={Sparkles}
          restoreFocusTo={newChatRef}
        >
          <p className="management-settings-hint">{labels.openingPickerHint}</p>
          <div className="opening-options" role="list" data-testid="opening-picker-list">
            {openings.map((variant, index) => {
              // An opening pins to its position in the set: it has no durable id on this wire, the
              // Host commits it by that very position, and two openings can share a label. The id is
              // minted once, when the set is read (`openingOptions`), so React keys by that identity
              // rather than by a loop index - the same discipline the editor rows follow.
              const preview = openingPreview(variant.text);
              return (
                <div key={variant.optionId} role="listitem">
                  <button
                    type="button"
                    className="opening-option"
                    data-testid="opening-option"
                    onClick={() => {
                      setPickerOpen(false);
                      createChat(index);
                    }}
                  >
                    <span className="opening-option-name" data-testid="opening-option-name">
                      {openingVariantWords({ label: variant.label, index, count: openings.length }, labels)}
                    </span>
                    {/* Her first spoken line, with the beat that precedes it kept as the
                        option's own action line: the two are read in the order the
                        transcript reads them. */}
                    {preview.action !== null && (
                      <MarkdownMessage className="opening-option-action" text={preview.action} />
                    )}
                    <MarkdownMessage
                      className="opening-option-line"
                      testId="opening-option-line"
                      text={preview.spoken}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </ContextDrawer>
      )}
      {created !== null && (
        <div className="chat-item-card">
          <div className="chat-item-title">{labels.newChat}</div>
          {/* The opening is companion prose, so it renders through the same
              sanitised Markdown renderer the transcript uses: a `*beat*` is a
              stage direction here exactly as it is in a bubble, and printing
              the raw string showed the player its asterisks. */}
          <MarkdownMessage className="chat-item-main" text={created.opening} />
        </div>
      )}
      <div className="chat-list" role="list">
        {list.length === 0 ? (
          <p className="empty-subtle">{labels.noChats}</p>
        ) : (
          rows.map(({ chat, name }) => {
            const isSelected = chat.handle === currentChatHandle;
            const isSelecting = chat.handle === selecting;
            // The confirmation belongs to exactly one row, and while it is armed that row's
            // rename/archive/trash strip steps aside: the confirmation is the row's only action
            // until it is answered.
            const armedHere = confirmation !== null && confirmation.handle === chat.handle;
            const editingHere = editing !== null && editing.handle === chat.handle;
            /*
             * The row's whole surface is the select control: its title, its stamp and
             * its preview are one gesture, because the preview is most of the row's
             * area and the title alone is a target a thumb misses. Two states take the
             * surface away rather than sharing it - the armed confirmation, which is the
             * row's only action until it is answered, and the rename editor, whose own
             * field must not also be a selection target.
             */
            const rowSelects = !armedHere && !editingHere && selectAvailable !== false && selecting === null;
            return (
              <div
                key={chat.handle}
                role="listitem"
                data-testid="chat-item"
                data-selected={isSelected ? "true" : "false"}
                data-selectable={rowSelects ? "true" : undefined}
                className={`chat-item-card ${isSelected ? "selected" : ""}`}
                onClick={rowSelects ? () => selectChat(chat.handle) : undefined}
              >
                {editing !== null && editing.handle === chat.handle && renameAvailable !== false ? (
                  <>
                    <input
                      type="text"
                      className="form-input"
                      aria-label={labels.renameChatTitleField}
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
                  <>
                    <div className="chat-item-main">
                      <button
                        type="button"
                        className="chat-item-title chat-select-btn"
                        data-testid="chat-select"
                        aria-current={isSelected ? "true" : undefined}
                        disabled={selectAvailable === false || selecting !== null}
                        onClick={(event) => {
                          // The row carries the same gesture, so the title answers it
                          // once rather than once per handler between here and the row.
                          event.stopPropagation();
                          selectChat(chat.handle);
                        }}
                      >
                        {name}
                      </button>
                      {/* The transient acknowledgement: the switch request is out, so the click is
                          not ignored. Never a refusal - the row stays enabled while a turn runs. */}
                      {isSelecting && (
                        <span className="chat-item-badge" data-testid="chat-select-pending">
                          {labels.chatSelectSwitching}
                        </span>
                      )}
                      {armedHere ? null : (
                        <div className="chat-item-actions">
                          {renameAvailable !== false && (
                            <button
                              type="button"
                              className="icon-button-small"
                              title={labels.renameChat}
                              aria-label={labels.renameChat}
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditing({ handle: chat.handle, title: chat.title ?? "" });
                              }}
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                          )}
                          {/* Every row carries its own archive/trash arm+confirm, so cleaning up history
                              no longer means switching into each Chat first. */}
                          {retentionAvailable !== false && (
                            <>
                              <button
                                type="button"
                                className="icon-button-small"
                                title={labels.chatRetentionArchive}
                                aria-label={labels.chatRetentionArchive}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setConfirmation({
                                    handle: chat.handle,
                                    operation: "archive",
                                    selectedAtArm: currentChatHandle,
                                  });
                                }}
                              >
                                <Archive size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="icon-button-small"
                                title={labels.chatRetentionTrash}
                                aria-label={labels.chatRetentionTrash}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setConfirmation({
                                    handle: chat.handle,
                                    operation: "trash",
                                    selectedAtArm: currentChatHandle,
                                  });
                                }}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    {/* The row's own last-activity facts, below its title line: the durable time
                        the Host recorded and the plain-text opening of the last message. */}
                    <div className="chat-item-meta" data-testid="chat-item-meta">
                      <span data-testid="chat-item-when">{chatRowStamp(chat.updatedAtMs, labels, Date.now())}</span>
                      {" · "}
                      {chat.preview === null ? null : <span data-testid="chat-item-preview">{chat.preview}</span>}
                    </div>
                    {/* The confirmation is its own row of the card, below the title row: it never
                        shares a line with the title or with the row's controls. */}
                    {armedHere && (
                      <div className="chat-item-confirm" data-testid="chat-retention-confirm">
                        <p className="chat-item-confirm-prompt" role="status">
                          {confirmation.operation === "archive"
                            ? labels.chatRetentionArchiveConfirm
                            : labels.chatRetentionTrashConfirm}
                        </p>
                        <div className="chat-item-confirm-actions">
                          <button
                            type="button"
                            className="small-button danger"
                            data-testid="chat-retention-confirm-yes"
                            onClick={() => {
                              const { handle, operation } = confirmation;
                              setConfirmation(null);
                              transition(handle, operation);
                            }}
                          >
                            {confirmation.operation === "archive"
                              ? labels.chatRetentionArchiveConfirmYes
                              : labels.chatRetentionTrashConfirmYes}
                          </button>
                          <button
                            type="button"
                            className="small-button"
                            data-testid="chat-retention-confirm-no"
                            onClick={() => setConfirmation(null)}
                          >
                            {labels.chatRetentionConfirmNo}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
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
    ? { kind: "empty", projectionRevision: result.projectionRevision, chapters: result.chapters }
    : {
        kind: "ready",
        rows: result.memories,
        projectionRevision: result.projectionRevision,
        chapters: result.chapters,
      };
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
      | Readonly<{ operation: "archive"; handle: string }>
      | Readonly<{ operation: "update_chapter"; handle: string; content: string }>
      | Readonly<{ operation: "delete_chapter"; handle: string }>,
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
      } catch (error) {
        // The rejection may still hide a committed change (a same-cookie stale
        // tab hits the projection conflict), so the authoritative projection is
        // re-read BEFORE the failure is reported: a rejected write never appears
        // as saved.
        try {
          setView(memoryViewOf(await api.readMemory()));
        } catch {
          setView({ kind: "error" });
        }
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
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
      } catch (error) {
        // A rejection can still hide a committed change (a same-cookie stale tab
        // hits the revision conflict), so re-read the authority before reverting.
        try {
          const preference = await api.readLanguagePreference();
          settingsRevisionRef.current = preference.revision;
          setLanguageView({ kind: "ready", locale: preference.locale, pending: false });
        } catch {
          setLanguageView({ kind: "error" });
        }
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
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

  const mutateVoice = (
    action: "accept" | "revoke" | "setOutputDevice" | "setPersona",
    value: string | null = null,
  ): void => {
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
          ? { action, expectedRevision, outputDevice: value }
          : action === "setPersona"
            ? { action, expectedRevision, persona: value }
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
      } catch (error) {
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
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error) });
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
          error instanceof TavernProblemError && error.code === "settings_revision_conflict"
            ? ("conflict" as const)
            : null;
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
        onSelectPersona={(persona) => mutateVoice("setPersona", persona)}
      />
      {connectionView.kind === "ready" && (
        // Rendered only when the mounted profile actually published the
        // connection routes; a profile without them never shows a control that
        // could not work.
        <ConnectionSettingsPanel
          connectionView={connectionView}
          labels={labels}
          onCreate={createConnection}
          onTest={(connectionId) =>
            void mutateConnection(async (client, token) => {
              if (connectionView.kind !== "ready") throw new TavernProtocolError();
              const probe = await client.testConnection(connectionId, connectionView.state.revision, token);
              return probe.state;
            }, false)
          }
          onActivate={(connectionId) =>
            void mutateConnection(async (client, token) => {
              if (connectionView.kind !== "ready") throw new TavernProtocolError();
              return await client.activateConnection(connectionId, connectionView.state.revision, token);
            }, true)
          }
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
          onRemove={(connectionId) =>
            void mutateConnection(async (client, token) => {
              if (connectionView.kind !== "ready") throw new TavernProtocolError();
              return await client.removeConnection(connectionId, connectionView.state.revision, token);
            }, false)
          }
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
