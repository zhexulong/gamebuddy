import { randomUUID } from "node:crypto";
import { type CompanionArrivalHistory, companionArrivalFact } from "./companion-arrival-fact.js";
import type { CompanionInterruption, StopAdmission } from "./companion-interruption.js";
import type { CompanionLiveSourceEvidenceSink } from "./companion-live-source-attestation.js";
import {
  type CompanionLoop,
  isProviderEmptyCompletion,
  type NativeGameCompanionContent,
  type NativeGameContentPresenter,
  PROVIDER_EMPTY_COMPLETION,
} from "./companion-loop.js";
import type { CompanionTurnOutcome, WorldFact } from "./event-pump.js";
import type { IntegrationEventSource, IntegrationLifecycleEvent } from "./integration-launcher.js";
import { NativeNoticeLedger } from "./native-notice-fact.js";
import type {
  CompanionTextPort,
  GameCompanionTextExpression,
  HostPresentationAdmissionProvider,
} from "./presentation.js";
import type { ExecutionReceipt, Snapshot } from "./protocol.js";
import {
  boundProviderFailureLine,
  classifyProviderFailure,
  type ProviderFailureClass,
} from "./provider-failure-classification.js";
import { formatSnapshotHud } from "./snapshot-hud.js";
import {
  resolveProviderFailureSystemNotice,
  resolveProviderWaitSystemNotice,
  resolveStopSystemNotice,
  type SystemNotice,
} from "./system-notices.js";
import { deliverFinalVoiceInput, type FinalVoiceInput } from "./voice.js";

export type FinalVoiceSource = Readonly<{ onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void }>;

/** Frozen refusal singletons: one shared value, never a fresh object per call. */
const REFUSED_PLAYER_INPUT = Object.freeze({
  session_closed: Object.freeze({ accepted: false, reasonCode: "player_input_session_closed" }),
  integration_unavailable: Object.freeze({ accepted: false, reasonCode: "player_input_integration_unavailable" }),
  run_terminated: Object.freeze({ accepted: false, reasonCode: "player_input_run_terminated" }),
  empty: Object.freeze({ accepted: false, reasonCode: "player_input_empty" }),
} as const);

/**
 * Voice-local playback observations (v2 push lane). The Host only derives a
 * bounded "上一句语音被打断" note for the next prompt assembly; it never
 * touches ChatThreadStore and never cancels any Game action.
 */
export type VoicePlaybackObservationSource = Readonly<{
  onPlaybackObservation(
    listener: (observation: Readonly<{ terminalStatus: string; speechJobId: string | undefined }>) => void,
  ): () => void;
}>;

/** Host-owned outcome of a newly admitted STOP, derived only from Pi consumption state. */
export type StopOutcome = "active_turn_cancelled" | "queued_turn_cancelled" | "no_active_turn";

/**
 * Why the Host refused a player message.
 *
 * The Host deliberately refuses input it cannot honestly deliver: while the
 * integration admission is closed the world view is stale (an overflow or a
 * disconnect revoked it), and a STOP-free session that is already closed has no
 * reader at all. What must NEVER happen is refusing SILENTLY:
 *
 *   - a real player typing into the game would lose their message with no sign,
 *   - a harness would see "accepted" and report a turn that never happened.
 *
 * Measured on a real ladder-5 run (2026-10-05): the runner submitted its prompt
 * into a closed admission, `acceptPlayerInput` returned void, the call site
 * resolved in ~1s with no snapshot (revision 0), no tool call and no receipt,
 * and the result read like "the companion chose to do nothing".
 */
export type PlayerInputRefusalCode =
  | "player_input_session_closed"
  | "player_input_integration_unavailable"
  | "player_input_run_terminated"
  | "player_input_empty";

/**
 * Admission outcome of one player message. `accepted` means ENQUEUED for
 * delivery, and it is returned only after that delivery ran to settlement, so
 * it also carries how the turn ENDED (`turnOutcome`). A provider/runtime failure
 * is no longer indistinguishable from an answer: it used to be discarded at the
 * Game loop's content observer (`onRejected`) and reached the caller as an
 * ordinary accepted message. A later transport failure before consumption still
 * throws, because then the message was admitted but never delivered.
 */
export type PlayerInputDisposition =
  | Readonly<{ accepted: true; turnOutcome: CompanionTurnOutcome }>
  | Readonly<{ accepted: false; reasonCode: PlayerInputRefusalCode }>;

/** Source-owned settlement emitted only after exact Host/Mod STOP correlation. */
export type StopSettledPayload = Readonly<{
  stopId: string;
  sourceEventId: string;
  batchId: string | null;
  epoch: number;
  observationRevision: number;
}>;

/**
 * One consumed player turn admits a bounded sequence of native expressions, not
 * exactly one: incremental presentation commits each completed sentence as it
 * arrives so the player sees the companion speak before the turn ends, and a
 * single reply legitimately spans several short pieces.
 *
 * The bound keeps the surface replay-safe without ever refusing a reply the text
 * layer already accepted: every piece comes from the same reply, so the turn's
 * cumulative presented bytes can never exceed one reply's own text budget
 * (`MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES`). A duplicated or looping delta stream
 * is what pushes past it, and that must fail closed instead of being drawn into
 * unbounded native chat. This is an exact bound, not a heuristic — and it is
 * also the only one needed: a piece is refused when empty, so every accepted
 * piece is at least one byte and the piece count is therefore bounded by the
 * byte budget itself.
 *
 * A separate piece-count ceiling is deliberately NOT imposed: a legal reply may
 * consist of thousands of one-sentence units (e.g. "好。" repeated) inside the
 * same byte budget, and a count cap below the byte budget would refuse text the
 * text layer already accepted — the exact false-rejection class this bound
 * exists to avoid.
 *
 * Text equality is deliberately NOT an admission check: a reply may legitimately
 * repeat a line ("好的。好的。"), so refusing repeats would crash on valid output.
 * Replay of a re-sent request is already refused by the Game port's per-piece
 * `expressionId` idempotency, and an uncertain commit closes the turn.
 */
export const MAX_NATIVE_PRESENTATION_TURN_BYTES = 16_384;

/**
 * How many empty completions one delivered prompt may end with before the run is over.
 *
 * <p>
 * Three, because an empty answer is worth asking for once more - a provider that hiccuped answers the same prompt on the
 * next attempt - while a provider that answers with nothing three times in a row is not going to produce a turn, and a
 * fourth attempt would only make the stall look longer. The retry is the SAME prompt: `EventPump` restores the exact
 * batch a rejected delivery owned, so the retry carries the facts the first attempt carried, not a fresh composition.
 * </p>
 */
const PROVIDER_EMPTY_COMPLETION_ATTEMPTS = 3;

/**
 * The pause before re-asking a prompt that came back empty.
 *
 * <p>
 * Short on purpose: nothing an empty completion says asks the operator to wait. It exists only so the retry is not a
 * tight loop against a provider in the first milliseconds after it answered nothing.
 * </p>
 */
const PROVIDER_EMPTY_COMPLETION_RETRY_DELAY_MS = 250;

/**
 * The fact that ended a run of turns: a provider kept answering with nothing, so no further turn can be expected.
 *
 * <p>
 * It is published rather than acted on destructively. The Game world, the bridge and the run's own state stay exactly
 * where they are - only this session's turns stop - so a verdict can say `provider_empty_completion` instead of nothing
 * at all. Before this existed the same run idled for 148 minutes with the game alive and the bridge connected, which
 * from outside is indistinguishable from a companion still thinking (2026-11-07).
 * </p>
 */
export type HostRunTermination = Readonly<{
  code: typeof PROVIDER_EMPTY_COMPLETION;
  /** How many empty completions this session received, retried ones included. */
  emptyCompletions: number;
}>;

/**
 * Private production turn authority; no model/tool identity can mint lineage.
 * Every captured admission stays valid for the whole turn and for every piece,
 * so a piece produced before an earlier piece finishes committing is never
 * rejected as stale during normal sequential draining.
 */
