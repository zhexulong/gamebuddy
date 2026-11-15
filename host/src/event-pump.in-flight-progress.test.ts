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
  SETTLED_PROGRAM_OUTCOMES,
  type SettledProgramOutcome,
  TURN_OPENING,
  TURN_SUPPRESSION,
  type WorldFact,
} from "./event-pump.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import {
  createProgramProgressObserver,
  type InFlightProgrammeReading,
  type PlanAnswerNode,
} from "./program-status-wait.js";
import { EXECUTION_STATES } from "./protocol.js";

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
    settling: [],
  };
}

const NOTHING_IN_FLIGHT: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([]),
  omittedProgrammes: 0,
  settling: Object.freeze([]),
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

/** One node row of the Mod's own journal, as the settlement read sees it. */
type JournalRow = Readonly<{ nodeId: string; state: string; rejectionCode?: string; failureCode?: string }>;

function planNode(nodeId: string): PlanAnswerNode {
  return {
    nodeId,
    actionId: "move_to_tile",
    arguments: {
      x: { type: "integer", canonicalValue: "60" },
      y: { type: "integer", canonicalValue: "10" },
    },
  };
}

/**
 * The settlement fact, built by the PRODUCER rather than written out here.
 *
 * A hand-written payload is a second copy of `program-settlement-digest.ts`'s own shape, and the two agree on the day one
 * is written. This one cannot disagree: what the pump classifies is what `programSettledDigest` actually mints, counts,
 * rows and all.
 */
function settledFact(rows: readonly JournalRow[], programId = "plan_harvest_cauli"): WorldFact {
  const fact = programSettledDigest({
    programId,
    settledAtMs: 4_242,
    compiled: rows.map((row) => planNode(row.nodeId)),
    status: {
      code: "found",
      snapshot: { programId, state: "succeeded", catalogRevision: 3, stopEpoch: 0, eventHighWater: 90, nodes: rows },
    },
    nowMs: 9,
  });
  assert.ok(fact !== undefined, `the producer must state a settled ${programId}`);
  return fact;
}

/** A programme that did every node it was given: the shape round59 produced 72 times. */
function programSettled(): WorldFact {
  return settledFact([
    { nodeId: "n001", state: "succeeded" },
    { nodeId: "n002", state: "succeeded" },
    { nodeId: "n003", state: "succeeded" },
  ]);
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

test("a turn that only carries 'programme N succeeded' opens none, and the next turn carries its outcome", async () => {
  // THE DEFECT THIS CLOSES. MEASURED 2026-11-15 (`round59`): `turns opened 88 {player_input: 4, world_fact: 84
  // {adapter_ingress: 79, companion_arrival: 1, program_settlement: 4}}` against 72 submissions, and every one of the 42
  // settled turns the audit read carried text. The shape was: programme N settles, nothing else is in flight, it opens a
  // turn, she submits N+1 and writes a line - one utterance bought with one plan.
  //
  // A programme that did what it was told states work she already dispatched. Nothing in it changes what she does next,
  // so it belongs in the next turn's block with every other progress fact - and the property below is that it is still
  // THERE, in `<execution-result>`, when that turn comes.
  const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
  const turns = recorder();

  pump.enqueueFact(settledFact([{ nodeId: "n001", state: "succeeded" }]), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    0,
    "a turn that only carries 'programme N succeeded, nothing else' must not open one - that is the turn round59 bought 72 times",
  );
  assert.equal(turns.batches.length, 0, "and no turn means no delivery yet");
  assert.equal(
    pump.turnAccount.suppressed[TURN_SUPPRESSION.progress],
    1,
    "the flush is COUNTED as progress, not as a re-stated reading: a reading is re-stated before every flush",
  );

  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_1",
    text: "收完了吗？",
    locale: "zh-CN",
    timestampMs: 1_000,
  });
  await pump.flush(turns.sink);

  const batch = turns.batches[0]!;
  assert.match(batch.text, /<execution-result>\n/u, "the outcome still arrives, in the next turn's own block");
  assert.match(batch.text, /1\/1 步做成了/u, "in the producer's own counts, not a paraphrase");
});

