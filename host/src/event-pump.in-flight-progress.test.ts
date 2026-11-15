import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factTurnConsequence,
  HELD_SEMANTIC_PROGRESS_KINDS,
  HOST_MINTED_WAKE_KINDS,
  IN_FLIGHT_SEMANTIC_PROGRESS_KINDS,
  type PendingBatch,
  TURN_SUPPRESSION,
  type WorldFact,
} from "./event-pump.js";
import { EXECUTION_STATES } from "./protocol.js";
import type { InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * A step of a programme the journal still shows running is PROGRESS, not a decision.
 *
 * <p>
 * MEASURED 2026-11-15 (`round57`, `GAME_TURN_ACCOUNT`): `turns opened 66 {player_input: 4, world_fact: 62
 * {adapter_ingress: 57, companion_arrival: 1, program_settlement: 4}}`. Fifty-seven of sixty-six turns were opened by
 * one adapter fact, and the run's own transcript shows what they were: she submitted `builder.harvest_crop` for three
 * cauliflowers, and every node that finished arrived as its own terminal receipt and opened its own turn -
 * `#68`, `#70`, `#72`, `#76`, `#78`: five utterances for one micro-action.
 * </p>
 * <p>
 * The fact is not the news. `program_settled` is: it states the plan's outcome, per node, in `<execution-result>`. A
 * node's `succeeded` receipt arriving while the journal still lists the plan is the pump re-stating work in flight that
 * she already dispatched - the same rule `TURN_OPENING` states for a reading, applied to a step.
 * </p>
 * <p>
 * NOTHING IS LOST: the receipt keeps its place in the window and travels in the turn the settlement opens, and a
 * `<in-flight>` still running at that moment is rendered into the same block.
 * </p>
 * <p>
 * THE EXPECTED READING ON A RERUN. `round57` printed `turns opened 66 {player_input: 4, world_fact: 62 {adapter_ingress:
 * 57, companion_arrival: 1, program_settlement: 4}}`. With a step silent, `adapter_ingress` can only fall to the
 * refusals it carried, so `turns opened` should move toward `player_input 4 + program_settlement 4 + companion_arrival 1
 * + refusals` - nine plus whatever the run actually refused - and the flushes those steps arrived on must appear as a
 * new segment, `suppressed N {… in_flight_progress: k …}`, with `opened + Σ suppressed` still equal to `flushes
 * examined`. A run whose `adapter_ingress` count stays near 57 while `in_flight_progress` stays at 0 has not exercised
 * this path at all, and that is a different answer from "the fix did not work".
 * </p>
 */

/** The three cauliflowers of the measured plan, as the journal's own reading states them. */
function harvestPlan(remaining: number): InFlightProgrammeReading {
  return {
    programmes: [
      {
        programId: "plan_harvest_cauli",
        total: 3,
        settled: 3 - remaining,
        remaining,
        readAgeMs: 400,
        nodes: [
          {
            index: 0,
            nodeId: "n001",
            actionId: "harvest_crop",
            state: remaining < 3 ? "succeeded" : "running",
            observedInStateMs: 2_000,
          },
          { index: 1, nodeId: "n002", actionId: "harvest_crop", state: "pending", observedInStateMs: 0 },
          { index: 2, nodeId: "n003", actionId: "harvest_crop", state: "pending", observedInStateMs: 0 },
        ],
        omitted: 0,
      },
    ],
    omittedProgrammes: 0,
  };
}

const NOTHING_IN_FLIGHT: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([]),
  omittedProgrammes: 0,
});

/** One node of the plan finishing: the receipt that opened `#69`, `#71` and `#73` of the transcript. */
function nodeSucceeded(tile: string, revision: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: `exec_harvest_${tile}`,
    executionId: `exec_harvest_${tile}`,
    requestId: `request_harvest_${tile}`,
    revision,
    payload: {
      actionId: "harvest_crop",
      state: "succeeded",
      reasonCode: "crop_harvested",
      revision,
      evidence: { detail: `tile=${tile}` },
    },
  };
}

function nodeRejected(tile: string, revision: number): WorldFact {
  return {
    ...nodeSucceeded(tile, revision),
    payload: {
      actionId: "harvest_crop",
      state: "rejected",
      reasonCode: "tool_not_held",
      revision,
      evidence: { detail: `tile=${tile}` },
    },
  };
}

