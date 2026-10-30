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
import { Archive, Download, Pencil, Sparkles, Trash2 } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";
import type { Locale, Messages } from "../i18n";
import { problemTextWithCode } from "../composed-problem-view";
import { useArmedConfirmation } from "./armed-confirmation";
import { ContextDrawer } from "./ContextDrawer";
import { MarkdownMessage } from "./MarkdownMessage";
import { openingVariantName } from "./opening-variant-labels";
import { type ChatModelRoute, readChatModelRoute } from "../chat-model-route";
import {
  type ChatTitleV1,
  createManagementPipelineApi,
  type ManagementPipelineApi,
  MAX_GAME_PROMPT_ADDITION_CHARS,
  type MemoryReadV1,
  TavernProblemError,
  TavernProtocolError,
  type ChatExportV1,
  type TavernConnectionStateV1,
  type TavernConnectionThinkingLevelV1,
  type TavernConnectionProviderV1,
  type TavernGamePromptAdditionV1,
  type TavernModelProfilesV1,
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
  type MemoryMutationOutcome,
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
 * The download's own file name: a bounded, filesystem-safe spelling of the Chat's display name, so
 * a title that is empty, very long or full of separators still yields a name the browser will save.
 */
function transcriptFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "chat";
}

/**
 * How many facts of the conversation the Host's own export left out. The number is what the player
 * is told: the export's `field` values are the interchange's own identifiers (`message_ids`,
 * `swipes`), and printing those would put the artifact's vocabulary in the product's face.
 */
