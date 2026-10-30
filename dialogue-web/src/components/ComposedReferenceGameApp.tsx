import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Gamepad2, MessagesSquare, Settings, SlidersHorizontal, Users } from "lucide-react";
import type { Locale } from "../i18n";
import { applyDocumentLocale, messages, persistLocale, resolveLocale } from "../i18n";
import type { BrowserDraftV1, BrowserEventV1 } from "../reference-pipeline-api";
import {
  createReferencePipelineSession,
  type PendingSubmission,
  pendingSubmission,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import { composedProblemView as problemView, declaredProblemSentence } from "../composed-problem-view";
import { type ChatModelRoute, readChatModelRoute } from "../chat-model-route";
import { newIdempotencyKey, type ReadyView } from "./composed-reference-game-view";
import {
  type ComposedPreviewV1,
  TERMINAL_TURN_STATES,
  terminalTurn,
  useComposedBootstrap,
} from "./use-composed-bootstrap";
import { AppBar } from "./AppBar";
import { ChatSurface } from "./ChatSurface";
import { GameSurface } from "./GameSurface";
import { ContextDrawer } from "./ContextDrawer";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { CharactersSurface } from "./CharactersSurface";
import { turnFailureText } from "./turn-failure-text";
import { createManagementPipelineApi, type WorldInfoSurfaceSource } from "./management-surface-panels";
import { ChatsSurface } from "./ChatsSurface";
import { MemorySurface } from "./MemorySurface";
import { SettingsSurface } from "./SettingsSurface";
import {
  CHARACTERS_PANEL,
  CHATS_PANEL,
  CHAT_PANEL,
  GAME_PANEL,
  MEMORY_PANEL,
  SETTINGS_PANEL,
  useSurfaceRoute,
} from "../composed-surface-route";

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
    kind: "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete";
    handle: string;
  }> | null>(null);
  // The rewind arm: the message the player asked to cut back to, and the order they were shown it
  // at. A rewind destroys everything after that point, so the arm only names the target and the
  // confirmation below the bubble is what sends it.
  const [rewindArm, setRewindArm] = useState<Readonly<{ handle: string; expectedOrder: number }> | null>(null);
  // The delete arm: the one message the player asked to remove, and the order they were shown it at.
  // A delete is destructive and has no undo, so the arm names the target and the confirmation below
  // the bubble is what sends it - the same shape the rewind arm and a Chats row's trash use.
  const [deleteArm, setDeleteArm] = useState<Readonly<{ handle: string; expectedOrder: number }> | null>(null);
  // The variant-discard arm: the reply the player asked to strip one variant from, and the variant index
  // they were looking at. A discard destroys a generation they spent tokens on, so the arm names it and
  // the confirmation is what sends it - the same shape the rewind and delete arms use.
  const [swipeRemoveArm, setSwipeRemoveArm] = useState<Readonly<{ handle: string; targetIndex: number }> | null>(null);
  const chatMutationRef = useRef(false);
  // The durable draft's authoring state is the composer's own field (see the
  // seeding effect below); what stays here is the closed outcome line its
  // Save/Discard report through.
  const [draftNotice, setDraftNotice] = useState<Readonly<{ kind: "success" | "failure"; text: string }> | null>(null);
  /**
   * The last send this surface refused, in the refusal's own sentence.
   *
   * The words go back into the field, and this is what stands beside them: a refusal is a fact
   * about one attempt, so it is reported where the player can act on it and never replaces the
   * conversation the attempt was written into. It is spent by the next turn-starting mutation
   * (`beginTurnMutation`, shared by send and regenerate) and by adopting another Chat, because
   * past either point it describes an attempt that no longer stands.
   */
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  /**
   * The last variant discard this surface was refused, in the refusal's own sentence.
   *
   * A discard is the one mutation here whose control can VANISH on success (the reply falls back to a
   * single variant), so a refusal cannot be left to the row: the player pressed a button, the variant is
   * still there, and nothing said why. The Host refuses the last-position case by name
   * (`chat_swipe_last_variant`) and the catalogue's sentence for it is what this line carries - the code
   * is contract vocabulary and never printed (see `composed-problem-view.ts`). It is spent by the next
   * arm of the same control and by adopting another Chat, because past either point it describes a press
   * that no longer stands.
   */
  const [swipeRemoveNotice, setSwipeRemoveNotice] = useState<string | null>(null);
  // A created Chat whose chosen opening could not be committed. The Chat itself is durable and the
  // player is landed in it either way, so this is the one fact left to state: it opens on the
  // default opening. It clears when another switch lands.
  const [openingNotice, setOpeningNotice] = useState<string | null>(null);
  /**
   * The optimistic player message: the text the player just sent, keyed by the idempotency key
   * the send already minted. It is shown until the Host's authoritative transcript for that key
   * lands and is never replayed on a reconnect or re-read (a fresh mount starts with none), so a
   * settled turn leaves no ghost and the pair collapses to the one authoritative message.
   */
  const [optimistic, setOptimistic] = useState<Readonly<{ idempotencyKey: string; text: string }> | null>(null);
  // The durable revision the editor was last seeded from, and the chat that seed
  // belongs to: the revision lets a later authoritative read replace the editor
  // without discarding text the player typed past the seed, and the chat identity
  // is what makes a *switch* reseed from the target chat's own draft instead of
  // keeping the previous chat's text.
  const seededDraftRef = useRef<Readonly<{ chat: string | null; revision: number; text: string }> | null>(null);
  const localeRef = useRef<Locale>(resolveLocale());
  const eventSourceRef = useRef<{ close(): void } | null>(null);
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
  const memoryEntryRef = useRef<HTMLButtonElement>(null);
  const modelPopoutEntryRef = useRef<HTMLButtonElement>(null);
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

  const { shownSurface, openPanelOf } = useSurfaceRoute();

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
  } = useComposedBootstrap(localeRef, setPreview);

  const eventStreamEpoch =
    view.kind === "ready" ? `${view.session.snapshot.eventStream?.epoch ?? ""}#${mountedChatRevision}` : undefined;

  useEffect(() => {
    if (view.kind !== "ready" || view.session.snapshot.eventStream === null) return;
    let disposed = false;
    let recovering = false;
    let work = Promise.resolve();
    let cursor = view.session.snapshot.eventStream.cursor;
    let pendingResetCursor = false;
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
      try {
        const doReset = pendingResetCursor;
        pendingResetCursor = false;
        const root = await composedApiRef.current.readState();
        const draft = await tavernApiRef.current.readDraft();
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
        if (draft.revision !== root.chat.chat.draft.revision || (draft.text !== null) !== root.chat.chat.draft.present)
          throw new ReferencePipelineSessionError("state_reconciliation_required");
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
      } catch (error) {
        if (!disposed) commit(problemView(error, messages(localeRef.current)));
      } finally {
        recovering = false;
        if (pendingResetCursor && !disposed) void recover(true);
        else if (!disposed && viewRef.current.kind === "ready") connect();
      }
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
            const root = await composedApiRef.current.readState();
            const draft = await tavernApiRef.current.readDraft();
            const latest = viewRef.current;
            // A recovery that started under these reads is reading the same
            // authority with a cursor of its own; its answer supersedes this one.
            if (disposed || recovering || latest.kind !== "ready" || root.chat.chat === null) return;
            if (
              draft.revision !== root.chat.chat.draft.revision ||
              (draft.text !== null) !== root.chat.chat.draft.present
            )
              throw new ReferencePipelineSessionError("state_reconciliation_required");
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
      work = work.then(async () => {
        if (disposed || recovering) return;
        try {
          const current = viewRef.current;
          if (current.kind !== "ready") return;
          checkpoint = checkpoint.applyEvent(event);
          cursor = lastEventId;
          if (event.eventType === "companion.delta") {
            setPreview((existing) =>
              Object.freeze({
                turnHandle: event.payload.turnHandle,
                text:
                  existing?.turnHandle === event.payload.turnHandle
                    ? `${existing.text}${event.payload.delta}`
                    : event.payload.delta,
              }),
            );
            return;
          }
          if (event.eventType === "message.committed" || event.eventType === "turn.state_changed") setPreview(null);
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
        commit(problemView(error, messages(localeRef.current)));
      }
    }
    connect();
    return () => {
      disposed = true;
      closeSource();
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

  const handleSend = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.pending !== null) return;
    const text = inputTextRef.current.trim();
    if (text.length === 0) return;
    const idempotencyKey = newIdempotencyKey();
    const pending = beginTurnMutation(idempotencyKey, current);
    if (pending === null) return;
    setOptimistic(Object.freeze({ idempotencyKey: pending.idempotencyKey, text }));
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
      // The sentence stands beside the words rather than in place of them. A refused send says nothing about the
      // conversation behind it - the transcript and this shell's snapshot are still what they were, and the
      // pending record is spent - so replacing the whole surface with a problem page would take away the field
      // the words were just put back into, and report a state fault that did not happen. The one line is the same
      // sentence that page drew, from the same place: `composedProblemView` is the owner of which words a failure
      // earns, and its `detail` is what a one-line notice has room for. The read that leaves the chat unreadable
      // is a different failure, and that path still commits the problem view.
      setSendFailure(problemView(error, messages(current.locale)).detail);
      commit({ ...current, session: current.session.withPending(null) });
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
   */
  const rereadChat = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const root = await composedApiRef.current.readState();
    const draft = await tavernApiRef.current.readDraft();
    if (
      root.chat.chat === null ||
      draft.revision !== root.chat.chat.draft.revision ||
      (draft.text !== null) !== root.chat.chat.draft.present
    ) {
      throw new ReferencePipelineSessionError("state_reconciliation_required");
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
      session: terminalTurn(root.chat.chat.turn) ? session.withPending(null) : session,
      draft,
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

  /** Takes a validated durable draft read-back as the composer field's new truth. */
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
   * stale tab's 409 draft/selection conflict), so the composer field and the
   * mounted draft both take the server read-back and the stale local value can
   * never survive the conflict.
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
      try {
        const draft = await managementPipelineApiRef.current.readDraft();
        seedDraft(draft);
        setDraftNotice({ kind: "failure", text: sentence });
        const fresh = viewRef.current;
        if (fresh.kind === "ready") commit({ ...fresh, draft });
      } catch {
        setDraftNotice({ kind: "failure", text: sentence });
      }
    }
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
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "swipe" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.selectSwipe(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, direction },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
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
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "opening" as const, handle: messageHandle }));
    try {
      await managementPipelineApiRef.current.selectOpeningVariant(
        { apiVersion: 1, selectionGeneration: selection.generation, direction },
        current.session.snapshot.csrfToken,
      );
      await rereadChat();
    } catch (error) {
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
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "regenerate" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.regenerate(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle },
        { csrfToken: current.session.snapshot.csrfToken, idempotencyKey },
      );
      await rereadChat();
      startPolling();
    } catch (error) {
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The rewind arm and its confirmation. The arm names the message AND the order the page rendered
   * it at, and it is dropped the moment that pairing stops holding, so a stale arm can never fire a
   * destructive command on a message the player is no longer looking at. The Host re-checks the
   * same pairing anyway: this only keeps the surface honest.
   */
  const mountedTranscript = view.kind === "ready" ? (view.session.snapshot.chat?.transcript ?? null) : null;
  useEffect(() => {
    if (rewindArm === null) return;
    if (
      mountedTranscript?.some(
        (message) => message.handle === rewindArm.handle && message.order === rewindArm.expectedOrder,
      ) === true
    )
      return;
    setRewindArm(null);
  }, [rewindArm, mountedTranscript]);

  const handleRewindArm = (messageHandle: string, expectedOrder: number): void => {
    // Only one destructive arm can be open at a time, so arming one drops the other: a row showing
    // two confirmations at once would leave the player unable to tell what the next press removes.
    setDeleteArm(null);
    setSwipeRemoveArm(null);
    setRewindArm(Object.freeze({ handle: messageHandle, expectedOrder }));
  };

  const handleRewindCancel = (): void => {
    setRewindArm(null);
  };

  const handleRewindConfirm = async (messageHandle: string, expectedOrder: number): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    setRewindArm(null);
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "rewind" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.rewind(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The delete arm and its confirmation, the rewind arm's own shape one row over: the arm names the
   * message AND the order the page rendered it at, and it is dropped the moment that pairing stops
   * holding, so a stale arm can never delete a message the player is no longer looking at. The Host
   * re-checks the same pairing anyway: this only keeps the surface honest.
   */
  useEffect(() => {
    if (deleteArm === null) return;
    if (
      mountedTranscript?.some(
        (message) => message.handle === deleteArm.handle && message.order === deleteArm.expectedOrder,
      ) === true
    )
      return;
    setDeleteArm(null);
  }, [deleteArm, mountedTranscript]);

  const handleDeleteArm = (messageHandle: string, expectedOrder: number): void => {
    setRewindArm(null);
    setSwipeRemoveArm(null);
    setDeleteArm(Object.freeze({ handle: messageHandle, expectedOrder }));
  };

  const handleDeleteCancel = (): void => {
    setDeleteArm(null);
  };

  const handleDeleteConfirm = async (messageHandle: string, expectedOrder: number): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    if (chatMutationRef.current) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    setDeleteArm(null);
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "delete" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.delete(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      await rereadChat().catch(() => {
        commit(problemView(error, messages(current.locale)));
      });
    } finally {
      chatMutationRef.current = false;
      setChatMutation(null);
    }
  };

  /**
   * The variant discard's arm and its confirmation, the delete arm's own shape one row over. The arm
   * names the reply and the variant index the page rendered, and it is dropped the moment the reply stops
   * being one of the transcript's rows - a stale arm must never discard a variant of a reply the player
   * is no longer looking at. The index itself is re-checked by the Host, which refuses a position that is
   * not there rather than guessing.
   */
  useEffect(() => {
    if (swipeRemoveArm === null) return;
    if (mountedTranscript?.some((message) => message.handle === swipeRemoveArm.handle) === true) return;
    setSwipeRemoveArm(null);
  }, [swipeRemoveArm, mountedTranscript]);

  const handleSwipeRemoveArm = (messageHandle: string, targetIndex: number): void => {
    setSwipeRemoveNotice(null);
    setRewindArm(null);
    setDeleteArm(null);
    setSwipeRemoveArm(Object.freeze({ handle: messageHandle, targetIndex }));
  };

  const handleSwipeRemoveCancel = (): void => {
    setSwipeRemoveArm(null);
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
    setSwipeRemoveArm(null);
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "swipeRemove" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.removeSwipeVariant(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, targetIndex },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
      // The refusal's own sentence, said out loud before the reread: a variant that did not leave is a
      // fact about this press, and the words for it already exist in the catalogue.
      setSwipeRemoveNotice(problemView(error, messages(current.locale)).detail);
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
    chatMutationRef.current = true;
    setChatMutation(Object.freeze({ kind: "edit" as const, handle: messageHandle }));
    try {
      await tavernApiRef.current.edit(
        { apiVersion: 1, selectionGeneration: selection.generation, messageHandle, expectedOrder, text },
        { csrfToken: current.session.snapshot.csrfToken },
      );
      await rereadChat();
    } catch (error) {
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
    if (draft.revision !== root.chat.chat.draft.revision || (draft.text !== null) !== root.chat.chat.draft.present)
      throw new ReferencePipelineSessionError("state_reconciliation_required");
    setPreview(null);
    // The refusal's sentence described an attempt in the conversation this mount is leaving, so it
    // is not a fact about the one it adopts.
    setSendFailure(null);
    setSwipeRemoveNotice(null);
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
        const draft = await tavernApiRef.current.readDraft();
        adoptMountedChat(root, draft);
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
   * the shell is never asked to move to a Chat that does not exist. What remains here is
   * the residual case where this shell's own list read disagrees with that decision, or
   * the mounted turn refuses the switch: there is nothing to move to, so the live stream
   * is closed instead of being left reading the dead thread.
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
          closeLiveStream();
          return;
        }
        await managementPipelineApiRef.current.selectChat(
          { apiVersion: 1, selectionGeneration: selection.generation, chatHandle: next.handle },
          csrfToken,
        );
        const root = await composedApiRef.current.readState();
        const draft = await tavernApiRef.current.readDraft();
        if (root.chat.selection?.chatHandle === removedHandle) {
          // The runtime could not leave the archived Chat, so nothing may keep
          // reading its stream.
          closeLiveStream();
          return;
        }
        adoptMountedChat(root, draft);
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
   * items happened to be missing". Its own bind's compare-and-swap carries the
   * composed snapshot's selection generation, which is the only fact `bind` needs
   * that the projection does not carry.
   */
  const readProductWorldInfo = useCallback(async (): Promise<WorldInfoSurfaceSource> => {
    const current = viewRef.current;
    const root = await composedApiRef.current.readState();
    return {
      worldInfo: root.chat.chat?.worldInfo ?? null,
      selectionGeneration: current.kind === "ready" ? (current.session.snapshot.selection?.generation ?? 0) : 0,
    };
  }, []);

  /**
   * The interface's own display language, not the companion's: it changes what
   * the player reads here (and the document locale), while the companion language
   * keeps the separate choice the settings panel owns and persists.
   */
  const handleUiLocale = (locale: Locale): void => {
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
      try {
        await rereadChat();
      } catch {
        commit(problemView(error, messages(current.locale)));
      }
    }
  };

  const submitAvailable =
    view.kind === "ready" &&
    view.session.pending === null &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.submit" && op.availability === "available");
  // The optimistic entry is visible only while the pending record carries its exact key and the
  // authoritative transcript has not yet carried the same player line. A settled/failed turn
  // clears the pending record, so the pair collapses to one message and no ghost survives a
  // re-read or a reload.
  const pendingOptimisticMessage =
    view.kind === "ready" &&
    optimistic !== null &&
    view.session.pending?.idempotencyKey === optimistic.idempotencyKey &&
    !(view.session.snapshot.chat?.transcript ?? []).some(
      (message) => message.role === "player" && message.text === optimistic.text,
    )
      ? optimistic
      : null;
  const stopAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat?.turn?.canCancel === true &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.cancel" && op.availability === "available");
  const terminalTurnNotice =
    view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "cancelled"
      ? labels().chatStopped
      : view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "failed"
        ? turnFailureText(view.session.snapshot.chat.turn.problemCode, labels())
        : null;
  // The app-bar indicator is the Chat surface's own connection/turn fact: a turn
  // is in flight from the moment a submission is admitted until the authoritative
  // turn reaches a terminal state. The Game connection has its own drawer
  // (design/26 §4.1, design/104 §2); it is not announced from here.
  const turnInFlight =
    view.kind === "ready" &&
    (view.session.pending !== null ||
      (view.session.snapshot.chat?.turn != null && !TERMINAL_TURN_STATES.has(view.session.snapshot.chat.turn.state)));

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

  /**
   * The route a message the player sends from here would actually reach a model through.
   *
   * It is derived, never guessed: `readChatModelRoute` is the one function that reads the two
   * settings projections and applies the Host's own precedence (an active connection, else the
   * shipped Chat profile on this machine's operator gateway), and the conversation words itself
   * from that answer alone. A mount that publishes neither read, or answers with something this
   * client cannot read, keeps `unknown`: saying nothing is the only honest sentence then. The read
   * is repeated whenever the conversation is shown again, so activating a connection in Settings
   * clears the surface's own sentence without a reload.
   */
  const [chatModelRoute, setChatModelRoute] = useState<ChatModelRoute>({ kind: "unknown" });
  const conversationShown = view.kind === "ready" && view.session.snapshot.chat !== null;
  useEffect(() => {
    if (!conversationShown || shownSurface !== CHAT_PANEL) return;
    let active = true;
    void readChatModelRoute(managementPipelineApiRef.current).then((route) => {
      if (active) setChatModelRoute(route);
    });
    return () => {
      active = false;
    };
  }, [conversationShown, shownSurface]);

  /**
   * The conversation the shell has committed has to be re-read when the player comes back to it.
   *
   * Every fact the conversation renders - the transcript, the mic control, the voice state the
   * Host projects - is the composed root's Chat half, and the Host can move it while another
   * surface is open. Granting the cloud-TTS consent in Settings is the case that reported it:
   * coming back kept the pre-consent `unavailable` mic, because nothing re-read the root and
   * the stale projection stood until a reload.
   *
   * The read is `rereadChat`, the mount's own authoritative path (the composed root plus the
   * draft that must still reconcile with it), taken once per arrival. The ref is what keeps
   * the first paint from paying for a second read: mount already read, so only a *change* of
   * surface is an arrival. The other surfaces read their own projections when they mount, so
   * this one belongs to the surface that renders the shell's committed projection; it is a
   * read on an event, never a timer. A read that fails commits the shell's problem view, so a
   * conversation that cannot be re-read says so instead of keeping the projection it had.
   */
  const lastArrivedSurfaceRef = useRef<string>(shownSurface);
  useEffect(() => {
    if (lastArrivedSurfaceRef.current === shownSurface) return;
    lastArrivedSurfaceRef.current = shownSurface;
    if (shownSurface !== CHAT_PANEL) return;
    void rereadChat().catch((error: unknown) => commit(problemView(error, messages(localeRef.current))));
  }, [shownSurface, commit]);

  const openGamePanel = openPanelOf(GAME_PANEL, gameEntryRef);
  const openChat = openPanelOf(CHAT_PANEL, chatEntryRef);
  const openChats = openPanelOf(CHATS_PANEL, chatsEntryRef);
  const openCharacters = openPanelOf(CHARACTERS_PANEL, charactersEntryRef);
  const openSettings = openPanelOf(SETTINGS_PANEL, settingsEntryRef);
  const openMemory = openPanelOf(MEMORY_PANEL, memoryEntryRef);

  return (
    <div className="tavern-app-shell" data-profile="composed-reference-game">
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
          <AppBar
            brandMark={labels().appMark}
            brandLabel={labels().appName}
            companionName={view.session.snapshot.chat.companion.name}
            companionHandle={view.session.snapshot.chat.companion.handle}
            companionDigest={avatarDigests[view.session.snapshot.chat.companion.handle]}
            statusLabel={turnInFlight ? labels().generating : labels().online}
            statusTone={turnInFlight ? "progress" : "idle"}
            entries={[
              // The surfaces are peers: each entry selects the region's content and
              // the conversation is simply the default one (design/104 §2).
              {
                id: CHAT_PANEL,
                label: labels().chatPanel,
                icon: MessagesSquare,
                active: shownSurface === CHAT_PANEL,
                onClick: openChat,
                ref: chatEntryRef,
              },
              {
                id: GAME_PANEL,
                label: labels().gamePanel,
                icon: Gamepad2,
                active: shownSurface === GAME_PANEL,
                onClick: openGamePanel,
                ref: gameEntryRef,
              },
              ...(managementPanelsAvailable
                ? [
                    {
                      id: CHATS_PANEL,
                      label: labels().chatsPanel,
                      icon: MessagesSquare,
                      active: shownSurface === CHATS_PANEL,
                      onClick: openChats,
                      ref: chatsEntryRef,
                    },
                    {
                      id: CHARACTERS_PANEL,
                      label: labels().charactersPanel,
                      icon: Users,
                      active: shownSurface === CHARACTERS_PANEL,
                      onClick: openCharacters,
                      ref: charactersEntryRef,
                    },
                    {
                      id: SETTINGS_PANEL,
                      label: labels().settingsPanel,
                      icon: Settings,
                      active: shownSurface === SETTINGS_PANEL,
                      onClick: openSettings,
                      ref: settingsEntryRef,
                    },
                    {
                      id: MEMORY_PANEL,
                      label: labels().memoryPanel,
                      icon: Brain,
                      active: shownSurface === MEMORY_PANEL,
                      onClick: openMemory,
                      ref: memoryEntryRef,
                    },
                  ]
                : []),
            ]}
            fold={{ from: 2, label: labels().appBarMore }}
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
                pendingPlayerMessage={pendingOptimisticMessage}
                notice={
                  pollFailure
                    ? labels().chatFailed
                    : (sendFailure ?? swipeRemoveNotice ?? terminalTurnNotice ?? openingNotice)
                }
                replyTruncated={view.session.snapshot.chat.turn?.truncated === true}
                onSwipe={(messageHandle, direction) => void handleSwipe(messageHandle, direction)}
                onSwipeRemove={handleSwipeRemoveArm}
                onSwipeRemoveConfirm={(messageHandle, targetIndex) =>
                  void handleSwipeRemoveConfirm(messageHandle, targetIndex)
                }
                onSwipeRemoveCancel={handleSwipeRemoveCancel}
                swipeRemoveArmedHandle={swipeRemoveArm === null ? null : swipeRemoveArm.handle}
                onRegenerate={(messageHandle) => void handleRegenerate(messageHandle)}
                onOpeningVariant={(messageHandle, direction) => void handleOpeningVariant(messageHandle, direction)}
                onRewind={handleRewindArm}
                onRewindConfirm={(messageHandle, expectedOrder) =>
                  void handleRewindConfirm(messageHandle, expectedOrder)
                }
                onRewindCancel={handleRewindCancel}
                rewindArmedHandle={rewindArm === null ? null : rewindArm.handle}
                onEdit={(messageHandle, expectedOrder, text) => void handleEdit(messageHandle, expectedOrder, text)}
                onDelete={handleDeleteArm}
                onDeleteConfirm={(messageHandle, expectedOrder) =>
                  void handleDeleteConfirm(messageHandle, expectedOrder)
                }
                onDeleteCancel={handleDeleteCancel}
                deleteArmedHandle={deleteArm === null ? null : deleteArm.handle}
                value={inputText}
                onChange={writeInput}
                onSend={() => void handleSend()}
                onStop={() => void handleStop()}
                isGenerating={turnInFlight}
                canStop={stopAvailable}
                disabled={!submitAvailable}
                modelRoute={chatModelRoute}
                onOpenSettings={openSettings}
                voice={view.session.snapshot.voice}
                settingsAction={{
                  label: labels().chatModelSettings,
                  expanded: modelPopoutOpen,
                  onClick: () => setModelPopoutOpen(true),
                  ref: modelPopoutEntryRef,
                }}
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
                onSelectUiLocale={handleUiLocale}
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
  );
}