/** The turn the plan itself owes: what the Mod's settlement watch mints when the journal stops naming the plan. */
function programSettled(): WorldFact {
  return {
    source: "host_game_session",
    kind: "world_fact",
    eventId: "program_settled_plan_harvest_cauli",
    sourceEventId: "program_settled_plan_harvest_cauli",
    correlationId: "plan_harvest_cauli",
    revision: 61,
    semanticKind: "program_settled",
    payload: {
      programId: "plan_harvest_cauli",
      state: "succeeded",
      succeeded: 3,
      failed: 0,
      refused: 0,
      decided: 3,
    },
  };
}

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

test("a node's success inside a still-running programme does not open a turn", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(2));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    0,
    "the first cauliflower finishing is a step of a plan she already dispatched: it opened a turn in round57 (#69), and that is the defect",
  );
  assert.equal(turns.batches.length, 0, "and no turn means no delivery");
  assert.equal(
    pump.turnAccount.lastDecision?.kind,
    "suppressed",
    `the flush must still be decided and named, got ${JSON.stringify(pump.turnAccount.lastDecision)}`,
  );
  assert.equal(
    pump.turnAccount.suppressed[TURN_SUPPRESSION.inFlightProgress],
    1,
    "and named as a step, so a rerun's account can count how many turns this rule removed",
  );
  assert.equal(
    pump.turnAccount.suppressedByProducer[TURN_SUPPRESSION.inFlightProgress][FACT_PRODUCER.adapterIngress],
    1,
    "with the entrance the fact came in by, or a suppressed fact has no record of where it arrived",
  );
});

test("the settlement opens the turn, and it carries the nodes that finished inside it", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(2));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  pump.enqueueFact(programSettled(), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "one plan, one turn: the settlement is the decision");
  const batch = turns.batches[0]!;
  assert.deepEqual(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").map((fact) => fact.payload.reasonCode),
    ["crop_harvested"],
    "the suppressed receipt is still delivered: the fix is WHERE it arrives, not whether",
  );
  assert.match(batch.text, /harvest_crop 做成了：crop_harvested/u, "and in the Mod's own words");
});

test("a plan still running when a turn opens for another reason states the programme AND its finished steps", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(1));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(nodeSucceeded("60,11", 61), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(turns.batches.length, 0, "two finished nodes, no turn");

  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_1",
    text: "还有一颗呢？",
    locale: "zh-CN",
    timestampMs: 1_000,
  });
  await pump.flush(turns.sink);

  const batch = turns.batches[0]!;
  assert.match(batch.text, /<in-flight>\n/u, "the programme in flight reaches the turn that follows");
  assert.match(batch.text, /in_flight:settled=2;total=3;remaining=1/u);
  assert.equal(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").length,
    2,
    "and so do both finished nodes",
  );
});

test("with nothing in flight a success is news: a lone action's outcome has no settlement to speak for it", async () => {
  const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a single action that finished is the only fact that will ever say so");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u);
});

test("a refusal inside a running programme is a decision, not progress", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(2));
  const turns = recorder();

  pump.enqueueFact(nodeRejected("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a rejected node is the one thing mid-plan she can act on");
  assert.match(turns.batches[0]!.text, /harvest_crop 没做成：tool_not_held/u);
});

// ---------------------------------------------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------------------------------------------

const IN_FLIGHT_PROGRESS_OPENED_A_TURN = "in_flight_progress_opened_a_turn";

/** One shape the ingress can deliver, with a fact that carries it. */
type ShapeCase = Readonly<{ shape: string; fact: WorldFact }>;

function snapshotFact(): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot_1",
    revision: 1,
    payload: { location: "Farm", gameTime: "0610" },
  };
}

function milestoneFact(): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "milestone_600",
    sourceEventId: "milestone_600",
    correlationId: "milestone_600",
    revision: 1,
    semanticKind: "time_milestone",
    payload: { milestone: 600 },
  };
}

function lifecycleFact(): WorldFact {
  return {
    source: "stardew_mod",
    kind: "lifecycle",
    correlationId: "lifecycle_1",
    revision: 1,
    payload: { state: "disconnected", reasonCode: "bridge_closed" },
  };
}

function receiptOf(state: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: `exec_${state}`,
    executionId: `exec_${state}`,
    requestId: `request_${state}`,
    revision: 1,
    payload: { actionId: "harvest_crop", state, reasonCode: `reason_${state}`, revision: 1 },
  };
}

function semanticEventOf(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: `transport_${kind}`,
    executionId: "exec_one",
    revision: 1,
    payload: { kind, revision: 1, reasonCode: "body_trace", activeExecution: null },
  };
}