function exportDroppedFacts(exported: ChatExportV1): number {
  return exported.dispositions.filter((disposition) => disposition.classification !== "accepted_typed").length;
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
 * validated list -> PUT /chat/title with the target's own handle and that
 * revision -> the validated durable read-back replaces the entry, so the list
 * never shows a guessed revision or title; any rejection re-reads the
 * authoritative list before the failure is reported.
 *
 * `renameAvailable`/`retentionAvailable` are the mount's capability flags: a
 * management profile that publishes no `chat.rename` passes `false` and the
 * control is absent; `undefined` means this mount cannot see that projection and
 * the served list is the capability (see the file header).
 *
 * Every row's rename, archive and trash name that row's own Chat, not the mounted
 * one: the command carries the row's handle and CASes its own management revision, so
 * cleaning up history never means switching into each Chat first, and a target that is
 * not the mounted row leaves the mounted conversation - and its live stream - exactly as
 * it is. Only a transition of the MOUNTED row moves the shell, through
 * `onCurrentChatRemoved` (see the row's own note) - or, when the removal emptied the
 * active list, through the New Chat creation `applyChatRemoval` performs (see its note).
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
  /** The mounted selection's generation: the mounted operations (`chat.create`, `chat.select`, `chat.opening`) carry it. */
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
  // One opening at a time: the chooser is a list of choices, and a player who asks to read one
  // is deciding about that one - collapsing the previous keeps the list scannable and the
  // state trivial (a single id rather than a set that grows as the player explores).
  const [expandedOpening, setExpandedOpening] = useState<string | null>(null);
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
  // The Chat whose transcript export is in flight. Export is a read and a
  // download, not a mutation, so it never moves the mounted selection and the
  // list is untouched; this only marks the row so a slow read is not silent.
  const [exporting, setExporting] = useState<string | null>(null);
  const { inline, report } = useSurfaceNotice(onNotice);
  // The row's rename editor is the same arm-and-close pair the destructive rows use
  // (`armed-confirmation.ts`): opening it REPLACES the pencil that was pressed with a field,
  // so without this the page drops focus onto `<body>` the moment the pencil is clicked, and
  // again when the editor closes under the player. The trigger is whichever pencil opened the
  // editor - the pencils share the ref, and the editor's own mount is what re-attaches it, so
  // it can only ever hold the one row that is being renamed.
  const renamePair = useArmedConfirmation(editing !== null, () => setEditing(null));

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

  /**
   * Re-reads the authoritative active list and hands it back to the caller that asked.
   * `null` is the read that failed: the projection is then the error state, and no
   * caller may treat an unreadable list as an empty one - the empty list is the fact
   * `applyChatRemoval` acts on.
   */
  const reread = async (): Promise<readonly ChatListEntry[] | null> => {
    try {
      const read = await api.listChats();
      setList(read.chats);
      return read.chats;
    } catch {
      setList("error");
      return null;
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
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
      }
    })();
  };

  /**
   * Closes the rename editor and gives the pencil back its focus.
   *
   * The module names the step `cancel` because its first user was a destructive confirmation;
   * here it is only the close half - Escape stops there and writes nothing, and Enter closes
   * through it and then commits the title it was asked to save.
   */
  const closeRename = renamePair.cancel;

  const commitRename = (handle: string, title: string): void => {
    closeRename();
    rename(handle, title);
  };

  /**
   * The editor's own keyboard path: Enter saves, Escape dismisses, and both give the pencil
   * back. `stopPropagation` on the Escape is the module's, so a dismissal is not also a
   * dismissal of the surface the row sits on.
   */
  const renameKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      renamePair.onConfirmKeyDown(event);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (editing === null) return;
    const next = editing.title.trim();
    if (next.length > 0) commitRename(editing.handle, next);
    else closeRename();
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
  const createChat = async (openingTargetIndex?: number): Promise<boolean> => {
    if (creating) return false;
    setCreating(true);
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
      return true;
    } catch (error) {
      // A rejection may still hide a committed creation, so the authoritative
      // list is re-read BEFORE the failure is reported.
      await reread();
      report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
      return false;
    } finally {
      setCreating(false);
    }
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
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
      } finally {
        setSelecting(null);
      }
    })();
  };

  /**
   * THE REMOVAL SEAM: the one place a Chat removal is applied, and the one place the
   * owner's rule about an emptied active list lives.
   *
   * Today two removals funnel through this function - `archive` and `trash` - and they
   * differ only in the operation it sends. A physical delete, when the product grows one,
   * belongs to this same function: it inherits the rule below by being a removal here,
   * not by adding a second branch beside the archive's.
   *
   * The owner's rule: a removal that leaves the companion with ZERO active Chats creates
   * one, because `chat === null` may never reach the client - with nothing mounted there
   * is no conversation to write to and no surface to stand on. The Chat it creates is the
   * New Chat control's own creation (`createChat`: the same `chat.create` command, the
   * Host's own greeting as the opening) and the switch that lands the player in it is that
   * control's own (`requestSelection` -> `onChatSwitched`), so a removal never gains a
   * second writer and never names an opening itself. A removal that leaves another active
   * Chat is unchanged: the shell moves its selection to a survivor (`onCurrentChatRemoved`).
   *
   * The decision is taken from the active list the Host serves after the removal, never
   * from which operation produced it.
   */
  const applyChatRemoval = (handle: string, operation: "archive" | "trash"): void => {
    const entry = chatListRows(list).find((chat) => chat.handle === handle);
    if (entry === undefined) {
      report({ kind: "failure", text: labels.chatRetentionFailed });
      return;
    }
    void (async () => {
      try {
        // Owner's rule (2026-10-21): the active list never reaches zero. When this removal would
        // empty it, the successor is created and mounted **first** - the store refuses a lifecycle
        // transition on the mounted selection, and a crash between the two steps must not leave a
        // root with no active Chat (which the store then calls corrupt on the next start).
        const emptiesTheList = chatListRows(list).length === 1;
        const successorMounted = emptiesTheList ? await createChat() : false;
        if (emptiesTheList && !successorMounted) {
          // The successor could not be created or mounted, so removing now would empty the list:
          // the removal is refused instead, and the player keeps the Chat they have.
          report({ kind: "failure", text: labels.chatRetentionFailed });
          return;
        }
        await api.transitionChatLifecycle(handle, operation, entry.managementRevision, csrfToken);
        // The transition removed the chat from the active list (metadata-only
        // mutation), so reconcile against the durable list it left behind.
        const remaining = await reread();
        if (remaining !== null && remaining.length === 0) {
          // The successor was created and mounted before this removal, so an empty list here means the
          // read disagrees with what the Host just committed. Creating a second Chat would hide that;
          // the player is told, and the shell's own re-read decides what to show.
          report({ kind: "failure", text: labels.chatRetentionFailed });
          return;
        }
        // When the removed chat WAS the mounted one, the shell's selection no longer
        // names a chat the list holds: the mount owns the selection and the live cursor,
        // so it is told to move to a survivor. An unreadable list is that same report -
        // the shell re-reads the list itself and decides on what it sees. A removal that
        // first created and mounted a successor has already moved the player, so the shell
        // must not be asked to move again.
        if (!successorMounted && handle === currentChatHandle) onCurrentChatRemoved?.(handle);
        report({ kind: "success", text: labels.success });
      } catch (error) {
        await reread();
        report({ kind: "failure", text: problemTextWithCode(labels.chatRetentionFailed, error, labels) });
      }
    })();
  };

  /**
   * Saves one Chat's transcript as the SillyTavern chat file the Host's own interchange produced.
   *
   * Export is a read and a download: it names any row by its own handle, never the mounted one, so
   * saving a conversation does not mean switching into it. The file is the Host's own bytes - the
   * browser never re-serializes the transcript - and the Host's dispositions are reported beside it,
   * because the file is a subset (the selected variant of each turn, no durable message ids) and a
   * silent subset reads as a lost conversation. A refusal is a sentence, not a lost click.
   */
  const exportTranscript = (handle: string, name: string): void => {
    if (exporting !== null) return;
    setExporting(handle);
    void (async () => {
      let notice: ManagementSurfaceNotice;
      try {
        const exported = await api.exportChat({ chatHandle: handle });
        const fileName = `${transcriptFileName(name)}.jsonl`;
        const url = URL.createObjectURL(new Blob([exported.jsonl], { type: "application/jsonl" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        notice = { kind: "success", text: labels.chatExportSaved.replace("{{file}}", fileName) };
        const dropped = exportDroppedFacts(exported);
        if (dropped > 0)
          notice = {
            kind: "success",
            text: `${notice.text} ${labels.chatExportDropped.replace("{{count}}", String(dropped))}`,
          };
      } catch (error) {
        notice = { kind: "failure", text: problemTextWithCode(labels.chatExportFailed, error, labels) };
      } finally {
        setExporting(null);
      }
      report(notice);
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
              if (openings === null) void createChat();
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
              // The option names the opening it commits and nothing more: the position in the set
              // belongs to the strip under the opening bubble, and composing the two here put the
              // index into the name twice (`备用 1 2/3`).
              const name = openingVariantName({ label: variant.label, index, count: openings.length }, labels);
              const expanded = expandedOpening === variant.optionId;
              const revealName = (expanded ? labels.openingCollapseName : labels.openingExpandName).replace(
                "{{name}}",
                name,
              );
              return (
                <div key={variant.optionId} role="listitem">
                  {/* One card per opening, and the card itself is a container rather than a control: it
                      reads, and the two things a player can do with it sit in its own footer row. Clicking
                      the prose used to commit the opening, which meant a reader who only wanted to see the
                      rest of it started a conversation instead - and on a phone, selecting text did the same.
                      The prose is now inert text, and both verbs are buttons. */}
                  <div className="opening-option-card" data-testid="opening-option-card">
                    <div className="opening-option" data-testid="opening-option">
                      <span className="opening-option-name" data-testid="opening-option-name">
                        {name}
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
                    </div>
                    {/* The card's text is exactly what the choice turns on:
                        one line of beat and two of speech. A real opening runs past that - the
                        companion's own third opening is a paragraph - and a player choosing a
                        scene they will live in should be able to read it first. */}
                    {expanded && (
                      <div
                        className="opening-option-full"
                        id={`${variant.optionId}-full`}
                        data-testid="opening-option-full"
                      >
                        <MarkdownMessage text={variant.text} />
                      </div>
                    )}
                    {/* The reveal names the opening it belongs to: three cards in one drawer mean
                        three controls whose visible word alone cannot say which one they open. */}
                    <div className="opening-option-footer">
                      <button
                        type="button"
                        className="opening-option-commit small-button"
                        data-testid="opening-option-commit"
                        onClick={() => {
                          setPickerOpen(false);
                          void createChat(index);
                        }}
                      >
                        {labels.openingUse}
                      </button>
                      <button
                        type="button"
                        className="opening-option-expand small-button"
                        data-testid="opening-option-expand"
                        aria-expanded={expanded}
                        {...(expanded ? { "aria-controls": `${variant.optionId}-full` } : {})}
                        aria-label={revealName}
                        title={revealName}
                        onClick={() => setExpandedOpening(expanded ? null : variant.optionId)}
                      >
                        {expanded ? labels.openingCollapse : labels.openingExpand}
                      </button>
                    </div>
                  </div>
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
            /*
             * Every row carries its own rename: `chat.rename` names the target by its own handle and
             * CASes that Chat's management revision (`chat-management-service.ts`), so a pencil on a row
             * the mount is not on is served like any other and leaves the mounted conversation untouched.
             * The list carries only active Chats, so the pencil appears on every non-archived/trashed row.
             * The editor is held to its own row: a stale editor left on a row the mount has moved off
             * would offer a Save that CASes a revision the player can no longer see.
             */
            const renameHere = renameAvailable !== false;
            // The confirmation belongs to exactly one row, and while it is armed that row's
            // rename/archive/trash strip steps aside: the confirmation is the row's only action
            // until it is answered.
            const armedHere = confirmation !== null && confirmation.handle === chat.handle;
            const editingHere = renameHere && editing !== null && editing.handle === chat.handle;
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
                {editingHere ? (
                  <div data-testid="chat-rename" onKeyDown={renameKeyDown}>
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
                          if (next.length > 0) commitRename(chat.handle, next);
                          else closeRename();
                        }}
                      >
                        {labels.save}
                      </button>
                      <button type="button" className="small-button" onClick={closeRename}>
                        {labels.close}
                      </button>
                    </div>
                  </div>
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
                          {renameHere && (
                            <button
                              ref={renamePair.triggerRef}
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
                          {/* The transcript export is a read of this exact row, so a conversation
                              is saved without switching into it. It is not a destructive action, so
                              it needs no arm/confirm - only its own in-flight mark. */}
                          <button
                            type="button"
                            className="icon-button-small"
                            data-testid="chat-export"
                            title={labels.exportChat}
                            aria-label={labels.exportChat}
                            disabled={exporting !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              exportTranscript(chat.handle, name);
                            }}
                          >
                            <Download size={14} aria-hidden="true" />
                          </button>
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
                              applyChatRemoval(handle, operation);
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
  conversationTurn,
  mutationAvailable,
  onNotice,
}: Readonly<{
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  /** The player's UI language, which is the language the Memory rows are labelled in. */
  locale: Locale;
  /**
   * The mounted conversation's turn, as this shell has committed it. The notebook's rows are
   * not on the composed root - they come from this panel's own `memory.read` route - so the
   * shell cannot hand the panel the rows themselves. What it can say is when the ground under
   * them moved: a turn settling is the moment the companion writes, and a panel that read only
   * on mount kept showing the pre-turn notebook until the player pressed Refresh.
   *
   * It is the whole of what the panel is told: which turn, and where it is. Any change to that
   * pair is a read, so a settlement (same turn, new state) and a fresh turn both count, and
   * nothing but a read of the route ever produces a row.
   */
  conversationTurn: Readonly<{ handle: string; state: string }> | null;
  mutationAvailable?: boolean;
  onNotice?: (notice: ManagementSurfaceNotice) => void;
}>): ReactElement {
  const [view, setView] = useState<MemoryView>({ kind: "loading" });
  const { inline, report } = useSurfaceNotice(onNotice);
  // The identity of the turn the rows below were read beside. It is a value, not an effect
  // dependency list of its own, so the one effect below stays the single read path: mounting
  // reads, and so does every settlement the shell commits afterwards.
  const turnIdentity = conversationTurn === null ? "" : `${conversationTurn.handle}@${conversationTurn.state}`;

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
  }, [api, turnIdentity]);

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
  ): Promise<MemoryMutationOutcome> => {
    const projectionRevision = view.kind === "ready" || view.kind === "empty" ? view.projectionRevision : null;
    // Nothing to CAS on means the write was never sent: the caller's field must keep the text for
    // the retry that can actually land.
    if (projectionRevision === null) return Promise.resolve({ kind: "refused", text: labels.failure });
    return (async () => {
      try {
        const result = await api.mutateMemory(
          { apiVersion: 1, expectedProjectionRevision: projectionRevision, ...input },
          csrfToken,
        );
        setView(memoryViewOf(result));
        report({ kind: "success", text: labels.success });
        return { kind: "saved" } as const;
      } catch (error) {
        // The rejection may still hide a committed change (a same-cookie stale
        // tab hits the projection conflict), so the authoritative projection is
        // re-read BEFORE the failure is reported: a rejected write never appears
        // as saved. A re-read that itself fails leaves the projection this panel
        // already holds on screen - rendering `error` in its place would unmount the
        // authoring form, and the player's unsent words with it.
        try {
          setView(memoryViewOf(await api.readMemory()));
        } catch {
          // The refusal stands on its own; the rows stay as they were read.
        }
        const text = problemTextWithCode(labels.failure, error, labels);
        report({ kind: "failure", text });
        return { kind: "refused", text } as const;
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
 * The player's own addition to the Game companion's instructions.
 *
 * `record` is what the Host has stored (and its revision is the CAS every write carries);
 * `draft` is what the field currently shows. The two follow different owners: an accepted save
 * adopts the Host's read-back into both, and a refused one adopts only the record, so the next
 * save CASes on the revision the Host holds while the field keeps exactly what the player typed.
 */
type GamePromptAdditionView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "ready"; record: TavernGamePromptAdditionV1; draft: string; pending: boolean }>;

/**
 * The player's own addition to the Game companion's instructions: one field, one bound, and
 * the sentence saying when it lands.
 *
 * That last sentence is not decoration. The runtime composes a game's instructions when the
 * game starts, so a saved addition reaches the NEXT game - unlike the action policy beside the
 * Game surface, which the Mod re-reads on its own tick. A control that saved silently would
 * leave a player watching a running game for a change it cannot make.
 *
 * The counter and the `maxLength` both read `MAX_GAME_PROMPT_ADDITION_CHARS`, and `onChange`
 * clamps to it as well: a paste or a programmatic fill is not stopped by `maxLength` (the
 * browser enforces that attribute on typing only), so the ceiling is applied to the value
 * itself rather than to one way of entering it.
 */
function GamePromptAdditionPanel({
  view,
  labels,
  onChange,
  onSave,
}: Readonly<{
  view: GamePromptAdditionView;
  labels: Messages;
  onChange: (next: string) => void;
  onSave: () => void;
}>): ReactElement {
  return (
    <section
      className="management-settings-section"
      aria-label={labels.gamePromptAdditionTitle}
      data-game-prompt-addition
    >
      <h2>{labels.gamePromptAdditionTitle}</h2>
      <p>{labels.gamePromptAdditionHint}</p>
      {view.kind === "loading" && <p>{labels.loading}</p>}
      {view.kind === "unavailable" && <p>{labels.gamePromptAdditionUnavailable}</p>}
      {view.kind === "error" && <p>{labels.failure}</p>}
      {view.kind === "ready" && (
        <>
          <label className="management-settings-label" htmlFor="game-prompt-addition">
            {labels.gamePromptAdditionField}
          </label>
          <textarea
            id="game-prompt-addition"
            className="form-textarea"
            rows={6}
            maxLength={MAX_GAME_PROMPT_ADDITION_CHARS}
            disabled={view.pending}
            value={view.draft}
            onChange={(event) => onChange(event.target.value.slice(0, MAX_GAME_PROMPT_ADDITION_CHARS))}
          />
          <p className="management-settings-hint" data-game-prompt-addition-count>
            {labels.gamePromptAdditionCount
              .replace("{{count}}", String(view.draft.length))
              .replace("{{max}}", String(MAX_GAME_PROMPT_ADDITION_CHARS))}
          </p>
          {/* WHEN it takes effect, always rendered beside the field: this is the one fact a
              save here cannot demonstrate for itself. */}
          <p className="management-settings-hint" data-game-prompt-addition-effective>
            {labels.gamePromptAdditionEffective}
          </p>
          <div className="composer-actions">
            <button type="button" className="small-button" disabled={view.pending} onClick={onSave}>
              {labels.gamePromptAdditionSave}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The Settings panel: the connection records, the companion language, the voice
 * consent/devices and the two model profiles - the four field groups the
 * management surface shows, over the same routes.
 *
 * The connection group is first because it is the one fact that decides whether
 * a reply can happen at all: without it every other setting describes a product
 * that cannot answer. A player who arrived here from the conversation's own
 * "no model connection" sentence lands on the controls that fix it, above the
 * language and voice preferences that only shape a conversation once one exists.
 *
 * The voice group is last, consent included. The first settings screen keeps the
 * one consent a conversation needs - the model connection - and the cloud-TTS
 * consent is a disclosure the player reads once, when they reach for voice. Its
 * controls stay exactly where they were, with the disclosure sentence they
 * consent to and the device and persona selections they apply to; nothing was
 * deleted and no rule changed, so voice is gated by the same durable consent the
 * moment it is used. It simply is not the third thing a player reads on a screen
 * about models.
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
  /**
   * The send path's own answer, read here from the two projections this surface already loads so
   * the connection section can word itself from it (see `ConnectionSettingsPanel.modelRoute`).
   * `unknown` until the read lands, and `unknown` is the honest first value: a sentence derived
   * before there is an answer would be a guess.
   */
  const [modelRoute, setModelRoute] = useState<ChatModelRoute>({ kind: "unknown" });
  const [modelProfilesView, setModelProfilesView] = useState<ModelProfilesView>({ kind: "loading" });
  const [promptAdditionView, setPromptAdditionView] = useState<GamePromptAdditionView>({ kind: "loading" });
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
      // Both settings projections, read ONCE each. They are the panel's own reads (the connection
      // section and the model editors need them), and they are also the two inputs `readChatModelRoute`
      // turns into "would a send reach a model". Reading them through that function instead of re-reading
      // them here is what keeps one authority: the same call the Chat makes, over the same values this
      // panel already holds.
      let connectionRead: Readonly<{ ok: true; state: TavernConnectionStateV1 }> | Readonly<{ ok: false }> = {
        ok: false,
      };
      let profilesRead:
        | Readonly<{ ok: true; profiles: TavernModelProfilesV1 }>
        | Readonly<{ ok: false; error: unknown }> = { ok: false, error: undefined };
      try {
        const state = await api.readConnection();
        connectionRead = { ok: true, state };
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
        profilesRead = { ok: true, profiles };
        if (active) setModelProfilesView({ kind: "ready", profiles, pending: null, notice: null });
      } catch (error) {
        profilesRead = { ok: false, error };
        if (active) setModelProfilesView({ kind: "unavailable" });
      }
      // The route, from the two reads above and no others: replaying their outcomes is what lets the
      // one authority classify them (including the profile-store refusals that mean "no model").
      const route = await readChatModelRoute({
        readConnection: async () => {
          if (!connectionRead.ok) throw new TavernProtocolError();
          return connectionRead.state;
        },
        readModelProfiles: async () => {
          if (!profilesRead.ok) throw profilesRead.error;
          return profilesRead.profiles;
        },
      });
      if (active) setModelRoute(route);
      // The player's prompt addition, read once. A route this build's Host does not serve leaves
      // the group saying so rather than showing a field whose save would always fail.
      try {
        const record = await api.readGamePromptAddition();
        if (active) setPromptAdditionView({ kind: "ready", record, draft: record.addition, pending: false });
      } catch {
        if (active) setPromptAdditionView({ kind: "unavailable" });
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
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
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
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
      }
    })();
  };

  /**
   * Writes the player's prompt addition.
   *
   * An accepted write is the Host's read-back, so both the record and the field become what the
   * store holds. A refusal must not: the addition in the field is the player's own text, and a
   * failed save that replaced it with the stored copy would answer her by deleting what she was
   * writing. So a refusal re-reads only the record - its revision is what the retry CASes on,
   * which is what makes the retry possible instead of looping on the revision that already lost.
   */
  const savePromptAddition = (): void => {
    if (promptAdditionView.kind !== "ready" || promptAdditionView.pending) return;
    const view = promptAdditionView;
    setPromptAdditionView({ ...view, pending: true });
    void (async () => {
      try {
        const written = await api.updateGamePromptAddition(
          { expectedRevision: view.record.revision, addition: view.draft },
          csrfToken,
        );
        setPromptAdditionView({ kind: "ready", record: written, draft: written.addition, pending: false });
        report({ kind: "success", text: labels.success });
      } catch (error) {
        try {
          const restated = await api.readGamePromptAddition();
          setPromptAdditionView({ kind: "ready", record: restated, draft: view.draft, pending: false });
        } catch {
          // The refusal stands on its own: the field keeps her text and the next save CASes on
          // the revision this panel still holds.
          setPromptAdditionView({ ...view, pending: false });
        }
        report({ kind: "failure", text: problemTextWithCode(labels.failure, error, labels) });
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
          // A keyless self-hosted endpoint sends no credential at all, and the fact that none is
          // needed travels with the command (never inferred from an absent field).
          ...(provider.setupFields.includes("apiKey") && form.apiKeyRequired ? { apiKey: form.apiKey } : {}),
          ...(provider.setupFields.includes("apiKeyRequired") ? { apiKeyRequired: form.apiKeyRequired } : {}),
          ...(provider.setupFields.includes("baseUrl") ? { baseUrl: form.baseUrl } : {}),
          ...(provider.setupFields.includes("apiShape") ? { apiShape: form.apiShape } : {}),
          // One model field for every provider the player configures: the id they chose or typed,
          // and nothing when they named none (the Host then keeps the entry's first suggestion).
          ...(provider.setupFields.includes("modelId") && form.modelId !== "" ? { modelId: form.modelId } : {}),
        },
        token,
      );
    }, false);
  };

  /**
   * One model-profile mutation at a time. The Host owns both the durable record
   * and the validation, so the panel sends exactly the level the player chose and
   * adopts the validated read-back as the only thing it shows; a rejected write
   * re-reads the authority before the failure notice appears.
   */
  const mutateModelProfile = (surface: "chat" | "game", thinkingLevel: string): void => {
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
      {connectionView.kind === "ready" && (
        // Rendered only when the mounted profile actually published the
        // connection routes; a profile without them never shows a control that
        // could not work.
        <ConnectionSettingsPanel
          connectionView={connectionView}
          modelRoute={modelRoute}
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
      <LanguageSettingsPanel
        languageView={languageView}
        uiLocale={uiLocale}
        labels={labels}
        onSelectLanguage={mutateCompanionLanguage}
        onSelectUiLanguage={selectUiLocale}
      />
      {modelProfilesView.kind === "ready" && (
        // Rendered only when the mounted profile published the model-profile
        // routes; a profile without them never shows an editor it cannot serve.
        <ModelProfilesPanel
          view={modelProfilesView}
          labels={labels}
          onSave={(surface, thinkingLevel) => mutateModelProfile(surface, thinkingLevel)}
        />
      )}
      {
        // Rendered from the first frame, like every other settings group: the read is what
        // decides whether there is a field to show, and a group that appeared only after its
        // read landed would pop into a list the player was already reading.
        <GamePromptAdditionPanel
          view={promptAdditionView}
          labels={labels}
          onChange={(next) =>
            setPromptAdditionView((previous) => (previous.kind === "ready" ? { ...previous, draft: next } : previous))
          }
          onSave={savePromptAddition}
        />
      }
      <VoiceSettingsPanel
        voiceView={voiceView}
        labels={labels}
        onAccept={() => mutateVoice("accept")}
        onRevoke={() => mutateVoice("revoke")}
        onSelectDevice={(deviceId) => mutateVoice("setOutputDevice", deviceId)}
        onSelectPersona={(persona) => mutateVoice("setPersona", persona)}
      />
    </>
  );
}
