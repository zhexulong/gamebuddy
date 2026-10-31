import { randomUUID } from "node:crypto";

export type FactKind = "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" | "world_fact";
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
  observedTick?: number;
  gameTime?: string | null;
  payload: Readonly<Record<string, unknown>>;
  /** Bounded model-facing context; the authoritative payload stays Host-owned. */
  contextProjection?: Readonly<Record<string, unknown>>;
  /**
   * Mod-owned semantic identity of a world_fact (day_started, time_milestone,
   * …). The Host keeps it only as an opaque label for bounded sensory
   * presentation leases; it never interprets the payload.
   */
  semanticKind?: string;
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
/**
 * How one delivered turn ENDED, as observed by whoever ran it.
 *
 * `completed` — Pi settled the turn without reporting a failure.
 * `aborted` / `error` — Pi's own final-message classification said so (see
 *   `native-companion-content.ts:252-258`, which already distinguishes them).
 * `refused` — Magic Context declined to prepare the pass and aborted the run rather than sending it
 *   unmanaged (see `companion-turn-refusal.ts`). It is its own ending: the abort is the refusal's
 *   consequence, not the player's STOP, and a refused turn must never read as `completed` or as
 *   `unobserved`.
 * `unobserved` — the adapter cannot say (no Pi event stream, or the turn never ran).
 *
 * This vocabulary exists because the classification WAS being discarded: the Game loop passed
 * `onRejected: () => undefined`, so an aborted/errored provider turn reached the caller as an ordinary
 * accepted message. A caller must be able to tell "the companion answered" from "the turn died", and
 * "nobody looked" must not be spelled the same way as "it worked".
 */
export type CompanionTurnOutcome = "completed" | "aborted" | "error" | "refused" | "unobserved";
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
  observedTick?: number;
  payload?: Readonly<Record<string, unknown>>;
  input?: PlayerInput;
}>;

// Sized from measurement, not from taste. A real run (`g97cross`) produced 870 facts in 535 s - about 1.6 per second,
// three of them per dispatch (accepted -> running -> succeeded) plus outcome semantics - while a single turn held them
// because a turn here can think for 60+ s. At 128 that window was crossed by ANY long turn, so the bridge closed
// mid-run (`g98cross`, with the drop rule already in: the window had nothing superseded left to evict, which is the
// honest refusal but the wrong outcome). 512 covers five minutes of the measured arrival rate at a stalled turn.
export const MAX_PENDING_INPUTS = 128;
export const MAX_PENDING_RECEIPTS = 512;
export const MAX_PENDING_SEMANTIC_EVENTS = 512;
export const MAX_PENDING_LIFECYCLE = 128;
export const MAX_PENDING_WORLD_FACTS = 32;

/**
 * How many characters one delivered batch may serialize to.
 *
 * The windows above bound the COUNT of pending facts. They do not bound the SIZE, and the two are not the
 * same constraint: on 2026-10-27 a twelve-minute multiday run accumulated 685 facts - 417 semantic events
 * and 260 execution receipts, comfortably inside the 512-entry windows - which serialized to 1,037,822
 * characters. The model answered `input: 373915, output: 1, stopReason: "length"` and then produced no
 * further action for the rest of the run, while the companion stood in the farmhouse with
 * `can_move=True; navigate=idle`.
 *
 * 60_000 is roughly 15k tokens of batch on its own, leaving room for the prompt, the conversation and the
 * model's output inside any context window this product runs on. It is also above the largest HEALTHY batch
 * observed in that run (ordinary ones were 8-60k characters), so it rarely splits a delivery that already worked.
 *
 * THE REASON IT CAME DOWN FROM 120_000, and the number that fixes it: a fold run's non-emergency chunk ceiling is
 * about 22,879 tokens, so a 120_000-byte batch (~45k tokens) is HALF A FOLD at best. Measured 2026-10-29 (`round7`):
 * 29 successful fold runs, ten messages each, and three `gamebuddy_fact_batch` messages still uncleared - 104,972 of
 * 123,130 input tokens (85%). A batch larger than the thing that consumes it cannot be consumed: every fold spends its
 * whole budget on one delivery and the tail never shrinks. 60_000 keeps a batch inside one chunk.
 *
 * Overflow is not dropped: `takeBatch` puts it back and the next flush delivers it.
 */
export const MAX_BATCH_BYTES = 60_000;

