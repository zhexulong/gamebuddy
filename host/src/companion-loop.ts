import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createCompanionActivityIndicator } from "./companion-activity.js";
import { GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import type { CompanionLiveSourceEvidenceSink } from "./companion-live-source-attestation.js";
import { isRefusedTurnEvent } from "./companion-turn-refusal.js";
import {
  CompanionEventPump,
  TURN_PRODUCTION,
  TURN_SUPPRESSION,
  turnAccountLine,
  type CompanionTurnOutcome,
  type DeliveryDisposition,
  type PendingBatch,
} from "./event-pump.js";
import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_DELIVERY_UNIT,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  type NativeCompanionContentObserver,
  type NativeCompanionPartSuppression,
  type NativeCompanionTurnBubble,
  readAssistantMessageFacts,
} from "./native-companion-content.js";

export type NativeGameCompanionContent = Readonly<{
  sourceEventId: string;
  text: string;
}>;

/**
 * Why one of a turn's assistant text parts never reached the player.
 *
 * <p>
 * Two layers can withhold a part, and each one names its own: the projection says what it
deliberately withheld (`NativeCompanionPartSuppression`, carried on `onMessageText`), and this loop
names the text no projection ever saw. `no_presentation_lease` is that second family's only member
today - the turn carried no presentation source, so no projection was attached and nothing else could
report its parts. It is declared here rather than in the projection's own enum because the projection
can never produce it, and a member no code path sets is decoration.
 * </p>
 */
export type CompanionTurnPartSuppression = NativeCompanionPartSuppression | "no_presentation_lease";

/**
 * The ending of a turn whose assistant message carried neither text nor a tool call.
 *
 * <p>
 * It is a terminal code, not an error class: `HostService` bounds how many of them one prompt may end with and then ends
 * the run by this name, so a stalled run cannot be reported as a companion that is still thinking.
 * </p>
 */
export const PROVIDER_EMPTY_COMPLETION = "provider_empty_completion" as const;

