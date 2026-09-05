import { randomUUID } from "node:crypto";

type FactKind = "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle";
export type WorldFact = Readonly<{
  /** Adapter-owned source label, or Host's explicitly non-world transport label. */
  source: string;
  kind: FactKind;
  eventId?: string;
  occurredAtMs?: number;
  correlationId: string;
  revision: number;
  executionId?: string;
  requestId?: string;
  sourceEventId?: string;
  payload: Readonly<Record<string, unknown>>;
  /** Bounded model-facing context; the authoritative payload stays Host-owned. */
  contextProjection?: Readonly<Record<string, unknown>>;
}>;
export type PlayerInput = Readonly<{
  source: "player_text" | "voice_final";
  inputId: string;
  eventId?: string;
  text: string;
  locale: string;
  timestampMs: number;
}>;

export type DeliveryDisposition = "steer" | "follow_up" | "hold";
export type PendingBatch = Readonly<{
  batchId: string;
  disposition: Exclude<DeliveryDisposition, "hold">;
  triggerEventIds: readonly string[];
  inputs: readonly PlayerInput[];
  facts: readonly WorldFact[];
  /** Immutable delivery frame retained verbatim if the sink rejects it. */
  serialized: string;
}>;

type NormalizedEvent = Readonly<{
  eventId: string;
  occurredAtMs: number;
  source: string;
  kind: string;
  correlationId: string;
  revision: number;
  executionId?: string;
  requestId?: string;
  sourceEventId?: string;
  payload?: Readonly<Record<string, unknown>>;
  input?: PlayerInput;
}>;

const MAX_PENDING_INPUTS = 128;
const MAX_PENDING_RECEIPTS = 128;
const MAX_PENDING_SEMANTIC_EVENTS = 128;
const MAX_PENDING_LIFECYCLE = 128;

export interface CompanionTurnSink {
  deliver(text: string, disposition: Exclude<DeliveryDisposition, "hold">): Promise<void>;
}

/** Product-neutral Host event pump. It forwards labelled facts; it never plans or interprets receipts. */
export class CompanionEventPump {
  #snapshot: WorldFact | undefined;
  readonly #receipts = new Map<string, WorldFact>();
  readonly #semanticEvents = new Map<string, WorldFact>();
  readonly #lifecycle = new Map<string, WorldFact>();
  readonly #inputs: PlayerInput[] = [];
  #retryBatch: PendingBatch | undefined;
  #delivering = false;
  // A clear can race an awaited sink delivery. Its generation revokes the
  // captured batch so a late rejection cannot resurrect stale facts.
  #generation = 0;

