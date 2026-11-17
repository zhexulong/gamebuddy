import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatSnapshotPair, readChatSnapshotPair } from "../chat-snapshot-pair";
import {
  declaredProblemSentence,
  composedProblemView as problemView,
  problemStepPresentation,
} from "../composed-problem-view";
import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import {
  CHARACTERS_PANEL,
  CHAT_PANEL,
  CHATS_PANEL,
  GAME_PANEL,
  MEMORY_PANEL,
  PRESETS_PANEL,
  SETTINGS_PANEL,
  useSurfaceRoute,
} from "../composed-surface-route";
import type { Locale } from "../i18n";
import { applyDocumentLocale, messages, persistLocale, resolveLocale } from "../i18n";
import type { BrowserDraftV1 } from "../reference-pipeline-api";
import { createReferencePipelineSession } from "../reference-pipeline-session";
import { type WorldInfoBindingSource, worldInfoBindingSource } from "../world-info-binding-source";
import { AppBar } from "./AppBar";
import { CharactersSurface } from "./CharactersSurface";
import { type ChatArmedAction, deriveChatUIState, isTurnInFlight } from "./chat-ui-state";
import { ChatSurface } from "./ChatSurface";
import { ChatsSurface } from "./ChatsSurface";
import {
  appBarGameStatus,
  appBarStatus,
  liveTurn,
  type OptimisticSend,
  pendingOptimisticMessage,
  stopAvailable,
  submitAvailable,
  terminalTurnNotice,
} from "./composed-chat-shell-state";
import { ContextDrawer } from "./ContextDrawer";
import { newIdempotencyKey } from "./composed-reference-game-view";
import { createDraftMutation, type DraftNotice } from "./draft-mutation";
import { GameSurface } from "./GameSurface";
import { MemorySurface } from "./MemorySurface";
import { createManagementPipelineApi } from "./management-surface-panels";
import { type ChatMutationKind, createMessageMutation, type MessageMutationOutcome } from "./message-mutation";
import { ProblemView } from "./ProblemView";
import { PresetAssemblySurface } from "./PresetAssemblySurface";
import { SettingsSurface } from "./SettingsSurface";
import { SkipLink } from "./SkipLink";
import { LEADING_SURFACE_COUNT, surfaceBarEntries } from "./surface-bar-entries";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { SurfaceDrafts } from "./surface-drafts";
import { createTurnMutation } from "./turn-mutation";
import { markTurn } from "./turn-timings";
import { useArrivalReread } from "./use-arrival-reread";
import { useAppearance } from "./use-appearance";
import { useChatEventStream } from "./use-chat-event-stream";
import { type ComposedPreviewV1, terminalTurn, useComposedBootstrap } from "./use-composed-bootstrap";

/**
 * The composed root with its Chat half replaced and its Game half left exactly as it stands.
 *
 * Every Chat read in this shell answers the whole aggregate: `/state` carries the conversation *and* a
 * `game` slice beside it, photographed when the request left. A read is a round trip, so a Game fact
 * that arrives inside it (`GameSurface.applyGameFact`, from the game's own channel, or the panel's own
 * `/game` read) is NEWER than that photograph - committing the photograph over it puts the panel back
 * on an older projection, and nothing in the Chat channel ever puts it forward again: the game channel
 * only speaks when the Host moves, which it has already done. So the Chat paths replace `chat` and keep
 * `root.game` from the view that is current when the read lands, the same rule these reads already
 * apply to the pending record and the preview.
 *
 * The reverse direction has its own guard (`GameSurface.rereadGame` commits the Game slice and nothing
 * else): each surface's authoritative read writes its own slice, and neither decides the other's.
 */
const withChatHalf = (
  current: ComposedReferenceGameBrowserRootV1,
  chat: ChatSnapshotPair["root"]["chat"],
): ComposedReferenceGameBrowserRootV1 => ({ ...current, chat });

/**
 * Same-origin composed reference-game shell. The composed root is the only
 * authority used to refresh either projection; the nested Reference pipeline
 * client remains the sole Chat mutation/events client.
 */