/** Whether one rejected turn ended because the provider answered with nothing. */
export function isProviderEmptyCompletion(error: unknown): boolean {
  return error instanceof Error && error.message === PROVIDER_EMPTY_COMPLETION;
}

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
  /**
   * What the player could be shown she is doing, derived from what this loop already knows (`companion-activity.ts`).
   *
   * <p>
   * Presentation only: it carries no words, enters no prompt and never reaches Pi, so it cannot be spoken as dialogue
   * and cannot change what a turn decides. Every transition below reads a fact the loop already has - a batch became a
   * turn, Pi consumed it, her text arrived, a tool started or returned, the pump's own windows - so there is no second
   * copy of any of them to disagree.
   * </p>
   */
  readonly #activity = createCompanionActivityIndicator();
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
   *
   * <p>
   * THIS IS THE ONE CALL SITE THAT OPENS A TURN, so it is also where the pump's own account is printed: "fewer turns"
   * and "lost turns" have to be distinguishable in a run's log, and only this layer sees both the decision and the run.
   * A flush suppressed for having nothing at all is not printed - it is not a decision the run paid for - but it stays
   * counted in `examined`, so the next line's arithmetic still closes.
   * </p>
   */
  public async flush(): Promise<CompanionTurnOutcome | undefined> {
    const outcome = await this.#pump.flush({
      deliver: async (batch) => {
        // Only the real Pi-consumed batch may activate presentation lineage.
        const sourceEventId = canonicalPresentationSource(batch);
        const batchId = isOpaqueSource(batch.batchId) ? batch.batchId : undefined;
        const completion = this.#deliverAndObserve(
          batch.text,
          batch.disposition,
          sourceEventId,
          batchId,
          canonicalTurnLocale(batch),
        );
        this.#inFlight = completion;
        try {
          return await completion;
        } finally {
          if (this.#inFlight === completion) this.#inFlight = undefined;
        }
      },
    });
    this.#reportTurnDecision();
    return outcome;
  }

  /**
   * One line per examined turn decision, in the shape the invariant is read back in.
   *
   * An OPENED turn prints the account alone; a suppression prints its own reason first, because the reason is the only
   * thing that tells "she had nothing new" from "a turn was lost".
   */
  #reportTurnDecision(): void {
    const account = this.#pump.turnAccount;
    const decision = account.lastDecision;
    if (decision === undefined || decision.reason === TURN_SUPPRESSION.nothingPending) return;
    const marker = decision.kind === "opened" ? "GAME_TURN_ACCOUNT" : `GAME_TURN_SUPPRESSED ${decision.reason}`;
    process.stderr.write(`${marker} ${turnAccountLine(account)}\n`);
  }

  /**
   * Inject the expiring facts into the turn that is ALREADY running.
   *
   * <p>
   * Deliberately not routed through `flush`: that method means "start or continue a turn" and it establishes
   * `#inFlight`, which belongs to the turn the running `deliver` call owns. A steer joins that turn rather than
   * starting another, so it must not take ownership of `#inFlight` and must not open a presentation lineage - the line
   * the model speaks in response belongs to the same turn, and attributing it to a second one is the arithmetic
   * `round23`'s audit already caught (`pieceAtMs` off by 12.4 minutes).
   * </p>
   * <p>
   * `deliverAs: "steer"` is Pi's own queueing ("A steering message enters after the current assistant turn and its
   * tool calls"), so it does not preempt a token stream in flight.
   * </p>
   */
  public async steer(): Promise<boolean> {
    return await this.#pump.steer({
      deliver: async (batch) => {
        await this.session.sendUserMessage(batch.text, {
          deliverAs: batch.disposition === "steer" ? "steer" : "followUp",
        });
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
    /**
     * Did this turn's assistant message carry any ordinary text?
     *
     * <p>
     * `producedWork` cannot answer it (a turn that only speaks produced none), and neither can `turnOutcome` - so the
     * two raw facts together are what tells a turn from a message that carried nothing at all. The tail of this method
     * carries the measurement that made that distinction necessary.
     * </p>
     */
    let producedText = false;
    /** Did any of this turn's assistant messages ask to run a tool? A tool call is a turn even when it says nothing. */
    let producedToolCall = false;
    /** Did Pi report at least one assistant message for this turn? */
    let sawAssistantMessage = false;
    /**
     * How many assistant text parts this turn produced, how many reached the player, and why the
     * rest did not.
     *
     * <p>
     * `assistantTextParts` is Pi's own message stream - the population. `presentedTextParts` and
     * `suppressedByReason` are the projection's own report of what it did with each message: how many parts it
     * delivered and how many it withheld, by reason. The three are counted independently and the identity between them
     * is `presented + suppressed === produced`; whatever does not fit it is a lost part, printed as `delivery_mismatch:`
     * and blocking the run's delivery verdict. That is exactly what the 2026-11-09 audit could not get from any
     * artifact: 47 of a 34-minute run's 60 parts never reached presentation, and nothing in the bundle said which layer
     * dropped them.
     * </p>
     */
    let assistantTextParts = 0;
    let presentedTextParts = 0;
    const suppressedByReason = new Map<CompanionTurnPartSuppression, number>();
    /**
     * What this turn's delivery took, in the unit the player experiences: the BUBBLE.
     *
     * <p>
     * MEASURED 2026-11-11 (round46b, 15 minutes): 27 prompt turns produced 55 assistant messages and 49 bubbles - one
     * every 13 seconds, 2.04 messages per turn - because every assistant message was presented as a reply of its own.
     * The surface's unit is now the turn (`native-companion-content.ts` `deliverTurn`), so `presentedTextPieces` counts
     * the bubbles this turn committed (0 or 1) and `textMessageIds` names the messages those bubbles rolled up. A part is
     * a block of model text, a bubble is one commit the player saw; publishing both is what lets a run's own
     * `presentation.pieceCount` reconcile against this record instead of reading the difference as missing turns.
     * </p>
     * <p>
     * MEASURED 2026-11-09 (round41 `multiday_routine`): `presentation.pieceCount` 59, `AGENT_PRESENTATION_PIECE` 59 lines,
     * `sessionTurns[].spokenLines` 59, and 13 delivery records accounting `textParts` 46 / `presented` 46 / `unaccounted`
     * 0 - and nothing said why the two populations differ. The 59 were 11 reaction sounds (one per paced turn), 46
     * paragraphs, and 2 extra pieces from a paragraph the length budget split: 13 pieces that are not text parts. Those
     * sounds are now inside the turn's bubble and a split is a second bubble, which is why the record carries one bubble
     * count rather than a text/ahead pair.
     * </p>
     */
    let presentedTextPieces = 0;
    /** The assistant messages whose text this turn's bubble rolled up, in arrival order. */
    let textMessages = 0;
    const textMessageIds: string[] = [];
    /** What the turn's one bubble cost when it was presented, or `null` when the turn presented none. */
    let turnBubble: NativeCompanionTurnBubble | null = null;
    /** Did Pi classify the message it ended on as a provider failure or a cancellation? Read from the raw stream. */
    let assistantFailed = false;
    /**
     * Publishes `speaking` for the text now arriving.
     *
     * Guarded by the state machine's own current state rather than a flag of its own: text arrives as a delta, again as
     * the message's final commit, and a second time for every later message in the same turn, and all of those are the
     * same state. A tool call in between has already moved the state on, which is what makes the next utterance a
     * transition - so the guard and the transitions cannot disagree.
     */
    const noteTextArriving = (): void => {
      if (this.#activity.current === "speaking") return;
      this.#activity.transition("speaking");
    };
    // TURN CREATED. A batch became a turn, so she is thinking about it from this moment - published before anything
    // below can fail, because a turn that dies in the next statement is exactly the silence the player has to be able
    // to read as an ending rather than as a crash.
    this.#activity.transition("thinking");
    try {
      if (tracksPlayerDelivery) this.#queuedPlayerDelivery = true;
      this.#cancelQueuedDelivery = resolveCancelled;
      // The player's Settings may have moved since the previous turn: the model a companion turn runs
      // with is the selection the player holds NOW, exactly as a Chat turn re-reads it before its own
      // prompt. It is also the one place this turn stands still with a prompt still owed, so it is
      // where STOP has to be able to win - see `#reloadModelSelectionUnlessSealed`.
      if (!(await this.#reloadModelSelectionUnlessSealed(cancelled))) return "unobserved";
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
      /**
       * One assistant message, read from Pi's raw stream and counted into this turn's delivery account.
       *
       * <p>
       * The turn's own ending facts: a surface that projects native content classifies them too, but that observer exists
       * only where a presenter is installed, and "was this a turn at all" is not a presentation question.
       * </p>
       */
      const noteAssistantMessage = (message: unknown): void => {
        const assistantFacts = readAssistantMessageFacts(message);
        if (assistantFacts === undefined) return;
        sawAssistantMessage = true;
        assistantTextParts += assistantFacts.textParts;
        // The roll-up's own input: a message that carried text is one of the messages this turn's
        // bubble had to fit. Naming them is what lets a reader see 28 messages arrive as 27 bubbles
        // instead of counting assistant messages and calling that the bubble count.
        if (assistantFacts.textParts > 0) {
          textMessages += 1;
          if (assistantFacts.id !== null) textMessageIds.push(assistantFacts.id);
        }
        // Nothing could have shown this message: the turn carried no presentation source, or the
        // surface installed no presenter, so the observer that names its own withholdings was never
        // attached. Naming it here is the whole difference between a measured omission and the
        // remainder no artifact could explain (2026-11-09: 40 of a run's 79 parts, every one of them
        // in a settlement-driven turn that this loop counted and no projection ever saw).
        if (assistantFacts.textParts > 0 && nativeContentObserver === undefined)
          suppressedByReason.set(
            "no_presentation_lease",
            (suppressedByReason.get("no_presentation_lease") ?? 0) + assistantFacts.textParts,
          );
        if (assistantFacts.hasText) {
          producedText = true;
          // The text paths with no projection attached (a reduced adapter, or a turn that carried no presentation
          // source) never see a delta, so the message's own record is where `speaking` is published for them.
          noteTextArriving();
        }
        if (assistantFacts.hasToolCall) producedToolCall = true;
        if (assistantFacts.failed) assistantFailed = true;
      };
      /**
       * Open this turn's presentation lineage and its listeners, at the moment Pi consumed the exact batch.
       *
       * <p>
       * Pi has now put this exact batch into its active context. The lineage opens *at this boundary*, not after
       * `sendUserMessage()` resolves (which is after the whole turn).
       * </p>
       */
      const openTurnPresentation = (): void => {
        if (sourceEventId === undefined) return;
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
                // Her text has started arriving. Published outside the voice branch below, because voice is one
                // consumer of the preview lane and not the lane itself.
                noteTextArriving();
                if (this.voiceSink === undefined) return;
                try {
                  await voiceBegin;
                  await this.voiceSink.append(delta.normalize("NFC"));
                } catch {
                  // Voice degradation is graceful.
                }
              },
              onFinalText: async (text) => {
                // The turn's ONE bubble: every message's presented text in arrival order, its reaction
                // sound at the head, cut to the bubble ceiling by `deliverTurn()`. A turn that said
                // nothing never reaches this sink, so absence is silence rather than an empty bubble.
                // Voice finalizes after this one piece, so cleanup (finally) never cancels an
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
                if (presentation !== undefined) {
                  presentedTextPieces += 1;
                  nativeContentFinal = presentation;
                }
                await presentation;
              },
              onMessageText: (outcome) => {
                // The projection's own answer for one message: its text parts, and the reason
                // none of them reached the player. Counting here is the whole point - a piece
                // withheld without a count reads exactly like a companion who said nothing.
                if (outcome.suppression === null) presentedTextParts += outcome.textParts;
                else
                  suppressedByReason.set(
                    outcome.suppression,
                    (suppressedByReason.get(outcome.suppression) ?? 0) + outcome.textParts,
                  );
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
              // The bubble's unit is the prompt turn, which is what makes one reply one bubble.
              deliveryUnit: NATIVE_BUBBLE_DELIVERY_UNIT,
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
          // Previews unlock the delta lane for the voice job, which reads the raw stream:
          // the bubble's own text is read from the message at `deliverTurn`, not from
          // this lane, so nothing here can be split into a second bubble.
          nativeContentObserver.openPreviews();
        }
      };
      /**
       * Pi settled this turn: record how it ended, name it on the evidence sink, and release the turn's wait.
       */
      const settleTurn = (aborted: boolean): void => {
        settled = true;
        // Pi 1.1.0 tells the observer whether the settled run was aborted. Without it, an aborted run
        // that never produced a final message left no recorded outcome, and the tail of this method
        // returned `completed` for a run the player had cancelled. The content observer's own
        // classification stays authoritative when it exists; this only fills the case where nothing
        // classified the run.
        if (aborted) recordOutcome("aborted");
        if (sourceEventId !== undefined && batchId !== undefined)
          this.#emitLiveEvidence((sink) => sink.piTurnSettled({ batchId, sourceEventId, disposition }));
        resolveCompleted();
      };
      unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
        // Any tool execution in this batch is work: the model chose an action rather than only speaking. Read from the raw
        // event stream because this is the only layer that sees it - the pump sees batches, and `turnOutcome` collapses
        // "acted" and "spoke" into `completed`. `tool_execution_start` is the one event type that fires for every tool a
        // turn runs, including a `stardew_plan_work` batch, and it is the SDK's own name for it.
        if (event.type === "tool_execution_start") {
          producedWork = true;
          this.#activity.transition("working");
        }
        // A tool call has returned, and what happens next is decided by what it left behind: an execution this pump
        // still holds an unsettled receipt for is her body working in the world (`busy`), and otherwise she is composing
        // the next step (`thinking`). Staying at `working` would report a tool that is no longer running.
        if (event.type === "tool_execution_end")
          this.#activity.transition(this.pump.hasExecutionInFlight ? "busy" : "thinking");
        if (event.type === "message_end") noteAssistantMessage(event.message);
        if (event.type === "message_start" && !accepted && isExactBatchMessage(event.message, batch)) {
          accepted = true;
          if (tracksPlayerDelivery) this.#queuedPlayerDelivery = false;
          openTurnPresentation();
          if (sourceEventId !== undefined && batchId !== undefined)
            this.#emitLiveEvidence((sink) => sink.piTurnAccepted({ batchId, sourceEventId, disposition }));
          // PROVIDER WAITING. Pi has consumed this exact batch, so the request is out and nothing has come back yet.
          // Same state as the turn's own start, published separately because the two answer different questions: the
          // first says a turn exists, this one dates the request - and a run whose first answer took 902 s
          // (`round39`) is only explainable against the moment the provider was actually asked.
          this.#activity.transition("thinking");
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
        if (event.type === "agent_settled" && accepted && !settled) settleTurn(event.aborted);
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
      // THE TURN'S ONE BUBBLE, at the moment the turn is over: every message it spoke, in arrival
      // order, with its reaction sound at the head. It cannot be delivered earlier - a bubble cannot be
      // retracted, so text produced after the commit would be lost - and it is not delivered at all on
      // the paths that never reach this line (STOP before consumption, a delivery Pi refused, an
      // unaccepted or unsettled turn): a stopped or uncertain turn does not speak after the fact. The
      // final observer callback is serialized independently of Pi's settlement notification, so
      // `close()` below drains the bubble's own presentation before the lineage closes.
      turnBubble = nativeContentObserver?.deliverTurn() ?? null;
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
      // An assistant turn that carries neither text nor a tool call is not a turn.
      //
      // MEASURED 2026-11-07: a live Game run's own session record ended with
      //
      //   {"type":"message","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}}}
      //   {"type":"context_edit","targetId":"f48af6ae","replacement":null}
      //
      // and then made no further record for 148 minutes while the game process stayed alive and the bridge stayed
      // connected. The turn HAD settled and Pi had reported no failure, so every layer above read it as the end of a
      // turn: `turnOutcome` stayed undefined, the Host's no-work counter did not move (a `completed` turn that spoke no
      // line is not `nothing happened`), the pump had nothing pending, and nothing named the stall.
      //
      // Reporting it as a REJECTED turn is what makes the ending recoverable rather than final: the pump restores the
      // exact batch this attempt owned, so the Host's retry asks the same question again instead of composing a new one
      // (`HostService#flushTurn` bounds that retry and names the terminal code).
      //
      // The exclusions are the endings Pi already classified - a refusal or a cancellation is the provider's or the
      // player's own decision - and the turns whose assistant message Pi never reported at all: that is not a message
      // that carried nothing, it is a session shape this loop has no fact about, and calling it an empty completion
      // would invent an ending from a missing event. `producedToolCall` is read from the message's own content, not from
      // `tool_execution_start`: the rule is about what the assistant asked for, and a turn that asked for a tool is not
      // a turn that said nothing.
      if (turnOutcome === undefined && sawAssistantMessage && !producedText && !producedToolCall && !assistantFailed)
        throw new Error(PROVIDER_EMPTY_COMPLETION);
      // The turn settled. If Pi classified its final message as abort/error the outcome says so; otherwise
      // the turn completed. `unobserved` is impossible here — reaching this point means the turn ran.
      return turnOutcome ?? "completed";
    } finally {
      // What this turn DID, in the three states the pump acts on separately: `worked` clears the narration run, `spoke`
      // extends it, `said_nothing` ends it. `producedText` and not `producedToolCall` is the second half, because a
      // message that ASKED for a tool and ran none did not narrate.
      this.pump.turnProduction = producedWork
        ? TURN_PRODUCTION.worked
        : producedText
          ? TURN_PRODUCTION.spoke
          : TURN_PRODUCTION.saidNothing;
      // One line per turn that had text to deliver: THREE populations, each counted where it was measured - the parts Pi's
      // stream produced, the parts the projection reported as presented, and the parts it named as withheld with a reason.
      // The record carries no residual: a stored difference reads like a fourth measurement and, summed across turns with
      // opposite signs, it cancelled itself to zero (a turn that lost two parts and a turn that counted two twice agreed).
      // The identity is `presented + suppressed === textParts`; when it does not hold, this turn says so in the same
      // channel every run reads, and no later reading can make it disappear.
      //
      // `bubbles` is the second population, in the unit the player experienced: how many bubbles this turn's
      // presentation committed, and what its one bubble cost when there was one. `textParts` and `bubbles` are
      // different counts of different things on purpose - a part is a block of model text, a bubble is one commit the
      // player saw - and publishing both is what lets a run reconcile its own `presentation.pieceCount` against this
      // account instead of reading the difference as missing turns. `messages` is the roll-up's own input: the messages
      // whose text the bubble had to fit, named so "28 messages arrived as 27 bubbles" is visible rather than inferred.
      if (assistantTextParts > 0 || presentedTextPieces > 0) {
        const suppressed = Object.fromEntries(suppressedByReason);
        const suppressedParts = Object.values(suppressed).reduce((total, count) => total + count, 0);
        process.stderr.write(
          `NATIVE_COMPANION_TURN_DELIVERY ${JSON.stringify({
            textParts: assistantTextParts,
            presented: presentedTextParts,
            suppressed,
            bubbles: presentedTextPieces,
            messages: Object.freeze({ count: textMessages, ids: Object.freeze([...textMessageIds]) }),
            ...(turnBubble === null ? {} : { bubble: turnBubble }),
          })}\n`,
        );
        const missingParts = assistantTextParts - presentedTextParts - suppressedParts;
        if (missingParts !== 0)
          process.stderr.write(
            `delivery_mismatch:produced=${String(assistantTextParts)};presented=${String(presentedTextParts)};suppressed=${String(suppressedParts)};missing=${String(missingParts)}\n`,
          );
        // The bubble's ceiling, when it cut the turn's speech. Named with the turn's own identity because it is a
        // CADENCE fact: more than one bubble's worth was said inside one turn, and the answer to that is fewer, shorter
        // turns - not a bigger bubble (`identity-profile.ts` states this same ceiling to the model). A non-zero count of
        // characters with ZERO sentences dropped is the one shape where no complete sentence fitted at all, so the cut
        // landed inside a sentence.
        if (turnBubble !== null && turnBubble.truncatedChars > 0)
          process.stderr.write(
            `bubble_truncated:${String(sourceEventId ?? batchId ?? "unknown")}:${String(turnBubble.truncatedChars)}:${String(turnBubble.sentencesDropped)}\n`,
          );
      }
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
      // The turn is over, and what is left is the pump's own answer. An unsettled execution it still holds is `busy` -
      // her body is working even though the model has stopped. An empty pump is `idle`, the state `round39`'s audit
      // could not establish for any stretch of a run: it is published here, once per turn that ends, so a reader can
      // tell "nobody woke her" from "she was working on something". Pending delivery is neither - the next turn's
      // `thinking` follows immediately, and publishing `idle` between two back-to-back turns would report a stillness
      // that never happened.
      if (this.pump.hasExecutionInFlight) this.#activity.transition("busy");
      else if (!this.pump.hasPendingDelivery) this.#activity.transition("idle");
    }
  }

  /**
   * Re-reads this turn's model selection unless STOP seals the turn first.
   *
   * <p>
   * This is the turn's only suspension point between "this turn exists" and "Pi is prompted", and awaiting it plainly
   * left that window open: a STOP landing here resolved the turn's own cancellation while the turn stood still, and
   * the turn then resumed into `subscribe` and `sendUserMessage` - a prompt handed to a session STOP had already
   * sealed. Its listener was revoked moments later by the `finally` below, so nothing was left observing what Pi did
   * with that message. Racing the two makes the seal and the reload mutually exclusive.
   * </p>
   *
   * @returns `false` when STOP sealed this turn during the reload; the caller must then end the turn unobserved
   * without prompting Pi.
   */
  async #reloadModelSelectionUnlessSealed(cancelled: Promise<void>): Promise<boolean> {
    if (this.reloadModelSelection === undefined) return true;
    // A reload that fails keeps its own meaning: an unusable selection fails the turn and the pump restores this exact
    // batch for the retry. Only the seal outranks it, and only by landing first.
    return await Promise.race([this.reloadModelSelection().then(() => true), cancelled.then(() => false)]);
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

/**
 * The language this turn is conducted in, from the last player input the batch
 * carried. A world-triggered turn has no player input and therefore no locale,
 * which the reaction mechanism reads as "say nothing" rather than guessing.
 */
function canonicalTurnLocale(batch: PendingBatch): string | undefined {
  const locales = batch.inputs
    .map((input) => input.locale)
    .filter((locale): locale is string => typeof locale === "string" && locale.length > 0);
  return locales.at(-1);
}

/**
 * Selects the canonical cause only from a real Pi-consumed batch. Events are
 * already deterministically sorted by CompanionEventPump; held snapshot and
 * progress facts never grant presentation authority.
 */
function canonicalPresentationSource(batch: PendingBatch): string | undefined {
  const events = batch.events;
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
  const factSources = events
    .filter((event) => event.kind === "world_fact" && opensPresentationLease(event.semanticKind))
    .map((event) => event.sourceEventId)
    .filter(isOpaqueSource);
  return factSources.length > 0 ? factSources.at(-1) : undefined;
}

/**
 * White-listed fact kinds allowed to mint a bounded presentation lease.
 *
 * Two families qualify, and a member is added only with the sentence that justifies it.
 *
 * SENSORY. `day_started` / `time_milestone` are the Mod's own salient events. `companion_arrival` is the
 * Host's (see `companion-arrival-fact.ts`): she has just arrived on the farm and the world clock gave its
 * first reading, the one proactive turn the product owes the player at arrival. `native_notice` is the
 * Host's too (`native-notice-fact.ts`): the game itself said something about the hour and the companion
 * may answer it out loud. `night_ended_pass_out` is the Mod's verdict on how the night ended. Each rides
 * the lease for the same reason - a reply that reaches the model but not the chat is a decision the
 * player never sees.
 *
 * OUTCOME. `program_settled` is the one-line ledger of a plan that stopped (`program-settlement-digest.ts`).
 * The pump already treats a settlement as news that opens a turn (`event-pump.ts:isHeldProgressFact`:
 * it is deliberately NOT held); without a lease the answer to that news was counted - and lost - as text
 * nobody was shown. An outcome is not progress, so its volume is one per program, never one per tile.
 *
 * Progress and every other world fact keep today's silence: the per-tile traffic (`route_progress`, the
 * receipt states) is what fills a session, and a bubble per harvested crop is not a companion.
 */
function opensPresentationLease(kind: string | undefined): boolean {
  return (
    kind === "day_started" ||
    kind === "time_milestone" ||
    kind === "companion_arrival" ||
    kind === "native_notice" ||
    kind === "night_ended_pass_out" ||
    kind === "program_settled"
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