/**
 * The semantic kinds this pump declares - a kind added to ANY of the three tables must be classified here.
 *
 * THE BOUNDARY IS WHAT THIS GATE READS, and it is worth naming: the Mod's semantic vocabulary is open, so a kind no Host
 * table mentions reaches the pump as an unclassified shape and takes the `decision` default (one extra turn, never a
 * lost fact). What is closed here is the pump's own vocabulary: the protocol's `EXECUTION_STATES` and the three kind
 * tables. `event-pump-wake-classification.test.ts` reports the wider spelled-kind population from source without
 * asserting over it, for exactly this reason.
 */
function semanticKindPopulation(): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS),
      ...Object.keys(IN_FLIGHT_SEMANTIC_PROGRESS_KINDS),
      ...Object.keys(HOST_MINTED_WAKE_KINDS),
    ]),
  ].sort();
}

function shapePopulation(): readonly ShapeCase[] {
  const cases: ShapeCase[] = [
    { shape: "snapshot", fact: snapshotFact() },
    { shape: "world_fact", fact: milestoneFact() },
    { shape: "lifecycle", fact: lifecycleFact() },
  ];
  for (const state of EXECUTION_STATES) cases.push({ shape: `receipt:${state}`, fact: receiptOf(state) });
  for (const kind of semanticKindPopulation()) cases.push({ shape: `semantic:${kind}`, fact: semanticEventOf(kind) });
  return cases;
}

/** What one drive of the pump did with one fact: the population the gate reasons over. */
type OpeningReading = Readonly<{ opened: number; reason: string | undefined }>;

async function openingOf(fact: WorldFact, inFlight: InFlightProgrammeReading): Promise<OpeningReading> {
  const pump = new CompanionEventPump(() => inFlight);
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver() {
      return undefined;
    },
  });
  return { opened: pump.turnAccount.opened, reason: pump.turnAccount.lastDecision?.reason };
}

/** One shape, driven twice: inside a running programme, and with nothing in flight. */
type ShapeReading = Readonly<{ shape: string; inProgramme: OpeningReading; alone: OpeningReading }>;

/**
 * `in_flight_progress_opened_a_turn:<producer>:<factKind>`: a shape classified as progress must not open a turn, and a
 * shape classified as a decision must not be swallowed.
 *
 * <p>
 * POPULATION IS THE SHAPE TABLE, derived in `shapePopulation` from the protocol's `EXECUTION_STATES` and the pump's own
 * kind tables, so a state or kind added to either is examined here without anyone extending a list. Each shape is driven
 * TWICE, because the two failure directions are different defects: inside a running programme a step must be silent, and
 * with nothing in flight a lone outcome must speak. Only the second drive can catch over-suppression - which is the
 * silence of 2026-11-07 (`program_settled` was held, and she went quiet for 816.5 s).
 * </p>
 *
 * The verdict comes from the readings, not from the pump's exit: zero population is BLOCKED with a reason rather than
 * green, and a violation names the producer and the shape it fired on.
 */
