import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  HELD_RECEIPT_PROGRESS_STATES,
  HELD_SEMANTIC_PROGRESS_KINDS,
  NOT_OWED,
  NOT_OWED_REASONS,
  type PendingBatch,
  type TurnAccount,
  turnAccountLine,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * THE SHAPE OF A FLUSH, AS A GATE RATHER THAN AS A COUNT.
 *
 * <p>
 * MEASURED 2026-11-16 (`round64`, the run's own account line): `flushes examined 134 · turns opened 8 · suppressed 126
 * {in_flight_progress 125}`, openers `adapter_ingress 5 · companion_arrival 1 · program_settlement 1 · player_input 1`.
 * The arithmetic is closed - `examined = opened + suppressed` - and that is exactly why it could not see its own defect:
 * 93% of the pump's work was to assemble a batch, decide it owed no turn, and drop it, and every one of those drops was
 * counted as a flush that had been examined.
 * </p>
 * <p>
 * THE INVARIANT. A fact that cannot open a turn must not become a flush in the first place. A call that owes no turn is
 * answered `not_owed`, composes NOTHING (`takeBatch` is reached only on the `opened` branch), and hands back a
 * `CarryTicket` naming the facts that will travel in the next batch - which is how "it did not vanish, it went into turn
 * N's block" stops being a hope and becomes a field.
 * </p>
 * <p>
 * AND THE CONSERVED QUANTITY IS EVENTS, NOT FACTS. `round64` produced 401 \"facts\", of which 260 were `tile_advanced`
 * (130) and `route_progress` (130) - her body moving one tile, stated twice - plus `body_idle` 25 and
 * `execution_started` 17. A trace is not news and never opens a turn; a decision either arrives or is carried, and this
 * gate fails if one is discarded. A gate that conserved the fact count would be conserving the flood: 把踪迹算进事实里，
 * 等于把洪水当成水位。
 * </p>
 */

function recorder(): { batches: PendingBatch[]; sink: { deliver(batch: PendingBatch): Promise<void> } } {
  const batches: PendingBatch[] = [];
  return {
    batches,
    sink: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  };
}

/** A reading of the pump's flush shape, from the account `turnAccountLine` already prints. */
function flushReading(account: TurnAccount): Readonly<{
  examined: number;
  opened: number;
  notOwed: number;
  discarded: number;
  /** Every fact a `not_owed` answer ticketed, and the three states it can leave in (`event-pump.ts#CARRY_HOLD_BOUND_MS`). */
  carried: number;
  consumed: number;
  held: number;
  /** The trace count, by the kind that produced it: the reading `traces N` alone could not give. */
  traces: Readonly<Record<string, number>>;
}> {
  const notOwed = NOT_OWED_REASONS.reduce((total, reason) => total + account.notOwed[reason], 0);
  return Object.freeze({
    examined: account.examined,
    opened: account.opened,
    notOwed,
    // A BATCH THAT PRODUCED NO TURN. `examined` is counted where a batch is composed, so this number is a measurement
    // rather than the sum of its own terms.
    discarded: account.examined - account.opened,
    carried: account.carry.carried,
    consumed: account.carry.consumed,
    held: account.carry.held,
    traces: account.traces,
  });
}

function describe(reading: ReturnType<typeof flushReading>, account: TurnAccount): string {
  return `flushes examined ${String(reading.examined)} · opened ${String(reading.opened)} · named-refused ${String(reading.notOwed)} · discarded ${String(reading.discarded)} · carried ${String(reading.carried)} · consumed ${String(reading.consumed)} · held ${String(reading.held)} · traces ${JSON.stringify(reading.traces)} · not owed ${JSON.stringify(account.notOwed)}`;
}

