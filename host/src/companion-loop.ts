import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CompanionLiveSourceEvidenceSink } from "./companion-live-source-attestation.js";
import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  type NativeCompanionContentObserver,
} from "./native-companion-content.js";
import { GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import { CompanionEventPump, type CompanionTurnOutcome, type DeliveryDisposition } from "./event-pump.js";
import { isRefusedTurnEvent } from "./companion-turn-refusal.js";

export type NativeGameCompanionContent = Readonly<{
  sourceEventId: string;
  text: string;
}>;

export type NativeGameContentPresenter = (content: NativeGameCompanionContent) => Promise<void>;

export interface CompanionTurnObserver {
  /**
   * Runs only around an actual Pi-consumed batch. `sourceEventId` is the
   * deterministic authenticated cause: the final player source when present,
   * otherwise the final non-held adapter world trigger—never a queue id or
   * generated batch id.
   */
  beginPlayerBatch(sourceEventId: string, batchId: string | undefined): void;
  endBatch(batchId: string | undefined): void;
  /**
   * Receives final ordinary assistant content only for the currently Pi-consumed
   * player batch. This callback owns surface admission; it is never invoked for
   * tool calls, world-only batches, aborted/error turns, or after STOP revoke.
   */
  presentNativeAssistantContent?(content: NativeGameCompanionContent): Promise<void>;
}

/** Completion is session-authoritative only after Pi itself reports idle. */
export type CompanionPiSession = Pick<AgentSession, "sendUserMessage"> &
  Partial<Pick<AgentSession, "abort" | "clearQueue" | "waitForIdle" | "subscribe">>;

/**
 * The Game surface's per-turn authored-context binding.
 *
 * The keyword-gated entries of the companion's own world book are selected from the
 * text the companion is handed for exactly ONE delivered turn, and released when that
 * turn settles, so no later turn can inherit an earlier turn's selection. The Game
 * runtime supplies this port only when a reviewed world book was actually published;
 * a surface without one never selects anything.
 */
export type CompanionTurnVolatileContext = Readonly<{
  bind(turnId: string, deliveredBatch: string): void;
  clear(turnId: string): void;
}>;

/**
 * The Game surface's per-turn model reload.
 *
 * A player can change provider, model or thinking level while the game is running, and the Chat
 * surface answers that by re-reading the selection before every prompt. The Game has no prompt
 * loop of its own - its turns are delivered by this loop - so this is where the same read happens:
 * immediately before a batch is handed to Pi, and nowhere else. A session whose selection is
 * unchanged is left untouched, so an idle game reads two small files per turn instead of rewriting
 * Pi's provider entry.
 */
export type CompanionTurnModelReload = () => Promise<void>;

/**
 * Thin Host orchestration: a labelled batch becomes one explicitly classified Pi turn.
 * It intentionally has no goals, planner state, or game-success inference.
 */
export class CompanionLoop {
  readonly #pump = new CompanionEventPump();
  #turnObserver: CompanionTurnObserver | undefined;
  #inFlight: Promise<CompanionTurnOutcome> | undefined;
  #cancelQueuedDelivery: (() => void) | undefined;
  #queuedPlayerDelivery = false;
  public constructor(
    private readonly session: CompanionPiSession,
    turnObserver?: CompanionTurnObserver,
    private readonly liveSourceEvidence?: CompanionLiveSourceEvidenceSink,
    private readonly voiceSink?: import("./voice.js").ChatVoiceSpeechPublisher,
    private readonly volatileContext?: CompanionTurnVolatileContext,
    private readonly reloadModelSelection?: CompanionTurnModelReload,
  ) {
    this.#turnObserver = turnObserver;
  }
  /** Private materializer wiring; the Host tracker is attached exactly once before ingress. */
  public attachTurnObserver(turnObserver: CompanionTurnObserver): void {
    if (this.#turnObserver !== undefined) throw new Error("companion_turn_observer_already_attached");
    this.#turnObserver = turnObserver;
  }

  /**
   * Adds the Host-owned native Game output hook without replacing turn lineage.
   * This is a composition-only seam: the presenter must be installed before
   * any ingress is accepted, so an actual Pi-consumed batch cannot race an
   * observerless Game turn.
   */
  public attachNativeGameContentPresenter(presenter: NativeGameContentPresenter): void {
    const observer = this.#turnObserver;
    if (observer === undefined || observer.presentNativeAssistantContent !== undefined)
      throw new Error("native_game_content_presenter_unavailable");
    this.#turnObserver = Object.freeze({
      ...observer,
      presentNativeAssistantContent: presenter,
    });
  }

  public get pump(): CompanionEventPump {
    return this.#pump;
  }

  /** A player request is accepted but has not yet emitted Pi's exact message_start. */
  public get hasQueuedPlayerDelivery(): boolean {
    return this.#queuedPlayerDelivery || this.#pump.hasPendingPlayerInput;
  }

  /**
   * STOP's synchronous caller seals ingress first. This then clears queued work,
   * requests exact Pi cancellation, and waits for the in-flight turn and Pi's
   * own idle barrier before it lets STOP become terminal.
   */
  public async abortAndClear(): Promise<void> {
    this.#pump.clear();
    // Production AgentSession always supplies the complete barrier. The
    // fallback is only for explicitly reduced deterministic test adapters;
    // neither branch can create live source evidence without `subscribe`.
    this.session.clearQueue?.();
    await this.session.abort?.();
    if (this.session.waitForIdle === undefined) {
      this.#cancelQueuedDelivery?.();
      return;
    }
    // After Pi acknowledges abort, a message that has not emitted its exact
    // user-message start was removed by clearQueue rather than consumed.
    this.#cancelQueuedDelivery?.();
    await this.#inFlight;
    await this.session.waitForIdle();
  }

  /**
   * Flush the pending batch. Resolves with how the delivered turn ended, or `undefined` when there was
   * nothing to deliver (or a delivery is already in flight) — callers must treat `undefined` as
   * `unobserved`, never as success.
   */
  public async flush(): Promise<CompanionTurnOutcome | undefined> {
    return await this.#pump.flush({
      deliver: async (batch, disposition) => {
        // Only the real Pi-consumed batch may activate presentation lineage.
        const parsed = JSON.parse(batch) as SerializedBatch;
        const sourceEventId = canonicalPresentationSource(parsed);
        const batchId = isOpaqueSource(parsed.batchId) ? parsed.batchId : undefined;
        const completion = this.#deliverAndObserve(
          batch,
          disposition,
          sourceEventId,
          batchId,
          canonicalTurnLocale(parsed),
        );
        this.#inFlight = completion;
        try {
          return await completion;
        } finally {
          if (this.#inFlight === completion) this.#inFlight = undefined;
        }
      },
    });
  }

  async #deliverAndObserve(
    batch: string,
    disposition: Exclude<DeliveryDisposition, "hold">,
    sourceEventId: string | undefined,
    batchId: string | undefined,
    turnLocale: string | undefined,
  ): Promise<CompanionTurnOutcome> {
    let accepted = false;
    let settled = false;
    // Pi's own final-message classification, which used to be thrown away here (`onRejected: () =>
    // undefined`). It is the only thing that can tell a caller the turn FAILED rather than answered.
    let turnOutcome: CompanionTurnOutcome | undefined;
    /**
     * Records how this turn ended. `refused` outranks every other ending: Magic Context never sent the
     * pass, so whatever Pi reports afterwards (the abort it caused, or a content rejection) is that
     * refusal's own consequence. Otherwise the first classification of the turn wins.
     */
    const recordOutcome = (outcome: CompanionTurnOutcome): void => {
      if (turnOutcome === "refused") return;
      if (outcome === "refused" || turnOutcome === undefined) turnOutcome = outcome;
    };
    let beganPresentation = false;
    let beganVoice = false;
    let voiceBegin: Promise<void> | undefined;
    let nativeContentObserver: NativeCompanionContentObserver | undefined;
    let nativeContentFinal: Promise<void> | undefined;
    let voiceFinalized = false;
    const tracksPlayerDelivery = sourceEventId !== undefined;
    let unsubscribe: (() => void) | undefined;
    let resolveStarted!: () => void;
    let resolveCompleted!: () => void;
    let resolveCancelled!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    // Did this turn DO anything, or only speak?
    //
    // MEASURED 2026-10-30 (`round9`): the companion came home at in-game 18:20, said one line about putting a pot on, and
    // stopped with `stop=stop` and no tool call. The pump had nothing pending, so nothing woke another turn - and because a
    // Stardew clock only advances while an action is taken, the 22:00 milestone that WOULD have told it to sleep could never
    // arrive. The world cannot break that lock by itself: the companion is the only thing that moves it.
    //
    // `turnOutcome` cannot answer this: `completed` covers both "acted" and "only spoke". So the turn records the one fact
    // that separates them - whether Pi emitted a tool call for this batch - and `HostService` uses it to decide whether
    // another turn is owed.
    let producedWork = false;
    try {
      if (tracksPlayerDelivery) this.#queuedPlayerDelivery = true;
      this.#cancelQueuedDelivery = resolveCancelled;
      // The player's Settings may have moved since the previous turn: the model a companion turn runs
      // with is the selection the player holds NOW, exactly as a Chat turn re-reads it before its own
      // prompt. A reload that fails is not swallowed into the turn - an unusable selection must reach
      // the player as a failed turn, never as one answered on the model they just left - and the pump
      // restores this exact batch for the retry, so nothing is lost.
      if (this.reloadModelSelection !== undefined) await this.reloadModelSelection();
      // Bind this turn's keyword-gated world-book entries to the exact batch Pi is about
      // to consume, the way the Chat surface binds its own volatile sources immediately
      // before `session.prompt`. The batch id is this turn's own identity, so two turns
      // can never share a selection, and the binding is released in the `finally` below.
      // A failure here degrades the turn's background; it must never decide the turn - but it
      // must not be SILENT either: her book not reaching a turn is exactly the kind of quiet loss
      // this feature exists to remove, so the failure names itself on stderr and the turn goes on.
      if (batchId !== undefined) {
        try {
          this.volatileContext?.bind(batchId, batch);
        } catch (error) {
          process.stderr.write(
            `[game-volatile] bind failed for batch ${batchId}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (this.session.subscribe === undefined) {
        // Tests and non-production adapters without Pi's event stream retain
        // legacy send completion semantics; they cannot mint live evidence, and
        // they cannot say how the turn ended either — `unobserved`, not success.
        if (sourceEventId !== undefined) {
          this.#turnObserver?.beginPlayerBatch(sourceEventId, batchId);
          beganPresentation = true;
        }
        await this.session.sendUserMessage(batch, { deliverAs: disposition === "steer" ? "steer" : "followUp" });
        return "unobserved";
      }
      unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
        // Any tool execution in this batch is work: the model chose an action rather than only speaking. Read from the raw
        // event stream because this is the only layer that sees it - the pump sees batches, and `turnOutcome` collapses
        // "acted" and "spoke" into `completed`. `tool_execution_start` is the one event type that fires for every tool a
        // turn runs, including a `stardew_plan_work` batch, and it is the SDK's own name for it.
        if (event.type === "tool_execution_start") producedWork = true;
        if (event.type === "message_start" && !accepted && isExactBatchMessage(event.message, batch)) {
          // Pi has now put this exact batch into its active context. Open the
          // presentation lineage *at this boundary*, not after
          // `sendUserMessage()` resolves (which is after the whole turn).
          accepted = true;
          if (tracksPlayerDelivery) this.#queuedPlayerDelivery = false;
          if (sourceEventId !== undefined) {
            this.#turnObserver?.beginPlayerBatch(sourceEventId, batchId);
            beganPresentation = true;
            // Voice: the same Game turn may stream generated companion speech
            // (NFC-normalized deltas appended as they arrive, finalized when the
            // final text lands). Voice stays voice-local: a failure here never
            // poisons the presentation lineage or the durable Game state.
            if (this.voiceSink !== undefined) {
              // Fire-and-forget open ordered before every delta/finalize/cancel:
              // appends and the terminal settle await this same promise, so a
              // fast stream can never race the job open.
              voiceBegin = (async () => {
                await this.voiceSink!.begin(String(batchId ?? sourceEventId));
                beganVoice = true;
              })().catch(() => {
                // Voice degradation is graceful.
              });
            }
            // A production Game composition installs the final-content
            // presenter before ingress opens. Smaller non-Game consumers of
            // CompanionLoop intentionally have no Game presentation surface,
            // so absence means "no projection", never a synthetic fallback.
            if (this.#turnObserver?.presentNativeAssistantContent !== undefined) {
              nativeContentObserver = attachNativeCompanionContent(
                this.session as AgentSession,
                {
                  // Raw Game companion deltas still feed the same streaming TTS
                  // lane when a voice sink is attached; without one they stay
                  // unprojected at delta granularity.
                  onPreviewDelta: async (delta) => {
                    if (this.voiceSink === undefined) return;
                    try {
                      await voiceBegin;
                      await this.voiceSink.append(delta.normalize("NFC"));
                    } catch {
                      // Voice degradation is graceful.
                    }
                  },
                  // Under incremental activation every completed sentence emitted
                  // from the delta lane is already a final presentation piece;
                  // it crosses the same source-lineage presenter as the final
                  // text, in arrival order, and is never re-chunked.
                  onIncrementalText: async (piece) => {
                    const content = Object.freeze({ sourceEventId, text: piece });
                    await this.#turnObserver?.presentNativeAssistantContent?.(content);
                  },
                  onFinalText: async (text) => {
                    // One message's text is one paragraph, committed once. The
                    // previous per-sentence chunking put four bubbles in front
                    // of the player inside the same instant, which reads as a
                    // stutter rather than as speech; the only piece allowed to
                    // leave before this is the working remark the observer
                    // released after a real silence. Voice finalizes after this
                    // one piece, so cleanup (finally) never cancels an
                    // already-finalized job.
                    if (this.voiceSink !== undefined) {
                      try {
                        await voiceBegin;
                        await this.voiceSink.finalize();
                        voiceFinalized = true;
                      } catch {
                        // Voice degradation is graceful.
                      }
                    }
                    const content = Object.freeze({ sourceEventId, text });
                    const presentation = this.#turnObserver?.presentNativeAssistantContent?.(content);
                    if (presentation !== undefined) nativeContentFinal = presentation;
                    await presentation;
                  },
                  onRejected: (reason) => {
                    // `aborted`/`error` are the transport-level endings; the remaining reasons are
                    // content rejections (empty, tool-only, identity mismatch) that all mean the turn
                    // produced nothing presentable — recorded as a failure, never as a quiet success.
                    recordOutcome(reason === "aborted" || reason === "error" ? reason : "error");
                  },
                },
                {
                  stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,
                  scaffolding: NATIVE_BUBBLE_SCAFFOLDING,
                  // The in-game surface delivers with pacing on; the Chat transcript's
                  // observer is configured elsewhere and takes the off default.
                  pacing: GAME_DELIVERY_PACING,
                  // The turn's own identity seeds the reaction sound and its language
                  // picks the vocabulary. Both come from the authenticated batch facts,
                  // never from generated content.
                  ...(sourceEventId === undefined
                    ? {}
                    : {
                        turn: Object.freeze({
                          id: sourceEventId,
                          ...(turnLocale === undefined ? {} : { locale: turnLocale }),
                        }),
                      }),
                },
              );
              nativeContentObserver.open();
              // Previews unlock the delta lane for every Game surface, not only
              // voice: incremental presentation consumes completed sentences from
              // that same stream, so the lane opens whenever a Game presenter is
              // installed. Voice stays one of its consumers; the message_end
              // residual still crosses the source-lineage bridge.
              nativeContentObserver.openPreviews();
            }
          }
          if (sourceEventId !== undefined && batchId !== undefined)
            this.#emitLiveEvidence((sink) => sink.piTurnAccepted({ batchId, sourceEventId, disposition }));
          resolveStarted();
          return;
        }
        // Magic Context refused this turn rather than sending a degraded pass. Upstream appends a
        // display-only refusal entry and then aborts the run (see companion-turn-refusal.ts), so the
        // abort is the refusal's own consequence and must not be reported as the player's STOP.
        if (isRefusedTurnEvent(event)) {
          recordOutcome("refused");
          return;
        }
        if (event.type === "agent_settled" && accepted && !settled) {
          settled = true;
          // Pi 1.1.0 tells the observer whether the settled run was aborted. Without it, an aborted run
          // that never produced a final message left no recorded outcome, and the tail of this method
          // returned `completed` for a run the player had cancelled. The content observer's own
          // classification stays authoritative when it exists; this only fills the case where nothing
          // classified the run.
          if (event.aborted) recordOutcome("aborted");
          if (sourceEventId !== undefined && batchId !== undefined)
            this.#emitLiveEvidence((sink) => sink.piTurnSettled({ batchId, sourceEventId, disposition }));
          resolveCompleted();
        }
      });
      // Attach an observed branch immediately: a synchronous/rejected Pi
      // delivery before `message_start` must reject the pump (so it preserves
      // the exact immutable batch for retry), not leave a rejected promise and
      // a permanently pending provenance wait behind.
      const delivery = this.session.sendUserMessage(batch, {
        deliverAs: disposition === "steer" ? "steer" : "followUp",
      });
      const deliveryObserved = delivery.then(
        () => ({ kind: "delivered" as const }),
        (error) => ({ kind: "failed" as const, error }),
      );
      // Successful send completion is not provenance: only `message_start`
      // proves Pi consumed this exact batch. Observe only a rejection here;
      // a successful delivery still waits for that event (or STOP cancellation).
      const deliveryFailure = deliveryObserved.then((outcome) =>
        outcome.kind === "failed" ? outcome : new Promise<never>(() => {}),
      );
      // `message_start` carries the exact user payload Pi added to the active
      // run. Queue admission and a generic agent_start are not provenance.
      const consumption = await Promise.race([
        started.then(() => ({ kind: "consumed" as const })),
        cancelled.then(() => ({ kind: "cancelled" as const })),
        deliveryFailure,
      ]);
      // A queued delivery rejected before consumption is a retryable Pi
      // failure. If STOP already sealed the batch, cancellation wins and the
      // old epoch must not be revived even if its queued delivery rejects later.
      if (consumption.kind === "failed") throw consumption.error;
      if (consumption.kind === "cancelled") {
        if (beganVoice && this.voiceSink !== undefined) {
          try {
            await this.voiceSink.cancel();
          } catch {
            // Voice degradation is graceful.
          }
        }
        await deliveryObserved;
        // STOP cancelled this batch before Pi consumed it: nothing ran, so there is no turn outcome to
        // report (and reporting `completed` here would be the same swallowed failure in a new shape).
        return "unobserved";
      }
      await deliveryObserved;
      // An abort that clears an unstarted queued message is terminal without a
      // Pi-consumption claim. An accepted turn instead must reach Pi settlement.
      if (!accepted) return "unobserved";
      await completed;
      if (!settled) throw new Error("pi_turn_settlement_missing");
      // The final observer callback is serialized independently of Pi's
      // settlement notification. Drain it before closing the lineage so the
      // bridge's source/epoch admission remains current through its only
      // native-content presentation write.
      try {
        await nativeContentObserver?.close();
      } catch (error) {
        if (!isSettledTailPresentationFailure(error)) throw error;
      }
      nativeContentObserver = undefined;
      try {
        await nativeContentFinal;
      } catch (error) {
        // This drain runs ONLY after the turn settled (accepted + agent_settled
        // observed above). The final native-content presentation is a tail
        // delivery, not the turn's authority: a stale epoch / revoked lineage /
        // rejected native write here means the runtime admission was already
        // closed by STOP, transport loss, or teardown AFTER settlement. The
        // presenter recorded that uncertain delivery through
        // closeForUncertainCommit before propagating; failing the settled turn
        // for it would fabricate a failure for a completed gameplay/receipt
        // cycle. Only this settled-turn tail is downgraded - in-turn
        // presentation errors still surface through the observer chain.
        if (!isSettledTailPresentationFailure(error)) throw error;
      }
      // The turn settled. If Pi classified its final message as abort/error the outcome says so; otherwise
      // the turn completed. `unobserved` is impossible here — reaching this point means the turn ran.
      return turnOutcome ?? "completed";
    } finally {
      this.pump.turnProducedWork = producedWork;
      if (batchId !== undefined) {
        try {
          this.volatileContext?.clear(batchId);
        } catch {
          /* settled turn: release is best-effort and a stale binding fails closed upstream */
        }
      }
      if (this.#cancelQueuedDelivery === resolveCancelled) this.#cancelQueuedDelivery = undefined;
      if (tracksPlayerDelivery) this.#queuedPlayerDelivery = false;
      unsubscribe?.();
      nativeContentObserver?.revoke();
      await nativeContentObserver?.close();
      // The voice job opened with the batch but never finalized; cleanup
      // waits for the (already-ordered) open then cancels so the gateway slot
      // is released even when the presentation lineage already closed.
      if (beganVoice && !voiceFinalized && this.voiceSink !== undefined) {
        try {
          await voiceBegin;
          await this.voiceSink.cancel();
        } catch {
          // Voice degradation is graceful.
        }
      }
      if (beganPresentation) this.#turnObserver?.endBatch(batchId);
    }
  }

  /** Evidence loss invalidates the live gate but must not stall Pi/STOP control. */
  #emitLiveEvidence(emit: (sink: CompanionLiveSourceEvidenceSink) => void): void {
    try {
      if (this.liveSourceEvidence !== undefined) emit(this.liveSourceEvidence);
    } catch {
      /* intentionally observational */
    }
  }
}

function isExactBatchMessage(message: unknown, expectedBatch: string): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Readonly<{ role?: unknown; content?: unknown }>;
  if (record.role !== "user") return false;
  // Pi's `sendUserMessage(string)` canonicalizes its payload to exactly this
  // single text block. Reject any additional, non-text, or string-shaped
  // content: a matching part is not proof that this exact batch was consumed.
  return (
    Array.isArray(record.content) &&
    record.content.length === 1 &&
    !!record.content[0] &&
    typeof record.content[0] === "object" &&
    !Array.isArray(record.content[0]) &&
    (record.content[0] as Readonly<{ type?: unknown; text?: unknown }>).type === "text" &&
    (record.content[0] as Readonly<{ text?: unknown }>).text === expectedBatch
  );
}

type SerializedBatch = Readonly<{
  batchId?: string;
  playerInputs?: readonly Readonly<{ eventId?: string; inputId?: string; locale?: string }>[];
  worldFacts?: readonly Readonly<{
    kind?: string;
    sourceEventId?: string;
    eventId?: string;
    correlationId?: string;
    revision?: number;
    occurredAtMs?: number;
    payload?: Readonly<{ state?: unknown }>;
  }>[];
  events?: readonly Readonly<{
    kind?: string;
    eventId?: string;
    occurredAtMs?: number;
    revision?: number;
    input?: Readonly<{ eventId?: string; inputId?: string }>;
    sourceEventId?: string;
    semanticKind?: string;
    payload?: Readonly<{ state?: unknown }>;
  }>[];
}>;

/**
 * The language this turn is conducted in, from the last player input the batch
 * carried. A world-triggered turn has no player input and therefore no locale,
 * which the reaction mechanism reads as "say nothing" rather than guessing.
 */
function canonicalTurnLocale(batch: SerializedBatch): string | undefined {
  const locales = (batch.playerInputs ?? [])
    .map((input) => input.locale)
    .filter((locale): locale is string => typeof locale === "string" && locale.length > 0);
  return locales.at(-1);
}

/**
 * Selects the canonical cause only from a real serialized Pi batch. Events are
 * already deterministically sorted by CompanionEventPump; held snapshot and
 * progress facts never grant presentation authority.
 */
function canonicalPresentationSource(batch: SerializedBatch): string | undefined {
  const events = batch.events ?? [];
  const playerSources = events
    .filter((event) => event.kind === "player_input")
    // `inputId` is correlation/dedupe only. A presentation cause must have
    // crossed an authenticated ingress as an explicit opaque event identity.
    .map((event) => event.input?.eventId)
    .filter(isOpaqueSource);
  if (playerSources.length > 0) return playerSources.at(-1);

  // Bounded sensory lease: only explicitly salient world-fact kinds may open a
  // companion turn (e.g. day_started / time_milestone morning greetings). Every
  // other world-trigger batch still gets no native presentation lineage.
  const sensorySources = events
    .filter((event) => event.kind === "world_fact" && isSalientSensoryKind(event.semanticKind))
    .map((event) => event.sourceEventId)
    .filter(isOpaqueSource);
  return sensorySources.length > 0 ? sensorySources.at(-1) : undefined;
}

/**
 * White-listed salient sensory kinds allowed to mint a bounded presentation lease.
 *
 * `day_started` / `time_milestone` are the Mod's own salient events. `companion_arrival` is the Host's
 * (see `companion-arrival-fact.ts`): she has just arrived on the farm and the world clock gave its first
 * reading. It is the one proactive turn the product owes the player at arrival, so it must open the same
 * presentation lease every other proactive turn does, or her greeting would reach the model and never
 * reach the chat.
 *
 * `native_notice` is the Host's too (`native-notice-fact.ts`): the game itself said something about the hour
 * ("It's getting late...") and the companion may answer it out loud. It rides the same lease for the same
 * reason - a reply that reaches the model but not the chat is a decision the player never sees.
 */
function isSalientSensoryKind(kind: string | undefined): boolean {
  return (
    kind === "day_started" || kind === "time_milestone" || kind === "companion_arrival" || kind === "native_notice"
  );
}

function isOpaqueSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Failure classes that mean "the turn already settled and this native-content
 * presentation is only a tail delivery": the runtime epoch was revoked (STOP /
 * transport loss / teardown -> stale_interruption_admission), the source lineage
 * was revoked or closed (stale_presentation_lineage / uncertain lineage), or the
 * bridge refused the presentation (bridge_rejected).
 * None of them can undo the settled gameplay/receipt cycle; downgrading them
 * keeps a completed turn from being reported as failed because its final text
 * did not land after settlement. Everything else (programming errors) still
 * propagates.
 */
function isSettledTailPresentationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === "stale_interruption_admission" ||
    message === "stale_presentation_lineage" ||
    message.startsWith("bridge_rejected:") ||
    message === "native_presentation_lineage_mismatch"
  );
}