test("at a programme's boundary the receipt and its settlement travel together into the next turn", async () => {
  // The shape `round59` produced 79 times: the last node's `succeeded` receipt arrives while the journal still names the
  // plan (every node terminal, `remaining` `0`), and the settlement follows it within a second. Neither is a turn; both
  // are carried by the next one that opens for a decision, so the outcome and the receipts it summarises arrive together.
  const pump = new CompanionEventPump(() => harvestPlan(0));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settledFact([{ nodeId: "n001", state: "succeeded" }]), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 0, "a boundary receipt and a successful settlement state work she dispatched");

  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_1",
    text: "收完了吗？",
    locale: "zh-CN",
    timestampMs: 1_000,
  });
  await pump.flush(turns.sink);

  const batch = turns.batches[0]!;
  assert.deepEqual(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").map((fact) => fact.payload.reasonCode),
    ["crop_harvested"],
    "the receipt the settlement summarises is delivered: the change moves WHERE it arrives, never whether",
  );
  assert.match(batch.text, /harvest_crop 做成了：crop_harvested/u, "in the Mod's own words");
  assert.match(batch.text, /<execution-result>\n/u, "beside the settlement that states it");
  assert.match(batch.text, /1\/1 步做成了/u);
});

test("a settlement that REFUSED a node still opens the turn: a refusal is a decision, and this change must not silence it", async () => {
  // THE FALSIFIER THAT MATTERS. If this direction is not proven, the change does not remove narration - it removes bad
  // news. A refused node is the one thing inside a plan she can act on, so the settlement states it and opens.
  const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
  const turns = recorder();

  pump.enqueueFact(
    settledFact([
      { nodeId: "n001", state: "succeeded" },
      { nodeId: "n002", state: "rejected", rejectionCode: "tool_not_held" },
    ]),
    FACT_PRODUCER.programSettlement,
  );
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a plan that was refused has to reach her, whatever else is quiet");
  const batch = turns.batches[0]!;
  assert.match(batch.text, /<execution-result>\n/u);
  assert.match(batch.text, /1\/2 步做成了/u, "the count says one of two done, not 'done'");
  assert.match(batch.text, /move_to_tile 没做成（tool_not_held）/u, "and the refusal is named with the Mod's own code");
});

test("a settlement that only PARTIALLY did a node opens the turn too", async () => {
  // `partially_succeeded` is the polite lie the state exists to refuse (`settledSummary`): it did part of its work, so it
  // is not success, and a settlement carrying one is not progress.
  const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
  const turns = recorder();

  pump.enqueueFact(
    settledFact([
      { nodeId: "n001", state: "succeeded" },
      { nodeId: "n002", state: "partially_succeeded", failureCode: "partially_watered" },
    ]),
    FACT_PRODUCER.programSettlement,
  );
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a partial node is not a programme that did what it was told");
  assert.match(turns.batches[0]!.text, /move_to_tile 没做成（partially_watered）/u);
});

