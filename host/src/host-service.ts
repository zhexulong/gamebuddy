import { randomUUID } from "node:crypto";
import type { CompanionInterruption, StopAdmission } from "./companion-interruption.js";
import type { CompanionLiveSourceEvidenceSink } from "./companion-live-source-attestation.js";
import type { CompanionLoop, NativeGameCompanionContent, NativeGameContentPresenter } from "./companion-loop.js";
import type { WorldFact } from "./event-pump.js";
import type { IntegrationEventSource, IntegrationLifecycleEvent } from "./integration-launcher.js";
import type {
  CompanionTextPort,
  GameCompanionTextExpression,
  HostPresentationAdmissionProvider,
} from "./presentation.js";
import type { ExecutionReceipt } from "./protocol.js";
import { resolveStopSystemNotice, type StopSystemNotice } from "./system-notices.js";
import { deliverFinalVoiceInput, type FinalVoiceInput } from "./voice.js";

export type FinalVoiceSource = Readonly<{ onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void }>;

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
 * The bounds keep the surface replay-safe without ever refusing a reply the text
 * layer already accepted:
 *
 * - Every piece comes from the same reply, so the turn's cumulative presented
 *   bytes can never exceed one reply's own text budget
 *   (`MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES`). A duplicated or looping delta
 *   stream is what pushes past it, and that must fail closed instead of being
 *   drawn into unbounded native chat. This is an exact bound, not a heuristic:
 *   a healthy reply's pieces sum to exactly its own length.
 * - The piece count is a secondary denial-of-service guard, set far above any
 *   real reply (the design targets 1-3 pieces and treats >3 as a health
 *   signal), purely to stop a stream of one-byte pieces.
 *
 * Text equality is deliberately NOT an admission check: a reply may legitimately
 * repeat a line ("好的。好的。"), so refusing repeats would crash on valid output.
 * Replay of a re-sent request is already refused by the Game port's per-piece
 * `expressionId` idempotency, and an uncertain commit closes the turn.
 */
export const MAX_NATIVE_PRESENTATIONS_PER_TURN = 256;
export const MAX_NATIVE_PRESENTATION_TURN_BYTES = 16_384;

/**
 * Private production turn authority; no model/tool identity can mint lineage.
 * Every captured admission stays valid for the whole turn and for every piece,
 * so a piece produced before an earlier piece finishes committing is never
 * rejected as stale during normal sequential draining.
 */