function snapshotFact(revision: number, gameTime = "0610"): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(revision)}`,
    revision,
    payload: { location: "Farm", gameTime, revision },
  };
}

/** A receipt for a step of a programme she dispatched: the \"it moved one tile\" shape, in its receipt spelling. */
function programmeStep(state: string, revision: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: `exec_step_${String(revision)}`,
    executionId: `exec_step_${String(revision)}`,
    requestId: `request_step_${String(revision)}`,
    revision,
    payload: {
      actionId: "navigate_to_destination",
      state,
      reasonCode: "tile_advanced",
      revision,
      origin: { kind: "programme", programId: "plan_walk", nodeId: "n001" },
    },
  };
}

/** The journal's own statement that a plan she dispatched still has nodes to get through. */
function runningPlan(remaining: number): InFlightProgrammeReading {
  return Object.freeze({
    programmes: Object.freeze([
      Object.freeze({
        programId: "plan_walk",
        total: remaining,
        settled: 0,
        remaining,
        readAgeMs: 250,
        nodes: Object.freeze([]),
        omitted: 0,
        unsettledTiles: Object.freeze([]),
      }),
    ]),
    omittedProgrammes: 0,
  });
}

/** A native notice: the game said something about the hour, and two copies of it say it once. */
function noticeFact(published: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `notice_night_${String(published)}`,
    sourceEventId: `notice_night_${String(published)}`,
    correlationId: `notice_night_${String(published)}`,
    revision: 1,
    semanticKind: "native_notice",
    payload: { message: "It is getting late." },
  };
}

/** The same step in its semantic spelling: the Mod publishes both for one node. */
function bodyTrace(kind: string, revision: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `trace_${kind}_${String(revision)}`,
    correlationId: `trace_transport_${String(revision)}`,
    executionId: `exec_step_${String(revision)}`,
    revision,
    payload: {
      kind,
      revision,
      reasonCode: "body_trace",
      bodyTrace: {
        category: kind,
        executionId: `exec_step_${String(revision)}`,
        requestId: "request_step",
        tick: revision,
      },
    },
  };
}

/**
 * A player's word: the one opener that is not a fact and always owes a turn.
 *
 * It is also the only way this gate opens a turn, so every scenario below ends with one and the facts that were waiting
 * have somewhere to be carried to.
 */
const PLAYER_INPUT = {
  source: "player_text" as const,
  inputId: "player_1",
  eventId: "player_source_1",
  text: "你在做什么？",
  locale: "zh-CN",
  timestampMs: 1_000,
};

/**
 * `fact_flushed_then_discarded:<suppressor>` - every flush the pump assembles opens a turn, or is a named refusal.
 *
 * <p>
 * THE POPULATION IS DERIVED. One scenario per `NOT_OWED_REASONS` member is built by driving the pump's real entrances -
 * a snapshot (a reading), a programme step (a trace), a player's word (a decision) - and the population of reasons is the
 * closed list itself, so a reason added there is driven here or the scenario table refuses to compile.
 * </p>
 * <p>
 * THE PROPERTY IS NEGATIVE: `discarded === 0`. A batch composed and then dropped is the defect, so it is not the turns
 * that are counted - it is the batches that produced none.
 * </p>
 */
test("fact_flushed_then_discarded: a flush that produced no turn is not a flush", async () => {
  const scenarios: ReadonlyArray<
    Readonly<{
      reason: string;
      /**
       * The journal's own reading, for the answers that depend on what her plan still has to get through.
       *
       * A pump reads the real ledger (`readInFlightProgrammes`) unless it is given one, and in this process that ledger
       * is empty - so the one reason whose whole subject is a RUNNING PLAN has to be driven with a reading that says
       * so. It is the scenario's own input rather than a global, which is what keeps the other scenarios honest.
       */
      reading?: InFlightProgrammeReading;
      drive: (pump: CompanionEventPump, sink: { deliver(batch: PendingBatch): Promise<void> }) => Promise<void>;
    }>
  > = [
    {
      reason: NOT_OWED.planStillRunning,
      reading: runningPlan(2),
      drive: async (pump, sink) => {
        // A HUD line the game showed, while her own plan still has nodes: it may open a turn, and the answer that plan
        // is about to give is the batch it travels in (`event-pump.plan-keeps-the-turn.test.ts`).
        pump.enqueueFact(noticeFact(0), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.nothingPending,
      drive: async (pump, sink) => {
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.observationRestated,
      drive: async (pump, sink) => {
        pump.enqueueFact(snapshotFact(1), FACT_PRODUCER.adapterIngress);
        // The reading is the `<world-state>` block every turn re-states: the first call renders it, and the second one is
        // the same reading again - the "nothing moved" call a per-tile stream produced 125 times in `round64`.
        pump.enqueuePlayerInput(PLAYER_INPUT);
        await pump.flush(sink);
        pump.enqueueFact(snapshotFact(1), FACT_PRODUCER.snapshotRestate);
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.observationMoved,
      drive: async (pump, sink) => {
        pump.enqueueFact(snapshotFact(1), FACT_PRODUCER.adapterIngress);
        // A reading is standing state, so a turn has to hand the FIRST one over: `observation_moved` compares the reading
        // against the one she was GIVEN, and a pump holding a reading nobody was shown has moved nothing she can see.
        pump.enqueuePlayerInput(PLAYER_INPUT);
        await pump.flush(sink);
        pump.enqueueFact(snapshotFact(2, "0620"), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.noSurface,
      drive: async (pump, sink) => {
        // A NODE'S TERMINAL RECEIPT: a decision by shape, and a shape the surface has nowhere to show - `receipt` carries no
        // event identity on the wire (`protocol/bridge-v1.schema.json`), so no projection can be attached to a turn opened on
        // it. It waits in its window and the next turn that can present carries it (`event-pump.turn-surface.test.ts`).
        pump.enqueueFact(programmeStep("succeeded", 70), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.progress,
      drive: async (pump, sink) => {
        pump.enqueueFact(bodyTrace("route_progress", 61), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
      },
    },
    {
      reason: NOT_OWED.worldFactRestated,
      drive: async (pump, sink) => {
        pump.enqueueFact(noticeFact(0), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
        // The same statement published again under a fresh event id: `round46b`'s 07:30:43 turn, in one call. A clock
        // mark cannot demonstrate this - a moment is news every time it is stated (`DAY_BOUNDARY_SEMANTIC_KINDS`) - so
        // the notice is the shape that can be re-stated.
        pump.enqueueFact(noticeFact(1), FACT_PRODUCER.adapterIngress);
        await pump.flush(sink);
      },
    },
  ];
  // DERIVED FROM THE CLASSIFICATION, not from the reason list alone. `in_flight_progress` is still DECLARED - the
  // pump's own table names it so a shape that came back would be filed rather than defaulted - but no shape is
  // classified that way any more (`IN_FLIGHT_RECEIPT_PROGRESS_STATES` is empty by ruling), so no scenario can drive it.
  // It is the one reason exempted here, and the exemption is checked in both directions: the census below fails if a
  // reason appears that no scenario covers, and fails if a shape ever IS filed `in_flight_progress` while this list
  // still says nothing can reach it.
  assert.deepEqual(
    Object.values(FACT_TURN_CONSEQUENCE).filter((consequence) => consequence === "in_flight_progress"),
    [],
    "no fact shape is filed as in_flight_progress, which is the only reason this table cannot drive that answer",
  );
  assert.deepEqual(
    [...scenarios.map((scenario) => scenario.reason), NOT_OWED.inFlightProgress].sort(),
    [...NOT_OWED_REASONS].sort(),
    "the scenario table must drive every declared reason, or a reason nobody exercises is a reason nobody measures",
  );

  for (const scenario of scenarios) {
    const pump = new CompanionEventPump(
      scenario.reading === undefined ? undefined : () => scenario.reading as InFlightProgrammeReading,
    );
    const turns = recorder();
    await scenario.drive(pump, turns.sink);
    const reading = flushReading(pump.turnAccount);
    assert.equal(
      pump.turnAccount.notOwed[scenario.reason as keyof TurnAccount["notOwed"]],
      1,
      `the scenario for \`${scenario.reason}\` must reach that answer: ${describe(reading, pump.turnAccount)}`,
    );
    assert.equal(
      reading.discarded,
      0,
      `fact_flushed_then_discarded:${scenario.reason}: a batch assembled and then discarded is the defect this pump exists to remove (${describe(reading, pump.turnAccount)})`,
    );
    // THE FALSIFIER FOR THE OTHER DIRECTION: a call that owes no turn must not have reached `takeBatch` either, so the
    // count of batches examined is the count of turns and nothing else.
    assert.equal(reading.examined, reading.opened, describe(reading, pump.turnAccount));
    assert.equal(
      turns.batches.length,
      reading.opened,
      "every opened turn is one delivery, and no delivery exists without one",
    );
  }
});