test("the step that CLOSES a programme is progress: the boundary receipt does not open a turn", async () => {
  // THE OTHER HALF OF THE 79. `in_flight_progress` caught 290 receipts while the journal showed the plan running; the ones
  // that arrived after its last node went terminal did not match `remaining > 0`, so each opened a turn - and the plan was
  // still ACTIVE in the journal, which is why `harvestPlan(0)` (every node terminal, programme still named) is the reading
  // this test drives. Those are the boundary receipts of round59: 79 ingress-opened turns against 72 submissions.
  const pump = new CompanionEventPump(() => harvestPlan(0));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    0,
    "the last node of a plan still named by the journal is a step: the settlement is what states it",
  );
  assert.equal(
    pump.turnAccount.suppressed[TURN_SUPPRESSION.inFlightProgress],
    1,
    "and it is COUNTED as that step, so a rerun can see how many boundary turns the rule removed",
  );
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

/**
 * One settlement per outcome the pump DECLARES, built by the producer.
 *
 * The population comes from `SETTLED_PROGRAM_OUTCOMES`, not from this list, so an outcome added there appears in the gate
 * below without anyone remembering to extend it - and one whose classification drifts fails by name.
 */
function settledFactOf(outcome: SettledProgramOutcome): WorldFact {
  return outcome === "succeeded"
    ? settledFact([{ nodeId: "n001", state: "succeeded" }])
    : settledFact([
        { nodeId: "n001", state: "succeeded" },
        { nodeId: "n002", state: "rejected", rejectionCode: "tool_not_held" },
      ]);
}

function shapePopulation(): readonly ShapeCase[] {
  const cases: ShapeCase[] = [
    { shape: "snapshot", fact: snapshotFact() },
    { shape: "world_fact", fact: milestoneFact() },
    { shape: "lifecycle", fact: lifecycleFact() },
  ];
  for (const state of EXECUTION_STATES) cases.push({ shape: `receipt:${state}`, fact: receiptOf(state) });
  for (const kind of semanticKindPopulation()) cases.push({ shape: `semantic:${kind}`, fact: semanticEventOf(kind) });
  for (const outcome of Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[])
    cases.push({ shape: `settled:${outcome}`, fact: settledFactOf(outcome) });
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

/** One shape, driven three times: a running programme, the programme's boundary, and nothing named at all. */
type ShapeReading = Readonly<{
  shape: string;
  inProgramme: OpeningReading;
  boundary: OpeningReading;
  alone: OpeningReading;
}>;

/**
 * `in_flight_progress_opened_a_turn:<producer>:<factKind>`: a shape classified as progress must not open a turn, and a
 * shape classified as a decision must not be swallowed.
 *
 * <p>
 * POPULATION IS THE SHAPE TABLE, derived in `shapePopulation` from the protocol's `EXECUTION_STATES`, the pump's own
 * kind tables and its settlement outcomes, so a state, kind or outcome added to any of them is examined here without
 * anyone extending a list. Each shape is driven THREE times, because the failure directions are different defects: inside
 * a running programme a step must be silent, at a programme's boundary a step must still be silent (the settlement is
 * what speaks), and with nothing named a lone outcome must speak. Only the last drive can catch over-suppression - which
 * is the silence of 2026-11-07 (`program_settled` was held, and she went quiet for 816.5 s).
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
    // The shape's own meaning decides what the drives must show.
    const silentInProgramme = consequence === "progress" || consequence === "in_flight_progress";
    const speaksAlone = consequence === "decision" || consequence === "in_flight_progress";
    if (silentInProgramme) progress += 1;
    else decision += 1;
    if (silentInProgramme && reading.inProgramme.opened > 0)
      violations.push(`${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
    if (silentInProgramme && reading.boundary.opened > 0)
      violations.push(`${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:boundary:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
    if (speaksAlone && reading.alone.opened === 0)
      violations.push(`decision_swallowed:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
    // The falsifier's own direction, derived rather than remembered: a decision must still speak at the boundary, or the
    // change that silenced a programme's steps also silenced a refusal inside one.
    if (consequence === "decision" && reading.boundary.opened === 0)
      violations.push(`boundary_swallowed:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
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
      // The boundary: every node terminal, the plan still ACTIVE in the journal - the reading `round59` opened 79 turns in.
      boundary: await openingOf(fact, harvestPlan(0)),
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
      boundary: { opened: 1, reason: "world_fact" },
      alone: { opened: 1, reason: "world_fact" },
    },
  ]);

  assert.deepEqual(
    recorded.violations,
    [
      `${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:adapter_ingress:receipt:succeeded`,
      // The boundary is the same defect stated at the second reading: round59's 79 ingress-opened turns are exactly these.
      `${IN_FLIGHT_PROGRESS_OPENED_A_TURN}:boundary:adapter_ingress:receipt:succeeded`,
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
      boundary: { opened: 0, reason: "in_flight_progress" },
      alone: { opened: 0, reason: "nothing_pending" },
    },
  ]);

  assert.deepEqual(overSuppressed.violations, [
    "decision_swallowed:adapter_ingress:receipt:rejected",
    "boundary_swallowed:adapter_ingress:receipt:rejected",
  ]);
});

test("boundary_swallowed: the gate is red when a REFUSED settlement is silenced at the boundary", () => {
  // THE FALSIFIER FOR THE DIRECTION THAT MATTERS. The settlement that refuses a node is the fact this change must never
  // make progress: silencing it turns "fewer turns" into "bad news nobody delivered".
  assert.equal(
    FACT_TURN_CONSEQUENCE["settled:refused"],
    "decision",
    "the refused settlement is a decision in the table before the gate is asked to police it",
  );
  const silenced = inFlightProgressGate([
    {
      shape: "settled:refused",
      inProgramme: { opened: 0, reason: "in_flight_progress" },
      boundary: { opened: 0, reason: "in_flight_progress" },
      alone: { opened: 0, reason: "in_flight_progress" },
    },
  ]);

  assert.deepEqual(silenced.violations, [
    "decision_swallowed:adapter_ingress:settled:refused",
    "boundary_swallowed:adapter_ingress:settled:refused",
  ]);
});

test("in_flight_progress_opened_a_turn: zero population is blocked, never green", () => {
  const empty = inFlightProgressGate([]);
  assert.equal(empty.blocked, "zero_population:no_fact_shape_was_examined");
  assert.deepEqual(empty.violations, []);
  assert.equal(empty.examined, 0);
});

test("the shape the ingress delivers is classified once, in the table the pump reads", () => {
  // The class-closing property: the table's population is derived from the protocol's state list plus the pump's own
  // kind and outcome tables, and every member of those is in it. A state the protocol adds, a kind or a settlement
  // outcome the pump declares, fails HERE by name rather than arriving in a running bridge as an unclassified fact.
  const examined = shapePopulation();
  assert.ok(examined.length > 0, "an empty population proves nothing");
  assert.deepEqual(
    examined.filter((entry) => FACT_TURN_CONSEQUENCE[entry.shape] === undefined).map((entry) => entry.shape),
    [],
    "every shape the ingress can deliver must be classified as a decision or as progress",
  );
  // Derived, so an outcome added to `SETTLED_PROGRAM_OUTCOMES` is examined rather than forgotten.
  assert.deepEqual(
    (Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[])
      .filter((outcome) => FACT_TURN_CONSEQUENCE[`settled:${outcome}`] === undefined)
      .map((outcome) => `settled:${outcome}`),
    [],
    "every settlement outcome the pump declares is in the classification",
  );
  assert.equal(
    factTurnConsequence(nodeSucceeded("60,10", 60)),
    "in_flight_progress",
    "and the fact the measured run opened fifty-seven turns with is the one the table calls a step",
  );
  assert.equal(
    factTurnConsequence(programSettled()),
    "progress",
    "a programme that did every node is work restated: round59's 72 settlements each bought one utterance",
  );
  assert.equal(
    factTurnConsequence(settledFactOf("refused")),
    "decision",
    "while a settlement with a refusal in it is the one thing she has to find out",
  );
  assert.equal(factTurnConsequence(nodeRejected("60,10", 60)), "decision", "and so does every refusal receipt");
});

test("the classification table, printed with its population", () => {
  // The table itself, as the reading a commit message and a run audit quote. Names and counts only: a shape the pump
  // classifies is one a rerun's account can attribute a turn to.
  const rows = Object.entries(FACT_TURN_CONSEQUENCE).sort(([left], [right]) => left.localeCompare(right));
  const shapeStartsWithSettled = ([shape]: readonly [string, string]): boolean => shape.startsWith("settled:");
  const byConsequence: Record<string, number> = {};
  for (const [, consequence] of rows) byConsequence[consequence] = (byConsequence[consequence] ?? 0) + 1;
  const family = (prefix: string): number => rows.filter(([shape]) => shape.startsWith(prefix)).length;
  console.log(
    `fact_turn_consequence: shapes ${String(rows.length)} · decision ${String(byConsequence.decision ?? 0)} · progress ${String(byConsequence.progress ?? 0)} · in_flight_progress ${String(byConsequence.in_flight_progress ?? 0)} · receipts ${String(family("receipt:"))} · semantic ${String(family("semantic:"))} · settled ${String(family("settled:"))}`,
  );
  console.log(rows.map(([shape, consequence]) => `${shape}=${consequence}`).join(" · "));

  assert.ok(rows.length > 0, "an empty table prints nothing and proves nothing");
  assert.equal(
    rows.length,
    shapePopulation().length,
    "the table and the population the gate drives are the same set: a shape the ingress delivers and the table has no row for would take the silent `decision` default",
  );
  assert.deepEqual(
    rows.filter((row) => row[1] === "progress" && shapeStartsWithSettled(row)).map(([shape]) => shape),
    (Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[])
      .filter((outcome) => SETTLED_PROGRAM_OUTCOMES[outcome].consequence === "progress")
      .map((outcome) => `settled:${outcome}`),
    "the settlement rows the table calls progress are exactly the outcomes that DECLARE it, so a second spelling cannot drift",
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The lifetime: a programme is not forgotten the instant its status turns terminal.
// ---------------------------------------------------------------------------------------------------------------

/**
 * `receipt_for_a_forgotten_program:<program>:<receiptKind>` - a receipt belonging to a programme a PRIOR status update
 * removed still opened a turn.
 *
 * <p>
 * THE RACE, MEASURED 2026-11-15 (`round62`): `program_settlement` was suppressed 168 times as `progress` and
 * `adapter_ingress` still opened 71 turns. The ledger deleted a programme at the same instant its status turned terminal
 * (`program-status-wait.ts`, `observe`), so the LAST node's receipt - which arrives one microsecond after that read and
 * before the settlement that states it - found no programme to belong to, fell through to `decision`, and bought a turn
 * for a step whose own settlement was already queued behind it.
 * </p>
 * <p>
 * WHY A UNIT GATE AND NOT THE ROUND62 COUNT. The pump cannot attribute a receipt to a programme: `execution_receipt`
 * carries an `executionId`, not a `nodeId` (the same reason `#programmeNamed` exists), so the 71 cannot be re-derived
 * from a run's log by joining on a name. What CAN be replayed exactly is the ordering, and the population it runs over is
 * every fact shape this pump classifies as `in_flight_progress` - the shapes the lifetime governs, derived from
 * `FACT_TURN_CONSEQUENCE` rather than listed. At run scale the same population produced the 71; here it produces one
 * violation per shape, and the token names the programme and the shape so a rerun's account can be joined to it.
 * </p>
 */
const RECEIPT_FOR_A_FORGOTTEN_PROGRAM = "receipt_for_a_forgotten_program";

/** One `program_status` payload as the settlement watch and every status call read it: the journal's own rows. */
function journalStatus(
  programId: string,
  state: string,
  nodes: readonly Readonly<{ nodeId: string; actionId: string; state: string }>[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: "found",
    snapshot: Object.freeze({
      programId,
      state,
      catalogRevision: 3,
      stopEpoch: 0,
      eventHighWater: 90,
      nodes: Object.freeze(
        nodes.map((node) =>
          Object.freeze({
            nodeId: node.nodeId,
            state: node.state,
            nodeAttempt: 0,
            admissionAttempt: 0,
            actionId: node.actionId,
          }),
        ),
      ),
    }),
  });
}

/** What one replayed ordering did with one shape. */
type BoundaryReading = Readonly<{
  shape: string;
  program: string;
  /** Turns the tail receipt opened after the read that saw the programme stop. Must be `0`. */
  openedByTailReceipt: number;
  /** What that flush was decided as. Must be `in_flight_progress`: it is the programme's own last step. */
  tailReason: string | undefined;
  /** Turns the flush holding the programme's own settlement opened, in the window the receipt waits in. `0`. */
  settlementOpened: number;
  /** What a flush holding ONLY that settlement is decided as, off the same ledger. Must be `progress`. */
  settlementReason: string | undefined;
  /** Turns a receipt for an id NO ledger read ever named opened. Must NOT be `0`: that is a genuine lone outcome. */
  loneOutcomeOpened: number;
}>;

/**
 * Replay the ordering for one shape: `active` read -> the read that sees it stop -> tail receipt -> settlement.
 *
 * The pump is handed the REAL ledger (`createProgramProgressObserver`), not a literal reading: the defect is in the
 * lifetime, so a fixture that stated the reading itself could not reproduce it.
 */
async function readBoundaryOrdering({ shape, fact }: ShapeCase): Promise<BoundaryReading> {
  const program = `plan_forgotten_${shape.replace(/:/gu, "_")}`;
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus(program, "active", [
      { nodeId: "n001", actionId: "harvest_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "harvest_crop", state: "running" },
    ]),
    1_000,
  );
  // The read that sees the last node finish: the programme is no longer `active`, and the settlement watch is about to
  // state it. This is the read the ledger used to answer by forgetting everything it knew.
  observer.observe(
    journalStatus(program, "succeeded", [
      { nodeId: "n001", actionId: "harvest_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "harvest_crop", state: "succeeded" },
    ]),
    2_000,
  );
  const settlement = settledFact(
    [
      { nodeId: "n001", state: "succeeded" },
      { nodeId: "n002", state: "succeeded" },
    ],
    program,
  );

  const pump = new CompanionEventPump(() => observer.inFlight(2_000));
  const turns = recorder();
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  const openedByTailReceipt = pump.turnAccount.opened;
  const tail = pump.turnAccount.lastDecision;
  const tailReason = tail?.kind === "suppressed" ? tail.reason : undefined;

  // The settlement that states the programme arrives behind that receipt, into the same window.
  pump.enqueueFact(settlement, FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);
  const settlementOpened = pump.turnAccount.opened - openedByTailReceipt;

  // ... and on its own, off the SAME ledger: what a flush carrying only a stopped programme's outcome is decided as. The
  // waiting receipt would otherwise be the answer, because a step outranks an outcome in `#suppressionReason`.
  const settledAlone = new CompanionEventPump(() => observer.inFlight(2_000));
  settledAlone.enqueueFact(settlement, FACT_PRODUCER.programSettlement);
  await settledAlone.flush(recorder().sink);
  const alone = settledAlone.turnAccount.lastDecision;
  const settlementReason = alone?.kind === "suppressed" ? alone.reason : undefined;

  // THE INVERSE, IN THE SAME DRIVE: an id no ledger read ever named. Nothing was forgotten, so nothing may be silenced.
  const lone = new CompanionEventPump(() => createProgramProgressObserver().inFlight(2_000));
  lone.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  await lone.flush(recorder().sink);

  return Object.freeze({
    shape,
    program,
    openedByTailReceipt,
    tailReason,
    settlementOpened,
    settlementReason,
    loneOutcomeOpened: lone.turnAccount.opened,
  });
}

/** The population: every shape this pump classifies as a step of a programme, derived from the classification. */
function inFlightProgressShapes(): readonly ShapeCase[] {
  return shapePopulation().filter(({ shape }) => FACT_TURN_CONSEQUENCE[shape] === "in_flight_progress");
}

async function readEveryBoundaryOrdering(): Promise<readonly BoundaryReading[]> {
  const readings: BoundaryReading[] = [];
  for (const shapeCase of inFlightProgressShapes()) readings.push(await readBoundaryOrdering(shapeCase));
  return readings;
}

/**
 * The verdict over the replayed orderings, with zero population BLOCKED rather than green.
 *
 * Three defects, three directions: a forgotten programme's receipt opening a turn (the race), the settlement that states
 * it no longer suppressed as `progress` (the same flush counted differently), and a lone outcome silenced (what an
 * over-broad lifetime costs - a fact nothing else will ever state).
 */
function receiptForAForgottenProgramGate(readings: readonly BoundaryReading[]): Readonly<{
  examined: number;
  opened: number;
  violations: readonly string[];
  blocked: string | null;
}> {
  if (readings.length === 0)
    return Object.freeze({
      examined: 0,
      opened: 0,
      violations: Object.freeze([]),
      blocked: "zero_population:no_in_flight_progress_shape_was_examined",
    });
  const violations: string[] = [];
  let opened = 0;
  for (const reading of readings) {
    if (reading.openedByTailReceipt > 0) {
      opened += reading.openedByTailReceipt;
      violations.push(`${RECEIPT_FOR_A_FORGOTTEN_PROGRAM}:${reading.program}:${reading.shape}`);
    }
    if (reading.tailReason !== TURN_SUPPRESSION.inFlightProgress)
      violations.push(`forgotten_tail_not_a_step:${reading.program}:${reading.shape}:${String(reading.tailReason)}`);
    if (reading.settlementOpened > 0) {
      opened += reading.settlementOpened;
      violations.push(`${RECEIPT_FOR_A_FORGOTTEN_PROGRAM}:${reading.program}:settled:succeeded`);
    }
    if (reading.settlementReason !== TURN_SUPPRESSION.progress)
      violations.push(
        `settlement_not_progress_for_a_forgotten_program:${reading.program}:${reading.shape}:${String(reading.settlementReason)}`,
      );
    if (reading.loneOutcomeOpened === 0)
      violations.push(`lone_outcome_swallowed:${FACT_PRODUCER.adapterIngress}:${reading.shape}`);
  }
  return Object.freeze({ examined: readings.length, opened, violations: Object.freeze(violations), blocked: null });
}

test("receipt_for_a_forgotten_program: the tail receipt of a stopped programme opens no turn, and its settlement stays progress", async () => {
  const gate = receiptForAForgottenProgramGate(await readEveryBoundaryOrdering());

  assert.equal(gate.blocked, null, `the gate measured nothing: ${String(gate.blocked)}`);
  assert.ok(gate.examined > 0, "zero population is blocked, never green");
  // Printed for the same reason the shape gate prints its own population: "0 violations" over an unstated population
  // agrees with itself.
  console.log(
    `receipt_for_a_forgotten_program: turns examined ${String(gate.examined)} · opened by a forgotten programme's receipt ${String(gate.opened)}`,
  );
  assert.deepEqual(
    gate.violations,
    [],
    "a receipt that arrives after the read which saw its programme stop is that programme's own last step, not a lone outcome",
  );
});

test("receipt_for_a_forgotten_program: the gate is red on the ordering round62 measured, and names the programme and the shape", () => {
  // THE FALSIFIER. The same gate over the reading the tree produced before the lifetime was fixed: the read that saw the
  // programme stop removed it, so the tail receipt opened a turn.
  const recorded = receiptForAForgottenProgramGate([
    {
      shape: "receipt:succeeded",
      program: "plan_273",
      openedByTailReceipt: 1,
      tailReason: TURN_OPENING.worldFact,
      settlementOpened: 0,
      settlementReason: TURN_SUPPRESSION.progress,
      loneOutcomeOpened: 1,
    },
  ]);

  assert.deepEqual(
    recorded.violations,
    [
      `${RECEIPT_FOR_A_FORGOTTEN_PROGRAM}:plan_273:receipt:succeeded`,
      `forgotten_tail_not_a_step:plan_273:receipt:succeeded:${TURN_OPENING.worldFact}`,
    ],
    "the violation must name the programme and the receipt kind, or the next reader is told 'expected 0, got 1'",
  );
  assert.equal(recorded.opened, 1, "and the headline number is the turns it opened, not the shapes it examined");
});

test("receipt_for_a_forgotten_program: an over-broad lifetime that silences a lone outcome is red too", () => {
  // The other direction, which "fewer turns" alone can never detect: a receipt no plan ever owned is the only fact that
  // will ever say the action happened.
  const swallowed = receiptForAForgottenProgramGate([
    {
      shape: "receipt:succeeded",
      program: "plan_gone",
      openedByTailReceipt: 0,
      tailReason: TURN_SUPPRESSION.inFlightProgress,
      settlementOpened: 0,
      settlementReason: TURN_SUPPRESSION.progress,
      loneOutcomeOpened: 0,
    },
  ]);
  assert.deepEqual(swallowed.violations, ["lone_outcome_swallowed:adapter_ingress:receipt:succeeded"]);

  const miscounted = receiptForAForgottenProgramGate([
    {
      shape: "receipt:succeeded",
      program: "plan_gone",
      openedByTailReceipt: 0,
      tailReason: TURN_SUPPRESSION.inFlightProgress,
      settlementOpened: 1,
      settlementReason: TURN_SUPPRESSION.observationRestated,
      loneOutcomeOpened: 1,
    },
  ]);
  assert.deepEqual(
    miscounted.violations,
    [
      `${RECEIPT_FOR_A_FORGOTTEN_PROGRAM}:plan_gone:settled:succeeded`,
      "settlement_not_progress_for_a_forgotten_program:plan_gone:receipt:succeeded:observation_restated",
    ],
    "the settlement that states a stopped programme is progress, and a count of the turn it did not open says so",
  );
});

test("receipt_for_a_forgotten_program: zero population is blocked, never green", () => {
  const empty = receiptForAForgottenProgramGate([]);
  assert.equal(empty.blocked, "zero_population:no_in_flight_progress_shape_was_examined");
  assert.deepEqual(empty.violations, []);
  assert.equal(empty.examined, 0);
});

test("receipt_for_a_forgotten_program: the population is the classification's own in_flight_progress rows", () => {
  const population = inFlightProgressShapes();
  assert.ok(population.length > 0, "an empty population proves nothing");
  assert.deepEqual(
    population.filter(({ shape }) => FACT_TURN_CONSEQUENCE[shape] !== "in_flight_progress").map(({ shape }) => shape),
    [],
    "every examined shape is one the classification calls a step",
  );
  assert.deepEqual(
    Object.entries(FACT_TURN_CONSEQUENCE)
      .filter(([, consequence]) => consequence === "in_flight_progress")
      .map(([shape]) => shape)
      .filter((shape) => !population.some((entry) => entry.shape === shape)),
    [],
    "and every row the classification calls a step is examined here, so a shape added to it cannot go unreplayed",
  );
});