function inFlightProgressGate(readings: readonly ShapeReading[]): Readonly<{
  examined: number;
  decision: number;
  progress: number;
  violations: readonly string[];
  blocked: string | null;
}> {
  if (readings.length === 0)
    return Object.freeze({
      examined: 0,
      decision: 0,
      progress: 0,
      violations: Object.freeze([]),
      blocked: "zero_population:no_fact_shape_was_examined",
    });
  const violations: string[] = [];
  let decision = 0;
  let progress = 0;
  for (const reading of readings) {
    const consequence = FACT_TURN_CONSEQUENCE[reading.shape];
    if (consequence === undefined) violations.push(`unclassified_fact_shape:${reading.shape}`);
    // The shape's own meaning decides what the two drives must show.
    const silentInProgramme = consequence === "progress" || consequence === "in_flight_progress";
    const speaksAlone = consequence === "decision" || consequence === "in_flight_progress";
    if (silentInProgramme) progress += 1;
    else decision += 1;
    if (silentInProgramme && reading.inProgramme.opened > 0)
      violations.push(`${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
    if (speaksAlone && reading.alone.opened === 0)
      violations.push(`decision_swallowed:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
    // A step of a programme must be COUNTED, not silently skipped: the reason is the only evidence a run's account has
    // that the fact arrived and was held on purpose.
    if (consequence === "in_flight_progress" && reading.inProgramme.reason !== TURN_SUPPRESSION.inFlightProgress)
      violations.push(
        `in_flight_progress_unnamed:${FACT_PRODUCER.adapterIngress}:${reading.shape}:${String(reading.inProgramme.reason)}`,
      );
  }
  return Object.freeze({
    examined: readings.length,
    decision,
    progress,
    violations: Object.freeze(violations),
    blocked: null,
  });
}

async function readEveryShape(): Promise<readonly ShapeReading[]> {
  const readings: ShapeReading[] = [];
  for (const { shape, fact } of shapePopulation())
    readings.push({
      shape,
      inProgramme: await openingOf(fact, harvestPlan(2)),
      alone: await openingOf(fact, NOTHING_IN_FLIGHT),
    });
  return readings;
}

test("in_flight_progress_opened_a_turn: no progress shape opens a turn, and no decision is swallowed", async () => {
  const gate = inFlightProgressGate(await readEveryShape());

  assert.equal(gate.blocked, null, `the gate measured nothing: ${String(gate.blocked)}`);
  assert.ok(gate.examined > 0, "zero population is blocked, never green");
  // The printed population is the reading a run's log cannot give: a gate that says "0 violations" without saying what it
  // examined agrees with itself.
  console.log(
    `in_flight_progress_opened_a_turn: examined ${String(gate.examined)} fact kinds · decision ${String(gate.decision)} · progress ${String(gate.progress)}`,
  );
  assert.deepEqual(
    gate.violations,
    [],
    "a step of a programme that is still running owes no turn; a refusal, an outcome or the world speaking still does",
  );
});

test("in_flight_progress_opened_a_turn: the gate is red on a shape that opened a turn anyway", () => {
  // THE FALSIFIER. A guard nobody has seen red is decoration, so the same gate is handed the reading the tree produced
  // before this change: a node's `succeeded` receipt, delivering its own turn while the plan was still running.
  const recorded = inFlightProgressGate([
    {
      shape: "receipt:succeeded",
      inProgramme: { opened: 1, reason: "world_fact" },
      alone: { opened: 1, reason: "world_fact" },
    },
  ]);

  assert.deepEqual(
    recorded.violations,
    [
      `${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:adapter_ingress:receipt:succeeded`,
      // Both halves of the defect, because the tree that opened this turn also had no way to say it had been a step:
      // the fact arrived, opened a turn, and left nothing in the account that a rerun could read as "held on purpose".
      `in_flight_progress_unnamed:adapter_ingress:receipt:succeeded:world_fact`,
    ],
    "the gate must name the producer and the fact kind it fired on, or the next reader is told 'expected true, got false'",
  );
  assert.equal(recorded.progress, 1, "and it must count the shape it failed, so the printed population still closes");
});

test("in_flight_progress_opened_a_turn: the gate is red on a decision it swallowed instead", () => {
  // The other direction, which "fewer turns" alone can never detect: an over-suppressed shape costs her the only fact
  // that would ever have said an action happened.
  const overSuppressed = inFlightProgressGate([
    {
      shape: "receipt:rejected",
      inProgramme: { opened: 0, reason: "in_flight_progress" },
      alone: { opened: 0, reason: "nothing_pending" },
    },
  ]);

  assert.deepEqual(overSuppressed.violations, ["decision_swallowed:adapter_ingress:receipt:rejected"]);
});

test("in_flight_progress_opened_a_turn: zero population is blocked, never green", () => {
  const empty = inFlightProgressGate([]);
  assert.equal(empty.blocked, "zero_population:no_fact_shape_was_examined");
  assert.deepEqual(empty.violations, []);
  assert.equal(empty.examined, 0);
});

test("the shape the ingress delivers is classified once, in the table the pump reads", () => {
  // The class-closing property: the table's population is derived from the protocol's state list plus the pump's own
  // kind tables, and every member of those is in it. A state the protocol adds fails HERE by name rather than arriving
  // in a running bridge as an unclassified fact.
  const examined = shapePopulation();
  assert.ok(examined.length > 0, "an empty population proves nothing");
  assert.deepEqual(
    examined.filter((entry) => FACT_TURN_CONSEQUENCE[entry.shape] === undefined).map((entry) => entry.shape),
    [],
    "every shape the ingress can deliver must be classified as a decision or as progress",
  );
  assert.equal(
    factTurnConsequence(nodeSucceeded("60,10", 60)),
    "in_flight_progress",
    "and the fact the measured run opened fifty-seven turns with is the one the table calls a step",
  );
  assert.equal(factTurnConsequence(programSettled()), "decision", "while the plan's own settlement stays a decision");
  assert.equal(factTurnConsequence(nodeRejected("60,10", 60)), "decision", "and so does every refusal");
});