/**
 * `fact_flushed_then_discarded:carried` - a decision is never lost, and every fact that owed no turn is proved carried.
 *
 * The second half of invariant I: `not_owed` carries a ticket, and the ticket must resolve to the batch that consumed the
 * facts. A fact that opened no turn and was never carried is a loss, and it is the one this field exists to make
 * impossible to hide.
 */
test("fact_flushed_then_discarded:carried, every fact that owed no turn reaches a later batch", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();
  pump.enqueueFact(snapshotFact(1), FACT_PRODUCER.adapterIngress);
  // TWO TRACES, because a trace is what still owes no turn: a finished programme STEP used to be silent here and is
  // now the answer that opens its own turn (`program_settled`/`execution_receipt` are both `decision`), so a test that
  // drove this with a step would be asserting a premise the ruling removed.
  const trace = bodyTrace("route_progress", 61);
  const idle = bodyTrace("body_idle", 63);
  pump.enqueueFact(trace, FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(idle, FACT_PRODUCER.adapterIngress);
  const notOwed = await pump.flush(turns.sink);
  assert.equal(notOwed.kind, "not_owed", `two traces owe no turn, got ${notOwed.kind}`);
  assert.ok(notOwed.kind === "not_owed");
  assert.equal(notOwed.carry.facts.length, 2, "the ticket names both facts that are waiting");
  assert.equal(pump.carriedInto(notOwed.carry), undefined, "and answers `not yet` until a batch consumes them");
  const before = flushReading(pump.turnAccount);
  assert.equal(before.consumed, 0, "nothing has been consumed yet: a ticket is not a delivery");
  assert.equal(before.held, 2, "both are held, which is the promise a `not_owed` answer makes");

  pump.enqueuePlayerInput(PLAYER_INPUT);
  const opened = await pump.flush(turns.sink);
  assert.equal(opened.kind, "opened");
  const carriedInto = pump.carriedInto(notOwed.carry);
  assert.equal(
    carriedInto,
    turns.batches[0]!.batchId,
    "the ticket resolves to the batch that carried those exact facts",
  );
  const after = flushReading(pump.turnAccount);
  assert.equal(after.consumed, 2, "and both facts are counted as arrived: 事件守恒 —— 一个都不许消失");
  assert.equal(after.held, 0, "nothing is left waiting");
  assert.equal(after.carried, 2, "and the population is the two facts the ledger closed over");
  assert.equal(turns.batches[0]!.facts.filter((fact) => fact.kind === "semantic_event").length, 2);
});