export class GameTurnLineageTracker {
  #lineage: Readonly<{ sourceEventId: string; generation: number }> | undefined;
  #presentedBytes = 0;
  #generation = 0;
  beginPlayerBatch(sourceEventId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceEventId)) throw new Error("invalid_presentation_source_event_id");
    this.#lineage = Object.freeze({ sourceEventId, generation: this.#generation });
    this.#presentedBytes = 0;
  }
  endBatch(): void {
    // Clearing the lineage ends the turn's admission window. A consumed batch
    // that never spoke is legitimate (tool-only, empty, or rejected text), and
    // an over-budget turn already failed closed at capture, so there is no
    // remaining condition to assert here.
    this.#lineage = undefined;
    this.#presentedBytes = 0;
  }
  revoke(): void {
    this.#generation += 1;
    this.#lineage = undefined;
    this.#presentedBytes = 0;
  }
  /**
   * A piece whose native commit failed is an uncertain delivery for the whole
   * turn: the failed piece may have landed, so the turn is over and no later
   * piece may be admitted. This keeps the sequence contract from quietly turning
   * one uncertain commit into a stream of further native chat.
   */
  closeForUncertainDelivery(): void {
    this.#lineage = undefined;
    this.#presentedBytes = 0;
  }
  capture(
    expectedSourceEventId?: string,
    /**
     * The exact text about to be presented, when this is a text commit. Its
     * UTF-8 size feeds the turn's cumulative budget; the value itself is not
     * inspected (a reply may legitimately repeat a line).
     */
    text?: string,
  ): Readonly<{
    surface: "game";
    sourceEventId: string;
    admission: Readonly<{ hostBinding: object; assertHostCurrent(binding: object): void }>;
  }> {
    const lineage = this.#lineage;
    if (lineage === undefined) throw new Error("presentation_lineage_unavailable");
    if (expectedSourceEventId !== undefined && lineage.sourceEventId !== expectedSourceEventId)
      throw new Error("native_game_presentation_lineage_mismatch");
    if (text !== undefined) {
      const textBytes = Buffer.byteLength(text, "utf8");
      if (textBytes <= 0) throw new Error("invalid_presentation_text_size");
      if (this.#presentedBytes + textBytes > MAX_NATIVE_PRESENTATION_TURN_BYTES)
        throw new Error("player_turn_presentation_budget_exceeded");
      this.#presentedBytes += textBytes;
    }
    const binding = Object.freeze({ generation: lineage.generation });
    return Object.freeze({
      surface: "game" as const,
      sourceEventId: lineage.sourceEventId,
      admission: Object.freeze({
        hostBinding: binding,
        // Identity is asserted against this exact turn's lineage object, so a
        // piece that finishes after the turn closed (or that belongs to another
        // turn) is still rejected. Within one turn the identity stays stable,
        // so ordered pieces cannot invalidate each other.
        assertHostCurrent: (candidate: object) => {
          if (candidate !== binding || this.#generation !== lineage.generation || this.#lineage !== lineage)
            throw new Error("stale_presentation_lineage");
        },
      }),
    });
  }
}

/**
 * Binds a real Pi-consumed source lineage to the runtime interruption epoch.
 * Both opaque capabilities must still be current immediately at presentation
 * commit; a tracker-only revoke is never a substitute for epoch authority.
 */
export function createGamePresentationAdmissionProvider(
  turnTracker: GameTurnLineageTracker,
  interruption: CompanionInterruption,
): Readonly<{
  capture(
    expectedSourceEventId: string,
    /** The exact text about to be presented, when this is a text commit. */
    text?: string,
  ): Readonly<{
    surface: "game";
    sourceEventId: string;
    admission: Readonly<{ hostBinding: object; assertHostCurrent(binding: object): void }>;
  }>;
  closeForUncertainCommit(): void;
}> {
  return Object.freeze({
    capture: (expectedSourceEventId: string, text?: string) => {
      const capturedLineage = turnTracker.capture(expectedSourceEventId, text);
      const interruptionBinding = interruption.capture();
      const binding = Object.freeze({});
      return Object.freeze({
        surface: "game" as const,
        sourceEventId: capturedLineage.sourceEventId,
        admission: Object.freeze({
          hostBinding: binding,
          assertHostCurrent: (candidate: object) => {
            if (candidate !== binding) throw new Error("stale_presentation_lineage");
            capturedLineage.admission.assertHostCurrent(capturedLineage.admission.hostBinding);
            interruption.assertCurrent(interruptionBinding);
          },
        }),
      });
    },
    closeForUncertainCommit: () => turnTracker.closeForUncertainDelivery(),
  });
}

function isAuthenticatedStardewPlayerControl(value: unknown): value is Readonly<{
  kind: "player_input" | "stop_all";
  controlId: string;
  sourceEventId: string;
  text: string | undefined;
  locale: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const opaque = (entry: unknown): entry is string => typeof entry === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry);
  if (
    !opaque(candidate.controlId) ||
    !opaque(candidate.sourceEventId) ||
    typeof candidate.locale !== "string" ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(candidate.locale)
  )
    return false;
  if (candidate.kind === "stop_all" && candidate.text === undefined) return true;
  if (
    candidate.kind === "player_input" &&
    typeof candidate.text === "string" &&
    candidate.text.trim().length > 0 &&
    candidate.text.length <= 4_000
  )
    return true;
  return false;
}

function isAuthenticatedModStopObservation(
  value: unknown,
): value is Readonly<{ kind: "body_settled"; stopId: string; sourceEventId: string; epoch: number }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "body_settled" &&
    typeof candidate.stopId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(candidate.stopId) &&
    typeof candidate.sourceEventId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(candidate.sourceEventId) &&
    Number.isSafeInteger(candidate.epoch) &&
    (candidate.epoch as number) >= 1
  );
}

function isEventPumpOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "event_pump_terminal_overflow" || error.message === "event_pump_event_overflow")
  );
}

/**
 * Host glue with deliberately limited authority: validated adapter facts become
 * ordinary Agent turns; it neither plans actions nor predicts execution outcomes.
 */
