import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CompanionLiveSourceEvidenceSink } from "./companion-live-source-attestation.js";
import { CompanionEventPump, type DeliveryDisposition } from "./event-pump.js";

export interface CompanionTurnObserver {
  /**
   * Runs only around an actual Pi-consumed batch. `sourceEventId` is the
   * deterministic authenticated cause: the final player source when present,
   * otherwise the final non-held adapter world trigger—never a queue id or
   * generated batch id.
   */
  beginPlayerBatch(sourceEventId: string, batchId: string | undefined): void;
  endBatch(batchId: string | undefined): void;
}

/** Completion is session-authoritative only after Pi itself reports idle. */
export type CompanionPiSession = Pick<AgentSession, "sendUserMessage"> &
  Partial<Pick<AgentSession, "abort" | "clearQueue" | "waitForIdle" | "subscribe">>;

/**
 * Thin Host orchestration: a labelled batch becomes one explicitly classified Pi turn.
 * It intentionally has no goals, planner state, or game-success inference.
 */
export class CompanionLoop {
  readonly #pump = new CompanionEventPump();
  #turnObserver: CompanionTurnObserver | undefined;
  #inFlight: Promise<void> | undefined;
  #cancelQueuedDelivery: (() => void) | undefined;
  #queuedPlayerDelivery = false;
  public constructor(
    private readonly session: CompanionPiSession,
    turnObserver?: CompanionTurnObserver,
    private readonly liveSourceEvidence?: CompanionLiveSourceEvidenceSink,
  ) {
    this.#turnObserver = turnObserver;
  }
  /** Private materializer wiring; the Host tracker is attached exactly once before ingress. */
  public attachTurnObserver(turnObserver: CompanionTurnObserver): void {
    if (this.#turnObserver !== undefined) throw new Error("companion_turn_observer_already_attached");
    this.#turnObserver = turnObserver;
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

  public async flush(): Promise<void> {
    await this.#pump.flush({
      deliver: async (batch, disposition) => {
        // Only the real Pi-consumed batch may activate presentation lineage.
        const parsed = JSON.parse(batch) as SerializedBatch;
        const sourceEventId = canonicalPresentationSource(parsed);
        const batchId = isOpaqueSource(parsed.batchId) ? parsed.batchId : undefined;
        const completion = this.#deliverAndObserve(batch, disposition, sourceEventId, batchId);
        this.#inFlight = completion;
        try {
          await completion;
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
  ): Promise<void> {
    let accepted = false;
    let settled = false;
    let beganPresentation = false;
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
    try {
      if (tracksPlayerDelivery) this.#queuedPlayerDelivery = true;
      this.#cancelQueuedDelivery = resolveCancelled;
      if (this.session.subscribe === undefined) {
        // Tests and non-production adapters without Pi's event stream retain
        // legacy send completion semantics; they cannot mint live evidence.
        if (sourceEventId !== undefined) {
          this.#turnObserver?.beginPlayerBatch(sourceEventId, batchId);
          beganPresentation = true;
        }
        await this.session.sendUserMessage(batch, { deliverAs: disposition === "steer" ? "steer" : "followUp" });
        return;
      }
      unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_start" && !accepted && isExactBatchMessage(event.message, batch)) {
          // Pi has now put this exact batch into its active context. Open the
          // presentation lineage *at this boundary*, not after
          // `sendUserMessage()` resolves (which is after the whole turn).
          accepted = true;
          if (tracksPlayerDelivery) this.#queuedPlayerDelivery = false;
          if (sourceEventId !== undefined) {
            this.#turnObserver?.beginPlayerBatch(sourceEventId, batchId);
            beganPresentation = true;
          }
          if (sourceEventId !== undefined && batchId !== undefined)
            this.#emitLiveEvidence((sink) => sink.piTurnAccepted({ batchId, sourceEventId, disposition }));
          resolveStarted();
          return;
        }
        if (event.type === "agent_settled" && accepted && !settled) {
          settled = true;
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
        await deliveryObserved;
        return;
      }
      await deliveryObserved;
      // An abort that clears an unstarted queued message is terminal without a
      // Pi-consumption claim. An accepted turn instead must reach Pi settlement.
      if (!accepted) return;
      await completed;
      if (!settled) throw new Error("pi_turn_settlement_missing");
    } finally {
      if (this.#cancelQueuedDelivery === resolveCancelled) this.#cancelQueuedDelivery = undefined;
      if (tracksPlayerDelivery) this.#queuedPlayerDelivery = false;
      unsubscribe?.();
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
  playerInputs?: readonly Readonly<{ eventId?: string; inputId?: string }>[];
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
    payload?: Readonly<{ state?: unknown }>;
  }>[];
}>;

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

  // World-trigger turns may use their normal tools but never receive the
  // player-native presentation admission or exact-one obligation.
  return undefined;
}

function _isHeldWorldEvent(event: Readonly<{ kind?: string; payload?: Readonly<{ state?: unknown }> }>): boolean {
  return (
    event.kind === "snapshot" ||
    (event.kind === "execution_receipt" &&
      typeof event.payload?.state === "string" &&
      ["accepted", "running", "meaningful_progress", "blocked"].includes(event.payload.state))
  );
}

function isOpaqueSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