/**
 * `progress_reported_as_a_fact:<kind>` - every trace shape the pump declares never opens a turn.
 *
 * <p>
 * THE POPULATION IS THE PUMP'S OWN TABLES, not a list written here: `HELD_SEMANTIC_PROGRESS_KINDS` and
 * `HELD_RECEIPT_PROGRESS_STATES` are what the Mod's trace traffic is classified by, so a kind added there is measured by
 * this gate without anyone remembering to extend a second table. The property is that a trace, on its own, is answered
 * `not_owed` and composed into nothing - `round64` spent 125 flushes finding that out one receipt at a time.
 * </p>
 */
test("progress_reported_as_a_fact: no trace shape opens a turn", async () => {
  const semanticKinds = Object.keys(HELD_SEMANTIC_PROGRESS_KINDS);
  const receiptStates = Object.keys(HELD_RECEIPT_PROGRESS_STATES);
  assert.ok(semanticKinds.length > 0 && receiptStates.length > 0, "an empty population agrees with itself");
  let examined = 0;
  for (const kind of semanticKinds) {
    const pump = new CompanionEventPump();
    const turns = recorder();
    pump.enqueueFact(bodyTrace(kind, 70), FACT_PRODUCER.adapterIngress);
    const outcome = await pump.flush(turns.sink);
    examined += 1;
    assert.equal(
      outcome.kind,
      "not_owed",
      `progress_reported_as_a_fact:${kind}: a body trace is not an event: it must never become a delivery`,
    );
    assert.equal(turns.batches.length, 0, `progress_reported_as_a_fact:${kind}: no batch may exist for a trace`);
    assert.equal(
      pump.turnAccount.traces[`semantic:${kind}`],
      1,
      `progress_reported_as_a_fact:${kind}: the trace is counted under the kind that produced it`,
    );
  }
  for (const state of receiptStates) {
    const pump = new CompanionEventPump();
    const turns = recorder();
    pump.enqueueFact(programmeStep(state, 71), FACT_PRODUCER.adapterIngress);
    const outcome = await pump.flush(turns.sink);
    examined += 1;
    assert.equal(
      outcome.kind,
      "not_owed",
      `progress_reported_as_a_fact:receipt:${state}: a step of a programme she dispatched is progress, not a decision`,
    );
    assert.equal(
      turns.batches.length,
      0,
      `progress_reported_as_a_fact:receipt:${state}: no batch may exist for a trace`,
    );
  }
  assert.equal(
    examined,
    semanticKinds.length + receiptStates.length,
    "every declared trace shape was driven exactly once",
  );
});

