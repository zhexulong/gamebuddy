import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Gamepad2, MessagesSquare, Settings, SlidersHorizontal, Users } from "lucide-react";
import type { Locale } from "../i18n";
import { applyDocumentLocale, messages, persistLocale, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type BrowserEventV1,
  type BrowserMessageV1,
  type BrowserTurnV1,
  createReferencePipelineApi,
  TavernProblemError,
  TavernProtocolError,
} from "../reference-pipeline-api";
import {
  applyStatus,
  createReferencePipelineSession,
  type PendingSubmission,
  pendingSubmission,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import {
  createComposedReferenceGameBrowserApi,
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "../composed-reference-game-browser-api";
import { composedProblemView as problemView } from "../composed-problem-view";
import {
  newIdempotencyKey,
  type ReadyView,
  type ViewState,
} from "./composed-reference-game-view";
import { AppBar } from "./AppBar";
import { ChatSurface } from "./ChatSurface";
import { GameSurface } from "./GameSurface";
import { ContextDrawer } from "./ContextDrawer";
import { SurfaceView } from "./SurfaceView";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { CharactersSurface } from "./CharactersSurface";
import {
  createManagementPipelineApi,
  type WorldInfoSurfaceSource,
} from "./management-surface-panels";
import { ChatsSurface } from "./ChatsSurface";
import { MemorySurface } from "./MemorySurface";
import { SettingsSurface } from "./SettingsSurface";



/**
 * The Host admits one provider invocation under a fixed 120 s ceiling
 * (`PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS` in the production coordinator).
 * The fallback poll must outlast that ceiling: a client budget that expires
 * first abandons a turn the Host still believes is running and leaves the
 * content-free pending record set, which locks the composer forever.
 */
const HOST_TURN_ADMISSION_CEILING_MS = 120_000;
const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 5_000] as const;
const MAX_POLL_ATTEMPTS = Math.ceil(HOST_TURN_ADMISSION_CEILING_MS / POLL_INTERVAL_MS) + 10;
const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);

/**
 * The single contextual panel this profile can open (design/26 §4.2). The open
 * panel is part of the URL, so a refresh restores it and Browser Back closes it
 * before it leaves the chat (design/26 §7.2, design/104 §2).
 */
const PANEL_PARAM = "panel";
const CHAT_PANEL = "chat" as const;
const GAME_PANEL = "game" as const;
const CHATS_PANEL = "chats" as const;
const CHARACTERS_PANEL = "characters" as const;
const SETTINGS_PANEL = "settings" as const;
const MEMORY_PANEL = "memory" as const;

function readPanelFromUrl(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(PANEL_PARAM);
}

function terminalTurn(turn: BrowserTurnV1 | null): boolean {
  return turn !== null && TERMINAL_TURN_STATES.has(turn.state);
}

/**
 * Whether the conversation still shows its first screen: nothing has been said
 * yet, or the only thing on it is the companion's own committed opening.
 *
 * The product's initial-Chat saga draws message zero from the greeting record
 * whenever the companion was provisioned from a card
 * (`host/src/tavern/initial-chat-exact-content-port.ts` `companionOwnOpening`,
 * invoked by `continuity-semantic-production-coordinator.internal.ts`
 * `materializeExpectedChatContent`), so a card-provisioned first screen already
 * carries one message - and a gate on "no messages at all" can never be true for
 * it. The opening is exactly the one message the Host projects with
 * `openingVariant`, so it is the only message a not-yet-started conversation is
 * allowed to show; a player line, a companion reply after the opening, or an
 * opening the Host could not describe (no `openingVariant`) ends the first
 * screen.
 */
function firstScreenOpen(transcript: readonly BrowserMessageV1[]): boolean {
  return transcript.every(
    (message) => message.role === "companion" && message.openingVariant !== undefined,
  );
}

/**
 * Same-origin composed reference-game shell. The composed root is the only
 * authority used to refresh either projection; the nested Reference pipeline
 * client remains the sole Chat mutation/events client.
 */