export class CompanionHostService {
  readonly #unsubscribe: () => void;
  readonly #unsubscribeConnection: () => void;
  #unsubscribeVoice: (() => Promise<void>) | undefined;
  #unsubscribePlayback: (() => Promise<void>) | undefined;
  /** Voice-local note consumed by the next prompt assembly; never Chat/Game state. */
  #voiceInterruptionNote: Readonly<{ atMs: number; speechJobId: string | undefined }> | undefined;
  #flushScheduled = false;
  /**
   * How the most recent delivered turn ended, as reported by the loop. `accepted` player input is
   * returned after the turn settled, so the caller can be told whether the companion actually answered;
   * `unobserved` until a turn has been delivered (and whenever a flush had nothing to deliver).
   */
  #lastTurnOutcome: CompanionTurnOutcome = "unobserved";
  /**
   * Consecutive delivered turns that ended with the model doing nothing (a spoken line, no action), with no pending
   * delivery to justify another one.
   *
   * <p>
   * MEASURED 2026-10-30 (`round9`): the companion came home at in-game 18:20, said "进屋了。门槛上的泥磕掉了，手也搓干净
   * 了，锅我架上了。", and stopped. `stop=stop`, no tool call, world static - so `EventPump.hasPendingDelivery` was false,
   * the `finally` in `flushSoon` saw nothing pending, and nothing woke another turn. `rx` froze at 415/415 and the clock
   * stopped, which meant the 22:00 milestone this pipeline DOES publish (`day_5_2200` appeared in the previous run) could
   * never arrive - a Stardew clock only moves while an action is being taken.
   * </p>
   * <p>
   * The self-lock is the whole point: a static world mints no fact, and the companion is the only thing that moves the
   * world. So a turn that ended after dialogue alone must not be indistinguishable from a turn that found nothing to do.
   * TWO is the bound, because a companion is usually right to speak first and act second - it says one line and then
   * works on the next turn - while a model that will not act should not spend turns indefinitely.
   * </p>
   */
  #idleTurnsWithoutWork = 0;
  /**
   * The provider failure class of the last flush that could not reach a model, or `undefined` once a turn settles.
   *
   * <p>
   * Recorded so a verdict can say WHICH environment fact stopped the run. A sustained 429 is not "she did nothing";
   * it is `provider_rate_limited`, and the difference decides whether a run is product evidence or an infrastructure
   * loss (round35, 2026-11-06: five minutes of bridge-connected silence with `rx` frozen at 3).
   * </p>
   */
  #lastProviderFailure: ProviderFailureClass | undefined;
  /**
   * How many delivered turns ended as an empty completion, for the whole session - the ones a retry recovered included.
   *
   * <p>
   * Cumulative rather than consecutive, and never reset by a later answer: an engine that only counts the empty
   * completion it FAILED on hides every provider hiccup that a retry happened to cover, which is the provider trouble
   * an operator needs to see. The bound that ends a run is counted separately, per prompt, by `#flushTurn`.
   * </p>
   */
  #providerEmptyCompletions = 0;
  /**
   * The run-ending fact, or `undefined` while this session can still make a turn.
   *
   * <p>
   * Read by a verdict, the way `lastProviderFailure` is, so a stalled run can name itself. It stops the turn loop - no
   * retry, no automatic re-arm, and no new player turn - and stops nothing else: the world, the bridge and STOP keep
   * working, because a provider that answered nothing is an AI-authority failure, not a reason to tear a game down.
   * </p>
   */
  #runTermination: HostRunTermination | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The single timer that notices an execution has stopped making progress.
   *
   * <p>
   * MEASURED 2026-11-08 (`round43`): the Mod owned an execution and then published nothing for more than 180 s while the
   * receipt the Host still held said `running`, the companion's session record aged past three minutes, and no turn was
   * created - a frozen-looking game and a silent companion for the rest of the run. Every other turn start in this file
   * needs a fact to ARRIVE, and the whole shape of a stall is that none does.
   * </p>
   * <p>
   * ONE timer, not one per execution, armed only while the pump is timing something: `#armStallWatch` clears it when the
   * last in-flight execution settles (`stallWatch.nextStallInMs` becomes `undefined`), when admission seals, and on
   * close. THE SPLIT: the pump measures and speaks, and this file owns liveness - so the fact still starts its turn
   * through the one path every other turn start uses. See `#publishStallFact`.
   * </p>
   */
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** The retry ladder's first step, and the sentinel that says "the last attempt succeeded". */
  readonly #baseRetryDelayMs = 50;
  #retryDelayMs = this.#baseRetryDelayMs;
  #closed = false;
  #integrationAdmissionOpen = true;
  /** Set by the one call that completes attach: only an attached session may greet on arrival. */
  #attached = false;
  /**
   * The live half of the arrival's once-only rule; the durable half is the Game session's own
   * transcript (see `companion-arrival-fact.ts`).
   */
  #arrivalSaid = false;
  /** The notice identities this session has already delivered (see `native-notice-fact.ts`). */
  readonly #nativeNotices = new NativeNoticeLedger();
  /**
   * The session's latest world snapshot fact, re-stated into every turn (see `#restateWorldSnapshot`).
   *
   * The pump holds a snapshot as latest state and hands it out with the batch that follows its arrival, so a
   * turn with no new observation would carry no state at all. That is the defect the standing state block
   * exists to remove: a model told where the ladder was four turns ago either guesses or re-observes.
   */
  #latestSnapshotFact: WorldFact | undefined;
  /**
   * `pump.deliveredBatches` at the moment `#latestSnapshotFact` arrived.
   *
   * The difference is the age the standing state block reports. Nothing refreshes a snapshot between turns (the
   * bridge has no unsolicited snapshot push), so the block is re-stated from an observation that stands still while
   * the world does not - and a count of delivered turns is the only age the Host can state without inventing a clock.
   */
  #snapshotArrivedAfterBatch = 0;
  #stopVoice: ((reasonCode: string) => Promise<unknown>) | undefined;
  /**
   * The Host-owned line channel a player-facing surface installs, and the locale its
   * registered copy is written in.
   *
   * It carries the STOP confirmations and the provider-wait status lines - never companion
   * dialogue: a status line must be distinguishable from speech in the artifact, so this is
   * a different request on the wire (`system_notice_request`), not a `companion_text` piece.
   */
  #presentSystemNotice: ((notice: SystemNotice, noticeId: string) => Promise<void>) | undefined;
  #systemNoticeLocale = "en-US";
  /**
   * Whether this session has told the player it is connected and waiting for the provider.
   *
   * MEASURED 2026-11-06: a 48-minute Game run put nothing in front of the player for 709
   * seconds. The run's first act is to ask the model for a plan, so the first thing that
   * can go wrong is invisible by construction - the player watches an idle game and cannot
   * tell "she is thinking" from "the endpoint refused us". Said once, before the first
   * request, because saying it again is not progress.
   */
  #providerWaitAnnounced = false;
  /**
   * The provider failure classes whose own words the player has already been shown.
   *
   * Bounded per distinct class until the provider answers again, because pi retries a
   * refusal three times under us and each of those retries is the same fact. Cleared by a
   * turn that succeeds, so a later, separate outage is news rather than suppression.
   */
  readonly #announcedProviderFailures = new Set<ProviderFailureClass>();
  #activePiBatch: Readonly<{ sourceEventId: string; batchId: string }> | undefined;
  readonly #settledStops = new Map<
    string,
    Readonly<{ sourceEventId: string; batchId: string | null; epoch: number }>
  >();
  readonly #pendingStopObservations = new Map<
    string,
    Readonly<{ sourceEventId: string; epoch: number; revision: number }>
  >();
  readonly #stopSettledListeners = new Set<(payload: StopSettledPayload) => void>();

  public constructor(
    private readonly loop: CompanionLoop,
    events: IntegrationEventSource,
    private readonly onIntegrationDisconnected?: (reasonCode: string) => void,
    private readonly interruption?: CompanionInterruption,
    private readonly cancelOldEpoch?: (epoch: number, reasonCode: string) => Promise<unknown>,
    private readonly abortWorker?: (reasonCode: string) => Promise<unknown>,
    private readonly turnTracker = new GameTurnLineageTracker(),
    private readonly bindIntegrationReceipt?: (receipt: ExecutionReceipt) => void,
    private readonly liveSourceEvidence?: CompanionLiveSourceEvidenceSink,
    private readonly arrivalHistory?: CompanionArrivalHistory,
    /**
     * Cancel the Body Program the companion is currently running, fenced by the STOP epoch.
     *
     * Injected for the same reason `cancelOldEpoch` and `abortWorker` are: the STOP path must not reach into the runtime
     * to find the program port. Without it the player's interruption stopped the MODEL and left the companion's body
     * walking - a program keeps executing in the game after the turn that submitted it was abandoned, because the Mod
     * refuses NEW intents and nothing cancelled the old one.
     */
    private readonly stopBodyProgram?: (stopEpoch: number, reasonCode: string) => Promise<unknown>,
  ) {
    this.#unsubscribe = events.onFact((fact) => this.acceptIntegrationFact(fact));
    this.#unsubscribeConnection = events.onLifecycle((event) => this.acceptLifecycleEvent(event));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.turnTracker.revoke();
    this.#unsubscribe();
    this.#unsubscribeConnection();
    const detachVoice = this.#unsubscribeVoice;
    const detachPlayback = this.#unsubscribePlayback;
    // Detach synchronously so a closed Host never retains an admitting Voice
    // Gateway callback. Gateways whose unsubscribe is asynchronous may finish
    // their own cleanup afterwards, but admission stops at this boundary now.
    this.#unsubscribeVoice = undefined;
    this.#unsubscribePlayback = undefined;
    this.#voiceInterruptionNote = undefined;
    if (detachVoice !== undefined) void detachVoice();
    if (detachPlayback !== undefined) void detachPlayback();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#disarmStallWatch();
    this.#stopSettledListeners.clear();
  }

  /**
   * The provider failure class that stopped the last flush, or `undefined` when the session is answering again.
   *
   * <p>
   * A verdict reads this to tell an environment fact from a product one: `provider_rate_limited` means the run could
   * not ask a model, which is not "she did nothing" (round35, 2026-11-06).
   * </p>
   */
  public get lastProviderFailure(): ProviderFailureClass | undefined {
    return this.#lastProviderFailure;
  }