/**
 * `delivered_text_never_arrived:<reason>` - the account names what the delivery layer lost.
 *
 * Population: every presentation commit the loop reports through `noteDelivery`. Property: the account's `lost` names
 * every reason it was handed, so a bubble that was delivered and withheld is a number a reader can see rather than a
 * per-turn stderr line in a stream nobody reads back (`round64`: batch 6's bubble was delivered, `no_presentation_lease`,
 * and the account said nothing).
 */
test("delivered_text_never_arrived: a withheld bubble is named in the account", () => {
  const pump = new CompanionEventPump();
  pump.noteDelivery({ bubbles: 1, lost: { blank_text: 1 } });
  pump.noteDelivery({ bubbles: 0, lost: { no_presentation_lease: 2 } });
  const account = pump.turnAccount;
  assert.equal(account.delivery.bubbles, 1, "one bubble reached the player");
  assert.equal(account.delivery.lostTotal, 3, "and three parts did not");
  assert.deepEqual(
    account.delivery.lost,
    { blank_text: 1, no_presentation_lease: 2 },
    "every reason the delivery layer reported is named, with its count",
  );
  const line = turnAccountLine(account);
  assert.match(line, /bubbles delivered 1/u, `the account line carries the bubble count: ${line}`);
  assert.match(
    line,
    /lost 3 \{blank_text: 1, no_presentation_lease: 2\}/u,
    `delivered_text_never_arrived:no_presentation_lease: the account line must name the loss and its reason: ${line}`,
  );
  // FALSIFIER: a delivery that lost nothing says `0`, and the two readings are different statements rather than one
  // number that could mean either.
  const clean = new CompanionEventPump();
  clean.noteDelivery({ bubbles: 2, lost: {} });
  assert.equal(clean.turnAccount.delivery.lostTotal, 0);
  assert.match(turnAccountLine(clean.turnAccount), /bubbles delivered 2 · lost 0 \{\}/u);
});

/**
 * The account line's own identity: `flushes examined` IS `turns opened`, and the line says so.
 *
 * A printer that dropped one of the two readings would let a run's log answer "how many turns" and not "how many flushes
 * paid for them", which is the question `round64` could not ask.
 */
test("the account line prints the flush, the carry and the loss in one reading", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();
  pump.enqueueFact(snapshotFact(1), FACT_PROVIDER_INGRESS);
  pump.enqueueFact(bodyTrace("body_idle", 80), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  pump.enqueuePlayerInput(PLAYER_INPUT);
  await pump.flush(turns.sink);
  const reading = flushReading(pump.turnAccount);
  assert.equal(reading.examined, 1, "one batch was composed");
  assert.equal(reading.opened, 1, "and it opened one turn");
  assert.equal(reading.notOwed, 1, "one call owed no turn");
  assert.equal(reading.consumed, 1, "and the trace it declined was carried by the turn that followed");
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /flushes examined 1/u, line);
  assert.match(line, /turns opened 1/u, line);
  assert.match(line, /carried 1 · consumed 1 · lost 0 · held 0/u, line);
  assert.match(line, /traces 1/u, line);
});

/** The one producer the admission of a reading is attributed to in the last test, named so the line reads back. */
const FACT_PROVIDER_INGRESS = FACT_PRODUCER.adapterIngress;