  public enqueueFact(fact: WorldFact): void {
    if (typeof fact.source !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(fact.source))
      throw new Error("invalid_world_fact_source");
    if (fact.source === "host_local_transport" && (fact.kind !== "lifecycle" || fact.revision !== 0))
      throw new Error("invalid_local_transport_fact");
    const frozen = Object.freeze({ ...fact });
    if (fact.kind === "snapshot") {
      if (this.#snapshot === undefined || fact.revision >= this.#snapshot.revision) this.#snapshot = frozen;
      return;
    }
    const destination =
      fact.kind === "execution_receipt"
        ? this.#receipts
        : fact.kind === "semantic_event"
          ? this.#semanticEvents
          : this.#lifecycle;
    const limit =
      fact.kind === "execution_receipt"
        ? MAX_PENDING_RECEIPTS
        : fact.kind === "semantic_event"
          ? MAX_PENDING_SEMANTIC_EVENTS
          : MAX_PENDING_LIFECYCLE;
    if (!destination.has(fact.correlationId) && destination.size >= limit) {
      throw new Error(
        fact.kind === "execution_receipt" && isTerminalExecutionFact(fact)
          ? "event_pump_terminal_overflow"
          : "event_pump_event_overflow",
      );
    }
    const previous = destination.get(fact.correlationId);
    if (previous === undefined || fact.revision >= previous.revision) destination.set(fact.correlationId, frozen);
  }

  public enqueuePlayerInput(input: PlayerInput): void {
    if (input.text.length === 0)
      throw new Error(input.source === "voice_final" ? "empty_final_voice_input" : "empty_player_input");
    if (this.#inputs.length >= MAX_PENDING_INPUTS) throw new Error("event_pump_input_overflow");
    this.#inputs.push(Object.freeze({ ...input }));
  }

  /** Dispose-time cancellation boundary; pending facts are never replayed into a closed runtime. */
  public clear(): void {
    this.#generation++;
    this.#snapshot = undefined;
    this.#receipts.clear();
    this.#semanticEvents.clear();
    this.#lifecycle.clear();
    this.#inputs.length = 0;
    this.#retryBatch = undefined;
  }

  public get pendingCount(): number {
    return (
      (this.#snapshot === undefined ? 0 : 1) +
      this.#receipts.size +
      this.#semanticEvents.size +
      this.#lifecycle.size +
      this.#inputs.length +
      (this.#retryBatch === undefined ? 0 : this.#retryBatch.inputs.length + this.#retryBatch.facts.length)
    );
  }

  /** True only when pending state can create a Pi turn; held state remains latest-only. */
  public get hasPendingDelivery(): boolean {
    return this.#retryBatch !== undefined || this.#inputs.length > 0 || this.#hasPendingFactTrigger();
  }

  /** Authenticated player input has been accepted but is not yet Pi-consumed. */
  public get hasPendingPlayerInput(): boolean {
    return this.#inputs.length > 0 || (this.#retryBatch?.inputs.length ?? 0) > 0;
  }

  public async flush(sink: CompanionTurnSink): Promise<void> {
    if (this.#delivering || !this.hasPendingDelivery) return;
    this.#delivering = true;
    const generation = this.#generation;
    const pending = this.#retryBatch ?? this.takeBatch();
    this.#retryBatch = undefined;
    try {
      await sink.deliver(pending.serialized, pending.disposition);
    } catch (error) {
      // Do not revive a batch cleared while its asynchronous delivery was in
      // flight. Facts admitted after clear belong to the current generation.
      if (this.#generation === generation) this.#retryBatch = pending;
      throw error;
    } finally {
      this.#delivering = false;
    }
  }

  private takeBatch(): PendingBatch {
    const inputs = this.#inputs.splice(0);
    const snapshot = this.#snapshot;
    this.#snapshot = undefined;
    const receipts = [...this.#receipts.values()];
    this.#receipts.clear();
    const semanticEvents = [...this.#semanticEvents.values()];
    this.#semanticEvents.clear();
    const lifecycle = [...this.#lifecycle.values()];
    this.#lifecycle.clear();
    const facts = [...receipts, ...semanticEvents, ...lifecycle];
    const triggers = facts.filter((fact) => !isHeldFact(fact));
    // takeBatch is called only when input/fact triggering is already known.
    // Hold is represented by retaining latest state in the pump, never by an
    // empty Pi delivery.
    const disposition = inputs.length > 0 ? "steer" : "follow_up";
    const batchId = randomUUID();
    const triggerEventIds = Object.freeze([
      ...inputs.map((input) => input.eventId ?? input.inputId),
      ...triggers.map(factEventId),
    ]);
    const batchInputs = Object.freeze(inputs);
    const batchFacts = Object.freeze([...(snapshot === undefined ? [] : [snapshot]), ...facts]);
    const normalizedInputs = batchInputs.map((input) => normalizeInput(input));
    const normalizedFacts = batchFacts.map((fact) => normalizeFact(fact));
    const events = [...normalizedInputs, ...normalizedFacts].sort(compareEvents);
    // Serialize before delivery, rather than rebuilding on retry: callers own
    // arbitrary nested payload objects and may mutate them while a sink awaits.
    // The complete authoritative payload remains available to Host consumers;
    // only the model-facing worldFacts projection is narrowed here.
    const deliveredFacts = batchFacts.map((fact) => {
      const projection = fact.contextProjection;
      if (projection === undefined) return fact;
      const { contextProjection: _contextProjection, ...factWithoutProjection } = fact;
      return Object.freeze({ ...factWithoutProjection, payload: projection });
    });
    const serialized = JSON.stringify({
      kind: "gamebuddy_fact_batch",
      batchId,
      disposition,
      triggerEventIds,
      playerInputs: batchInputs,
      worldFacts: deliveredFacts,
      events,
    });
    return Object.freeze({
      batchId,
      disposition,
      triggerEventIds,
      inputs: batchInputs,
      facts: batchFacts,
      serialized,
    });
  }

  #hasPendingFactTrigger(): boolean {
    return [...this.#receipts.values(), ...this.#semanticEvents.values(), ...this.#lifecycle.values()].some(
      (fact) => !isHeldFact(fact),
    );
  }
}

/** Receipt progress is latest-only; terminal and invalidating states remain ordinary facts. */
function isMeaningfulProgressFact(fact: WorldFact): boolean {
  return (
    fact.kind === "execution_receipt" &&
    typeof fact.payload.state === "string" &&
    ["accepted", "running", "meaningful_progress"].includes(fact.payload.state)
  );
}

function isHeldFact(fact: WorldFact): boolean {
  return fact.kind === "snapshot" || isMeaningfulProgressFact(fact);
}

function isTerminalExecutionFact(fact: WorldFact): boolean {
  return (
    fact.kind === "execution_receipt" &&
    typeof fact.payload.state === "string" &&
    [
      "succeeded",
      "partially_succeeded",
      "failed",
      "cancelled",
      "expired",
      "invalidated",
      "rejected",
      "uncertain",
    ].includes(fact.payload.state)
  );
}

function factEventId(fact: WorldFact): string {
  return fact.eventId ?? `${fact.source}:${fact.kind}:${fact.correlationId}:${fact.revision}`;
}

function normalizeInput(input: PlayerInput): NormalizedEvent {
  return {
    eventId: input.eventId ?? input.inputId,
    occurredAtMs: input.timestampMs,
    source: input.source,
    kind: "player_input",
    correlationId: input.inputId,
    revision: 0,
    input,
  };
}

function normalizeFact(fact: WorldFact): NormalizedEvent {
  return {
    eventId: factEventId(fact),
    occurredAtMs: fact.occurredAtMs ?? 0,
    source: fact.source,
    kind: fact.kind,
    correlationId: fact.correlationId,
    revision: fact.revision,
    ...(fact.executionId === undefined ? {} : { executionId: fact.executionId }),
    ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
    ...(fact.sourceEventId === undefined ? {} : { sourceEventId: fact.sourceEventId }),
    payload: fact.contextProjection ?? fact.payload,
  };
}

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  return (
    left.occurredAtMs - right.occurredAtMs ||
    left.revision - right.revision ||
    left.eventId.localeCompare(right.eventId)
  );
}
