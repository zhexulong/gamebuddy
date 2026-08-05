import { randomUUID } from "node:crypto";

export type FactKind = "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle";
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
}>;
export type PlayerInput = Readonly<{
  source: "player_text" | "voice_final";
  inputId: string;
  eventId?: string;
  text: string;
  locale: string;
  timestampMs: number;
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

type PendingBatch = Readonly<{
  batchId: string;
  inputs: readonly PlayerInput[];
  facts: readonly WorldFact[];
}>;

const MAX_PENDING_INPUTS = 128;
const MAX_PENDING_RECEIPTS = 128;
const MAX_PENDING_SEMANTIC_EVENTS = 128;

export interface CompanionTurnSink { deliver(text: string): Promise<void>; }

/** Product-neutral Host event pump. It forwards labelled facts; it never plans or interprets receipts. */
export class CompanionEventPump {
  #snapshot: WorldFact | undefined;
  readonly #receipts = new Map<string, WorldFact>();
  readonly #semanticEvents = new Map<string, WorldFact>();
  readonly #lifecycle = new Map<string, WorldFact>();
  readonly #inputs: PlayerInput[] = [];
  #retryBatch: PendingBatch | undefined;
  #delivering = false;

  public enqueueFact(fact: WorldFact): void {
    if (typeof fact.source !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(fact.source)) throw new Error("invalid_world_fact_source");
    if (fact.source === "host_local_transport" && (fact.kind !== "lifecycle" || fact.revision !== 0)) throw new Error("invalid_local_transport_fact");
    const frozen = Object.freeze({ ...fact });
    if (fact.kind === "snapshot") {
      if (this.#snapshot === undefined || fact.revision >= this.#snapshot.revision) this.#snapshot = frozen;
      return;
    }
    const destination = fact.kind === "execution_receipt" ? this.#receipts : fact.kind === "semantic_event" ? this.#semanticEvents : this.#lifecycle;
    const limit = fact.kind === "execution_receipt" ? MAX_PENDING_RECEIPTS : fact.kind === "semantic_event" ? MAX_PENDING_SEMANTIC_EVENTS : MAX_PENDING_SEMANTIC_EVENTS;
    if (!destination.has(fact.correlationId) && destination.size >= limit) {
      throw new Error(fact.kind === "execution_receipt" ? "event_pump_receipt_overflow" : "event_pump_event_overflow");
    }
    const previous = destination.get(fact.correlationId);
    if (previous === undefined || fact.revision >= previous.revision) destination.set(fact.correlationId, frozen);
  }

  public enqueuePlayerInput(input: PlayerInput): void {
    if (input.text.length === 0) throw new Error(input.source === "voice_final" ? "empty_final_voice_input" : "empty_player_input");
    if (this.#inputs.length >= MAX_PENDING_INPUTS) throw new Error("event_pump_input_overflow");
    this.#inputs.push(Object.freeze({ ...input }));
  }

  public get pendingCount(): number {
    return (this.#snapshot === undefined ? 0 : 1) + this.#receipts.size + this.#semanticEvents.size + this.#lifecycle.size + this.#inputs.length + (this.#retryBatch === undefined ? 0 : this.#retryBatch.inputs.length + this.#retryBatch.facts.length);
  }

  public async flush(sink: CompanionTurnSink): Promise<void> {
    if (this.#delivering || (this.pendingCount === 0 && this.#retryBatch === undefined)) return;
    this.#delivering = true;
    const pending = this.#retryBatch ?? this.takeBatch();
    this.#retryBatch = undefined;
    try {
      const normalizedInputs = pending.inputs.map((input) => normalizeInput(input));
      const normalizedFacts = pending.facts.map((fact) => normalizeFact(fact));
      const events = [...normalizedInputs, ...normalizedFacts].sort(compareEvents);
      await sink.deliver(JSON.stringify({
        kind: "gamebuddy_fact_batch",
        batchId: pending.batchId,
        playerInputs: pending.inputs,
        worldFacts: pending.facts,
        events,
      }));
    } catch (error) {
      this.#retryBatch = pending;
      throw error;
    } finally {
      this.#delivering = false;
    }
  }

  private takeBatch(): PendingBatch {
    const inputs = this.#inputs.splice(0);
    const snapshot = this.#snapshot;
    this.#snapshot = undefined;
    const receipts = [...this.#receipts.values()]; this.#receipts.clear();
    const semanticEvents = [...this.#semanticEvents.values()]; this.#semanticEvents.clear();
    const lifecycle = [...this.#lifecycle.values()]; this.#lifecycle.clear();
    return Object.freeze({
      batchId: randomUUID(),
      inputs: Object.freeze(inputs),
      facts: Object.freeze([...(snapshot === undefined ? [] : [snapshot]), ...receipts, ...semanticEvents, ...lifecycle]),
    });
  }
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
    eventId: fact.eventId ?? `${fact.source}:${fact.kind}:${fact.correlationId}:${fact.revision}`,
    occurredAtMs: fact.occurredAtMs ?? 0,
    source: fact.source,
    kind: fact.kind,
    correlationId: fact.correlationId,
    revision: fact.revision,
    ...(fact.executionId === undefined ? {} : { executionId: fact.executionId }),
    ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
    ...(fact.sourceEventId === undefined ? {} : { sourceEventId: fact.sourceEventId }),
    payload: fact.payload,
  };
}

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  return left.occurredAtMs - right.occurredAtMs || left.revision - right.revision || left.eventId.localeCompare(right.eventId);
}