export class GameTurnLineageTracker {
  #lineage: Readonly<{ sourceEventId: string; generation: number }> | undefined;
  #presentations = 0;
  #presentedBytes = 0;
  #generation = 0;
  beginPlayerBatch(sourceEventId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceEventId)) throw new Error("invalid_presentation_source_event_id");
    this.#lineage = Object.freeze({ sourceEventId, generation: this.#generation });
    this.#presentations = 0;
    this.#presentedBytes = 0;
  }
  endBatch(): void {
    // Clearing the lineage ends the turn's admission window. A consumed batch
    // that never spoke is legitimate (tool-only, empty, or rejected text), and
    // an over-budget batch already failed closed at capture, so there is no
    // count condition left to assert here.
    this.#lineage = undefined;
    this.#presentations = 0;
    this.#presentedBytes = 0;
  }
  revoke(): void {
    this.#generation += 1;
    this.#lineage = undefined;
    this.#presentations = 0;
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
    this.#presentations = 0;
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
    if (this.#presentations >= MAX_NATIVE_PRESENTATIONS_PER_TURN)
      throw new Error("player_turn_presentation_budget_exceeded");
    if (text !== undefined) {
      const textBytes = Buffer.byteLength(text, "utf8");
      if (textBytes <= 0) throw new Error("invalid_presentation_text_size");
      if (this.#presentedBytes + textBytes > MAX_NATIVE_PRESENTATION_TURN_BYTES)
        throw new Error("player_turn_presentation_budget_exceeded");
      this.#presentedBytes += textBytes;
    }
    this.#presentations += 1;
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
  #integrationToolRefresh: Promise<void> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = 50;
  #closed = false;
  #integrationAdmissionOpen = true;
  #stopVoice: ((reasonCode: string) => Promise<unknown>) | undefined;
  #presentStopSystemNotice: ((notice: StopSystemNotice, noticeId: string) => Promise<void>) | undefined;
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
    private readonly refreshIntegrationTools?: () => Promise<void>,
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
    this.#stopSettledListeners.clear();
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

  /** Preview composition may mount only this fixed-copy, game-thread notice capability. */
  public attachStopSystemNoticePresenter(
    presenter: (notice: StopSystemNotice, noticeId: string) => Promise<void>,
  ): void {
    if (this.#closed || this.#presentStopSystemNotice !== undefined)
      throw new Error("stop_system_notice_authority_unavailable");
    this.#presentStopSystemNotice = presenter;
  }

  /** Authenticated control ingress retains its source event through Pi consumption. */
  public async acceptPlayerInput(
    input: Readonly<{ sourceEventId: string; text: string; locale: string; timestampMs?: number }>,
  ): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen || input.text.trim().length === 0) return;
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
  }

  /** Internal callers without authenticated ingress receive a fresh Host event id. */
  public async acceptPlayerText(text: string, locale = "zh-CN", timestampMs = Date.now()): Promise<void> {
    await this.acceptPlayerInput({ sourceEventId: randomUUID(), text, locale, timestampMs });
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
      if (input.locale !== undefined && this.#presentStopSystemNotice !== undefined) {
        // Cancellation settles before optional native-chat delivery. A slow or
        // failed display may not delay its receipt, proof, or control response.
        void this.#presentStopSystemNotice(resolveStopSystemNotice(outcome, input.locale), admission.stopId).catch(
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

  /** Initial launch facts were already adapter-validated before runtime mount. */
  public acceptInitialFacts(facts: readonly WorldFact[]): void {
    for (const fact of facts) this.acceptIntegrationFact(fact);
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
      this.loop.pump.enqueueFact(fact);
    } catch (error) {
      if (!isEventPumpOverflow(error)) throw error;
      this.#containIntegrationOverflow();
      return;
    }
    if (fact.kind === "snapshot" && this.refreshIntegrationTools !== undefined) {
      // The runtime callback owns idle-barrier coalescing. Retain only its
      // latest shared completion so a burst stays bounded and Pi cannot receive
      // any admitted snapshot before the corresponding projection is installed.
      try {
        const previousRefresh = this.#integrationToolRefresh;
        const nextRefresh = this.refreshIntegrationTools();
        // Each async invocation may return a distinct wrapper around the
        // runtime's shared in-flight refresh. Observe an overwritten wrapper so
        // its common rejection cannot escape while the latest one owns gating.
        if (previousRefresh !== undefined) void previousRefresh.catch(() => undefined);
        this.#integrationToolRefresh = nextRefresh;
      } catch {
        try {
          this.#containIntegrationFailure("integration_tool_refresh_failed");
        } catch {
          // The stable refresh failure owns containment even if revocation rejects.
        }
        return;
      }
    }
    void this.flushSoon().catch(() => undefined);
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
    this.#integrationToolRefresh = undefined;
    this.turnTracker.revoke();
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

  private async flushSoon(): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen || this.#flushScheduled) return;
    this.#flushScheduled = true;
    try {
      // A microtask coalesces bursts of Mod receipts/snapshots without adding
      // an intent layer or holding game-thread/pipe work open.
      await Promise.resolve();
      // An overflow can occur after this work was scheduled. Admission is the
      // Host-owned cancellation fence for scheduled and retry flushes.
      if (!this.#closed && this.#integrationAdmissionOpen) {
        while (this.#integrationToolRefresh !== undefined) {
          const refresh = this.#integrationToolRefresh;
          try {
            await refresh;
          } catch {
            try {
              this.#containIntegrationFailure("integration_tool_refresh_failed");
            } catch {
              // The stable refresh failure remains the externally observable
              // reason even if adapter revocation itself rejects.
            }
            throw new Error("integration_tool_refresh_failed");
          } finally {
            if (this.#integrationToolRefresh === refresh) this.#integrationToolRefresh = undefined;
          }
        }
        if (!this.#closed && this.#integrationAdmissionOpen) await this.loop.flush();
      }
      this.#retryDelayMs = 50;
    } catch (error) {
      // EventPump restored the exact batch. Do not spin or create an unhandled
      // rejection when a provider/session is unavailable; retry with bounded
      // exponential backoff and retain backpressure in the pump.
      this.scheduleRetry();
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
        if (this.#retryDelayMs === 50) void this.flushSoon().catch(() => undefined);
      }
    }
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
