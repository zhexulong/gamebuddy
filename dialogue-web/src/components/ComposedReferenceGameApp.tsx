import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readChatSnapshotPair } from "../chat-snapshot-pair";
import {
  declaredProblemSentence,
  composedProblemView as problemView,
  problemDrawsOwnRead,
  problemStepLine,
} from "../composed-problem-view";
import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "../composed-reference-game-browser-api";
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
import type { BrowserDraftV1, BrowserEventV1 } from "../reference-pipeline-api";
import { TavernProblemError, TavernProtocolError } from "../reference-pipeline-api";
import {
  createReferencePipelineSession,
  type PendingSubmission,
  pendingSubmission,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import { type WorldInfoBindingSource, worldInfoBindingSource } from "../world-info-binding-source";
import { createSerialDrain, type SerialDrain } from "../serial-drain";
import { AppBar } from "./AppBar";
import { CharactersSurface } from "./CharactersSurface";
import { type ChatArmedAction, deriveChatUIState, isTurnInFlight } from "./chat-ui-state";
import { ChatSurface } from "./ChatSurface";
import { ChatsSurface } from "./ChatsSurface";
import {
  appBarStatus,
  liveTurn,
  type OptimisticSend,
  pendingOptimisticMessage,
  stopAvailable,
  submitAvailable,
  terminalTurnNotice,
} from "./composed-chat-shell-state";
import { ContextDrawer } from "./ContextDrawer";
import { newIdempotencyKey, type ReadyView } from "./composed-reference-game-view";
import { GameSurface } from "./GameSurface";
import { MemorySurface } from "./MemorySurface";
import { createManagementPipelineApi } from "./management-surface-panels";
import { ProblemView } from "./ProblemView";
import { PresetAssemblySurface } from "./PresetAssemblySurface";
import { SettingsSurface } from "./SettingsSurface";
import { SkipLink } from "./SkipLink";
import { LEADING_SURFACE_COUNT, surfaceBarEntries } from "./surface-bar-entries";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { SurfaceDrafts } from "./surface-drafts";
import { markTurn, observeTurnEvent } from "./turn-timings";
import { useArrivalReread } from "./use-arrival-reread";
import { useAppearance } from "./use-appearance";
import { type ComposedPreviewV1, terminalTurn, useComposedBootstrap } from "./use-composed-bootstrap";

/** The recovery read's first retry delay, and the ceiling its doubling stops at. */
const RETRY_FIRST_MS = 1_000;
const RETRY_CEILING_MS = 5_000;

/** Every message-level mutation this surface can have in flight, and show as busy on its own row. */
type ChatMutationKind = "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete";

/**
 * True when a failed read says something about the conversation rather than about the link.
 *
 * The same four classes the bootstrap's fallback poll treats as terminal (`use-composed-bootstrap`,
 * the catch inside its poll tick): a reducer rejection, a protocol fault, or a Host refusal the Host
 * itself says is not retryable. Those are what the problem page is for - a state that cannot be
 * reconciled, a build that does not speak this contract, a command that will be refused the same way
 * again. Everything else - an offline read, a 5xx, a retryable refusal - is a link that comes back,
 * and replacing the whole shell for one of those is what ended reconnection for a session.
 *
 * The list is spelled twice because the poll that owns the other copy is in another module; a shared
 * predicate is where this belongs the next time that module is opened.
 */
function terminalReadFailure(error: unknown): boolean {
  // A fetch that never landed arrives as a protocol error, and it is the most transient failure there
  // is - the client's own `network_error` reason names the link, not the contract.
  if (error instanceof ComposedReferenceGameProtocolError && error.reason === "network_error") return false;
  return (
    error instanceof ReferencePipelineSessionError ||
    error instanceof TavernProtocolError ||
    (error instanceof TavernProblemError && !error.retryable) ||
    error instanceof ComposedReferenceGameProtocolError ||
    (error instanceof ComposedReferenceGameProblemError && !error.retryable)
  );
}

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
  const [draftNotice, setDraftNotice] = useState<Readonly<{ kind: "success" | "failure"; text: string }> | null>(null);
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
   * The live cursor's reconnect read that could not be taken, in the surface's own sync sentence.
   *
   * A stream that dies and a read that fails in the same breath is one transient outage, and the
   * projection on screen is still the last one the Host confirmed - so the shell keeps it and says
   * which read it could not make, the same rule the arrival read follows (`use-arrival-reread.ts`).
   * Spent by the recovery read that lands; a failure the Host describes as terminal never sets it,
   * because that class replaces the surface with its problem view instead.
   */
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
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
  const presetsEntryRef = useRef<HTMLButtonElement>(null);
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

  const { shownSurface, openPanelOf } = useSurfaceRoute({ returnFocusTo: composerFieldRef });

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

  const eventStreamEpoch =
    view.kind === "ready" ? `${view.session.snapshot.eventStream?.epoch ?? ""}#${mountedChatRevision}` : undefined;

  useEffect(() => {
    if (view.kind !== "ready" || view.session.snapshot.eventStream === null) return;
    let disposed = false;
    let recovering = false;
    // The frame queue (`../serial-drain`): one slot, in order, and a link that rejects does not stop the
    // drain. A bare `work = work.then(...)` chain stops at its first rejection while the socket stays open
    // and `streamLiveRef` stays true - a stream that looks live and delivers nothing, with the fallback
    // poll suspended because the stream looks live.
    let drain: SerialDrain | null = null;
    let cursor = view.session.snapshot.eventStream.cursor;
    let pendingResetCursor = false;
    // The recovery read's own retry: one timer and the attempt count that shapes its delay.
    let retryTimer: number | null = null;
    let retries = 0;
    // A new epoch or Chat starts from no stated failure: the sentence below describes a read this
    // cursor could not take, and this is a different cursor.
    setStreamNotice(null);
    // The stream's own position, advanced by every frame this effect validates. A
    // frame is validated against the position the frame before it left, and the
    // reads below no longer commit between frames - so the checkpoint is carried
    // here instead, and a burst that all arrives during one read still catches a
    // gap. An epoch or Chat switch rebuilds this effect, so it cannot go stale.
    let checkpoint = view.session;

    const closeSource = (): void => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      streamLiveRef.current = false;
    };
    const recover = async (resetCursor = false): Promise<void> => {
      if (resetCursor) pendingResetCursor = true;
      if (disposed || recovering) return;
      recovering = true;
      closeSource();
      let retry = false;
      try {
        const doReset = pendingResetCursor;
        pendingResetCursor = false;
        const pair = await readChatSnapshotPair(composedApiRef.current);
        const root = pair.root;
        const draft = pair.draft;
        if (disposed) return;
        const current = viewRef.current;
        if (current.kind !== "ready" || root.chat.chat === null) return;
        const epochChanged = root.chat.eventStream?.epoch !== current.session.snapshot.eventStream?.epoch;
        let session: ReturnType<typeof createReferencePipelineSession>;
        let rebuilt = false;
        try {
          session = checkpoint.applySnapshot(root.chat);
        } catch (error) {
          // A committed Chat switch replaces the mounted identity itself: the new
          // snapshot cannot be reconciled with the old session, so the session is
          // rebuilt from it instead of failing the whole surface.
          if (!(error instanceof ReferencePipelineSessionError) || error.code !== "state_reconciliation_required")
            throw error;
          session = createReferencePipelineSession(root.chat);
          rebuilt = true;
        }
        if (doReset || epochChanged || rebuilt) {
          if (root.chat.eventStream === null) throw new ReferencePipelineSessionError("stream_resync_required");
          cursor = root.chat.eventStream.cursor;
          session = session.resetEventCheckpoint();
        }
        setPreview(null);
        // The stream handler's own settle rule: an authoritative read that sees a
        // terminal turn spends the pending submission record. A stream that keeps
        // failing reconnects and re-suspends the poll within milliseconds of each
        // failure, so the recovery read - not a poll hop - is what has to unlock
        // the composer in that state.
        // The checkpoint carries the stream position only: the pending record is
        // the committed session's, which a turn-starting mutation publishes outside
        // this effect.
        const settled = terminalTurn(root.chat.chat.turn)
          ? session.withPending(null)
          : session.withPending(current.session.pending);
        checkpoint = settled;
        commit({ kind: "ready", root, session: settled, draft, locale: current.locale });
        setStreamNotice(null);
        retries = 0;
      } catch (error) {
        if (disposed) return;
        if (terminalReadFailure(error)) {
          commit(problemView(error, messages(localeRef.current)));
          return;
        }
        // The projection stands. A refresh that failed is not a conversation that stopped existing
        // - the rule the arrival read follows - and the shell says which read it could not take
        // instead of unmounting the surface that was about to reconnect.
        setStreamNotice(messages(localeRef.current).chatArrivalNotice);
        retry = true;
      } finally {
        recovering = false;
        if (retry) scheduleRecovery();
        else if (pendingResetCursor && !disposed) void recover(true);
        else if (!disposed && viewRef.current.kind === "ready") connect();
      }
    };
    /**
     * The next attempt after a recovery read the link refused.
     *
     * The backoff is the fallback poll's own shape: one second doubling to a five-second ceiling,
     * because a Host that is down is not made alive by hammering it and a link that dropped does
     * come back. The timer belongs to this effect, so an epoch switch, a Chat switch or an unmount
     * disposes it with the socket, and one attempt is ever outstanding.
     */
    const scheduleRecovery = (): void => {
      if (disposed || retryTimer !== null) return;
      const delay = Math.min(RETRY_FIRST_MS * 2 ** retries, RETRY_CEILING_MS);
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void recover(true);
      }, delay);
    };
    /**
     * The authoritative half of a committed frame, coalesced to one pass at a time.
     *
     * Confirming a committed message or a turn transition costs `/state` and then
     * the draft read that cross-checks it. Paid once per frame, a burst queued the
     * reads faster than they resolved, so the authoritative state lagged the stream
     * it was meant to confirm. A frame arriving while a pass is reading only marks
     * that pass pending; the in-flight pass then runs exactly one more read, and
     * clears the mark *before* it starts, so a frame that arrives during that read
     * is pending too. The last frame therefore always gets a read issued after it
     * arrived: coalescing can never become a lost update.
     */
    let reconciling = false;
    let pendingReconcile = false;
    const reconcile = async (): Promise<void> => {
      if (reconciling) {
        pendingReconcile = true;
        return;
      }
      reconciling = true;
      try {
        do {
          pendingReconcile = false;
          if (disposed || recovering) return;
          const current = viewRef.current;
          if (current.kind !== "ready") return;
          try {
            const { root, draft } = await readChatSnapshotPair(composedApiRef.current);
            const latest = viewRef.current;
            // A recovery that started under these reads is reading the same
            // authority with a cursor of its own; its answer supersedes this one.
            if (disposed || recovering || latest.kind !== "ready" || root.chat.chat === null) return;
            const session = checkpoint.applySnapshot(root.chat);
            setPreview(null);
            // The authoritative turn is settled, so a pending record for it is spent
            // - the same rule the fallback poll applies to the turns it settles. The
            // stream is the live channel and the poll is suspended underneath it, so
            // without this the record - and with it the composer - would survive the
            // very settle the stream just delivered.
            const settled = terminalTurn(root.chat.chat.turn)
              ? session.withPending(null)
              : session.withPending(latest.session.pending);
            checkpoint = settled;
            commit({ kind: "ready", root, session: settled, draft, locale: latest.locale });
          } catch {
            await recover(true);
            return;
          }
        } while (pendingReconcile && !disposed);
      } finally {
        reconciling = false;
      }
    };
    const handleEvent = (event: BrowserEventV1, lastEventId: string): void => {
      drain?.push(async () => {
        if (disposed || recovering) return;
        try {
          const current = viewRef.current;
          if (current.kind !== "ready") return;
          checkpoint = checkpoint.applyEvent(event);
          cursor = lastEventId;
          if (event.eventType === "companion.delta") {
            setPreview((existing) => {
              /* The first delta of a turn is the moment the player sees words; later deltas are the same paint. */
              observeTurnEvent(event, turnKeyRef.current, existing?.turnHandle ?? null);
              return Object.freeze({
                turnHandle: event.payload.turnHandle,
                text:
                  existing?.turnHandle === event.payload.turnHandle
                    ? `${existing.text}${event.payload.delta}`
                    : event.payload.delta,
              });
            });
            return;
          }
          if (event.eventType === "message.committed" || event.eventType === "turn.state_changed") {
            setPreview(null);
            /* The mark mapping lives in `turn-timings`: it is a fact about the contract's state union. */
            if (observeTurnEvent(event, turnKeyRef.current, null).terminal) turnKeyRef.current = null;
          }
          // Not awaited: the pass owns the reads, so a frame that arrives while it
          // runs still validates its own position here and then marks it pending.
          void reconcile();
        } catch {
          await recover(true);
        }
      });
    };
    function connect(): void {
      if (disposed || recovering || eventSourceRef.current !== null) return;
      try {
        eventSourceRef.current = tavernApiRef.current.openEvents({
          cursor,
          onEvent: handleEvent,
          onError: () => {
            streamLiveRef.current = false;
            streamFailedRef.current = true;
            void recover();
          },
        });
        streamLiveRef.current = true;
      } catch (error) {
        streamLiveRef.current = false;
        if (terminalReadFailure(error)) commit(problemView(error, messages(localeRef.current)));
        else {
          streamFailedRef.current = true;
          setStreamNotice(messages(localeRef.current).chatArrivalNotice);
          scheduleRecovery();
        }
      }
    }
    // A frame the queue could not process is the same fact a bad frame is: the stream owes an authoritative
    // read, so the recovery pass is what a rejected link runs.
    drain = createSerialDrain(() => void recover(true));
    connect();
    return () => {
      disposed = true;
      closeSource();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [view.kind, commit, eventStreamEpoch]);

  /**
   * Begin the durable half of a turn-starting Chat mutation: the profile must
   * offer `chat.submit` as `available` (the store admits exactly one turn at a
   * time, so that availability *is* "no turn is in flight"), and the mutation's
   * own pending record - correlated by the idempotency key it sends - must be
   * published before its wire call.
   *
   * The record is not bookkeeping. `startPolling`'s first tick returns for a
   * session with nothing pending, which is what keeps every idle session from
   * polling, and that fallback poll is the only thing that settles a turn when
   * no event stream is delivering it. Publishing in this one place is what keeps
   * the next turn-starting mutation (send and regenerate are the two) from
   * starting a poll that is dead on its first tick; a mutation that starts no
   * turn (swipe) publishes nothing and polls nothing.
   *
   * Returns null - having committed the rejected projection, or having found no
   * available `chat.submit` - and the caller must then send nothing.
   */
  const beginTurnMutation = (idempotencyKey: string, current: ReadyView): PendingSubmission | null => {
    const operation = current.session.snapshot.operations.find((op) => op.operationId === "chat.submit");
    if (operation?.availability !== "available") return null;
    try {
      const pending = pendingSubmission(idempotencyKey, current.session.snapshot);
      commit({ ...current, session: current.session.withPending(pending) });
      // The last refusal described the last attempt, and this attempt is the answer to it. Cleared here
      // rather than in the handler because this is the seam both turn-starting mutations share - send and
      // regenerate - so neither can leave a sentence about an attempt it already superseded on screen.
      setSendFailure(null);
      return pending;
    } catch (error) {
      commit(problemView(error, messages(current.locale)));
      return null;
    }
  };

  /**
   * Whether the Host itself answered a failed turn-starting mutation.
   *
   * `TavernProblemError` is the Host's own validated problem document: it answered, and the answer
   * is that the command was not carried out. Everything else is the absence of an answer - a dropped
   * connection, a timeout, a body this client could not read - and the absence of an answer is not a
   * refusal: it says nothing about whether the Host admitted the submission.
   */
  const hostAnswered = (error: unknown): boolean => error instanceof TavernProblemError;

  /**
   * What a failed turn-starting mutation does with the record it published.
   *
   * Two facts, not one, and the difference decides whether the player may send again:
   *
   *   - **refused** - the Host answered. Nothing ran, so the record is spent and the composer is
   *     handed back. `rereadChat`'s settle rule cannot do this: it spends a record for a *terminal
   *     turn*, and a refusal leaves no turn at all, so the spinner of a submission no turn backs
   *     would outlive the refusal until the player switched chats or reloaded.
   *   - **unanswered** - no answer arrived. The record survives, because it is exactly the fact that
   *     a submission may be held: it keeps the fallback poll live and keeps the send gate closed.
   *     Handing it back invites a resend of a message the Host may already be answering, which is a
   *     second player row and a second provider turn for one press. The poll is the one authority
   *     that can say what happened, and it spends the record when the turn settles.
   *
   * Send and regenerate publish the same record through the same seam (`beginTurnMutation`), so they
   * resolve it through the same one.
   *
   * Read from `viewRef` rather than from the caller's own view: this runs after the mutation's await
   * (and, for regenerate, after its reread), so the view the caller captured is no longer the view
   * the record lives in.
   */
  const settleFailedTurnMutation = (error: unknown): void => {
    if (!hostAnswered(error)) {
      startPolling();
      return;
    }
    const latest = viewRef.current;
    if (latest.kind === "ready" && latest.session.pending !== null)
      commit({ ...latest, session: latest.session.withPending(null) });
  };

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
    setPollFailure(false);
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
      // An answered refusal costs the record this send published; an unanswered attempt keeps it.
      settleFailedTurnMutation(error);
      return;
    }
    startPolling();
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
      root,
      // A record this surface published while the read was in flight is the surface's own fact, and
      // the reading cannot have seen the submission it names: `applySnapshot` carries it over, and
      // the read only spends it for the one state that settles it - a terminal turn.
      session: terminalTurn(root.chat.chat.turn) ? session.withPending(null) : session,
      draft,
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
        commit(problemView(error, messages(localeRef.current)));
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
   * Durable draft authoring, merged from the removed management surface: the
   * PUT/DELETE carries this mount's exact expected revision and the validated
   * durable read-back replaces the draft - nothing is ever guessed locally.
   *
   * The composed Chat projection pins the reference profile's operation list,
   * which declares no `draft.save`/`draft.discard`, so there is no capability
   * flag to gate these two controls on and the served route IS the capability -
   * the same rule `management-surface-panels.tsx` documents for a panel mounted
   * here. A rejected mutation is therefore reported, never hidden.
   *
   * Any rejection first re-reads the authoritative durable draft: a rejected
   * write means the durable draft may no longer match this mount's revision (a
   * stale tab's 409 draft/selection conflict), so the mounted draft takes the
   * server read-back and the next save is the compare-and-swap the route asks
   * for. The read-back is AUTHORITY, never text: it must not reach the composer,
   * which holds whatever the player is writing. An earlier version seeded it
   * there, so a 409 or a network blip replaced the sentence in flight with the
   * Host's older copy - player input discarded by a failure the player did not
   * cause. A read-back may only become the field's text on a success (`seedDraft`
   * below) or through the seeding effect above, which leaves a locally edited field
   * alone when the revision it was seeded at moves.
   */
  const handleDraftMutation = async (kind: "save" | "discard"): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.snapshot.selection === null) return;
    try {
      const command = {
        apiVersion: 1 as const,
        selectionGeneration: current.session.snapshot.selection.generation,
        expectedRevision: current.draft.revision,
        ...(kind === "save" ? { text: inputTextRef.current.trim() } : {}),
      };
      const result =
        kind === "save"
          ? await managementPipelineApiRef.current.saveDraft(
              command as { apiVersion: 1; selectionGeneration: number; expectedRevision: number; text: string },
              current.session.snapshot.csrfToken,
            )
          : await managementPipelineApiRef.current.discardDraft(command, current.session.snapshot.csrfToken);
      seedDraft(result);
      setDraftNotice({ kind: "success", text: labels().success });
      commit({ ...current, draft: result });
    } catch (error) {
      // The refusal's own sentence, not a generic one: a stale draft and a forbidden draft read differently to the
      // player, and every other mutation on this surface already words itself through the catalogue.
      const sentence = declaredProblemSentence(error, labels()) ?? labels().failure;
      setDraftNotice({ kind: "failure", text: sentence });
      try {
        const draft = await managementPipelineApiRef.current.readDraft();
        const fresh = viewRef.current;
        // `commit` only - never `seedDraft`: the revision is what the next save compares and swaps
        // against, and the words stay the player's. The seeding effect leaves a locally edited field
        // alone when the revision it was seeded at moves, so this cannot reach the composer either.
        if (fresh.kind === "ready") commit({ ...fresh, draft });
      } catch {
        // The read-back failed too, so this mount keeps the revision it had; the notice above is what
        // the player reads, and the next save states the same conflict again rather than guessing.
      }
    }
  };

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
   * Swipe selection and regenerate are Chat-owned mutations the reference
   * surface offered and the composed shell did not: with the reference entry
   * gone they live here. Both take their own idempotency key and never append a
   * response locally; the authoritative reread owns what the transcript shows,
   * and a failed attempt resolves through that same reread rather than a local
   * guess.
   */
  const handleSwipe = async (messageHandle: string, direction: "prev" | "next"): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    // Single-flight: a second click while the first is in flight is dropped, not
    // sent. Only this attempt's own resolution clears the latch.
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    beginMessageMutation("swipe", messageHandle);
    try {
      await tavernApiRef.current.selectSwipe(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, direction },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      // Said out loud before the reread: the reread restores the variant the Host still holds, so
      // without this line the row flickers back with nothing explaining the press.
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The new-chat opening choice. It has the same shape as swipe - single-flight, no local variant
   * held - but it records the choice through the Host's `chat.opening` route and then rereads the
   * authoritative snapshot, because the committed variant and the sealed-opening fact are the
   * Host's, never React state's.
   */
  const handleOpeningVariant = async (messageHandle: string, direction: "prev" | "next"): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    beginMessageMutation("opening", messageHandle);
    try {
      await managementPipelineApiRef.current.selectOpeningVariant(
        { apiVersion: 1, selectionGeneration: selection.generation, direction },
        current.session.snapshot.csrfToken,
      );
      await rereadChat();
    } catch (error) {
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  const handleRegenerate = async (messageHandle: string): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    // Single-flight, exactly as swipe: without it a double click mints two fresh
    // idempotency keys and the Host admits two regenerations.
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    // Regeneration starts a real turn, so it begins the way a send does: only
    // while the profile offers an available `chat.submit` (one turn at a time)
    // and under a published pending record. That record is what makes the
    // fallback poll live; without it the poll this handler starts dies on its
    // first tick (nothing is pending), and on a dropped event stream the
    // transcript never leaves the pre-regenerate variant.
    const idempotencyKey = newIdempotencyKey();
    if (beginTurnMutation(idempotencyKey, current) === null) return;
    // The turn-key discipline is `handleSend`'s, word for word, and it is here for the same reason:
    // this regenerate mints a NEW durable turn - it reuses message identities, never a turn handle -
    // so every mark the turn produces has to name it. Without these two lines the turn's
    // `accepted`/`first-token`/`settled` marks named no turn at all, and after a turn settled by
    // the fallback poll or a committed message rather than a terminal state event - the only thing
    // that clears `turnKeyRef` - they named the turn BEFORE this one.
    turnKeyRef.current = idempotencyKey;
    markTurn("submit", { surface: "chat", turnKey: idempotencyKey });
    beginMessageMutation("regenerate", messageHandle);
    try {
      await tavernApiRef.current.regenerate(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle },
        { csrfToken: current.session.snapshot.csrfToken, idempotencyKey },
      );
      await rereadChat();
      startPolling();
    } catch (error) {
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
      // Last, so the record's fate is decided against the view the reread left behind: a refusal
      // spends the record this regenerate published, and an unanswered attempt keeps it and hands
      // it to the poll.
      settleFailedTurnMutation(error);
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The arm and its confirmation. It names the message AND the order the page rendered it at (or, for a
   * variant discard, just the reply), and it is dropped the moment that pairing stops holding, so a stale
   * arm can never fire a destructive command on a message the player is no longer looking at. The Host
   * re-checks the same pairing anyway: this only keeps the surface honest.
   */
  const mountedTranscript = view.kind === "ready" ? (view.session.snapshot.chat?.transcript ?? null) : null;
  useEffect(() => {
    if (arm === null) return;
    const held = mountedTranscript?.some((message) =>
      arm.action === "swipe_remove"
        ? message.handle === arm.targetId
        : message.handle === arm.targetId && message.order === arm.expectedOrder,
    );
    if (held === true) return;
    setArm(null);
  }, [arm, mountedTranscript]);

  const handleRewindArm = (messageHandle: string, expectedOrder: number): void => {
    setArm(Object.freeze({ action: "rewind", targetId: messageHandle, expectedOrder }));
  };

  const handleRewindCancel = (): void => {
    setArm(null);
  };

  const handleRewindConfirm = async (messageHandle: string, expectedOrder: number): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    setArm(null);
    beginMessageMutation("rewind", messageHandle);
    try {
      await tavernApiRef.current.rewind(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  const handleDeleteArm = (messageHandle: string, expectedOrder: number): void => {
    setArm(Object.freeze({ action: "delete", targetId: messageHandle, expectedOrder }));
  };

  const handleDeleteCancel = (): void => {
    setArm(null);
  };

  const handleDeleteConfirm = async (messageHandle: string, expectedOrder: number): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    setArm(null);
    beginMessageMutation("delete", messageHandle);
    try {
      await tavernApiRef.current.delete(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

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
  const handleSwipeRemoveConfirm = async (messageHandle: string, targetIndex: number): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    setArm(null);
    beginMessageMutation("swipeRemove", messageHandle);
    try {
      await tavernApiRef.current.removeSwipeVariant(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, targetIndex },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      // The refusal's own sentence, said out loud before the reread: a variant that did not leave is a
      // fact about this press, and the words for it already exist in the catalogue.
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The edit: the player's own message carries different text from now on, in the transcript and in
   * the model's own session together. It has the same shape as the other message mutations -
   * single-flight, no local rewrite held - and it sends the order the page rendered the row at,
   * because the transcript is what a position means and the Host refuses a row that has moved. The
   * authoritative reread owns what the conversation then shows.
   */
  const handleEdit = async (messageHandle: string, expectedOrder: number, text: string): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    beginMessageMutation("edit", messageHandle);
    try {
      await tavernApiRef.current.edit(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder, text },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      // The editor stays open on the words the player typed (the row closes it only on the edit that
      // landed), so the sentence is what stands beside them: "nothing happened" with no reason is what
      // sent players looking for a failure the page never named.
      setMessageMutationNotice(problemView(error, messages(current.locale)).detail);
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

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
    // The refusal's sentence described an attempt in the conversation this mount is leaving, so it
    // is not a fact about the one it adopts.
    setSendFailure(null);
    setMessageMutationNotice(null);
    const base = createReferencePipelineSession(root.chat);
    const session = root.chat.eventStream === null ? base : base.resetEventCheckpoint();
    setMountedChatRevision((revision) => revision + 1);
    commit({ ...current, root, session, draft });
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
        commit(problemView(error, messages(current.locale)));
      }
    })();
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
    const locale = current.locale;
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
        commit(problemView(error, messages(locale)));
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
        commit(problemView(error, messages(current.locale)));
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

  const openGamePanel = openPanelOf(GAME_PANEL, gameEntryRef);
  const openChat = openPanelOf(CHAT_PANEL, chatEntryRef);
  const openChats = openPanelOf(CHATS_PANEL, chatsEntryRef);
  const openCharacters = openPanelOf(CHARACTERS_PANEL, charactersEntryRef);
  const openSettings = openPanelOf(SETTINGS_PANEL, settingsEntryRef);
  const openPresets = openPanelOf(PRESETS_PANEL, presetsEntryRef);
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
    [PRESETS_PANEL]: { open: openPresets, ref: presetsEntryRef },
  };

  return (
    // One draft store for every surface: the shell is the only thing that outlives them.
    <SurfaceDrafts>
      <div className="tavern-app-shell" data-profile="composed-reference-game">
        <SkipLink label={labels().skipToChat} />
        {view.kind === "loading" && (
          <main id="main-content" className="app-main-content">
            <div className="state-placeholder">
              <p className="loading-text">{labels().openingChat}</p>
            </div>
          </main>
        )}
        {view.kind === "problem" && (
          <ProblemView
            title={view.title}
            detail={view.detail}
            stepLine={problemStepLine(view.step, labels())}
            action={problemDrawsOwnRead(view.step) ? { label: labels().problemRetryRead, run: retryProblemView } : null}
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
              entries={surfaceBarEntries(labels(), shownSurface, managementPanelsAvailable, entryOpeners)}
              fold={{ from: LEADING_SURFACE_COUNT, label: labels().appBarMore }}
            />
            <main id="main-content" className="app-main-content">
              {/* Every surface is a peer: it takes this region in full, none of them
                covers another, and the conversation is simply the default one
                (design/104 §2). The URL names the selected surface, so Back
                returns to the previous one and a reload restores it. */}
              {shownSurface === CHAT_PANEL && (
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
                    pollFailure
                      ? labels().chatFailed
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
                  onRewind={handleRewindArm}
                  onRewindConfirm={(messageHandle, expectedOrder) =>
                    void handleRewindConfirm(messageHandle, expectedOrder)
                  }
                  onRewindCancel={handleRewindCancel}
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
              )}
              <GameSurface
                selected={shownSurface === GAME_PANEL}
                ready={view.kind === "ready"}
                game={view.root.game}
                csrfToken={view.session.snapshot.csrfToken}
                labels={labels()}
                readView={() => viewRef.current}
                commit={commit}
                clearPreview={() => setPreview(null)}
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
              {shownSurface === PRESETS_PANEL && <PresetAssemblySurface labels={labels()} />}
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