  /**
   * How many delivered turns ended as an empty completion: Pi settled a turn whose assistant message carried neither
   * text nor a tool call.
   *
   * <p>
   * Published even when the retry answered, because a run that swallowed the empty completion would report a healthy
   * session over a provider that is intermittently returning nothing at all.
   * </p>
   */
  public get providerEmptyCompletions(): number {
    return this.#providerEmptyCompletions;
  }

  /**
   * The fact that ended the run, or `undefined` while this session can still make a turn.
   *
   * <p>
   * `code` is the terminal code a run's own artifact carries, so a verdict can say `provider_empty_completion` instead
   * of reporting silence; `emptyCompletions` is how many empty completions this session saw before the run ended, so the
   * artifact says how close the run came before it stopped.
   * </p>
   */
  public get runTermination(): HostRunTermination | undefined {
    return this.#runTermination;
  }

  /** Observe the existing exact STOP settlement without admitting or issuing STOP. */
  public onStopSettled(listener: (payload: StopSettledPayload) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#stopSettledListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#stopSettledListeners.delete(listener);
    };
  }

  /** Runtime-owned Voice STOP_ALL authority may be attached only after bootstrap. */
  public attachVoiceStopper(stopVoice: (reasonCode: string) => Promise<unknown>): void {
    if (this.#closed || this.#stopVoice !== undefined) throw new Error("voice_stop_authority_unavailable");
    this.#stopVoice = stopVoice;
  }

  /** A player-facing surface installs only this fixed-copy, game-thread notice capability. */
  public attachSystemNoticePresenter(
    presenter: (notice: SystemNotice, noticeId: string) => Promise<void>,
    locale: string,
  ): void {
    if (this.#closed || this.#presentSystemNotice !== undefined) throw new Error("system_notice_authority_unavailable");
    this.#presentSystemNotice = presenter;
    this.#systemNoticeLocale = locale;
  }

  /** Authenticated control ingress retains its source event through Pi consumption. */
  public async acceptPlayerInput(
    input: Readonly<{ sourceEventId: string; text: string; locale: string; timestampMs?: number }>,
  ): Promise<PlayerInputDisposition> {
    // Refusals are reported, never silent (see PlayerInputRefusalCode). The
    // check order is the honest precedence: a closed session cannot take input at
    // all, a closed admission would deliver against a revoked world view, and a
    // blank message has nothing to deliver.
    if (this.#closed) return REFUSED_PLAYER_INPUT.session_closed;
    // A run that has named its ending takes no new turns. Refusing is the only honest answer: the alternative is a
    // message enqueued into a loop that will never deliver it, which is the silent loss this refusal vocabulary exists
    // to prevent.
    if (this.#runTermination !== undefined) return REFUSED_PLAYER_INPUT.run_terminated;
    if (!this.#integrationAdmissionOpen) return REFUSED_PLAYER_INPUT.integration_unavailable;
    if (input.text.trim().length === 0) return REFUSED_PLAYER_INPUT.empty;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sourceEventId)) throw new Error("invalid_player_source_event_id");
    this.#injectVoiceInterruptionNote();
    this.loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: input.sourceEventId,
      eventId: input.sourceEventId,
      text: input.text,
      locale: input.locale,
      timestampMs: input.timestampMs ?? Date.now(),
    });
    await this.flushSoon();
    return Object.freeze({ accepted: true, turnOutcome: this.#lastTurnOutcome });
  }

  /** Internal callers without authenticated ingress receive a fresh Host event id. */
  public async acceptPlayerText(
    text: string,
    locale = "zh-CN",
    timestampMs = Date.now(),
  ): Promise<PlayerInputDisposition> {
    return await this.acceptPlayerInput({ sourceEventId: randomUUID(), text, locale, timestampMs });
  }

  /** Explicit STOP remains sealed after its old epoch has settled. */
  public stopAll(
    input: Readonly<{ stopId: string; sourceEventId: string; reasonCode: string; locale?: string }>,
  ): Readonly<{ admission: StopAdmission; outcome: StopOutcome; settled: Promise<void> }> {
    return this.#interrupt(input);
  }

  /** Synchronously seals old admission before starting any asynchronous cancellation. */
  #interrupt(
    input: Readonly<{ stopId: string; sourceEventId: string; reasonCode: string; locale?: string }>,
  ): Readonly<{ admission: StopAdmission; outcome: StopOutcome; settled: Promise<void> }> {
    if (this.#closed || this.interruption === undefined || this.#stopVoice === undefined)
      throw new Error("product_stop_unavailable");
    const stopVoice = this.#stopVoice;
    const interruption = this.interruption;
    const admission = interruption.stop(input.stopId, input.sourceEventId, input.reasonCode);
    // Freeze only a Pi-confirmed active batch. A STOP after the turn has
    // settled remains valid control, but has no cancellation-proof batch.
    // This is a Host-owned observation of Pi's exact message_start/settlement
    // lifecycle, not a guess from queue contents or a diagnostic log.
    const batchId = this.#activePiBatch?.batchId ?? null;
    const outcome: StopOutcome =
      batchId !== null
        ? "active_turn_cancelled"
        : this.loop.hasQueuedPlayerDelivery
          ? "queued_turn_cancelled"
          : "no_active_turn";
    if (!admission.accepted) return Object.freeze({ admission, outcome, settled: Promise.resolve() });
    this.#integrationAdmissionOpen = false;
    this.#disarmStallWatch();
    this.turnTracker.revoke();
    // Evidence is observational only: a congested/closed append or parent IPC
    // must make this run unverifiable, never prevent the already accepted STOP
    // from cancelling its old epoch.
    this.#emitLiveEvidence((sink) =>
      sink.stopSealed({
        stopId: admission.stopId,
        sourceEventId: admission.sourceEventId,
        batchId,
        epoch: admission.epoch,
      }),
    );
    const settled = (async () => {
      try {
        await Promise.all([
          this.cancelOldEpoch === undefined
            ? Promise.reject(new Error("stop_ledger_cancellation_unavailable"))
            : this.cancelOldEpoch(admission.previousEpoch, input.reasonCode),
          this.abortWorker === undefined
            ? Promise.reject(new Error("stop_worker_cancellation_unavailable"))
            : this.abortWorker(input.reasonCode),
          stopVoice(input.reasonCode),
          this.stopBodyProgram === undefined
            ? Promise.resolve()
            : this.stopBodyProgram(admission.epoch, input.reasonCode),
          this.loop.abortAndClear(),
        ]);
      } catch (error) {
        this.#emitLiveEvidence((sink) =>
          sink.stopUncertain({
            stopId: admission.stopId,
            sourceEventId: admission.sourceEventId,
            batchId,
            epoch: admission.epoch,
          }),
        );
        throw error;
      }
      this.#emitLiveEvidence((sink) =>
        sink.stopSettled({
          stopId: admission.stopId,
          sourceEventId: admission.sourceEventId,
          batchId,
          epoch: admission.epoch,
        }),
      );
      this.#settledStops.set(
        admission.stopId,
        Object.freeze({ sourceEventId: admission.sourceEventId, batchId, epoch: admission.epoch }),
      );
      this.#publishStopObservationIfExact(admission.stopId);
      // STOP seals only its old epoch. Once every cancellation barrier has
      // settled, the same Host session may accept a fresh player turn. A newer
      // STOP advances the epoch, so this older settlement cannot reopen it.
      if (interruption.openIfCurrentEpoch(admission.epoch) !== undefined) this.#integrationAdmissionOpen = true;
      if (input.locale !== undefined && this.#presentSystemNotice !== undefined) {
        // Cancellation settles before optional native-chat delivery. A slow or
        // failed display may not delay its receipt, proof, or control response.
        void this.#presentSystemNotice(resolveStopSystemNotice(outcome, input.locale), admission.stopId).catch(
          () => undefined,
        );
      }
    })();
    return Object.freeze({ admission, outcome, settled });
  }

  /** Called only by CompanionLoop around an actual Pi-consumed steer batch. */
  public beginPlayerBatch(sourceEventId: string, batchId: string | undefined): void {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    this.turnTracker.beginPlayerBatch(sourceEventId);
    this.#activePiBatch = batchId === undefined ? undefined : Object.freeze({ sourceEventId, batchId });
  }

  /** Pi delivery settles/aborts: lineage and active-batch proof never leak into a later turn. */
  public endBatch(batchId: string | undefined): void {
    this.turnTracker.endBatch();
    if (batchId !== undefined && this.#activePiBatch?.batchId === batchId) this.#activePiBatch = undefined;
  }

  /**
   * Projects final native assistant content through the exact Host-captured Game
   * lineage. This presenter owns no gameplay or action authority.
   */
  public createNativeAssistantContentPresenter(
    options: Readonly<{
      sessionId: string;
      locale: string;
      admissionProvider: HostPresentationAdmissionProvider;
      textPort: CompanionTextPort;
    }>,
  ): NativeGameContentPresenter {
    return async (content: NativeGameCompanionContent): Promise<void> => {
      if (this.#closed || !this.#integrationAdmissionOpen || content.text.trim().length === 0) return;
      // Text is part of admission: the turn's cumulative presented bytes must
      // stay inside one reply's budget and a repeated piece is refused, so a
      // duplicated or looping delta stream fails closed before it turns into
      // unbounded native chat.
      const captured = options.admissionProvider.capture(content.sourceEventId, content.text);
      if (captured.surface !== "game") throw new Error("native_game_presentation_lineage_mismatch");
      const expression: GameCompanionTextExpression = Object.freeze({
        surface: "game",
        expressionId: randomUUID(),
        sessionId: options.sessionId,
        sourceEventId: captured.sourceEventId,
        text: content.text,
        locale: options.locale,
      });
      try {
        await options.textPort.present(expression, captured.admission);
      } catch (error) {
        // A failed native commit is an uncertain delivery for the whole turn:
        // the piece may have landed. End the turn's admission (through the same
        // provider that admitted this piece) so no later piece turns one
        // uncertain commit into a stream of further native chat.
        options.admissionProvider.closeForUncertainCommit?.();
        throw error;
      }
    };
  }

  /** Captures only a Pi-consumed authenticated input lineage for presentation. */
  public capturePresentationAdmission(): ReturnType<GameTurnLineageTracker["capture"]> {
    if (this.#closed || !this.#integrationAdmissionOpen) throw new Error("presentation_lineage_unavailable");
    return this.turnTracker.capture();
  }

  /** Final voice input follows the same labelled player-input path as text. */
  public async acceptFinalVoice(input: FinalVoiceInput): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    await deliverFinalVoiceInput(
      {
        receive: async (final) => {
          this.#injectVoiceInterruptionNote();
          this.loop.pump.enqueuePlayerInput({
            // The Gateway-authenticated event identity, not local input
            // correlation, is the only voice presentation authority.
            source: "voice_final",
            inputId: final.inputId,
            eventId: final.sourceEventId,
            text: final.text,
            locale: final.locale,
            timestampMs: final.timestampMs,
          });
          await this.flushSoon();
        },
      },
      input,
    );
  }

  /** Attach only a Gateway that already validates/authenticates final ASR events. */
  public attachFinalVoiceSource(source: FinalVoiceSource, _sessionId?: string): () => Promise<void> {
    if (this.#unsubscribeVoice !== undefined) void this.#unsubscribeVoice();
    const unsubscribe = source.onFinalTranscript((input) => {
      // Gateway callbacks are not a game-thread boundary. A provider failure
      // remains local to voice; the Host event pump preserves pending input.
      void this.acceptFinalVoice(input).catch(() => undefined);
    });
    let detached = false;
    const wrapped = (): Promise<void> => {
      if (!detached) {
        detached = true;
        // Unsubscribe before returning so close/replacement immediately seals
        // listener admission; the Promise preserves the public cleanup shape.
        unsubscribe();
        if (this.#unsubscribeVoice === wrapped) this.#unsubscribeVoice = undefined;
      }
      return Promise.resolve();
    };
    this.#unsubscribeVoice = wrapped;
    return wrapped;
  }

  /**
   * Attach the v2 push lane. A cancelled playback observation only sets a
   * Voice-local note for the next player prompt; it must not cancel, write, or
   * route anything in Chat or Game.
   */
  public attachVoicePlaybackObservationSource(source: VoicePlaybackObservationSource): () => Promise<void> {
    if (this.#unsubscribePlayback !== undefined) void this.#unsubscribePlayback();
    const unsubscribe = source.onPlaybackObservation((observation) => {
      if (observation.terminalStatus !== "cancelled") return;
      this.#voiceInterruptionNote = Object.freeze({
        atMs: Date.now(),
        speechJobId: observation.speechJobId,
      });
    });
    let detached = false;
    const wrapped = (): Promise<void> => {
      if (!detached) {
        detached = true;
        unsubscribe();
        if (this.#unsubscribePlayback === wrapped) this.#unsubscribePlayback = undefined;
      }
      return Promise.resolve();
    };
    this.#unsubscribePlayback = wrapped;
    return wrapped;
  }

  /**
   * One-shot Voice-local context note for the next assembled prompt: the
   * previous utterance was cut short (player barge-in). Purely model-facing,
   * consumed exactly once, and never touches ChatThreadStore or Game actions.
   */
  #injectVoiceInterruptionNote(): void {
    const note = this.#voiceInterruptionNote;
    if (note === undefined) return;
    this.#voiceInterruptionNote = undefined;
    const ageMs = Date.now() - note.atMs;
    if (ageMs > 120_000) return; // stale note is not a fact for this turn
    try {
      this.loop.pump.enqueueFact({
        source: "voice",
        kind: "semantic_event",
        eventId: `voice_interruption_${note.speechJobId ?? "unknown"}`,
        occurredAtMs: note.atMs,
        correlationId: randomUUID(),
        revision: 0,
        payload: Object.freeze({ kind: "speech_interrupted", speechJobId: note.speechJobId ?? null }),
        contextProjection: Object.freeze({
          kind: "speech_interrupted",
          text: "上一句语音在播放中被玩家打断（玩家后来开口说话），玩家没有听到那句话的结尾。",
        }),
      });
    } catch {
      this.#voiceInterruptionNote = note; // retry on the next player input
    }
  }

  /**
   * Initial launch facts were already adapter-validated before runtime mount.
   *
   * This call is the attach boundary - `activateIngress` makes it exactly once, after the semantic
   * enter receipt commits - so it is also where the companion may first say that she has arrived.
   */
  public acceptInitialFacts(facts: readonly WorldFact[]): void {
    this.#attached = true;
    for (const fact of facts) this.acceptIntegrationFact(fact);
  }

  /**
   * A fact the Host itself mints about the companion's own work, onto the same pump every other fact uses.
   *
   * The one producer today is the settled-plan digest (`program-settlement-digest.ts`): the per-node terminal ledger of
   * a plan the Mod's journal has stopped. It travels here rather than through `acceptIntegrationFact` because that route
   * is the ADAPTER's ingress - it gates on the integration admission switch and on receipt identity, none of which is a
   * question about a fact the Host observed by reading the journal itself.
   */
  public acceptHostMintedFact(fact: WorldFact): void {
    if (this.#closed) return;
    this.loop.pump.enqueueFact(fact);
    this.#armStallWatch();
    // A held fact (`isSettledPlanDigest`) does not set `hasPendingDelivery` on its own, so this flush delivers it with
    // whatever else is queued and starts no turn of its own.
    void this.flushSoon().catch(() => undefined);
  }

  private acceptIntegrationFact(fact: WorldFact): void {
    if (this.#closed) return;
    // The Stardew adapter has already authenticated and scope-validated this
    // typed Host-human chat fact. It alone may enter the existing input/stop surfaces.
    if (
      fact.source === "stardew_mod" &&
      fact.kind === "semantic_event" &&
      (fact.payload.kind === "player_input" || fact.payload.kind === "stop_all")
    ) {
      const control = fact.payload.playerControl;
      if (!isAuthenticatedStardewPlayerControl(control) || control.kind !== fact.payload.kind) {
        this.#monitorNativeChatIngress("player_control_rejected_shape");
        return;
      }
      try {
        if (control.kind === "player_input") {
          this.#monitorNativeChatIngress("player_input_accepted");
          this.#emitLiveEvidence((sink) => sink.nativePlayerInputObserved({ sourceEventId: control.sourceEventId }));
          void this.acceptPlayerInput({
            sourceEventId: control.sourceEventId,
            text: control.text!,
            locale: control.locale,
          })
            .then(() => this.#monitorNativeChatIngress("player_input_enqueued"))
            .catch(() => this.#monitorNativeChatIngress("player_input_enqueue_failed"));
        } else {
          this.#monitorNativeChatIngress("stop_all_accepted");
          this.#emitLiveEvidence((sink) =>
            sink.nativeStopAllObserved({ stopId: control.controlId, sourceEventId: control.sourceEventId }),
          );
          const stopped = this.stopAll({
            stopId: control.controlId,
            sourceEventId: control.sourceEventId,
            reasonCode: "player_stop_all",
            locale: control.locale,
          });
          this.#monitorNativeChatIngress(`stop_all_${stopped.outcome}`);
          void stopped.settled.catch(() => undefined);
        }
      } catch {
        this.#monitorNativeChatIngress("player_control_callback_failed");
        /* callback containment: native bridge listeners never throw */
      }
      return;
    }
    // Receipt binding is an authoritative adapter-event route, not a model or
    // event-pump inference. It remains open after STOP so a post-write reject
    // can receive its late receipt and complete the exact cancellation barrier.
    if (fact.kind === "execution_receipt") this.bindIntegrationReceipt?.(fact.payload as ExecutionReceipt);
    if (fact.source === "stardew_mod" && fact.kind === "semantic_event" && fact.payload.kind === "body_settled") {
      const observation = fact.payload.stopObservation;
      if (
        isAuthenticatedModStopObservation(observation) &&
        observation.epoch >= 1 &&
        fact.revision === fact.payload.revision
      ) {
        this.#pendingStopObservations.set(
          observation.stopId,
          Object.freeze({
            sourceEventId: observation.sourceEventId,
            epoch: observation.epoch,
            revision: fact.revision,
          }),
        );
        this.#publishStopObservationIfExact(observation.stopId);
      }
      return;
    }
    if (!this.#integrationAdmissionOpen) return;
    // This source label is Host-reserved so an adapter cannot manufacture a
    // local transport transition and have it confused with Host lifecycle.
    if (fact.source === "host_local_transport") throw new Error("adapter_transport_source_reserved");
    try {
      // The snapshot is also where the world day and the presentation locale of a native notice are read.
      if (fact.kind === "snapshot") {
        this.#nativeNotices.observeSnapshot(fact.payload);
        this.#latestSnapshotFact = fact;
        this.#snapshotArrivedAfterBatch = this.loop.pump.deliveredBatches;
      }
      // The attach's own snapshot is the world clock's first live reading for this session, so the
      // arrival fact is minted here - before the snapshot itself, which the pump holds as latest state
      // and never turns into a turn on its own.
      if (this.#attached && fact.kind === "snapshot") this.#sayArrivalOnce(fact.payload);
      // A native notice is its own fact, admitted whatever the execution that carried it is doing: a
      // companion waiting between plans has nothing outstanding, which is exactly when the clock matters.
      if (fact.kind === "execution_receipt") this.#admitNativeNotices(fact);
      this.loop.pump.enqueueFact(fact);
      // The one call that re-arms (or clears) the stall watch: this fact is the freshest thing the pump has been told
      // about its execution, so it is also what moves that execution's next stall threshold.
      this.#armStallWatch();
    } catch (error) {
      if (!isEventPumpOverflow(error)) throw error;
      this.#containIntegrationOverflow();
      return;
    }
    void this.flushSoon().catch(() => undefined);
  }

  /**
   * Says "the companion has just arrived, and the world clock has ticked" at most once per Game
   * session. `companion-arrival-fact.ts` owns the fact and the why; this owns the two once-only
   * decisions and the delivery, which is the same pump every other fact uses.
   */
  #sayArrivalOnce(snapshot: Readonly<Record<string, unknown>>): void {
    if (this.#arrivalSaid) return;
    if (this.arrivalHistory?.alreadySaid() === true) {
      this.#arrivalSaid = true;
      return;
    }
    const arrival = companionArrivalFact(snapshot);
    // No usable clock yet: attach alone says nothing, and the once-only switch stays unmade so the
    // first real reading may still speak.
    if (arrival === undefined) return;
    this.#arrivalSaid = true;
    this.loop.pump.enqueueFact(arrival);
  }

  /** Admits this receipt's unseen native notices onto the same session-level pump as every other fact. */
  #admitNativeNotices(fact: WorldFact): void {
    const notices = this.#nativeNotices.admit(fact.payload as ExecutionReceipt, fact.occurredAtMs ?? Date.now());
    for (const notice of notices) this.loop.pump.enqueueFact(notice);
  }

  #publishStopObservationIfExact(stopId: string): void {
    const settled = this.#settledStops.get(stopId);
    const observation = this.#pendingStopObservations.get(stopId);
    if (
      settled === undefined ||
      observation === undefined ||
      settled.sourceEventId !== observation.sourceEventId ||
      settled.epoch !== observation.epoch
    )
      return;
    // `stopSettled` has awaited the old ledger cancellation barrier, worker,
    // voice, and Pi teardown. This subsequent Mod game-thread observation is
    // the fence proving the old epoch remained revoked through a fresh body
    // snapshot; neither fact is inferred from Host-local state alone.
    this.#emitLiveEvidence((sink) =>
      sink.bodySettled({
        stopId,
        sourceEventId: settled.sourceEventId,
        batchId: settled.batchId,
        epoch: settled.epoch,
        observationRevision: observation.revision,
      }),
    );
    this.#emitLiveEvidence((sink) =>
      sink.oldEpochQuiet({
        stopId,
        sourceEventId: settled.sourceEventId,
        batchId: settled.batchId,
        epoch: settled.epoch,
        observationRevision: observation.revision,
      }),
    );
    const payload: StopSettledPayload = Object.freeze({
      stopId,
      sourceEventId: settled.sourceEventId,
      batchId: settled.batchId,
      epoch: settled.epoch,
      observationRevision: observation.revision,
    });
    this.#settledStops.delete(stopId);
    this.#pendingStopObservations.delete(stopId);
    for (const listener of [...this.#stopSettledListeners]) {
      try {
        listener(payload);
      } catch {
        // STOP settlement remains authoritative even if a read-only observer fails.
      }
    }
  }

  /**
   * One-run phase-only telemetry for native ChatBox ingress. This is purposefully
   * separate from the evidence artifact: it carries no prompt/body, identifier,
   * locale, scope, credential, receipt, or model output.
   */
  #monitorNativeChatIngress(stage: string): void {
    console.debug(`GameBuddy native chat ingress stage=${stage}`);
  }

  /** Evidence loss invalidates the live gate but can never alter runtime control flow. */
  #emitLiveEvidence(emit: (sink: CompanionLiveSourceEvidenceSink) => void): void {
    try {
      if (this.liveSourceEvidence !== undefined) emit(this.liveSourceEvidence);
    } catch {
      /* intentionally observational */
    }
  }

  private acceptLifecycleEvent(event: IntegrationLifecycleEvent): void {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    // This truthfully identifies the local adapter transport; it is never
    // presented as a game-world fact emitted by the integration. Its admission
    // must happen before invoking external code: a synchronous reentrant
    // callback must observe either the queued terminal event or a sealed pump.
    try {
      this.loop.pump.enqueueFact({
        source: "host_local_transport",
        kind: "lifecycle",
        correlationId: `transport_${event.state}`,
        revision: 0,
        payload: event,
      });
    } catch (error) {
      if (!isEventPumpOverflow(error)) throw error;
      this.#containIntegrationOverflow();
      return;
    }
    // Every lifecycle event accepted by this port is terminal (the only
    // non-terminal state, `ready`, is admitted before bootstrap). Revoke the
    // Host execution fence for both transport loss and orderly adapter stop.
    this.onIntegrationDisconnected?.(event.reasonCode);
    void this.flushSoon().catch(() => undefined);
  }

  /**
   * Overflow has no Host-owned resynchronization authority. Revoke this
   * integration and discard every pending frame rather than deliver a partial
   * or stale view of the world. The callback may throw, but clear remains an
   * unconditional cancellation boundary and its error never replaces it.
   */
  #containIntegrationOverflow(revocationAlreadyRequested = false): void {
    this.#containIntegrationFailure("event_overflow", revocationAlreadyRequested);
  }

  #containIntegrationFailure(reasonCode: string, revocationAlreadyRequested = false): void {
    if (!this.#integrationAdmissionOpen) return;
    this.#integrationAdmissionOpen = false;
    this.turnTracker.revoke();
    this.#disarmStallWatch();
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    let callbackError: unknown;
    try {
      if (!revocationAlreadyRequested) this.onIntegrationDisconnected?.(reasonCode);
    } catch (error) {
      callbackError = error;
    } finally {
      try {
        this.loop.pump.clear();
      } catch (clearError) {
        if (callbackError === undefined) throw clearError;
      }
    }
    if (callbackError !== undefined) throw callbackError;
  }

  /**
   * Deliver the expiring facts into the running turn.
   *
   * Kept out of `flushSoon`'s body so the two never share a guard: a steer must not set `#flushScheduled`
   * (nothing about a steer schedules a turn) and must not touch `#retryBatch` (a batch that could not be steered is
   * still owed to the next turn, and `EventPump` only removes expiring facts once it has handed them over).
   */
  async #steer(): Promise<void> {
    await this.loop.steer();
  }

  /**
   * Put the session's current world snapshot back into the pump, immediately before a turn is composed.
   *
   * <p>
   * STATE IS NOT A DELTA, and the pump's snapshot slot is: it holds the latest snapshot and hands it to the
   * NEXT batch, so a turn triggered by a receipt or by the player's own words would carry no state at all.
   * Measured over 1,777 delivered batches in the persisted game sessions of 2026-10-31..2026-11: 1,086 (61%)
   * carried no snapshot, and a model reading one of those has only its own memory of the last one it saw.
   * </p>
   * <p>
   * Re-stating the fact is safe in the only way that matters: `enqueueFact` keeps the snapshot with the
   * greatest revision, so a newer observation already waiting for this batch is never replaced by this one.
   * </p>
   */
  #restateWorldSnapshot(): void {
    const snapshot = this.#latestSnapshotFact;
    if (snapshot !== undefined) this.loop.pump.enqueueFact(this.#stateBlockAsOf(snapshot));
  }

  /**
   * The snapshot fact with its state block re-rendered for the turn about to be composed.
   *
   * <p>
   * The block is composed once, when the snapshot is converted, and the Host then re-sends that fact every turn - so
   * without this the block presents the last observation as the current world, for as long as nobody observes again.
   * `snapshot-hud.ts#aged` carries the measurement that made that a defect and the reason the age is counted in turns.
   * </p>
   * <p>
   * A snapshot on its first delivery is returned untouched, so a turn that observed the world itself still carries
   * exactly the block `toWorldFact` composed.
   * </p>
   */
  #stateBlockAsOf(snapshot: WorldFact): WorldFact {
    const ageTurns = this.loop.pump.deliveredBatches - this.#snapshotArrivedAfterBatch;
    const projection = snapshot.contextProjection;
    // A projection without a block is one the adapter refused as invalid; there is no state to qualify.
    if (!(ageTurns >= 1) || projection === undefined || typeof projection.hud !== "string") return snapshot;
    return Object.freeze({
      ...snapshot,
      contextProjection: Object.freeze({
        ...projection,
        // The payload is the bridge-admitted `Snapshot` - `local-stardew-bridge.ts#receive` validates every inbound
        // frame before `toWorldFact` types it - not a second, unchecked copy of the world.
        hud: formatSnapshotHud(snapshot.payload as unknown as Snapshot, ageTurns),
      }),
    });
  }

  private async flushSoon(): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen || this.#runTermination !== undefined) return;
    // A steer runs exactly when a flush cannot: it injects into the turn that is ALREADY running, so
    // `#flushScheduled` being true is the condition it wants, not the condition it must wait out.
    //
    // Measured 2026-11-02 (`round25`, after the disposition change alone): 8 milestones, 2 answered, and the two were
    // the day-start ones where the turn happened to be ending. 1200 / 1800 / 2200 arrived mid-turn and never reached
    // the model, because `flushSoon` returned on `#flushScheduled` and the steer branch inside `flush` was never
    // reached - a turn-scoped lock guarding a turn-internal event.
    if (this.#flushScheduled) {
      if (this.loop.pump.hasExpiringFact) void this.#steer().catch(() => undefined);
      return;
    }
    this.#flushScheduled = true;
    try {
      // A microtask coalesces bursts of Mod receipts/snapshots without adding
      // an intent layer or holding game-thread/pipe work open.
      await Promise.resolve();
      // An overflow can occur after this work was scheduled. Admission is the
      // Host-owned cancellation fence for scheduled and retry flushes.
      if (!this.#closed && this.#integrationAdmissionOpen) {
        this.#restateWorldSnapshot();
        // Before the request, never after: this is the moment the wait begins, and the only
        // moment the Host knows the bridge is up and the model has been asked for nothing yet.
        this.#announceProviderWait();
        // The loop reports how the delivered turn ended (or nothing when there was nothing to deliver).
        // Retained so a caller that awaits player input can report it instead of guessing from silence.
        const outcome = await this.#flushTurn();
        this.#lastTurnOutcome = outcome ?? "unobserved";
        // What the turn DID, which `outcome` cannot say: `completed` covers both "acted" and "only spoke". A flush that
        // delivered nothing leaves the counter alone - it is not evidence either way.
        if (outcome === "completed")
          this.#idleTurnsWithoutWork = this.loop.pump.turnProducedWork ? 0 : this.#idleTurnsWithoutWork + 1;
        else if (outcome !== undefined) this.#idleTurnsWithoutWork = 0;
      }
      this.#retryDelayMs = this.#baseRetryDelayMs;
      // The provider answered, so the last recorded environment failure no longer describes the session.
      this.#lastProviderFailure = undefined;
      // ...and the next refusal of a class already announced is news again rather than a repeat.
      this.#announcedProviderFailures.clear();
    } catch (error) {
      // EventPump restored the exact batch. Two kinds of failure arrive here and they do not deserve the same answer.
      //
      // A PROVIDER failure (rate limit, model not served, credential, endpoint down) has already been retried by pi's
      // own policy - `SETTINGS_DEFAULTS.retry` is `{ enabled, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 }`
      // and its provider arm honours `retry-after` with a 60 s ceiling. Retrying it again here, on a 50 ms -> 5 s
      // ladder that never gives up, is what made a sustained 429 look like a live run: bridge connected, heartbeat
      // printing, `rx` frozen, and not one turn completed for five minutes (round35, 2026-11-06). So this layer does
      // not retry a provider failure at all. It records which class it was - by name, so a verdict can say
      // `provider_rate_limited` instead of `she did nothing` - and leaves the batch in the pump for the next real
      // trigger.
      //
      // Anything else is an internal transport hiccup that pi did not classify, and that is what the bounded ladder
      // is for.
      const providerFailure = classifyProviderFailure(error instanceof Error ? error.message : String(error));
      // An empty completion is neither of those two: `#flushTurn` owns its own bound and its own ending, so this layer
      // must not start the unbounded ladder under it. Everything else keeps the answers above.
      if (providerFailure !== undefined) {
        this.#lastProviderFailure = providerFailure;
        this.#presentProviderFailure(providerFailure, error);
      } else if (this.#runTermination === undefined) this.scheduleRetry();
      // Callers that await explicit player input receive the failure, while
      // bridge callbacks catch it at their boundary.
      throw error;
    } finally {
      this.#flushScheduled = false;
      // Facts may arrive after this invocation has captured its batch but
      // before its provider turn completes. Their attempted flush correctly
      // returned while scheduled; wake one follow-up turn without requiring an
      // unrelated third event.
      if (
        !this.#closed &&
        this.#integrationAdmissionOpen &&
        this.#retryTimer === undefined &&
        this.loop.pump.hasPendingDelivery
      ) {
        // Only a successful flush should immediately drain work accepted while
        // it was running. On failure scheduleRetry owns the next attempt.
        // Otherwise a rejected provider turn would recurse in this finally.
        //
        // A provider failure deliberately keeps `#retryDelayMs` untouched, so this branch cannot fire after one: the
        // pump holds the facts and waits for a real trigger rather than us spinning at the provider.
        if (this.#retryDelayMs === this.#baseRetryDelayMs && this.#lastProviderFailure === undefined)
          void this.flushSoon().catch(() => undefined);
      }
      // The liveness arm: asked even when the pump has nothing pending, because that is the whole defect. Placed in the
      // same `finally` so a turn that spoke only re-arms exactly once; `#turnOwesAnother` carries the bound.
      else if (this.#retryTimer === undefined && this.#turnOwesAnother()) {
        void this.flushSoon().catch(() => undefined);
      }
    }
  }

  /**
   * Tells the player the run is up and the model has not answered yet.
   *
   * <p>
   * Placed immediately BEFORE the first provider request, because that is the moment the wait begins. It is said
   * once: repeating it is not progress, and a status line that keeps reappearing reads as a companion stalling.
   * </p>
   * <p>
   * The run's own log carries the same instant (`PROVIDER_WAIT`), because a later reader has to be able to date the
   * wait even when no surface installed a notice presenter - the artifact must not depend on who was watching.
   * </p>
   */
  #announceProviderWait(): void {
    if (this.#providerWaitAnnounced) return;
    this.#providerWaitAnnounced = true;
    process.stderr.write(`PROVIDER_WAIT ${JSON.stringify({ atMs: Date.now(), locale: this.#systemNoticeLocale })}\n`);
    if (this.#presentSystemNotice === undefined) return;
    void this.#presentSystemNotice(resolveProviderWaitSystemNotice(this.#systemNoticeLocale), randomUUID()).catch(
      () => undefined,
    );
  }

  /**
   * Shows one provider refusal in the provider's OWN words, at most once per class until the provider answers again.
   *
   * <p>
   * The class is already recorded (`#lastProviderFailure`), but a class is not something the player can act on:
   * `429 ... retry shortly (after 30 s)` and `Request timed out.` are both "she is not answering" from the bubble's
   * point of view, and the words are the difference between waiting a minute and checking a credential. Bounded and
   * single-line by `boundProviderFailureLine`; pi retries a refusal three times under this layer, so the same class
   * is said once rather than once per retry.
   * </p>
   */
  #presentProviderFailure(providerFailure: ProviderFailureClass, error: unknown): void {
    if (this.#closed || this.#announcedProviderFailures.has(providerFailure)) return;
    this.#announcedProviderFailures.add(providerFailure);
    const line = boundProviderFailureLine(error instanceof Error ? error.message : String(error));
    process.stderr.write(`PROVIDER_FAILURE ${JSON.stringify({ atMs: Date.now(), class: providerFailure })}\n`);
    if (line === undefined || this.#presentSystemNotice === undefined) return;
    void this.#presentSystemNotice(
      resolveProviderFailureSystemNotice(this.#systemNoticeLocale, line),
      randomUUID(),
    ).catch(() => undefined);
  }

  /**
   * Drive one turn, re-asking the SAME prompt when the provider answers with nothing.
   *
   * <p>
   * An assistant turn that carries neither text nor a tool call is not a turn, and the loop reports that ending by name
   * (`provider_empty_completion`) rather than as an ordinary settled turn. Because it is reported as a rejection, the
   * pump has already restored the exact batch the attempt owned, so asking again re-sends the prompt the provider
   * answered with nothing - not a fresh composition of whatever facts happen to be waiting now.
   * </p>
   * <p>
   * The count is published before the decision (`providerEmptyCompletions`), because a retry that answers still leaves
   * the fact that the provider returned nothing once. Three empty answers in a row are a provider that will not produce
   * a turn, and that is named instead of being waited out: before this existed the run idled for 148 minutes with the
   * game alive and the bridge connected, which from outside looks exactly like a companion still thinking.
   * </p>
   */
  async #flushTurn(): Promise<CompanionTurnOutcome | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.loop.flush();
      } catch (error) {
        if (!isProviderEmptyCompletion(error)) throw error;
        this.#providerEmptyCompletions += 1;
        if (attempt >= PROVIDER_EMPTY_COMPLETION_ATTEMPTS) {
          this.#runTermination = Object.freeze({
            code: PROVIDER_EMPTY_COMPLETION,
            emptyCompletions: this.#providerEmptyCompletions,
          });
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_EMPTY_COMPLETION_RETRY_DELAY_MS));
        // STOP, teardown or an overflow can seal admission while the pause runs. A sealed session does not get another
        // provider turn from a retry that outlived it.
        if (this.#closed || !this.#integrationAdmissionOpen) throw error;
      }
    }
  }

  /**
   * Whether another turn is owed even though the pump has nothing to deliver.
   *
   * <p>
   * This is the ONE place that decides it. Before this existed the answer was `hasPendingDelivery` alone, and that made
   * "the model chose to speak only" identical to "there is nothing to do" - see `#idleTurnsWithoutWork` for the run that
   * proved it. The pump still owns delivery; this owns LIVENESS.
   * </p>
   * <p>
   * `#idleTurnsWithoutWork` cannot be inferred from `#lastTurnOutcome`: `completed` means the turn settled, not that it
   * produced work, and a turn that spoke AND acted also reports `completed`. The counter is incremented by the flush that
   * knows what the turn did.
   * </p>
   */
  #turnOwesAnother(): boolean {
    if (this.#closed || !this.#integrationAdmissionOpen || this.#runTermination !== undefined) return false;
    // A pending delivery is the ordinary reason, unchanged.
    if (this.loop.pump.hasPendingDelivery) return true;
    // The second reason, and the defect: the last turn settled without producing work, so the world is exactly where it
    // was and nothing will move it. Bounded, so a model that answers with dialogue forever costs two turns, not the run.
    return this.#idleTurnsWithoutWork > 0 && this.#idleTurnsWithoutWork < 2 && this.#lastTurnOutcome === "completed";
  }

  /**
   * Arm, re-arm or clear the stall watch from the pump's own next-due reading.
   *
   * <p>
   * Called after every fact the Host admits, because a fact is the only thing that changes the answer: a new fact for an
   * execution pushes its threshold out, and its terminal receipt removes it from the watch entirely - which is what
   * clears this timer when the last execution settles. No execution in flight means no timer.
   * </p>
   */
  #armStallWatch(): void {
    this.#disarmStallWatch();
    if (this.#closed || !this.#integrationAdmissionOpen || this.#runTermination !== undefined) return;
    // `?.` and not `stallWatch.`: the Host's own test doubles provide a partial pump, while the TYPE still requires the
    // getter - so a real pump that loses it fails the build instead of quietly disarming the watch.
    const dueInMs = this.loop.pump.stallWatch?.nextStallInMs;
    if (dueInMs === undefined) return;
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = undefined;
      this.#publishStallFact();
    }, dueInMs);
  }

  #disarmStallWatch(): void {
    if (this.#stallTimer === undefined) return;
    clearTimeout(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  /**
   * Say that an execution has stopped making progress, and let the fact start a turn.
   *
   * <p>
   * The fact is MINTED by the pump (`takeStallFact`) and travels the one path every other Host-minted fact uses, so a
   * stall cannot become a second way to start a turn. The threshold is re-armed BEFORE the turn is requested: a flush
   * may spend minutes at the provider, and the next bound belongs to the silence, not to the turn.
   * </p>
   */
  #publishStallFact(): void {
    const fact = this.loop.pump.takeStallFact();
    this.#armStallWatch();
    if (fact === undefined) return;
    // Named where an operator and a bundle reader can both date it: what was watched, what the bound evicted, and what
    // is stuck - including the ownership that would release it, when the Mod said.
    process.stderr.write(`EXECUTION_STALL ${JSON.stringify({ atMs: Date.now(), ...fact.payload })}\n`);
    this.acceptHostMintedFact(fact);
  }

  private scheduleRetry(): void {
    if (
      this.#closed ||
      !this.#integrationAdmissionOpen ||
      this.#retryTimer !== undefined ||
      this.loop.pump.pendingCount === 0
    )
      return;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, 5_000);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushSoon().catch(() => undefined);
    }, delay);
  }
}