export interface CompanionTurnSink {
  /**
   * Deliver one batch. The return value is how the turn ended; an adapter that cannot observe it returns
   * nothing, which callers must read as `unobserved` rather than as success.
   */
  deliver(text: string, disposition: Exclude<DeliveryDisposition, "hold">): Promise<CompanionTurnOutcome | void>;
}

/** Product-neutral Host event pump. It forwards labelled facts; it never plans or interprets receipts. */
export class CompanionEventPump {
  #snapshot: WorldFact | undefined;
  readonly #receipts = new Map<string, WorldFact>();
  readonly #semanticEvents = new Map<string, WorldFact>();
  readonly #lifecycle = new Map<string, WorldFact>();
  readonly #worldFacts = new Map<string, WorldFact>();
  readonly #inputs: PlayerInput[] = [];
  /**
   * What each held PROGRESS slot last TOLD the model, by slot key (see `progressStateIdentity`).
   *
   * The windows below keep one fact per slot, but the surviving fact was re-delivered into every later
   * batch, so a body that never left its tile was described again and again. Measured 2026-10-27 on a
   * twelve-minute session: `input` reached 114,569 tokens against a 131,072 window and the model answered
   * `stopReason: "length"` twice; the fact traffic by semantic kind was `route_progress` 859,
   * `execution_settled_succeeded` 219, `body_idle` 211, `execution_started` 184.
   *
   * A fact whose slot already told the model this exact state carries no information, so it stays behind.
   * It still triggers nothing either way (see `#hasPendingFactTrigger`): progress never minted a turn.
   */
  readonly #deliveredProgress = new Map<string, string>();
  #retryBatch: PendingBatch | undefined;
  /** Facts the bounds dropped instead of closing the bridge (see the full-queue branch of `enqueueFact`). */
  #droppedFacts = 0;
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
    // An execution that has SETTLED can publish no further progress, so its record is dead weight. Dropping
    // it here keeps the record bounded by the in-flight executions instead of by the session's action count.
    if (isTerminalExecutionFact(fact)) this.#forgetSettledProgress(fact);
    const destination =
      fact.kind === "execution_receipt"
        ? this.#receipts
        : fact.kind === "semantic_event"
          ? this.#semanticEvents
          : fact.kind === "world_fact"
            ? this.#worldFacts
            : this.#lifecycle;
    const limit =
      fact.kind === "execution_receipt"
        ? MAX_PENDING_RECEIPTS
        : fact.kind === "semantic_event"
          ? MAX_PENDING_SEMANTIC_EVENTS
          : fact.kind === "world_fact"
            ? MAX_PENDING_WORLD_FACTS
            : MAX_PENDING_LIFECYCLE;
    // Stable world-fact identity is the Mod eventId; correlationId is only a
    // transport-scoped routing label. Same eventId/different correlationId is
    // one fact, while distinct eventIds never collapse.
    //
    // A PROGRESS semantic event collapses onto the thing it is progressing: its execution when it names one, or
    // its kind when it does not (`body_idle` describes the actor, not an execution). The Mod mints a fresh
    // correlationId per event, so keying these by correlationId gave every per-tile observation its own slot -
    // and one long agent turn's 129 route observations filled the 128-entry window, which closed the bridge
    // mid-run (measured 2026-10-17). Collapsing them is what the receipt half of the same traffic already does.
    const key = factSlotKey(fact);
    if (!destination.has(key) && destination.size >= limit) {
      // FULL - and there are two different situations here that must not be answered the same way.
      //
      // A TERMINAL receipt is the authority for its execution: dropping it leaves a request that never settles, which is
      // exactly the shape the pump's fail-closed policy exists to refuse. Every OTHER fact only describes state that a
      // later fact describes again, so when the window is full the ARRIVAL is what can go - counted, never silent.
      //
      // Measured 2026-10-19 (`g97cross`): 870 facts in one run, 470 of them receipts, arriving while a turn was in
      // flight (a turn here thinks for 60+ s). The window is what makes a long turn safe; closing the whole bridge on it
      // is not what "bounded" has to mean, and it ended that run short of its night.
      if (isSupersededFact(fact)) {
        this.#droppedFacts += 1;
        return;
      }
      const evictable = [...destination.entries()].find(([, entry]) => isSupersededFact(entry));
      // A WORLD-FACT window is the one window that can fill with facts no later fact repeats: a day
      // started, a clock milestone, a native notice. Nothing in it is supersedable, so there is
      // nothing to evict - and closing the bridge over that destroys a healthy pipe, every fact it
      // held, and the session, to avoid losing one observation.
      //
      // The ARRIVAL always survives: it is the newest thing the world did, and dropping it would
      // leave the window permanently full of the OLDEST facts (`takeBatch` already applies the same
      // rule to a batch that is too large - a later fact describes a later world). What goes instead
      // is the OLDEST observation, and it is COUNTED (`droppedFacts`), so the loss is named rather
      // than silent. A terminal receipt and an execution OUTCOME keep failing closed: those are the
      // authority for an execution, and losing one leaves a request that never settles.
      const evictedKey =
        evictable?.[0] ?? (fact.kind === "world_fact" ? oldestWorldFactKey(destination) : undefined);
      if (evictedKey === undefined)
        throw new Error(
          fact.kind === "execution_receipt" ? "event_pump_terminal_overflow" : "event_pump_event_overflow",
        );
      destination.delete(evictedKey);
      this.#droppedFacts += 1;
    }
    const previous = destination.get(key);
    if (previous === undefined || fact.revision >= previous.revision) destination.set(key, frozen);
  }

  /**
   * Put a fact back in the window it came from, without re-running admission.
   *
   * Used only by `takeBatch` when a batch had to be split to fit the byte bound. These facts were
   * already admitted and may be older than what is in the window now, so re-admitting them would let an
   * older fact evict a newer one - the opposite of what the bound is for.
   */
  /** Forget both slots a settled execution could still be holding. Neither can publish again. */
  #forgetSettledProgress(fact: WorldFact): void {
    this.#deliveredProgress.delete(factSlotKey(fact));
    const executionId = fact.executionId;
    if (executionId !== undefined) this.#deliveredProgress.delete(executionProgressSlotKey(executionId));
  }

  #readmit(fact: WorldFact): void {
    const destination =
      fact.kind === "execution_receipt"
        ? this.#receipts
        : fact.kind === "semantic_event"
          ? this.#semanticEvents
          : fact.kind === "world_fact"
            ? this.#worldFacts
            : this.#lifecycle;
    const key = factSlotKey(fact);
    if (!destination.has(key)) destination.set(key, fact);
  }
  public enqueuePlayerInput(input: PlayerInput): void {
    if (input.text.length === 0)
      throw new Error(input.source === "voice_final" ? "empty_final_voice_input" : "empty_player_input");
    if (this.#inputs.length >= MAX_PENDING_INPUTS) throw new Error("event_pump_input_overflow");
    this.#inputs.push(Object.freeze({ ...input }));
  }

  /** How many facts the bounds have dropped instead of closing the bridge. Named, because every drop is a loss. */
  public get droppedFacts(): number {
    return this.#droppedFacts;
  }

  /** Dispose-time cancellation boundary; pending facts are never replayed into a closed runtime. */
  public clear(): void {
    this.#generation++;
    this.#snapshot = undefined;
    this.#receipts.clear();
    this.#semanticEvents.clear();
    this.#lifecycle.clear();
    this.#worldFacts.clear();
    this.#inputs.length = 0;
    this.#deliveredProgress.clear();
    this.#retryBatch = undefined;
  }

  public get pendingCount(): number {
    return (
      (this.#snapshot === undefined ? 0 : 1) +
      this.#receipts.size +
      this.#semanticEvents.size +
      this.#lifecycle.size +
      this.#worldFacts.size +
      this.#inputs.length +
      (this.#retryBatch === undefined ? 0 : this.#retryBatch.inputs.length + this.#retryBatch.facts.length)
    );
  }

  /** True only when pending state can create a Pi turn; held state remains latest-only. */
  public get hasPendingDelivery(): boolean {
    return this.#retryBatch !== undefined || this.#inputs.length > 0 || this.#hasPendingFactTrigger();
  }

  /**
   * Whether the most recently DELIVERED turn ran any tool, or only spoke.
   *
   * <p>
   * Set by `CompanionLoop` after each delivery, because that is the only layer that sees Pi's event stream. `false` for a
   * turn that produced dialogue and nothing else - the shape that let a 2026-10-30 run stop at in-game 18:20 and freeze
   * the clock, which then made the pipeline's own 22:00 milestone unreachable (`#idleTurnsWithoutWork` in HostService has
   * the full account).
   * </p>
   */
  public turnProducedWork = false;

  /** Authenticated player input has been accepted but is not yet Pi-consumed. */
  public get hasPendingPlayerInput(): boolean {
    return this.#inputs.length > 0 || (this.#retryBatch?.inputs.length ?? 0) > 0;
  }

  public async flush(sink: CompanionTurnSink): Promise<CompanionTurnOutcome | undefined> {
    if (this.#delivering || !this.hasPendingDelivery) return undefined;
    this.#delivering = true;
    const generation = this.#generation;
    const pending = this.#retryBatch ?? this.takeBatch();
    this.#retryBatch = undefined;
    try {
      return (await sink.deliver(pending.serialized, pending.disposition)) ?? undefined;
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
    const worldFacts = [...this.#worldFacts.values()].sort(compareWorldFacts);
    this.#worldFacts.clear();
    // A held PROGRESS fact whose slot already delivered this exact state says nothing new, so it does not
    // enter the batch at all. It is dropped rather than readmitted: re-delivering it is the defect, and the
    // slot's CURRENT state is what the next changed fact will carry.
    const facts = [...receipts, ...semanticEvents, ...lifecycle, ...worldFacts].filter((fact) => {
      if (!isHeldProgressFact(fact)) return true;
      return this.#deliveredProgress.get(factSlotKey(fact)) !== progressStateIdentity(fact);
    });
    // takeBatch is called only when input/fact triggering is already known.
    // Hold is represented by retaining latest state in the pump, never by an
    // empty Pi delivery.
    const disposition = inputs.length > 0 ? "steer" : "follow_up";
    const batchId = randomUUID();
    const batchInputs = Object.freeze(inputs);
    const normalizedInputs = batchInputs.map((input) => normalizeInput(input));

    // Fit the batch to MAX_BATCH_BYTES by dropping the OLDEST facts, and hand back whatever did not fit.
    //
    // The windows above bound how many facts the pump holds, not how large a delivery is. Measured
    // 2026-10-27: 685 facts inside those windows serialized to 1,037,822 characters, the model answered
    // `input: 373915, output: 1, stopReason: "length"`, and the run produced no further action.
    //
    // Oldest-first because a later fact describes a later world: keeping the beginning of a long turn
    // while the companion has moved on is a summary of somewhere it is no longer standing.
    const compose = (chosen: readonly WorldFact[], triggersForBatch: readonly WorldFact[]) => {
      const batchFacts = Object.freeze([...(snapshot === undefined ? [] : [snapshot]), ...chosen]);
      const deliveredFacts = batchFacts.map((fact) => {
        const projection = fact.contextProjection;
        if (projection === undefined) return fact;
        const { contextProjection: _contextProjection, ...factWithoutProjection } = fact;
        return Object.freeze({ ...factWithoutProjection, payload: projection });
      });
      // `events` is the PRESENTATION projection, not a second copy of the facts.
      //
      // Its only production consumer is `canonicalPresentationSource`
      // (`host/src/companion-loop.ts:537`), which reads exactly two things: `player_input` entries, and
      // `world_fact` entries whose semantic kind is salient. Measured 2026-10-27: a 131KB batch carried 58KB
      // of `worldFacts` and the SAME 58KB again under `events`, both 88 semantic events that consumer never
      // looks at. `input` reached 466,568 tokens and the model answered `output: 1, stopReason: "length"`
      // twelve times.
      //
      // What stays: the snapshot (it is the state the rest of the batch describes, and its bounded projection
      // is already the model-facing form) and `world_fact`. What goes: `semantic_event` and
      // `execution_receipt`, which the consumer never reads and which arrive in bulk.
      //
      // `worldFacts` is untouched and still carries every fact: that is the model-facing authoritative list.
      // `triggerEventIds` is untouched: it is the Host's delivery correlation, and a fact still present in
      // `worldFacts` must not lose its trigger identity.
      const presentationKinds = new Set(["snapshot", "world_fact"]);
      const events = [
        ...normalizedInputs,
        ...deliveredFacts
          .filter((fact) => fact.kind !== undefined && presentationKinds.has(fact.kind))
          .map((fact) => normalizeFact(fact)),
      ].sort(compareEvents);
      const serialized = JSON.stringify({
        kind: "gamebuddy_fact_batch",
        batchId,
        disposition,
        triggerEventIds: Object.freeze([
          ...inputs.map((input) => input.eventId ?? input.inputId),
          ...triggersForBatch.map(factEventId),
        ]),
        playerInputs: batchInputs,
        worldFacts: deliveredFacts,
        events,
      });
      return Object.freeze({
        batchFacts,
        serialized,
        triggerEventIds: Object.freeze([
          ...inputs.map((input) => input.eventId ?? input.inputId),
          ...triggersForBatch.map(factEventId),
        ]),
      });
    };

    let chosen = facts;
    let composed = compose(
      chosen,
      chosen.filter((fact) => !isHeldFact(fact)),
    );
    while (composed.serialized.length > MAX_BATCH_BYTES && chosen.length > 1) {
      chosen = chosen.slice(1);
      composed = compose(
        chosen,
        chosen.filter((fact) => !isHeldFact(fact)),
      );
    }

    // Anything left out goes back where it came from, so the next flush delivers it. Re-inserted
    // directly rather than through `enqueueFact`: these facts were already admitted, and re-running
    // admission would evict a newer fact to make room for an older one.
    const dropped = facts.slice(0, facts.length - chosen.length);
    for (const fact of dropped) this.#readmit(fact);

    // Remember what the model was just told by each held progress slot. Recorded for what the batch actually
    // CARRIES: a fact the byte bound pushed into a later batch was not delivered and must still go out.
    for (const fact of composed.batchFacts) {
      if (!isHeldProgressFact(fact)) continue;
      this.#deliveredProgress.set(factSlotKey(fact), progressStateIdentity(fact));
    }

    return Object.freeze({
      batchId,
      disposition,
      triggerEventIds: composed.triggerEventIds,
      inputs: batchInputs,
      facts: composed.batchFacts,
      serialized: composed.serialized,
    });
  }

  #hasPendingFactTrigger(): boolean {
    return [
      ...this.#receipts.values(),
      ...this.#semanticEvents.values(),
      ...this.#lifecycle.values(),
      ...this.#worldFacts.values(),
    ].some((fact) => !isHeldFact(fact));
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

/**
 * Semantic-event kinds that are PROGRESS, not outcomes: per-tile route advance, the start of an execution, and
 * the actor falling idle. They describe a moving state, so only the latest one matters.
 *
 * Measured 2026-10-17 on a real multi-day run: one long agent turn (70 assistant messages, ~350s) made the Mod
 * publish 129 such observations, each with its OWN freshly-minted correlationId, and they filled the 128-entry
 * pending window - so the pump threw and the bridge closed mid-run. The receipt counterpart of exactly this
 * traffic is already latest-only (see `isMeaningfulProgressFact`); a semantic event describing the same progress
 * must be treated the same way, or a long session is indistinguishable from a flood.
 *
 * The settled/invalidated kinds are deliberately NOT here: those are outcomes, and dropping one would hide an
 * execution that already ended.
 */
function isProgressSemanticEvent(fact: WorldFact): boolean {
  return (
    fact.kind === "semantic_event" &&
    typeof fact.payload.kind === "string" &&
    ["execution_started", "route_progress", "body_idle"].includes(fact.payload.kind)
  );
}

function isHeldFact(fact: WorldFact): boolean {
  return fact.kind === "snapshot" || isHeldProgressFact(fact);
}

/**
 * A fact that is HELD latest-only AND describes movement rather than an outcome: the two progress classes the
 * pump already collapses into one slot each.
 *
 * The snapshot is deliberately not here. It is held too, but it is the world the rest of a batch describes, so a
 * batch that carried facts without it would describe a state the model cannot see.
 */
function isHeldProgressFact(fact: WorldFact): boolean {
  return isMeaningfulProgressFact(fact) || isProgressSemanticEvent(fact);
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

/**
 * The slot a PROGRESS semantic event occupies: the newest observation of that execution (or of the actor itself)
 * supersedes every earlier one. Deliberately NOT the correlationId, which the Mod mints fresh per event.
 */
function progressSemanticEventKey(fact: WorldFact): string {
  const executionId = fact.executionId;
  return typeof executionId === "string" && executionId.length > 0
    ? executionProgressSlotKey(executionId)
    : `progress:${String(fact.payload.kind)}`;
}

function executionProgressSlotKey(executionId: string): string {
  return `progress:${executionId}`;
}

/**
 * Which pending-window slot a fact occupies. ONE spelling: `enqueueFact`, `#readmit` and the delivered-progress
 * record all ask this, so a fact cannot be held under one key and compared under another.
 */
function factSlotKey(fact: WorldFact): string {
  if (fact.kind === "world_fact") return worldFactKey(fact);
  if (isProgressSemanticEvent(fact)) return progressSemanticEventKey(fact);
  return fact.correlationId;
}

/**
 * What a held progress fact TELLS the model, as a comparable string.
 *
 * The per-observation counters are excluded, because they advance on every publish of an unchanged state: the
 * Mod mints a fresh wire message id and a fresh revision for each receipt it publishes, and each body trace
 * carries the game tick it was sampled at. Counting those as content is exactly the defect - a body standing
 * still on `64,15` re-observed forty times would read as forty facts.
 *
 * Everything else is content: the kind, the state, the reason, the location, the tile, the active execution and
 * its phase. A change in any of them is a change the model has not been told.
 */
function progressStateIdentity(fact: WorldFact): string {
  const { eventId: _eventId, correlationId: _correlationId, occurredAtMs: _occurredAtMs, ...stable } = fact;
  return JSON.stringify(stable, (key, value) => (key === "tick" || key === "revision" ? undefined : value));
}

function factEventId(fact: WorldFact): string {
  return fact.eventId ?? `${fact.source}:${fact.kind}:${fact.correlationId}:${fact.revision}`;
}

/** World-fact deduplication key: the stable Mod eventId, else its correlationId. */
function worldFactKey(fact: WorldFact): string {
  return fact.eventId ?? fact.correlationId;
}

/**
 * The world fact a full window sheds first: the OLDEST by the pump's own ordering (`compareWorldFacts`,
 * the same order a batch is delivered in), not by insertion or arrival luck.
 *
 * `undefined` only for an empty window, which `enqueueFact` cannot reach - it asks for a victim only
 * after `destination.size >= limit`. Naming that case keeps the caller's fail-closed branch honest
 * instead of deleting a key that does not exist.
 */
function oldestWorldFactKey(destination: ReadonlyMap<string, WorldFact>): string | undefined {
  let oldestKey: string | undefined;
  let oldest: WorldFact | undefined;
  for (const [key, entry] of destination) {
    if (oldest === undefined || compareWorldFacts(entry, oldest) < 0) {
      oldest = entry;
      oldestKey = key;
    }
  }
  return oldestKey;
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
    ...(fact.observedTick === undefined ? {} : { observedTick: fact.observedTick }),
    ...(fact.executionId === undefined ? {} : { executionId: fact.executionId }),
    ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
    ...(fact.sourceEventId === undefined ? {} : { sourceEventId: fact.sourceEventId }),
    ...(fact.semanticKind === undefined ? {} : { semanticKind: fact.semanticKind }),
    payload: fact.contextProjection ?? fact.payload,
  };
}

function compareWorldFacts(left: WorldFact, right: WorldFact): number {
  const tickDiff = (left.observedTick ?? 0) - (right.observedTick ?? 0);
  if (tickDiff !== 0) return tickDiff;
  const revDiff = left.revision - right.revision;
  if (revDiff !== 0) return revDiff;
  return (left.eventId ?? "").localeCompare(right.eventId ?? "");
}

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  if (left.kind === "world_fact" && right.kind === "world_fact") {
    const tickDiff = (left.observedTick ?? 0) - (right.observedTick ?? 0);
    if (tickDiff !== 0) return tickDiff;
    const revDiff = left.revision - right.revision;
    if (revDiff !== 0) return revDiff;
    return left.eventId.localeCompare(right.eventId);
  }
  return (
    left.occurredAtMs - right.occurredAtMs ||
    left.revision - right.revision ||
    left.eventId.localeCompare(right.eventId)
  );
}

/**
 * May this fact be dropped when a window is full?
 *
 * Only facts a LATER fact supersedes: progress observations of a live execution, a non-terminal receipt (its terminal is
 * still to come), and a lifecycle notice. Everything else carries something no other fact will say again - a terminal
 * receipt is the authority for its execution, and an execution's OUTCOME semantic event is how the companion learns it
 * ended - so those evict a superseded entry instead, and only close the bridge when the window holds nothing else.
 */
function isSupersededFact(fact: WorldFact): boolean {
  if (fact.kind === "execution_receipt") return !isTerminalExecutionFact(fact);
  if (fact.kind === "semantic_event") return isProgressSemanticEvent(fact);
  return fact.kind === "lifecycle";
}