export function ComposedReferenceGameApp() {
  const [inputText, setInputText] = useState("");
  // The composer's own field is the single authoring buffer for both the next
  // message and the durable draft (see the seeding effect below); the ref is
  // what the async draft mutation reads, so it can never act on a stale render.
  const inputTextRef = useRef("");
  const writeInput = (text: string): void => {
    inputTextRef.current = text;
    setInputText(text);
  };
  const [preview, setPreview] = useState<ComposedPreviewV1 | null>(null);
  // The chat mutation currently in flight. The submit button already has its own
  // gate; swipe and regenerate had none, so a double click issued two admitted
  // commands (regenerate mints a fresh idempotency key per click). The ref is the
  // synchronous single-flight guard, the state is the projection the surface shows.
  const [chatMutation, setChatMutation] = useState<Readonly<{
    kind: ChatMutationKind;
    handle: string;
  }> | null>(null);
  // The one destructive arm: the act the player asked to confirm, the message it names, and the order (or
  // variant index) they were shown it at. A rewind destroys everything after its point, a delete has no
  // undo, and a variant discard destroys a generation they spent tokens on, so each arm only names the
  // target and the confirmation below the bubble is what sends it. It is one value, not one per verb:
  // two confirmations open at once would leave the player unable to tell what the next press removes, and
  // arming a second act replaces the first by construction rather than by three handlers each remembering
  // to clear the other two.
  const [arm, setArm] = useState<ChatArmedAction | null>(null);
  const chatMutationRef = useRef(false);
  // The durable draft's authoring state is the composer's own field (see the
  // seeding effect below); what stays here is the closed outcome line its
  // Save/Discard report through.
  const [draftNotice, setDraftNotice] = useState<DraftNotice | null>(null);
  /**
   * The last send this surface could not complete, in the failure's own sentence.
   *
   * The words go back into the field, and this is what stands beside them: a failure is a fact about
   * one attempt, so it is reported where the player can act on it and never replaces the conversation
   * the attempt was written into. It is spent by the next turn-starting mutation (`beginTurnMutation`,
   * shared by send and regenerate) and by adopting another Chat, because past either point it
   * describes an attempt that no longer stands.
   */
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  /**
   * The last message mutation this surface was refused, in the refusal's own sentence.
   *
   * Every message-level mutation here - the rewind, the delete, the in-place edit, the regenerate,
   * the swipe, the opening variant, the variant discard - ends in an authoritative reread, and that
   * reread is what made the silence invisible: it restores the transcript the Host still holds, so a
   * refused press simply flickered and reverted and the player, who caused it, was told nothing.
   * Only a reread that ALSO failed reached them, and that replaced the whole surface.
   *
   * So the sentence stands beside the conversation, which stays readable underneath: a refusal is a
   * fact about one press. The words are the catalogue's for the code the Host named
   * (`composed-problem-view.ts`) - the code itself is contract vocabulary and is never printed. It is
   * spent by the next message mutation (`beginMessageMutation`) and by adopting another Chat, because
   * past either point it describes a press that no longer stands.
   */
  const [messageMutationNotice, setMessageMutationNotice] = useState<string | null>(null);
  // A created Chat whose chosen opening could not be committed. The Chat itself is durable and the
  // player is landed in it either way, so this is the one fact left to state: it opens on the
  // default opening. It clears when another switch lands.
  const [openingNotice, setOpeningNotice] = useState<string | null>(null);
  /**
   * The optimistic player line this shell is holding, with the row count it was accepted at.
   *
   * What it means, and the rule for when it stops being visible, belong to
   * `pendingOptimisticMessage` (`composed-chat-shell-state`): this declaration only holds the value
   * that derivation reads.
   */
  const [optimistic, setOptimistic] = useState<OptimisticSend | null>(null);
  // The durable revision the editor was last seeded from, and the chat that seed
  // belongs to: the revision lets a later authoritative read replace the editor
  // without discarding text the player typed past the seed, and the chat identity
  // is what makes a *switch* reseed from the target chat's own draft instead of
  // keeping the previous chat's text.
  const seededDraftRef = useRef<Readonly<{ chat: string | null; revision: number; text: string }> | null>(null);
  const localeRef = useRef<Locale>(resolveLocale());
  const eventSourceRef = useRef<{ close(): void } | null>(null);
  /*
   * The idempotency key of the turn currently in flight, so a mark recorded later (first delta, settle)
   * can be attributed to the same turn a `submit` mark named. Cleared when the turn ends: a mark that
   * outlives its turn would attach the next turn's timing to the previous turn's key.
   */
  const turnKeyRef = useRef<string | null>(null);
  // Bumped after the Host commits a turn-level Chat switch. The mounted identity
  // is new, so the live event subscription must reconnect on the new conversation
  // instead of continuing the previous Chat's cursor.
  const [mountedChatRevision, setMountedChatRevision] = useState(0);
  // This surface's model settings are a popout, not a block inside the reading
  // flow (design/104 §3 keeps the model on the surface it belongs to; the
  // conversation keeps its reading column). It is never the URL's `panel` fact,
  // because the popout replaces no surface: it opens over the conversation and
  // closes back to it.
  const [modelPopoutOpen, setModelPopoutOpen] = useState(false);
  const gameEntryRef = useRef<HTMLButtonElement>(null);
  const chatEntryRef = useRef<HTMLButtonElement>(null);
  const chatsEntryRef = useRef<HTMLButtonElement>(null);
  const charactersEntryRef = useRef<HTMLButtonElement>(null);

  /**
   * The picture each companion was last given, as the upload's own reply reported it.
   *
   * One owner, three readers: the bar, the transcript and the roster all draw her with
   * `CompanionAvatar`, whose `digest` keys the image element so a new picture is fetched
   * instead of served from the browser's cache. Without this the drawer and the roster
   * updated and everything else kept the old picture until a reload.
   */
  const [avatarDigests, setAvatarDigests] = useState<Readonly<Record<string, string>>>({});
  const handleAvatarUpdated = useCallback((handle: string, digest: string) => {
    setAvatarDigests((previous) => (previous[handle] === digest ? previous : { ...previous, [handle]: digest }));
  }, []);
  const settingsEntryRef = useRef<HTMLButtonElement>(null);
  /**
   * The control that opens the preset assembly, which is no longer a bar entry: it is the button in
   * the Settings surface's disclosure (`SettingsSurface`). `openPanelOf` hands focus back to it when
   * the player leaves that surface, so it is the button itself rather than a bar entry.
   */
  const presetsOpenRef = useRef<HTMLButtonElement>(null);
  const memoryEntryRef = useRef<HTMLButtonElement>(null);
  const modelPopoutEntryRef = useRef<HTMLButtonElement>(null);
  /**
   * The composer's field, owned here because two things need the same node: the conversation mounts
   * it (`Composer`'s `fieldRef`) and a return to the conversation focuses it (`useSurfaceRoute`).
   */
  const composerFieldRef = useRef<HTMLTextAreaElement>(null);
  // Every management surface - Characters, Chats, Settings and Memory - runs on
  // the one management pipeline client the management shell uses, on this
  // shell's own origin: the composed root serves those routes through the one
  // broker session, so the library, the Persona/Scenario/Greeting records, the
  // reviewed card import and the Chat, Memory, World Info and Settings panels are
  // the real ones rather than a second implementation (design/28 §2, design/104 §2).
  const managementPipelineApiRef = useRef(
    createManagementPipelineApi(fetch, (observation) => {
      // The opt-in, content-free operation-observation hook the removed
      // management surface owned, preserved verbatim (same fragment parameter,
      // same storage key). The Tavern release live gate consumes the mapping
      // `tools/record-tavern-ui-operation-evidence.mjs` builds from outcomes
      // that came from a real same-origin UI session, and this sessionStorage
      // key is that session's only export; without the hook here the gate's
      // producer stops existing.
      if (new URLSearchParams(location.hash.slice(1)).get("record") !== "operations") return;
      const key = "gamebuddy.tavern.ui.operation-observations";
      const current = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      sessionStorage.setItem(key, JSON.stringify([...current, observation]));
    }),
  );

  useEffect(() => {
    applyDocumentLocale(localeRef.current);
  }, []);

  // The appearance lives on the page, not on one panel: it is read and applied at mount, so a
  // player who chose the light appearance never sees the dark one while the conversation loads.
  const appearance = useAppearance(managementPipelineApiRef.current);

  const { shownSurface, openPanelOf, leaveSurface } = useSurfaceRoute({
    returnFocusTo: composerFieldRef,
    // The preset readout is the one surface opened from inside another surface (Settings' own
    // disclosure), so leaving it is a step back to Settings rather than to the conversation.
    parentOf: { [PRESETS_PANEL]: SETTINGS_PANEL },
  });

  const bootstrap = useComposedBootstrap(localeRef, setPreview, managementPipelineApiRef.current);
  const {
    view,
    viewRef,
    composedApiRef,
    tavernApiRef,
    commit,
    labels,
    cancelledRef,
    streamLiveRef,
    streamFailedRef,
    pollFailure,
    setPollFailure,
    startPolling,
  } = bootstrap;

  /**
   * Commits a failed CHAT read to the place it belongs: the Chat region.
   *
   * Every one of these reads used to answer with `kind: "problem"`, and that state is mutually
   * exclusive with the ready shell - so the card replaced the AppBar, every peer surface and
   * `<GameSurface />` with it. Chat and Game are peer surfaces that start, stop and recover
   * independently (`design/architecture/product-surfaces.md`): a conversation that cannot be
   * reread says nothing about a Player Host, a running SMAPI or the player's place on another
   * surface, and the unmounted Game surface stayed dead until the page was reloaded.
   *
   * The ready shell therefore keeps standing and carries the card in `chatProblem`, which the Chat
   * region draws in place of its conversation. `kind: "problem"` is left for the one failure that
   * has no session to keep - the mount's own read - where there is no region to draw in and
   * nothing else on the window to preserve.
   */
  const commitChatProblem = (error: unknown): void => {
    const current = viewRef.current;
    if (current.kind === "ready") {
      commit({ ...current, chatProblem: problemView(error, messages(current.locale)) });
      return;
    }
    commit(problemView(error, messages(localeRef.current)));
  };

  const eventStreamEpoch =
    view.kind === "ready" ? `${view.session.snapshot.eventStream?.epoch ?? ""}#${mountedChatRevision}` : undefined;

  /**
   * The paragraph an unanswered submission still owed the player.
   *
   * When the fallback poll spends its budget without a settlement it clears the pending record, and
   * the sending line goes with it - which is right, that line was the claim the record made. The
   * words inside it are the player's and nothing else holds them: the field was cleared at the
   * press. They come back here, keyed on the record the poll actually spent (so a regenerate's
   * unanswered request never returns a paragraph that was not its own), and only into an empty
   * field - a player who started writing again owns it now.
   */
  useEffect(() => {
    if (pollFailure === null) return;
    const held = optimistic;
    if (held === null || held.idempotencyKey !== pollFailure.idempotencyKey) return;
    setOptimistic(null);
    if (inputTextRef.current.length > 0) return;
    setInputText(held.text);
    inputTextRef.current = held.text;
  }, [pollFailure, optimistic]);

  /**
   * The turn key names one turn, and it must not outlive it.
   *
   * `turn-timings.ts` states the rule where the key is used: a key that survives its turn "attaches
   * the next turn's timing to the previous turn's name", so `turnDurations(key)` mixes two turns
   * into one reading. The stream's terminal frame clears it where that frame arrives; the fallback
   * poll's settle and every reread that sees a settled turn are the paths with no such frame, and
   * they all end at the same place - the committed view. So the rule is read there too, rather than
   * repeated at each of those writers: a terminal turn in the committed snapshot is a turn that no
   * longer owns a key, whoever noticed it first.
   */
  const settledTurn = view.kind === "ready" ? (view.session.snapshot.chat?.turn ?? null) : null;
  useEffect(() => {
    if (settledTurn !== null && terminalTurn(settledTurn)) turnKeyRef.current = null;
  }, [settledTurn]);

  const streamNotice = useChatEventStream({
    view,
    viewRef,
    composedApiRef,
    tavernApiRef,
    localeRef,
    eventSourceRef,
    streamLiveRef,
    streamFailedRef,
    turnKeyRef,
    setPreview,
    commit,
    commitChatProblem,
    withChatHalf,
    eventStreamEpoch,
  });

  /**
   * The one envelope both turn-starting mutations run through (`turn-mutation`): the record a press
   * publishes before its wire call, and what becomes of that record when the wire call fails.
   *
   * It is handed the shell's own seams rather than owning them - the committed view, the turn key,
   * the Chat problem, the two sentences and the poll - so send and regenerate cannot spell the
   * publication, the settle rule or the poll start for themselves. The two names are the ones their
   * call sites and `turn-timings-gate` already read: the gate's population is the call sites of
   * `beginTurnMutation` in THIS file, so the seam keeps its name where it is called and the module
   * owns the body.
   */
  const { begin: beginTurnMutation, settleFailure: settleFailedTurnMutation } = createTurnMutation({
    viewRef,
    turnKeyRef,
    commit,
    commitChatProblem,
    setSendFailure,
    setPollFailure,
    startPolling,
  });

  const handleSend = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.pending !== null) return;
    // The latch every message mutation takes (`beginMessageMutation`): a rewind, an edit, a delete or a
    // regenerate is rewriting the transcript, and the reread that follows it is the only thing that
    // says what the conversation then is. The gate the press came through reads the same fact
    // (`chat-ui-state`), and this covers the press that lands in the same tick as a mutation's start.
    if (chatMutationRef.current) return;
    const text = inputTextRef.current.trim();
    if (text.length === 0) return;
    const idempotencyKey = newIdempotencyKey();
    const pending = beginTurnMutation(idempotencyKey, current);
    if (pending === null) return;
    turnKeyRef.current = idempotencyKey;
    markTurn("submit", { surface: "chat", turnKey: idempotencyKey });
    setOptimistic(
      Object.freeze({
        idempotencyKey: pending.idempotencyKey,
        text,
        submittedAfterRows: current.session.snapshot.chat?.transcript.length ?? 0,
      }),
    );
    setInputText("");
    inputTextRef.current = "";
    // Sending clears the field, and the empty field is the new seed: the
    // durable draft that arrives next is a new delegation and prefills again,
    // while the text just sent is not re-offered as a draft.
    seededDraftRef.current = Object.freeze({
      chat: current.session.snapshot.selection?.chatHandle ?? null,
      revision: current.draft.revision,
      text: "",
    });
    setPreview(null);
    try {
      await tavernApiRef.current.submit(
        {
          apiVersion: 1,
          selectionGeneration: pending.selectionGeneration,
          text,
          locale: current.locale,
          expectedDraftRevision: pending.expectedDraftRevision,
        },
        { csrfToken: current.session.snapshot.csrfToken, idempotencyKey },
      );
      /*
       * The Host's answer is the acceptance: 202 with the turn it started, under the key this press
       * sent. It is the one mark that splits "the app took my press" from "the Host took my turn",
       * and it cannot come from the event stream - the Host's `turn.state_changed` for a fresh turn
       * carries the `queued` ledger state, not `running` (`turn-timings.ts` says so at the mapping).
       */
      markTurn("accepted", { surface: "chat", turnKey: idempotencyKey });
    } catch (error) {
      // A failed send costs the attempt, never the paragraph.
      //
      // Measured 2026-10-28: the field was cleared at `setInputText("")` BEFORE the await, so an offline send, a
      // 503, or a transient network error destroyed what the player had typed - the optimistic bubble was the only
      // copy left and it is not editable. A draft that survives is the difference between "send failed" and "I lost
      // my paragraph".
      //
      // The refusal's own branch needs this MORE than the retryable one, not less: `payload_too_large` tells the
      // player to send a smaller text, and a text that was thrown away cannot be shortened. Whether retrying can
      // help is a fact about the next attempt, and the sentence already carries it ("try again in a moment" versus
      // "send a smaller one"); it was never a fact about whose words these are.
      //
      // Only when the field is still empty: a player who started typing again while the request was in flight owns
      // the field now, and overwriting that would be the same defect pointing the other way.
      if (inputTextRef.current.length === 0) {
        setInputText(text);
        inputTextRef.current = text;
      }
      // The sentence stands beside the words rather than in place of them. A failed send says nothing about the
      // conversation behind it - the transcript and this shell's snapshot are still what they were, and the
      // pending record is spent if the Host answered at all (`settleFailedTurnMutation` decides that, and only
      // that) - so replacing the whole surface with a problem page would take away the field
      // the words were just put back into, and report a state fault that did not happen. The one line is the same
      // sentence that page drew, from the same place: `composedProblemView` is the owner of which words a failure
      // earns, and its `detail` is what a one-line notice has room for. The read that leaves the chat unreadable
      // is a different failure, and that path still commits the problem view.
      setSendFailure(problemView(error, messages(current.locale)).detail);
      // An answered refusal costs the record this send published; an unanswered attempt keeps it, and
      // the poll that started with the record is what decides what becomes of it.
      settleFailedTurnMutation(error);
      return;
    }
  };

  /**
   * Authoritative reread for a Chat-owned operation. The Chat draft is this
   * surface's own subject, so the durable draft is read alongside the composed
   * root and its revision must still reconcile with that root's Chat
   * projection: a revision that moved under a Chat mutation is a real conflict
   * and fails closed.
   *
   * The read also applies the settle rule the event stream and the fallback poll
   * apply: a snapshot whose turn is terminal spends the pending record. This is
   * the one read Stop performs, and when the stream is down (or silent) it is the
   * only thing that can hand the composer back - so the rule belongs here, where
   * every reread caller gets it, not in each handler.
   *
   * The streaming preview is spent only when the read no longer describes the turn
   * it belongs to. That is the state a reread always means - the authoritative
   * transcript now carries the reply - but it is not what a read taken *while* a
   * turn streams means: choosing another surface mid-reply rereads this shell too,
   * and dropping the preview there would erase the text the player was watching
   * until the stream's next delta rebuilt it from nothing. The comparison runs
   * through the updater so it reads the preview that is actually committed, never
   * the one this render closed over.
   *
   * A view that is not ready is the one other case, and it is what the problem
   * screen's step is: the shell has no session to apply the snapshot to, so this
   * same read - the mount's own - rebuilds one from what the Host publishes.
   * Nothing is carried over because there is nothing to carry: the player's place
   * on a problem screen is the problem screen, and a read that lands replaces it
   * wholesale.
   *
   * The view this read is applied to is the one that is current when the read
   * LANDS, never the one it saw when it started. A read is a round trip, and a
   * commit that lands inside it - a send's own pending record, a refusal's settle,
   * a problem view - is newer than the photograph the read took before leaving.
   * Committing that photograph erases them; the erased pending record is the one
   * that keeps the fallback poll alive (`beginTurnMutation`) and the send gate shut,
   * so the player's just-sent line leaves the screen and the composer unlocks
   * mid-turn. `recover` and `reconcile` below already read after their awaits for
   * the same reason - this is the read path that did not.
   *
   * The same photograph carries the aggregate's `game` slice, which this read has no
   * business deciding either: a Game fact that arrived inside the round trip is newer
   * than it. So the commit replaces the Chat half and keeps the Game half the landing
   * view holds (`withChatHalf`, which says why the panel never recovers on its own).
   */
  const rereadChat = async (): Promise<void> => {
    const { root, draft } = await readChatSnapshotPair(composedApiRef.current);
    const current = viewRef.current;
    if (current.kind !== "ready") {
      setPreview(null);
      commit({
        kind: "ready",
        root,
        session: createReferencePipelineSession(root.chat),
        draft,
        locale: localeRef.current,
        chatProblem: null,
      });
      return;
    }
    const runningTurn =
      root.chat.chat.turn === null || terminalTurn(root.chat.chat.turn) ? null : root.chat.chat.turn.handle;
    setPreview((existing) =>
      existing !== null && runningTurn !== null && existing.turnHandle === runningTurn ? existing : null,
    );
    const session = current.session.applySnapshot(root.chat);
    commit({
      ...current,
      root: withChatHalf(current.root, root.chat),
      // A record this surface published while the read was in flight is the surface's own fact, and
      // the reading cannot have seen the submission it names: `applySnapshot` carries it over, and
      // the read only spends it for the one state that settles it - a terminal turn.
      session: terminalTurn(root.chat.chat.turn) ? session.withPending(null) : session,
      draft,
      // This read landed, so the conversation it publishes has no problem: the card this shell was
      // carrying described the state it has just replaced.
      chatProblem: null,
    });
  };

  /**
   * The step the card can perform itself: the read it came from, taken again.
   *
   * `rereadChat` is that read - the composed root and the draft it carries, which is what the mount
   * took and every view here was committed over - so the control is a real call rather than a reload,
   * and the player's place survives either way: a read that lands replaces the screen, and one the
   * Host refuses commits its own sentence to the same card. The ref is the single-flight guard; the
   * button shows nothing while the read is outstanding, so a second state would only be a second
   * `/state`.
   *
   * The card draws its own control for exactly the failures whose `step` names it
   * (`problemDrawsOwnRead`): a refusal whose answer is something else (`turn_busy`, a
   * signed-out session, an oversized message) states its own step instead and gets no button that
   * cannot help it.
   */
  const problemRetryRef = useRef(false);
  const retryProblemView = (): void => {
    if (problemRetryRef.current) return;
    problemRetryRef.current = true;
    void rereadChat()
      .catch((error: unknown) => {
        commitChatProblem(error);
      })
      .finally(() => {
        problemRetryRef.current = false;
      });
  };

  /**
   * The composer's field follows the mounted conversation's durable draft: its
   * first authoritative revision seeds the field, and a later revision the player
   * has not typed past replaces it. An unsaved local value - whether the player is
   * writing the draft or a different message - is never silently discarded by a
   * background reread of the *same* chat; the mutation that owns it resolves it.
   *
   * A different chat is not that case. The field belongs to the mounted
   * conversation, so a switch takes the target chat's own durable draft as the
   * field's truth whatever the previous chat held - a dirty flag from the chat the
   * player just left must never keep its text standing in the new chat's box.
   */
  useEffect(() => {
    if (view.kind !== "ready") return;
    const chat = view.session.snapshot.selection?.chatHandle ?? null;
    const durable = view.draft.text ?? "";
    const seeded = seededDraftRef.current;
    if (seeded !== null && seeded.chat === chat) {
      if (seeded.revision === view.draft.revision) return;
      if (inputTextRef.current !== seeded.text) {
        seededDraftRef.current = Object.freeze({ chat, revision: view.draft.revision, text: inputTextRef.current });
        return;
      }
    }
    seededDraftRef.current = Object.freeze({ chat, revision: view.draft.revision, text: durable });
    writeInput(durable);
  }, [view]);

  /**
   * Takes the validated read-back of a save that LANDED as the composer field's new truth.
   *
   * Only a write the Host accepted earns this: the field then holds exactly what the Host kept. A
   * refused write re-reads the same draft for its revision (`handleDraftMutation`) and deliberately
   * does not call this, because the text in the field is the player's and not the Host's to replace.
   */
  const seedDraft = (draft: BrowserDraftV1): void => {
    const current = viewRef.current;
    const chat = current.kind === "ready" ? (current.session.snapshot.selection?.chatHandle ?? null) : null;
    const text = draft.text ?? "";
    seededDraftRef.current = Object.freeze({ chat, revision: draft.revision, text });
    writeInput(text);
  };

  /**
   * The one envelope both durable-draft controls run through (`draft-mutation`): the PUT/DELETE that
   * carries this mount's exact expected revision, and what a refusal of it may do to the composer.
   *
   * It is handed the shell's own seams rather than owning them - the committed view, the composer's
   * field, the three draft routes, the seeded draft, the notice and the catalogue - so neither control
   * can spell the compare-and-swap, the read-back, or the rule about what a read-back may reach, for
   * itself.
   */
  const handleDraftMutation = createDraftMutation({
    viewRef,
    inputTextRef,
    api: managementPipelineApiRef.current,
    seedDraft,
    setDraftNotice,
    commit,
    labels,
  });

  /**
   * Takes the single-flight latch and the busy projection for one message mutation, and spends the last
   * refusal with them.
   *
   * The clear belongs here because this is the seam every message-level mutation shares - the swipe, the
   * opening variant, the regenerate, the rewind, the delete, the discard and the edit - so none of them can
   * leave a sentence about a press it has already superseded on screen, for the same reason
   * `beginTurnMutation` spends a refused send's own line.
   */
  const beginMessageMutation = (kind: ChatMutationKind, handle: string): void => {
    chatMutationRef.current = true;
    setMessageMutationNotice(null);
    setChatMutation(Object.freeze({ kind, handle }));
  };

  /**
   * The one envelope every message-level mutation runs through (`message-mutation`): the guards, the
   * press's own admission, the single-flight latch, the wire call and the authoritative reread that
   * follows it. The commands below are requests to it, so none of them can spell the refusal
   * sentence, the latch release or the reread for itself.
   */
  const mutateMessage = createMessageMutation({
    viewRef,
    chatMutationRef,
    beginMessageMutation,
    rereadChat,
    commit,
    setMessageMutationNotice,
    setChatMutation,
  });

  /**
   * Swipe selection and regenerate are Chat-owned mutations the reference
   * surface offered and the composed shell did not: with the reference entry
   * gone they live here. Both take their own idempotency key and never append a
   * response locally; the authoritative reread owns what the transcript shows,
   * and a failed attempt resolves through that same reread rather than a local
   * guess.
   */
  const handleSwipe = (messageHandle: string, direction: "prev" | "next"): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "swipe",
      handle: messageHandle,
      send: ({ selectionGeneration, csrfToken }) =>
        tavernApiRef.current.selectSwipe(
          { apiVersion: 1, selectionGeneration, messageHandle, direction },
          { csrfToken },
        ),
    });

  /**
   * The new-chat opening choice. It has the same shape as swipe - single-flight, no local variant
   * held - but it records the choice through the Host's `chat.opening` route and then rereads the
   * authoritative snapshot, because the committed variant and the sealed-opening fact are the
   * Host's, never React state's.
   */
  const handleOpeningVariant = (messageHandle: string, direction: "prev" | "next"): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "opening",
      handle: messageHandle,
      send: ({ selectionGeneration, csrfToken }) =>
        managementPipelineApiRef.current.selectOpeningVariant(
          { apiVersion: 1, selectionGeneration, direction },
          csrfToken,
        ),
    });

  const handleRegenerate = async (messageHandle: string): Promise<void> => {
    // The turn is the request's subject and the request is the turn's, so they share one
    // idempotency key: the record this press publishes is the record the Host answers under it.
    const idempotencyKey = newIdempotencyKey();
    const outcome = await mutateMessage({
      kind: "regenerate",
      handle: messageHandle,
      // Regeneration starts a real turn, so it begins the way a send does: only while the profile
      // offers an available `chat.submit` (one turn at a time) and under a published pending record.
      // That record is what makes the fallback poll live: `beginTurnMutation` starts it at the
      // publication, so a regenerate whose answer never arrives is still resolved by it.
      before: (current) => {
        if (beginTurnMutation(idempotencyKey, current) === null) return false;
        // The turn-key discipline is `handleSend`'s, word for word, and it is here for the same
        // reason: this regenerate mints a NEW durable turn - it reuses message identities, never a
        // turn handle - so every mark the turn produces has to name it. Without these two lines the
        // turn's `accepted`/`first-token`/`settled` marks named no turn at all, and after a turn
        // settled by the fallback poll or a committed message rather than a terminal state event -
        // the only thing that clears `turnKeyRef` - they named the turn BEFORE this one.
        turnKeyRef.current = idempotencyKey;
        markTurn("submit", { surface: "chat", turnKey: idempotencyKey });
        return true;
      },
      send: async ({ selectionGeneration, csrfToken }) => {
        const accepted = await tavernApiRef.current.regenerate(
          { apiVersion: 1, selectionGeneration, messageHandle },
          { csrfToken, idempotencyKey },
        );
        // The same acceptance `handleSend` marks: the Host's 202 for THIS key, with the turn it started.
        markTurn("accepted", { surface: "chat", turnKey: idempotencyKey });
        return accepted;
      },
    });
    if (outcome.kind === "failed") {
      // After the envelope's own reread, so the record's fate is decided against the view that read
      // left behind: a refusal spends the record this regenerate published, and an unanswered
      // attempt keeps it for the poll that is already reading it.
      settleFailedTurnMutation(outcome.error);
    }
  };

  /**
   * The arm and its confirmation. It names the message AND, for the two acts that rewrite or drop rows,
   * the order the page rendered it at (a variant discard and a branch name just the row), and it is
   * dropped the moment that pairing stops holding, so a stale arm can never fire a command on a message
   * the player is no longer looking at. The Host re-checks the same pairing anyway: this only keeps the
   * surface honest.
   */
  const mountedTranscript = view.kind === "ready" ? (view.session.snapshot.chat?.transcript ?? null) : null;
  useEffect(() => {
    if (arm === null) return;
    const positional = arm.action === "delete" || arm.action === "from_here";
    const held = mountedTranscript?.some((message) =>
      positional
        ? message.handle === arm.targetId && message.order === arm.expectedOrder
        : message.handle === arm.targetId,
    );
    if (held === true) return;
    setArm(null);
  }, [arm, mountedTranscript]);

  const handleActFromHere = (messageHandle: string, expectedOrder: number): void => {
    // Opening the choice is a new intent, so the last refusal's sentence - about a different press - goes
    // with it.
    setMessageMutationNotice(null);
    setArm(Object.freeze({ action: "from_here", targetId: messageHandle, expectedOrder }));
  };

  const handleActCancel = (): void => {
    setArm(null);
  };

  const handleActRewind = (messageHandle: string, expectedOrder: number): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "rewind",
      handle: messageHandle,
      // The arm is spent by the press it confirmed, and only after the guards admitted that press: a
      // stale confirmation must not survive the mutation it sent.
      before: () => setArm(null),
      send: ({ selectionGeneration, csrfToken }) =>
        tavernApiRef.current.rewind(
          { apiVersion: 1, selectionGeneration, messageHandle, expectedOrder },
          { csrfToken },
        ),
    });

  const handleDeleteArm = (messageHandle: string, expectedOrder: number): void => {
    setArm(Object.freeze({ action: "delete", targetId: messageHandle, expectedOrder }));
  };

  const handleDeleteCancel = (): void => {
    setArm(null);
  };

  const handleDeleteConfirm = (messageHandle: string, expectedOrder: number): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "delete",
      handle: messageHandle,
      // The arm is spent by the press it confirmed, and only after the guards admitted that press.
      before: () => setArm(null),
      send: ({ selectionGeneration, csrfToken }) =>
        tavernApiRef.current.delete(
          { apiVersion: 1, selectionGeneration, messageHandle, expectedOrder },
          { csrfToken },
        ),
    });

  /**
   * The variant discard's arm and its confirmation, the delete arm's own shape one row over: the arm names
   * the reply and is dropped the moment the reply stops being one of the transcript's rows, so a stale arm
   * must never discard a variant of a reply the player is no longer looking at. The index travels with the
   * confirmation from the row itself, and the Host re-checks it, refusing a position that is not there
   * rather than guessing.
   */
  const handleSwipeRemoveArm = (messageHandle: string): void => {
    // Arming is a new intent, so the last refusal's sentence - about a different press - goes with it.
    setMessageMutationNotice(null);
    setArm(Object.freeze({ action: "swipe_remove", targetId: messageHandle }));
  };

  const handleSwipeRemoveCancel = (): void => {
    setArm(null);
  };

  /**
   * Discards the variant the player named and then rereads. The Host owns which variant is left showing -
   * the discarded one may be the active one, and removing it moves the position - so the new
   * `currentIndex` is READ back rather than computed here. A refusal is not silence: the Host refuses the
   * last variant by name and that sentence is what the player reads, because a disappeared button with
   * nothing said about it is exactly the state this control exists to avoid.
   */
  const handleSwipeRemoveConfirm = (messageHandle: string, targetIndex: number): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "swipeRemove",
      handle: messageHandle,
      // The arm is spent by the press it confirmed, and only after the guards admitted that press.
      before: () => setArm(null),
      send: ({ selectionGeneration, csrfToken }) =>
        tavernApiRef.current.removeSwipeVariant(
          { apiVersion: 1, selectionGeneration, messageHandle, targetIndex },
          { csrfToken },
        ),
    });

  /**
   * The edit: the player's own message carries different text from now on, in the transcript and in
   * the model's own session together. It has the same shape as the other message mutations -
   * single-flight, no local rewrite held - and it sends the order the page rendered the row at,
   * because the transcript is what a position means and the Host refuses a row that has moved. The
   * authoritative reread owns what the conversation then shows.
   */
  const handleEdit = (messageHandle: string, expectedOrder: number, text: string): Promise<MessageMutationOutcome> =>
    mutateMessage({
      kind: "edit",
      handle: messageHandle,
      send: ({ selectionGeneration, csrfToken }) =>
        tavernApiRef.current.edit(
          { apiVersion: 1, selectionGeneration, messageHandle, expectedOrder, text },
          { csrfToken },
        ),
    });

  /**
   * A rename from the Chats surface is a management mutation, and the composed
   * root owns this shell's Chat projection (its title heading included), so the
   * composed `/state` read is the authority that moves the heading. The panel
   * already shows the validated read-back; a reread that cannot reconcile leaves
   * this shell's projection as it was instead of adopting a mismatched one.
   */
  const handleRenamedTitle = (): void => {
    void rereadChat().catch(() => undefined);
  };

  /**
   * Adopts one authoritative composed read as this shell's mounted conversation.
   * The mounted identity itself is new - a committed switch released the previous
   * Chat and mounted another - so there is nothing to reconcile the session with:
   * it is rebuilt from the fresh snapshot, and the mounted-chat revision is bumped
   * so the event-stream effect re-subscribes on the new conversation's checkpoint
   * instead of continuing the previous one's cursor.
   */
  const adoptMountedChat = (root: ComposedReferenceGameBrowserRootV1, draft: BrowserDraftV1): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (cancelledRef.current || root.chat.chat === null) return;
    setPreview(null);
    // The key named a turn in the conversation this mount is leaving, and the conversation it adopts
    // is not that one's successor: its own turn, if any, was started elsewhere and has its own
    // identity. Both switch paths (`handleChatSwitched`, `handleCurrentChatRemoved`) adopt here, so
    // this is the one place the key can be forgotten for a committed switch.
    turnKeyRef.current = null;
    // The refusal's sentence described an attempt in the conversation this mount is leaving, so it
    // is not a fact about the one it adopts.
    setSendFailure(null);
    setMessageMutationNotice(null);
    const base = createReferencePipelineSession(root.chat);
    const session = root.chat.eventStream === null ? base : base.resetEventCheckpoint();
    setMountedChatRevision((revision) => revision + 1);
    commit({ ...current, root, session, draft, chatProblem: null });
  };

  /**
   * Ends the live event subscription when no mounted conversation remains to
   * stream: a cursor must never keep reading a thread the active list dropped.
   */
  const closeLiveStream = (): void => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    streamLiveRef.current = false;
  };

  /**
   * Follows a committed Chat switch. The Host has already released the previous
   * mounted Chat and mounted the selected one, so the mounted identity itself is
   * new: this shell rebuilds its session from the fresh snapshot (there is nothing
   * to reconcile it with) and restarts the live cursor on the new conversation.
   *
   * Choosing a conversation is a focus transfer (ADR-0010 Class A): the chosen
   * conversation is what the player is looking at next, so the read that adopts
   * the new mount also moves the region to it. The move is the same surface
   * selection the app bar's Chat entry makes, history entry included, so Browser
   * Back returns to the Chats list rather than leaving it replaced. A failed
   * read never moves the region: it commits the shell's problem view instead.
   *
   * A creation's own opening is committed here, before the player is shown the new
   * conversation, and only here: `chat.opening` addresses the MOUNTED Chat under
   * the selection generation of that mount (a settled switch mints a fresh one),
   * and this read is the only place that generation is known. A refused commit
   * leaves the Chat durable on the opening it was created with - the player still
   * lands in it, and the line the surface shows names exactly what did not happen.
   */
  const handleChatSwitched = (openingTargetIndex?: number): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    void (async () => {
      try {
        setOpeningNotice(null);
        let root = await composedApiRef.current.readState();
        if (openingTargetIndex !== undefined) root = await commitChosenOpening(root, openingTargetIndex);
        const pair = await readChatSnapshotPair(composedApiRef.current, root);
        adoptMountedChat(pair.root, pair.draft);
        openPanelOf(CHAT_PANEL, chatEntryRef)();
      } catch (error) {
        commitChatProblem(error);
      }
    })();
  };

  /**
   * The idempotency key of the fork attempt whose outcome is not known yet, and the row it names.
   *
   * A fork MINTS a durable Chat, and the Host derives that Chat's identity from this key: the same key
   * always names the same branch, which is what makes a retried attempt land on the branch it already
   * created instead of a second identical one. So the key's lifetime is the attempt's, not the press's:
   * it is minted once, kept while no answer has come back (a dropped connection, a Host that failed
   * without naming a refusal), and spent the moment the attempt is answered - by the branch existing, or
   * by a refusal that says nothing ran. A new press after either gets a new key, because it is a new
   * attempt at a branch that does not exist yet.
   */
  const forkAttemptRef = useRef<Readonly<{ messageHandle: string; key: string }> | null>(null);

  /**
   * The branch's key, minted per attempt rather than per press: the held one is reused while the attempt
   * that minted it has no answer, and a press naming a different row starts its own.
   */
  const forkKeyFor = (messageHandle: string): string => {
    const held = forkAttemptRef.current;
    if (held !== null && held.messageHandle === messageHandle) return held.key;
    const minted = newIdempotencyKey();
    forkAttemptRef.current = Object.freeze({ messageHandle, key: minted });
    return minted;
  };

  /**
   * Moves this window onto a branch that is already durable.
   *
   * The fork and the switch are two operations on purpose (`chat.fork` does not select what it mints),
   * and that separation is what lets a failed switch leave the player a branch they can still see and
   * open from Chats. It is therefore NOT reported as a failed fork: the branch exists, so the sentence
   * states the one thing that did not happen and where the branch is.
   */
  const switchToForkedChat = async (forkedHandle: string): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    try {
      await managementPipelineApiRef.current.selectChat(
        { apiVersion: 1, selectionGeneration: selection.generation, chatHandle: forkedHandle },
        current.session.snapshot.csrfToken,
      );
    } catch (error) {
      setMessageMutationNotice(declaredProblemSentence(error, labels()) ?? labels().chatForkSwitchFailed);
      return;
    }
    // The switch mounted another conversation: the shell adopts it, restarts its live cursor on it and
    // moves the player to it, exactly as choosing a row of the Chats list does (ADR-0010 Class A).
    handleChatSwitched();
  };

  /**
   * Branches the mounted conversation at the message the choice named, then moves to the branch.
   *
   * The press runs through the same envelope as every other message mutation (single flight, named
   * refusal said first, authoritative reread after), so a refused fork cannot leave the player looking at
   * a surface that silently did nothing. What the envelope's reread reads is still the ORIGIN - the Host
   * does not select what it mints - so the switch above is what changes the conversation on screen.
   */
  const handleActFork = async (messageHandle: string): Promise<MessageMutationOutcome> => {
    const idempotencyKey = forkKeyFor(messageHandle);
    let forkedHandle: string | null = null;
    const outcome = await mutateMessage({
      kind: "fork",
      handle: messageHandle,
      // The arm is spent by the press it confirmed, and only after the guards admitted that press.
      before: () => setArm(null),
      send: async ({ selectionGeneration, csrfToken }) => {
        try {
          const result = await managementPipelineApiRef.current.forkChat(
            { apiVersion: 1, selectionGeneration, messageHandle },
            { csrfToken, idempotencyKey },
          );
          forkedHandle = result.chat.handle;
          // Answered: the branch exists, so this key has done its work.
          forkAttemptRef.current = null;
        } catch (error) {
          // A named refusal is the Host stating it did not run the fork, so the attempt is answered and
          // the next press is a new one. An answer the Host could not give keeps the key, and the press
          // after it replays the attempt that may already have minted a branch.
          if (declaredProblemSentence(error, labels()) !== null) forkAttemptRef.current = null;
          throw error;
        }
      },
    });
    if (forkedHandle !== null) await switchToForkedChat(forkedHandle);
    return outcome;
  };

  /**
   * Records the opening a creation asked for on the Chat the switch just mounted, and reads the
   * conversation back so the shell adopts one snapshot carrying it. A refused commit is not a
   * failed creation: the Chat is durable on the opening it already has, so the read is returned
   * unchanged and the one fact that did not happen is named on the conversation itself.
   */
  const commitChosenOpening = async (
    root: ComposedReferenceGameBrowserRootV1,
    openingTargetIndex: number,
  ): Promise<ComposedReferenceGameBrowserRootV1> => {
    const selection = root.chat.selection;
    if (selection === null) {
      setOpeningNotice(labels().chatCreatedWithDefaultOpening);
      return root;
    }
    try {
      await managementPipelineApiRef.current.selectOpeningVariant(
        { apiVersion: 1, selectionGeneration: selection.generation, targetIndex: openingTargetIndex },
        root.chat.csrfToken,
      );
      return await composedApiRef.current.readState();
    } catch {
      setOpeningNotice(labels().chatCreatedWithDefaultOpening);
      return root;
    }
  };

  /**
   * The mounted conversation's own retention transition removed it and the active list
   * still holds another Chat. The shell owns the selection, so it moves the mount off the
   * dead thread rather than leaving the live cursor on a Chat the list no longer holds: it
   * switches to the next available Chat through the same `chat.select` route the Chats
   * surface offers and adopts the authoritative read, which restarts the cursor on the
   * survivor.
   *
   * The emptied list does not reach here: the Chats panel's removal seam applies the
   * owner's rule and creates a Chat through its own New Chat path before it reports, so
   * the shell is never asked to move to a Chat that does not exist. What remains is the
   * residual case where this shell's own list read disagrees with that decision: there is
   * no survivor to select, so the authority is read instead of the shell stopping. Stopping
   * at that point left the removed conversation mounted with its live stream closed - a
   * conversation the active list no longer held, that could not be written to, and with
   * nothing saying either.
   */
  const handleCurrentChatRemoved = (removedHandle: string): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    const csrfToken = current.session.snapshot.csrfToken;
    void (async () => {
      try {
        const list = await managementPipelineApiRef.current.listChats();
        const next = list.chats.find((chat) => chat.handle !== removedHandle) ?? null;
        if (next === null) {
          // No survivor to switch to, and the removed Chat is gone from the list: the
          // authority is what this shell shows, so it is read again rather than the dead
          // thread being kept with its cursor shut. The read adopts whatever conversation
          // the Host really holds, and a Host that holds none answers with no Chat half -
          // which `readChatSnapshotPair` refuses into the problem view and its Retry.
          closeLiveStream();
          const pair = await readChatSnapshotPair(composedApiRef.current);
          adoptMountedChat(pair.root, pair.draft);
          return;
        }
        await managementPipelineApiRef.current.selectChat(
          { apiVersion: 1, selectionGeneration: selection.generation, chatHandle: next.handle },
          csrfToken,
        );
        const pair = await readChatSnapshotPair(composedApiRef.current);
        if (pair.root.chat.selection?.chatHandle === removedHandle) {
          // The runtime could not leave the archived Chat, so nothing may keep
          // reading its stream.
          closeLiveStream();
          return;
        }
        adoptMountedChat(pair.root, pair.draft);
      } catch (error) {
        commitChatProblem(error);
      }
    })();
  };

  /**
   * The World Info revision this surface shows: the composed root's own Chat half.
   *
   * The shell projects it from the same World Info read that answers `GET
   * /world-info`, so the state, the revision and the items beside it come from one
   * read and can never describe two different moments. `null` therefore means
   * exactly one thing - this mount declares no `world-info.read` - and never "the
   * items happened to be missing".
   *
   * The generation a bind CASes on is decided HERE, from the same read, and never
   * from the view alone: the root that answers the revision also states which
   * selection it belongs to, so a Chat switched elsewhere is a refused pair rather
   * than a new revision under the old generation (see `worldInfoBindingSource`).
   */
  const readProductWorldInfo = useCallback(async (): Promise<WorldInfoBindingSource> => {
    const current = viewRef.current;
    const mounted = current.kind === "ready" ? (current.session.snapshot.selection?.generation ?? null) : null;
    const root = await composedApiRef.current.readState();
    return worldInfoBindingSource(root, mounted);
  }, []);

  /**
   * Adopts a language the Host has already confirmed.
   *
   * The interface language is the Host's choice (its `player-preference` record, written through
   * `/api/tavern/v1/settings/ui-language`), so nothing reaches this function until the store answered
   * with the value it now holds: this repaints the page in THAT language, rewrites the first-paint
   * cache from it, and remembers it for the next mount. The cache is a cache - the choice outliving a
   * launch is the Host record's doing, not this browser's.
   */
  const adoptUiLocale = (locale: Locale): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    localeRef.current = locale;
    persistLocale(locale);
    applyDocumentLocale(locale);
    commit({ ...current, locale });
  };

  const handleStop = async (): Promise<void> => {
    const current = viewRef.current;
    const turn = current.kind === "ready" ? current.session.snapshot.chat?.turn : null;
    const operation =
      current.kind === "ready"
        ? current.session.snapshot.operations.find((op) => op.operationId === "chat.cancel")
        : undefined;
    if (current.kind !== "ready" || turn == null || operation?.availability !== "available" || !turn.canCancel) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    try {
      await tavernApiRef.current.cancel(
        turn.handle,
        { apiVersion: 1, selectionGeneration: selection.generation },
        current.session.snapshot.csrfToken,
      );
      await rereadChat();
    } catch (error) {
      // Said out loud before the reread, the same rule every message mutation follows: the reread
      // restores the turn the Host still holds, so without this line the Stop press reverts and the
      // turn the player tried to end keeps running with nothing explaining it.
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      try {
        await rereadChat();
      } catch {
        commitChatProblem(error);
      }
    }
  };

  const managementPanelsAvailable = view.kind === "ready" && view.session.snapshot.chat !== null;

  /**
   * The mounted turn as the shell has committed it: which turn, and where it is.
   *
   * A surface whose rows the Host writes as a turn completes needs to know when that
   * happened, and the shell is the one place that knows - the same committed projection the
   * conversation reads. It carries no rows and no turn body; the panel reads only the pair
   * whose change is the event (see `MemorySurfacePanel`). It is the snapshot's own frozen
   * turn, so its identity moves exactly when the committed turn does.
   */
  const mountedTurn = view.kind === "ready" ? (view.session.snapshot.chat?.turn ?? null) : null;

  const arrivalReads = useArrivalReread(shownSurface, bootstrap, localeRef, rereadChat, managementPipelineApiRef);

  /**
   * The Chat surface's one state, derived from the facts above (`chat-ui-state`).
   *
   * The three facts it takes from the view - whether the Host would take a submission now, whether
   * the mounted turn is still the player's to stop, and which optimistic line still belongs to a
   * live submission - are answered by `composed-chat-shell-state`, so the phase and the send gate
   * move together instead of from three locals that could disagree.
   */
  const chatUIState = deriveChatUIState({
    submissionInFlight: view.kind === "ready" && view.session.pending !== null,
    turn: liveTurn(view),
    pendingLine: pendingOptimisticMessage(view, optimistic),
    stopAvailable: stopAvailable(view),
    submitAvailable: submitAvailable(view),
    messageMutationInFlight: chatMutation !== null,
    modelRoute: arrivalReads.chatModelRoute,
    armed: arm,
  });

  // Whether a turn is in flight: from the moment a submission is admitted until the authoritative
  // turn reaches a terminal state. It is the bar's first word (`statusLabel` below) and the
  // conversation's own reading of whether the last line may still be answered. The Game connection
  // has its own drawer (design/26 §4.1, design/104 §2); it is not announced from here.
  const turnInFlight = isTurnInFlight(chatUIState);

  // The bar's word and its dot are one derivation of the same fact (`appBarStatus`), so a narrow
  // bar that hides the label cannot glow a tone the word contradicts.
  const status = appBarStatus(turnInFlight, arrivalReads.chatModelRoute, labels());
  // The bar's second fact, from the game projection the Game surface is handed: the model's word
  // above says whether a reply can reach a model, and this one says whether the game is there.
  const gameStatus =
    view.kind === "ready" && view.root.game !== null
      ? appBarGameStatus(view.root.game.game.connectionStatus, labels())
      : undefined;

  const openGamePanel = openPanelOf(GAME_PANEL, gameEntryRef);
  const openChat = openPanelOf(CHAT_PANEL, chatEntryRef);
  const openChats = openPanelOf(CHATS_PANEL, chatsEntryRef);
  const openCharacters = openPanelOf(CHARACTERS_PANEL, charactersEntryRef);
  const openSettings = openPanelOf(SETTINGS_PANEL, settingsEntryRef);
  const openPresets = openPanelOf(PRESETS_PANEL, presetsOpenRef);
  const openMemory = openPanelOf(MEMORY_PANEL, memoryEntryRef);
  // Each peer surface's opener, with the button a closed drawer restores focus to. Keyed by the
  // bar table's own ids, so a surface the bar lists without an opener is a type error
  // (`surface-bar-entries`).
  const entryOpeners = {
    [CHAT_PANEL]: { open: openChat, ref: chatEntryRef },
    [GAME_PANEL]: { open: openGamePanel, ref: gameEntryRef },
    [CHATS_PANEL]: { open: openChats, ref: chatsEntryRef },
    [CHARACTERS_PANEL]: { open: openCharacters, ref: charactersEntryRef },
    [SETTINGS_PANEL]: { open: openSettings, ref: settingsEntryRef },
    [MEMORY_PANEL]: { open: openMemory, ref: memoryEntryRef },
  };

  // The step's sentence and the card's own control are one decision, so they are read once and cannot
  // disagree: a card drawing both would name two different steps for the same refusal.
  //
  // Two cards, because there are two failures. `view.kind === "problem"` is the shell's own: the
  // mount never got a session, so the card is the page. `view.chatProblem` is the conversation's,
  // drawn INSIDE the Chat region while every other surface - the Game surface above all - keeps its
  // place (`commitChatProblem` says why).
  const problemCard = view.kind === "problem" ? problemStepPresentation(view.step, labels()) : null;
  const chatProblem = view.kind === "ready" ? view.chatProblem : null;
  const chatProblemCard = chatProblem === null ? null : problemStepPresentation(chatProblem.step, labels());

  return (
    // One draft store for every surface: the shell is the only thing that outlives them.
    <SurfaceDrafts>
      <div className="tavern-app-shell" data-profile="composed-reference-game">
        <SkipLink label={labels().skipToChat} />
        {view.kind === "loading" && (
          <main id="main-content" className="app-main-content" tabIndex={-1}>
            <div className="state-placeholder">
              <p className="loading-text">{labels().openingChat}</p>
            </div>
          </main>
        )}
        {view.kind === "problem" && problemCard !== null && (
          // The shell never got a session: this card IS the page, and it claims the main region.
          <ProblemView
            title={view.title}
            detail={view.detail}
            stepLine={problemCard.stepLine}
            action={problemCard.drawsOwnRead ? { label: labels().problemRetryRead, run: retryProblemView } : null}
          />
        )}
        {view.kind === "ready" && view.session.snapshot.chat !== null && (
          <>
            <AppBar
              brandMark={labels().appMark}
              brandLabel={labels().appName}
              companionName={view.session.snapshot.chat.companion.name}
              companionHandle={view.session.snapshot.chat.companion.handle}
              companionDigest={avatarDigests[view.session.snapshot.chat.companion.handle]}
              statusLabel={status.label}
              statusTone={status.tone}
              {...(gameStatus === undefined ? {} : { gameStatus })}
              entries={surfaceBarEntries(labels(), shownSurface, managementPanelsAvailable, entryOpeners)}
              fold={{ from: LEADING_SURFACE_COUNT, label: labels().appBarMore }}
            />
            <main id="main-content" className="app-main-content" tabIndex={-1}>
              {/* Every surface is a peer: it takes this region in full, none of them
                covers another, and the conversation is simply the default one
                (design/104 §2). The URL names the selected surface, so Back
                returns to the previous one and a reload restores it. */}
              {shownSurface === CHAT_PANEL && chatProblem !== null && chatProblemCard !== null && (
                // The conversation's own failure, drawn where the conversation is drawn. Two existing
                // classes and no new rule: `.state-placeholder` is the region's centred container (the
                // loading state uses it) and `.problem-card` is the card's. `.problem-view` is NOT
                // reused here - it is the whole-window card (`height: 100dvh`, `id="main-content"`).
                <div className="state-placeholder" data-testid="chat-problem">
                  <ProblemView
                    region="chat"
                    title={chatProblem.title}
                    detail={chatProblem.detail}
                    stepLine={chatProblemCard.stepLine}
                    action={
                      chatProblemCard.drawsOwnRead ? { label: labels().problemRetryRead, run: retryProblemView } : null
                    }
                  />
                </div>
              )}
              {/* The conversation is the one surface that stays mounted while another one is
                  selected, and it does so for the transcript's own sake: `Timeline` is a live scroll
                  box whose mount effect follows the newest content, so remounting it is a reader put
                  back at the tail. This slot keeps the surface mounted and laid out while it is
                  parked (`.surface-slot-parked` takes it out of the flow and hides it with
                  `visibility`, never `display: none` - that would take the box away, and with it both
                  the offset the browser holds and the follow rule: measured, see
                  `timeline-position-survives-a-surface-switch.spec.ts`). `visibility: hidden` is also
                  what keeps the parked surface out of the accessibility tree, so the conversation's
                  one announcement region says nothing while it is parked. Nothing else may join this
                  slot: one conversation is one transcript and one announcement channel, and every
                  other peer keeps what it has by unmounting because it has no live scroll box to
                  lose. */}
              {chatProblem === null && (
                <div className={shownSurface === CHAT_PANEL ? "surface-slot" : "surface-slot surface-slot-parked"}>
                  <ChatSurface
                    transcript={view.session.snapshot.chat.transcript}
                    preview={preview}
                    companionName={view.session.snapshot.chat.companion.name}
                    companionHandle={view.session.snapshot.chat.companion.handle}
                    companionDigest={avatarDigests[view.session.snapshot.chat.companion.handle]}
                    chatTitle={view.session.snapshot.chat.title}
                    labels={labels()}
                    pending={chatMutation}
                    uiState={chatUIState}
                    notice={
                      pollFailure !== null
                        ? labels().chatRequestUnconfirmed
                        : (streamNotice ??
                          sendFailure ??
                          messageMutationNotice ??
                          terminalTurnNotice(view, labels()) ??
                          openingNotice)
                    }
                    arrivalNotice={arrivalReads.chatArrivalNotice}
                    replyTruncated={view.session.snapshot.chat.turn?.truncated === true}
                    onSwipe={(messageHandle, direction) => void handleSwipe(messageHandle, direction)}
                    onSwipeRemove={handleSwipeRemoveArm}
                    onSwipeRemoveConfirm={(messageHandle, targetIndex) =>
                      void handleSwipeRemoveConfirm(messageHandle, targetIndex)
                    }
                    onSwipeRemoveCancel={handleSwipeRemoveCancel}
                    onRegenerate={(messageHandle) => void handleRegenerate(messageHandle)}
                    onOpeningVariant={(messageHandle, direction) => void handleOpeningVariant(messageHandle, direction)}
                    onActFromHere={handleActFromHere}
                    onActRewind={(messageHandle, expectedOrder) => void handleActRewind(messageHandle, expectedOrder)}
                    onActFork={(messageHandle) => void handleActFork(messageHandle)}
                    onActCancel={handleActCancel}
                    onEdit={(messageHandle, expectedOrder, text) => void handleEdit(messageHandle, expectedOrder, text)}
                    onDelete={handleDeleteArm}
                    onDeleteConfirm={(messageHandle, expectedOrder) =>
                      void handleDeleteConfirm(messageHandle, expectedOrder)
                    }
                    onDeleteCancel={handleDeleteCancel}
                    value={inputText}
                    onChange={writeInput}
                    onSend={() => void handleSend()}
                    onStop={() => void handleStop()}
                    onOpenSettings={openSettings}
                    voice={view.session.snapshot.voice}
                    settingsAction={{
                      label: labels().chatModelSettings,
                      expanded: modelPopoutOpen,
                      onClick: () => setModelPopoutOpen(true),
                      ref: modelPopoutEntryRef,
                    }}
                    composerFieldRef={composerFieldRef}
                    restoreFocusTo={chatEntryRef}
                    draftActions={{
                      onSave: () => void handleDraftMutation("save"),
                      onDiscard: () => void handleDraftMutation("discard"),
                      // The row's own visibility is the composer's: it shows while a
                      // durable draft exists, while there is fresh text to keep as
                      // a first draft, or while a failed attempt has nothing else to
                      // report it. `durable` is what keeps Discard (and the "saved"
                      // wording) honest - the first draft is saved through this
                      // same command, under the same revision CAS.
                      durable: view.draft.text !== null,
                      notice: draftNotice,
                    }}
                  />
                </div>
              )}
              <GameSurface
                selected={shownSurface === GAME_PANEL}
                ready={view.kind === "ready"}
                game={view.root.game}
                csrfToken={view.session.snapshot.csrfToken}
                labels={labels()}
                readView={() => viewRef.current}
                commit={commit}
                isCancelled={() => cancelledRef.current}
                composedApi={composedApiRef.current}
                managementApi={managementPipelineApiRef.current}
                arrivalNotice={arrivalReads.gameArrivalNotice}
                restoreFocusTo={gameEntryRef}
              />
              {shownSurface === CHATS_PANEL && (
                <ChatsSurface
                  api={managementPipelineApiRef.current}
                  csrfToken={view.session.snapshot.csrfToken}
                  labels={labels()}
                  selectionGeneration={view.session.snapshot.selection?.generation ?? 0}
                  currentChatHandle={view.session.snapshot.selection?.chatHandle ?? ""}
                  onRenamedTitle={handleRenamedTitle}
                  onChatSwitched={handleChatSwitched}
                  onMountedChatChosen={openChat}
                  onCurrentChatRemoved={handleCurrentChatRemoved}
                  restoreFocusTo={chatsEntryRef}
                />
              )}
              {shownSurface === CHARACTERS_PANEL && (
                <CharactersSurface
                  api={managementPipelineApiRef.current}
                  csrfToken={view.session.snapshot.csrfToken}
                  labels={labels()}
                  locale={view.locale}
                  read={readProductWorldInfo}
                  avatarDigests={avatarDigests}
                  onAvatarUpdated={handleAvatarUpdated}
                  restoreFocusTo={charactersEntryRef}
                />
              )}
              {shownSurface === SETTINGS_PANEL && (
                <SettingsSurface
                  api={managementPipelineApiRef.current}
                  csrfToken={view.session.snapshot.csrfToken}
                  labels={labels()}
                  uiLocale={view.locale}
                  onSelectUiLocale={adoptUiLocale}
                  onSelectAppearance={appearance.choose}
                  presets={{ open: openPresets, ref: presetsOpenRef }}
                  restoreFocusTo={settingsEntryRef}
                />
              )}
              {shownSurface === MEMORY_PANEL && (
                <MemorySurface
                  api={managementPipelineApiRef.current}
                  csrfToken={view.session.snapshot.csrfToken}
                  labels={labels()}
                  locale={view.locale}
                  conversationTurn={mountedTurn}
                  restoreFocusTo={memoryEntryRef}
                />
              )}
              {shownSurface === PRESETS_PANEL && (
                <PresetAssemblySurface
                  labels={labels()}
                  onBack={() => leaveSurface(PRESETS_PANEL)}
                  restoreFocusTo={presetsOpenRef}
                />
              )}
            </main>
            {/* This surface's own model settings, over the conversation rather than
              in it (design/104 §3: Chat owns its model choice and the Host stores
              it under the chat half of settings/profiles). The popout is not a
              peer surface: it replaces no region, Escape or the backdrop closes
              it, and focus returns to the composer's own button. */}
            {modelPopoutOpen && (
              <ContextDrawer
                title={labels().chatModelSettings}
                closeLabel={labels().close}
                onClose={() => setModelPopoutOpen(false)}
                restoreFocusTo={modelPopoutEntryRef}
                testId="chat-model-drawer"
                icon={SlidersHorizontal}
              >
                <SurfaceModelSettings
                  surface="chat"
                  api={managementPipelineApiRef.current}
                  csrfToken={view.session.snapshot.csrfToken}
                  labels={labels()}
                />
              </ContextDrawer>
            )}
          </>
        )}
      </div>
    </SurfaceDrafts>
  );
}