export function ComposedReferenceGameApp() {
  const composedApiRef = useRef(createComposedReferenceGameBrowserApi());
  const tavernApiRef = useRef(createReferencePipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [inputText, setInputText] = useState("");
  // The composer's own field is the single authoring buffer for both the next
  // message and the durable draft (see the seeding effect below); the ref is
  // what the async draft mutation reads, so it can never act on a stale render.
  const inputTextRef = useRef("");
  const writeInput = (text: string): void => {
    inputTextRef.current = text;
    setInputText(text);
  };
  const [preview, setPreview] = useState<Readonly<{ turnHandle: string; text: string }> | null>(null);
  // The character card's own openings, for a conversation that has not started:
  // read from the companion's greeting record and never invented. `null` means
  // "not read yet", an empty array means "the card carries none".
  const [icebreakers, setIcebreakers] = useState<readonly Readonly<{ index: number; text: string }>[] | null>(null);
  const icebreakerReadRef = useRef(false);
  // The chat mutation currently in flight. The submit button already has its own
  // gate; swipe and regenerate had none, so a double click issued two admitted
  // commands (regenerate mints a fresh idempotency key per click). The ref is the
  // synchronous single-flight guard, the state is the projection the surface shows.
  const [chatMutation, setChatMutation] = useState<Readonly<{ kind: "swipe" | "regenerate" | "opening"; handle: string }> | null>(null);
  const chatMutationRef = useRef(false);
  // The durable draft's authoring state is the composer's own field (see the
  // seeding effect below); what stays here is the closed outcome line its
  // Save/Discard report through.
  const [draftNotice, setDraftNotice] = useState<Readonly<{ kind: "success" | "failure"; text: string }> | null>(null);
  // Set when the fallback poll spends its whole budget without an authoritative
  // settlement: the pending record is then cleared and this line says the turn
  // failed rather than silently leaving the composer disabled.
  const [pollFailure, setPollFailure] = useState(false);
  /**
   * The optimistic player message: the text the player just sent, keyed by the idempotency key
   * the send already minted. It is shown until the Host's authoritative transcript for that key
   * lands and is never replayed on a reconnect or re-read (a fresh mount starts with none), so a
   * settled turn leaves no ghost and the pair collapses to the one authoritative message.
   */
  const [optimistic, setOptimistic] = useState<Readonly<{ idempotencyKey: string; text: string }> | null>(null);
  // The durable revision the editor was last seeded from: what lets a later
  // authoritative revision replace the editor without ever discarding text the
  // player has typed past the last seed.
  const seededDraftRef = useRef<Readonly<{ revision: number; text: string }> | null>(null);
  const localeRef = useRef<Locale>(resolveLocale());
  const cancelledRef = useRef(false);
  const pollActiveRef = useRef(false);
  // True only while a live event-stream connection is open, and true once that
  // stream has failed while the current turn was in flight. The 250 ms/1000 ms
  // fallback poll exists for a turn no stream is delivering, so a healthy stream
  // suspends it instead of running a second channel over the same turn - and a
  // stream that failed for this turn is not trusted for it again, even after it
  // reconnects, so a flapping stream cannot starve the fallback of a window.
  const streamLiveRef = useRef(false);
  const streamFailedRef = useRef(false);
  const eventSourceRef = useRef<{ close(): void } | null>(null);
  // The open contextual panel, as the URL states it. A refresh with
  // `#…&panel=game` comes back with the drawer already open.
  const [openPanel, setOpenPanel] = useState<string | null>(() => readPanelFromUrl());
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
  // The surface occupying the main region. Chat is the default surface, not a
  // privileged one: every surface takes the same region, and the URL names the
  // selected one so Back returns to the previous surface.
  const shownSurface = openPanel ?? CHAT_PANEL;
  const gameEntryRef = useRef<HTMLButtonElement>(null);
  const chatEntryRef = useRef<HTMLButtonElement>(null);
  const chatsEntryRef = useRef<HTMLButtonElement>(null);
  const charactersEntryRef = useRef<HTMLButtonElement>(null);
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

  const commit = useCallback((next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  const labels = () => messages(view.kind === "ready" ? view.locale : localeRef.current);

  useEffect(() => {
    applyDocumentLocale(localeRef.current);
  }, []);

  // Browser Back moves between surfaces, because the selected surface is a
  // history entry rather than hidden state (design/26 §7.2). Escape returns to
  // the conversation from any other surface.
  useEffect(() => {
    const syncPanelWithHistory = (): void => setOpenPanel(readPanelFromUrl());
    window.addEventListener("popstate", syncPanelWithHistory);
    return () => window.removeEventListener("popstate", syncPanelWithHistory);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (shownSurface === CHAT_PANEL) return;
      // Stepping the history back removes the entry that selected this surface,
      // so a later refresh cannot resurrect it; a surface restored from a URL
      // this session never pushed returns to the conversation in place instead.
      if (window.history.state?.gbPanel !== undefined) {
        window.history.back();
        return;
      }
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.delete(PANEL_PARAM);
      url.hash = params.toString();
      window.history.replaceState(null, "", url.toString());
      setOpenPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shownSurface]);

  // Returning to the conversation puts the player back where they type. A
  // surface's own landing place is its heading (`SurfaceView`), which is right
  // for a peer surface a keyboard user is stepping into; the conversation's
  // landing place is the composer's field, and `Composer` owns that field, so the
  // shell reaches it by the class the composer renders - the same handle the
  // mounted gates use. Only a return moves focus; the first paint does not.
  const previousSurfaceRef = useRef<string>(shownSurface);
  useEffect(() => {
    const returned = shownSurface === CHAT_PANEL && previousSurfaceRef.current !== CHAT_PANEL;
    previousSurfaceRef.current = shownSurface;
    if (returned) document.querySelector<HTMLTextAreaElement>(".composer-textarea")?.focus();
  }, [shownSurface]);

  // Selecting a surface is one history entry (design/104 §2). The entries are the
  // shell's surface switcher, so all of them share this one behaviour.
  const openPanelOf = (panel: string, entryRef: React.RefObject<HTMLButtonElement | null>): (() => void) => (): void => {
    void entryRef;
    if (openPanel !== panel) {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.set(PANEL_PARAM, panel);
      url.hash = params.toString();
      window.history.pushState({ gbPanel: panel }, "", url.toString());
    }
    setOpenPanel(panel);
  };

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const bootToken = params.get("boot");
        const restoredPanel = params.get(PANEL_PARAM);
        const root = bootToken === null
          ? await composedApiRef.current.readState()
          : await composedApiRef.current.bootstrap(bootToken);
        if (bootToken !== null) {
          const url = new URL(window.location.href);
          // The one-time boot token is stripped from the fragment; a panel the
          // URL already names survives the rewrite.
          url.hash = restoredPanel === null
            ? "profile=composed-reference-game"
            : `profile=composed-reference-game&${PANEL_PARAM}=${encodeURIComponent(restoredPanel)}`;
          window.history.replaceState(null, "", url.toString());
        }
        const draft = await tavernApiRef.current.readDraft();
        if (
          root.chat.chat === null ||
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        ) {
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        }
        if (!active) return;
        const session = createReferencePipelineSession(root.chat);
        setPreview(null);
        commit({ kind: "ready", root, session, draft, locale: localeRef.current });
      } catch (error) {
        if (active) commit(problemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [commit]);

  const eventStreamEpoch = view.kind === "ready" ? `${view.session.snapshot.eventStream?.epoch ?? ""}#${mountedChatRevision}` : undefined;


  useEffect(() => {
    if (view.kind !== "ready" || view.session.snapshot.eventStream === null) return;
    let disposed = false;
    let recovering = false;
    let work = Promise.resolve();
    let cursor = view.session.snapshot.eventStream.cursor;
    let pendingResetCursor = false;

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
          session = current.session.applySnapshot(root.chat);
        } catch (error) {
          // A committed Chat switch replaces the mounted identity itself: the new
          // snapshot cannot be reconciled with the old session, so the session is
          // rebuilt from it instead of failing the whole surface.
          if (!(error instanceof ReferencePipelineSessionError) || error.code !== "state_reconciliation_required")
            throw error;
          session = createReferencePipelineSession(root.chat);
          rebuilt = true;
        }
        if (
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        ) throw new ReferencePipelineSessionError("state_reconciliation_required");
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
        commit({
          kind: "ready",
          root,
          session: terminalTurn(root.chat.chat.turn) ? session.withPending(null) : session,
          draft,
          locale: current.locale,
        });
      } catch (error) {
        if (!disposed) commit(problemView(error, messages(localeRef.current)));
      } finally {
        recovering = false;
        if (pendingResetCursor && !disposed) void recover(true);
        else if (!disposed && viewRef.current.kind === "ready") connect();
      }
    };
    const handleEvent = (event: BrowserEventV1, lastEventId: string): void => {
      work = work.then(async () => {
        if (disposed || recovering) return;
        try {
          const current = viewRef.current;
          if (current.kind !== "ready") return;
          const checkpointed = current.session.applyEvent(event);
          cursor = lastEventId;
          if (event.eventType === "companion.delta") {
            setPreview((existing) => Object.freeze({
              turnHandle: event.payload.turnHandle,
              text: existing?.turnHandle === event.payload.turnHandle
                ? `${existing.text}${event.payload.delta}`
                : event.payload.delta,
            }));
            return;
          }
          if (event.eventType === "message.committed" || event.eventType === "turn.state_changed") setPreview(null);
          const root = await composedApiRef.current.readState();
          const draft = await tavernApiRef.current.readDraft();
          if (disposed || root.chat.chat === null) return;
          if (
            draft.revision !== root.chat.chat.draft.revision ||
            (draft.text !== null) !== root.chat.chat.draft.present
          ) throw new ReferencePipelineSessionError("state_reconciliation_required");
          const session = checkpointed.applySnapshot(root.chat);
          setPreview(null);
          // The authoritative turn is settled, so a pending record for it is spent
          // - the same rule the fallback poll applies to the turns it settles. The
          // stream is the live channel and the poll is suspended underneath it, so
          // without this the record - and with it the composer - would survive the
          // very settle the stream just delivered.
          commit({
            kind: "ready",
            root,
            session: terminalTurn(root.chat.chat.turn) ? session.withPending(null) : session,
            draft,
            locale: current.locale,
          });
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
   * The draft a poll hop must project, taken from the composed snapshot the hop
   * has already read. `/state` carries the durable draft's revision and presence,
   * so a snapshot that agrees with the draft this surface already holds needs no
   * `/draft` read at all; the route is read on the one hop where the text itself
   * has moved. The compare-and-swap below is the same one the per-hop read used to
   * perform after the fact, so nothing is trusted that was not reconciled.
   */
  const resolvePollDraft = async (
    held: BrowserDraftV1,
    chat: Readonly<{ draft: Readonly<{ revision: number; present: boolean }> }>,
  ): Promise<BrowserDraftV1> => {
    if (held.revision === chat.draft.revision && (held.text !== null) === chat.draft.present) return held;
    const draft = await tavernApiRef.current.readDraft();
    if (draft.revision !== chat.draft.revision || (draft.text !== null) !== chat.draft.present)
      throw new ReferencePipelineSessionError("state_reconciliation_required");
    return draft;
  };

  const startPolling = (): void => {
    if (pollActiveRef.current) return;
    // A turn trusts the stream afresh: only a failure that happened while this
    // turn was in flight counts against it.
    streamFailedRef.current = false;
    pollActiveRef.current = true;
    let attempts = 0;
    const schedule = (delayMs: number): void => {
      if (cancelledRef.current) {
        pollActiveRef.current = false;
        return;
      }
      window.setTimeout(() => void tick(), delayMs);
    };
    const tick = async (): Promise<void> => {
      if (cancelledRef.current) {
        pollActiveRef.current = false;
        return;
      }
      const current = viewRef.current;
      if (current.kind !== "ready" || current.session.pending === null) {
        pollActiveRef.current = false;
        return;
      }
      // The stream is the live channel and this poll is only its fallback, so a
      // hop costs nothing while the stream is open and has not failed for this
      // turn: the authoritative reread it would perform is the stream's own job.
      // An open stream that never settles burns the same budget an HTTP hop does,
      // so silence past the budget resumes the poll rather than leaving the
      // composer locked behind a dead channel.
      if (streamLiveRef.current && !streamFailedRef.current && attempts < MAX_POLL_ATTEMPTS) {
        attempts += 1;
        schedule(POLL_INTERVAL_MS);
        return;
      }
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        pollActiveRef.current = false;
        // No authoritative settlement arrived inside the budget. Drop the
        // content-free pending record so the composer - and Stop, for a turn the
        // snapshot still marks cancellable - work again, and report the failure.
        commit({ ...current, session: current.session.withPending(null) });
        setPollFailure(true);
        return;
      }
      const pending = current.session.pending;
      try {
        const root = await composedApiRef.current.readState();
        if (root.chat.chat === null)
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        const draft = await resolvePollDraft(current.draft, root.chat.chat);
        let session = current.session.applySnapshot(root.chat);
        if (session.pending !== null) {
          const status = await tavernApiRef.current.readSubmissionStatus({
            apiVersion: 1,
            idempotencyKey: pending.idempotencyKey,
            selectionGeneration: pending.selectionGeneration,
          });
          session = session.withPending(applyStatus(session.pending, status).pending);
        }
        const next = { kind: "ready" as const, root, session, draft, locale: current.locale };
        if (terminalTurn(root.chat.chat?.turn ?? null)) {
          // The authoritative turn is settled; a pending record for it is spent
          // whatever an out-of-date submission status still says, and keeping it
          // is what would leave the composer disabled forever.
          commit(session.pending === null ? next : { ...next, session: session.withPending(null) });
          pollActiveRef.current = false;
          return;
        }
        commit(next);
        if (session.pending === null) {
          pollActiveRef.current = false;
          return;
        }
        schedule(POLL_INTERVAL_MS);
      } catch (error) {
        if (cancelledRef.current) {
          pollActiveRef.current = false;
          return;
        }
        if (
          error instanceof ReferencePipelineSessionError ||
          error instanceof TavernProtocolError ||
          (error instanceof TavernProblemError && !error.retryable) ||
          error instanceof ComposedReferenceGameProtocolError ||
          (error instanceof ComposedReferenceGameProblemError && !error.retryable)
        ) {
          commit(problemView(error, messages(current.locale)));
          pollActiveRef.current = false;
          return;
        }
        const backoff = POLL_BACKOFF_MS[Math.min(attempts, POLL_BACKOFF_MS.length) - 1] ?? POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1];
        schedule(backoff);
      }
    };
    schedule(POLL_FIRST_MS);
  };

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
    seededDraftRef.current = Object.freeze({ revision: current.draft.revision, text: "" });
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
      if (error instanceof TavernProblemError && !error.retryable) {
        commit({ ...current, session: current.session.withPending(null) });
        commit(problemView(error, messages(current.locale)));
        return;
      }
    }
    startPolling();
  };

  /**
   * Authoritative reread for a Chat-owned operation. The Chat draft is this
   * surface's own subject, so the durable draft is read alongside the composed
   * root and its revision must still reconcile with that root's Chat
   * projection: a revision that moved under a Chat mutation is a real conflict
   * and fails closed.
   */
  const rereadChat = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const root = await composedApiRef.current.readState();
    const draft = await tavernApiRef.current.readDraft();
    if (root.chat.chat === null || draft.revision !== root.chat.chat.draft.revision || (draft.text !== null) !== root.chat.chat.draft.present) {
      throw new ReferencePipelineSessionError("state_reconciliation_required");
    }
    setPreview(null);
    commit({ ...current, root, session: current.session.applySnapshot(root.chat), draft });
  };

  /**
   * The composer's field follows the durable draft: the first authoritative
   * revision seeds it, and a later revision the player has not typed past
   * replaces it. An unsaved local value - whether the player is writing the
   * draft or a different message - is never silently discarded by a background
   * reread; the mutation that owns it resolves it.
   */
  useEffect(() => {
    if (view.kind !== "ready") return;
    const seeded = seededDraftRef.current;
    if (seeded !== null && seeded.revision === view.draft.revision) return;
    const durable = view.draft.text ?? "";
    if (seeded !== null && inputTextRef.current !== seeded.text) {
      seededDraftRef.current = Object.freeze({ revision: view.draft.revision, text: inputTextRef.current });
      return;
    }
    seededDraftRef.current = Object.freeze({ revision: view.draft.revision, text: durable });
    writeInput(durable);
  }, [view]);

  /** Takes a validated durable draft read-back as the composer field's new truth. */
  const seedDraft = (draft: BrowserDraftV1): void => {
    const text = draft.text ?? "";
    seededDraftRef.current = Object.freeze({ revision: draft.revision, text });
    writeInput(text);
  };

  /**
   * The first screen's break-ice chips are the card's own openings, so they are
   * read from the companion's greeting record rather than authored here. Only a
   * conversation that has not started yet has a first thing to say - which
   * includes the companion's committed opening message, the state a
   * card-provisioned Chat actually opens in (`firstScreenOpen`) - so the record
   * is read once per such conversation and dropped as soon as the first screen
   * ends. A record that cannot be read, or that carries no variant, yields no
   * chip at all - this surface never fabricates an opening the card does not
   * carry.
   */
  useEffect(() => {
    if (view.kind !== "ready") return;
    if (!firstScreenOpen(view.session.snapshot.chat?.transcript ?? [])) {
      icebreakerReadRef.current = false;
      setIcebreakers(null);
      return;
    }
    if (icebreakerReadRef.current) return;
    icebreakerReadRef.current = true;
    let active = true;
    void (async () => {
      try {
        const greeting = await managementPipelineApiRef.current.readGreeting();
        if (!active) return;
        setIcebreakers(
          greeting.present
            ? greeting.variants.map((variant, index) => Object.freeze({ index, text: variant.text }))
            : [],
        );
      } catch {
        if (active) setIcebreakers([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [view]);

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
    } catch {
      try {
        const draft = await managementPipelineApiRef.current.readDraft();
        seedDraft(draft);
        setDraftNotice({ kind: "failure", text: labels().failure });
        const fresh = viewRef.current;
        if (fresh.kind === "ready") commit({ ...fresh, draft });
      } catch {
        setDraftNotice({ kind: "failure", text: labels().failure });
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

  /**
   * A break-ice chip: one of the card's own openings, on a conversation that has
   * not started. Tapping it records that opening through the Host's own
   * `chat.opening` route and then says it through this composer's one submit
   * path - there is no second composer and no second submit authority. The
   * record is legal only while the mounted Chat's opening is an unlocked
   * greeting; a refusal must not eat the message the player tapped, and the
   * authoritative reread - never this handler - is what the transcript shows.
   */
  const handleIcebreaker = (chip: Readonly<{ index: number; text: string }>): void => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.pending !== null) return;
    const selection = current.session.snapshot.selection;
    void (async () => {
      if (selection !== null) {
        try {
          await managementPipelineApiRef.current.selectOpeningVariant(
            { apiVersion: 1, selectionGeneration: selection.generation, targetIndex: chip.index },
            current.session.snapshot.csrfToken,
          );
        } catch {
          // The Chat's opening is not a greeting variant that can be chosen here,
          // or the route is not served on this profile. The chip's line is still
          // the player's to send, so the send below is not conditional on it.
        }
      }
      writeInput(chip.text);
      await handleSend();
    })();
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
   * Follows a committed Chat switch. The Host has already released the previous
   * mounted Chat and mounted the selected one, so the mounted identity itself is
   * new: this shell rebuilds its session from the fresh snapshot (there is nothing
   * to reconcile it with) and restarts the live cursor on the new conversation.
   */
  const handleChatSwitched = (): void => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    void (async () => {
      try {
        const root = await composedApiRef.current.readState();
        const draft = await tavernApiRef.current.readDraft();
        if (cancelledRef.current || root.chat.chat === null) return;
        if (
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        )
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        setPreview(null);
        const base = createReferencePipelineSession(root.chat);
        const session = root.chat.eventStream === null ? base : base.resetEventCheckpoint();
        setMountedChatRevision((revision) => revision + 1);
        commit({ ...current, root, session, draft });
      } catch (error) {
        commit(problemView(error, messages(current.locale)));
      }
    })();
  };

  /**
   * The World Info revision this surface shows. The composed Chat projection
   * carries no World Info at all (`chat.worldInfo: null` in the composed root and
   * a profile identity the management wire validator rejects), so this mount reads
   * the dedicated `GET /world-info` route the management dispatcher serves on the
   * same origin; the bind's compare-and-swap carries the composed snapshot's own
   * selection generation.
   */
  const readProductWorldInfo = useCallback(async (): Promise<WorldInfoSurfaceSource> => {
    const current = viewRef.current;
    return {
      worldInfo: await managementPipelineApiRef.current.readWorldInfo(),
      selectionGeneration:
        current.kind === "ready" ? current.session.snapshot.selection?.generation ?? 0 : 0,
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
    const operation = current.kind === "ready"
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

  const submitAvailable = view.kind === "ready" && view.session.pending === null && view.session.snapshot.operations.some((op) => op.operationId === "chat.submit" && op.availability === "available");
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
  const stopAvailable = view.kind === "ready" && view.session.snapshot.chat?.turn?.canCancel === true && view.session.snapshot.operations.some((op) => op.operationId === "chat.cancel" && op.availability === "available");
  const terminalTurnNotice = view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "cancelled"
    ? labels().chatStopped
    : view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "failed" ? labels().chatFailed : null;
  // The app-bar indicator is the Chat surface's own connection/turn fact: a turn
  // is in flight from the moment a submission is admitted until the authoritative
  // turn reaches a terminal state. The Game connection has its own drawer
  // (design/26 §4.1, design/104 §2); it is not announced from here.
  const turnInFlight = view.kind === "ready" && (
    view.session.pending !== null ||
    (view.session.snapshot.chat?.turn != null &&
      !TERMINAL_TURN_STATES.has(view.session.snapshot.chat.turn.state))
  );

  const managementPanelsAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat !== null;

  const openGamePanel = openPanelOf(GAME_PANEL, gameEntryRef);
  const openChat = openPanelOf(CHAT_PANEL, chatEntryRef);
  const openChats = openPanelOf(CHATS_PANEL, chatsEntryRef);
  const openCharacters = openPanelOf(CHARACTERS_PANEL, charactersEntryRef);
  const openSettings = openPanelOf(SETTINGS_PANEL, settingsEntryRef);
  const openMemory = openPanelOf(MEMORY_PANEL, memoryEntryRef);

  return (
    <div className="tavern-app-shell" data-profile="composed-reference-game">
      <SkipLink label={labels().skipToChat} />
      {view.kind === "loading" && <main id="main-content" className="app-main-content"><div className="state-placeholder"><p className="loading-text">{labels().openingChat}</p></div></main>}
      {view.kind === "problem" && <ProblemView title={view.title} detail={view.detail} />}
      {view.kind === "ready" && view.session.snapshot.chat !== null && (
        <>
           <AppBar
             brandMark={labels().appMark}
             brandLabel={labels().appName}
             companionName={view.session.snapshot.chat.companion.name}
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
                     { id: CHATS_PANEL, label: labels().chatsPanel, icon: MessagesSquare, active: shownSurface === CHATS_PANEL, onClick: openChats, ref: chatsEntryRef },
                     { id: CHARACTERS_PANEL, label: labels().charactersPanel, icon: Users, active: shownSurface === CHARACTERS_PANEL, onClick: openCharacters, ref: charactersEntryRef },
                     { id: SETTINGS_PANEL, label: labels().settingsPanel, icon: Settings, active: shownSurface === SETTINGS_PANEL, onClick: openSettings, ref: settingsEntryRef },
                     { id: MEMORY_PANEL, label: labels().memoryPanel, icon: Brain, active: shownSurface === MEMORY_PANEL, onClick: openMemory, ref: memoryEntryRef },
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
                chatTitle={view.session.snapshot.chat.title}
                labels={labels()}
                pending={chatMutation}
                pendingPlayerMessage={pendingOptimisticMessage}
                notice={pollFailure ? labels().chatFailed : terminalTurnNotice}
                onSwipe={(messageHandle, direction) => void handleSwipe(messageHandle, direction)}
                onRegenerate={(messageHandle) => void handleRegenerate(messageHandle)}
                onOpeningVariant={(messageHandle, direction) => void handleOpeningVariant(messageHandle, direction)}
                value={inputText}
                onChange={writeInput}
                onSend={() => void handleSend()}
                onStop={() => void handleStop()}
                isGenerating={stopAvailable}
                disabled={!submitAvailable}
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
                chips={
                  // The card's own openings, and only where a first thing to say
                  // still exists: a conversation that has started (the player has
                  // spoken, or the Host committed a reply after the opening), an
                  // unread record, a card with no opening material and a locked
                  // composer all render none. The companion's own committed
                  // opening is still the first screen, not a started conversation.
                  submitAvailable &&
                  icebreakers !== null &&
                  icebreakers.length > 0 &&
                  firstScreenOpen(view.session.snapshot.chat?.transcript ?? [])
                    ? {
                        label: labels().openingChipsLabel,
                        items: icebreakers.map((chip) => ({
                          id: `opening-${chip.index}`,
                          text: chip.text,
                          onClick: () => handleIcebreaker(chip),
                        })),
                      }
                    : undefined
                }
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
