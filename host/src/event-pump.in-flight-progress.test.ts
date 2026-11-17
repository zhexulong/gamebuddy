import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factTurnConsequence,
  HELD_RECEIPT_PROGRESS_STATES,
  HELD_SEMANTIC_PROGRESS_KINDS,
  HOST_MINTED_WAKE_KINDS,
  IN_FLIGHT_RECEIPT_PROGRESS_STATES,
  type PendingBatch,
  SETTLED_PROGRAM_OUTCOMES,
  type SettledProgramOutcome,
  TURN_SUPPRESSION,
  type WorldFact,
} from "./event-pump.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND, programSettledDigest } from "./program-settlement-digest.js";
import { type InFlightProgrammeReading, type PlanAnswerNode } from "./program-status-wait.js";
import { EXECUTION_STATES } from "./protocol.js";

/**
 * ONE CALL, ONE ANSWER - and the two halves of that sentence, because they are different questions.
 *
 * <p>
 * THE ANSWER: a settlement is the programme's one answer, so it opens exactly one turn and that turn carries the verdict
 * (`ok`, `reason`) and its bounded evidence. THE STEP: a state the programme is still working through is progress - it
 * opens no turn, and the settlement carries it.
 * </p>
 * <p>
 * NEITHER HALF IS `round57`'s SHAPE. That run opened 57 of 66 turns on one adapter fact because every finished NODE was
 * silent-then-counted against a liveness question, and every settlement bought one more utterance on top: `turns opened
 * 66 {player_input: 4, world_fact: 62 {adapter_ingress: 57, …}}` for one three-cauliflower harvest. What produced those
 * turns was the body traces and the per-node receipts as separate facts; `04598eda` removed the traces, `round64`
 * measures about 16 receipts and 22 settlements in a run, and this file pins the classification that follows from it.
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

/**
 * One node of the plan finishing: the receipt that opened `#69`, `#71` and `#73` of the transcript.
 *
 * THE PROVENANCE IS THE MOD'S STATEMENT, not this fixture's opinion: the journal binds `exec_harvest_60,10` to
 * `plan_harvest_cauli`/`n002` at the admission boundary
 * (`integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs#NodeExecutionBinding`), and the wire carries that.
 * A fixture that left it out would be a receipt the Host has to guess about - which is the defect, not the test.
 */
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
      origin: { kind: "programme", programId: "plan_harvest_cauli", nodeId: "n002" },
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
      origin: { kind: "programme", programId: "plan_harvest_cauli", nodeId: "n002" },
    },
  };
}

/** The same terminal receipt for an execution NO programme owns: a lone action, stated as such. */
function loneSucceeded(tile: string, revision: number): WorldFact {
  return {
    ...nodeSucceeded(tile, revision),
    payload: { ...nodeSucceeded(tile, revision).payload, origin: { kind: "standalone" } },
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

/**
 * THE RULING THIS FILE PINS, and the two falsifiers it is written for.
 *
 * A settlement is the ONE answer a programme gives - one call, one answer, and the answer has to be READABLE when it
 * arrives (`design/fact-authority.md` §1c) - so it opens exactly one turn, and that turn carries the verdict (`ok`,
 * `reason`) and its bounded evidence. A step the programme is still working through is PROGRESS: it opens none, and the
 * settlement that closes the programme carries it.
 *
 * WHAT CHANGED FROM THE OLD SHAPE, and why it is not a return to `round57`: that run opened 57 of 66 turns on one adapter
 * fact because every finished NODE opened a turn of its own while its programme ran, and the settlement then opened one
 * more. `04598eda` removed the body traces (per-tile advance, execution start, settled restatements), and `round64`
 * measures what is left: about 16 real receipts and 22 settlements in a run - a settlement per plan, not a turn per node.
 */
test("a settlement is the programme's ONE answer: exactly one turn, carrying its verdict and its bounded evidence", async () => {
  // FALSIFIER 1a, derived over every outcome the pump declares so an outcome added to SETTLED_PROGRAM_OUTCOMES is
  // examined rather than remembered.
  const outcomes = Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[];
  assert.ok(outcomes.length > 0, "an empty population proves nothing");
  for (const outcome of outcomes) {
    const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
    const turns = recorder();

    pump.enqueueFact(settledFactOf(outcome), FACT_PRODUCER.programSettlement);
    await pump.flush(turns.sink);

    assert.equal(
      pump.turnAccount.opened,
      1,
      `a settlement (${outcome}) is the answer to one call, and an answer nobody is handed is a description`,
    );
    assert.equal(turns.batches.length, 1, `and ONE settlement is exactly one turn (${outcome}), never two`);
    const batch = turns.batches[0]!;
    const delivered = batch.facts.find((fact) => fact.semanticKind === PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND);
    assert.ok(delivered !== undefined, `the turn carries the settlement itself, not a reference to it (${outcome})`);
    assert.equal(typeof delivered.payload.ok, "boolean", `and its verdict, \`ok\` (${outcome})`);
    assert.equal(
      delivered.payload.reason === null || typeof delivered.payload.reason === "string",
      true,
      `and \`reason\`, which is null exactly when the plan did what it was told (${outcome})`,
    );
    assert.equal(typeof delivered.payload.total, "number", "with the population its evidence is counted over");
    assert.equal(delivered.payload.omitted, 0, "and the bound's own count beside the rows it did not carry");
    assert.match(batch.text, /<execution-result>\n/u, `which is what she reads (${outcome})`);

    // One call, one answer: the same settlement is never a second turn.
    await pump.flush(turns.sink);
    assert.equal(pump.turnAccount.opened, 1, `the same settlement never buys a second turn (${outcome})`);
  }
});

test("a step the programme is still working through is PROGRESS: it opens no turn, and the settlement carries it", async () => {
  // FALSIFIER 1b. The population is the pump's own held set, so a state added there is examined here rather than
  // forgotten - and this is the half the old suppressor got wrong: these states are standing state, not suppressed facts.
  const states = Object.keys(HELD_RECEIPT_PROGRESS_STATES);
  assert.ok(states.length > 0, "an empty population agrees with itself");
  for (const state of states) {
    const pump = new CompanionEventPump(() => harvestPlan(1));
    const turns = recorder();

    pump.enqueueFact(receiptOf(state), FACT_PRODUCER.adapterIngress);
    await pump.flush(turns.sink);

    assert.equal(
      pump.turnAccount.opened,
      0,
      `a programme still working through ${state} states standing state inside work already answered: it is not news`,
    );
    assert.equal(turns.batches.length, 0, `and no turn means no delivery (${state})`);
    assert.equal(
      pump.turnAccount.lastDecision?.kind,
      "suppressed",
      `the flush is still decided and named, got ${JSON.stringify(pump.turnAccount.lastDecision)}`,
    );
    assert.equal(
      pump.turnAccount.suppressed[TURN_SUPPRESSION.progress],
      1,
      `and COUNTED as progress - not as in_flight_progress, which no shape is filed as any more (${state})`,
    );
  }
});

test("a finished node is an outcome: it opens the turn that states it", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(2));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    1,
    "a node that ran is a change of the world, and its receipt is the fact that states it - the settlement restates it once more, as the programme's answer",
  );
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u, "in the Mod's own words");
});

test("two answers, two turns: a step's receipt and the programme's settlement are each stated once", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(0));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  pump.enqueueFact(settledFact([{ nodeId: "n001", state: "succeeded" }]), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    2,
    "the step's receipt and the programme's settlement are each the answer to one call, so neither is silent",
  );
  assert.equal(turns.batches.length, 2, "and one flush is one turn: each fact is the opener of its own");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u, "the receipt arrives in its own turn");
  assert.match(
    turns.batches[1]!.text,
    /1\/1 步做成了/u,
    "and the settlement in the next, with the counts it was read from",
  );
});

test("a refusal inside a running programme is an outcome like any other", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(2));
  const turns = recorder();

  pump.enqueueFact(nodeRejected("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a rejected node is the one thing mid-plan she can act on");
  assert.match(turns.batches[0]!.text, /harvest_crop 没做成：tool_not_held/u);
});

test("a programme still running is stated in the turn its finished step opens", async () => {
  const pump = new CompanionEventPump(() => harvestPlan(1));
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(nodeSucceeded("60,11", 61), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  const batch = turns.batches[0]!;
  assert.match(batch.text, /<in-flight>\n/u, "the programme in flight reaches the turn that follows it");
  assert.match(batch.text, /in_flight:settled=2;total=3;remaining=1/u);
  assert.equal(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").length,
    2,
    "and so do both finished nodes: one turn, both answers",
  );
});

test("the filing is a function of the FACT: the ledger changes neither the turn nor the account", async () => {
  // The property the provenance gate exists for, stated once for this pump: the same receipt is filed the same way
  // whatever the journal says is running. Now that no shape asks the ledger, both readings agree by construction - and the
  // fact's own statement of its programme is still counted, which is what the account is for.
  for (const ledger of [NOTHING_IN_FLIGHT, harvestPlan(1), harvestPlan(0)]) {
    const pump = new CompanionEventPump(() => ledger);
    pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
    await pump.flush(recorder().sink);
    assert.equal(pump.turnAccount.opened, 1, "one finished node, one turn, whatever the ledger says");
    assert.equal(pump.turnAccount.executionProvenance.facts.programme, 1, "and its own programme is still counted");
  }
});

test("a lone action's success is news: no programme owns it, so its own receipt is the only fact that states it", async () => {
  const pump = new CompanionEventPump(() => NOTHING_IN_FLIGHT);
  const turns = recorder();

  pump.enqueueFact(loneSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a single action that finished is the only fact that will ever say so");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u);
  assert.equal(pump.turnAccount.executionProvenance.facts.standalone, 1, "and the account counted it as what it is");
});

// ---------------------------------------------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------------------------------------------

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
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: `reason_${state}`,
      revision: 1,
      origin: { kind: "programme", programId: "plan_harvest_cauli", nodeId: "n002" },
    },
  };
}

function semanticEventOf(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: `transport_${kind}`,
    executionId: "exec_one",
    revision: 1,
    payload: {
      kind,
      revision: 1,
      reasonCode: "body_trace",
      activeExecution: null,
      bodyTrace: {
        category: kind,
        executionId: "exec_one",
        requestId: "request_one",
        tick: 12,
        revision: 1,
        origin: { kind: "programme", programId: "plan_harvest_cauli", nodeId: "n002" },
      },
    },
  };
}

/**
 * The semantic kinds this pump declares - a kind added to ANY of the two tables must be classified here.
 *
 * THE BOUNDARY IS WHAT THIS GATE READS, and it is worth naming: the Mod's semantic vocabulary is open, so a kind no Host
 * table mentions reaches the pump as an unclassified shape and takes the `decision` default (one extra turn, never a
 * lost fact). What is closed here is the pump's own vocabulary: the protocol's `EXECUTION_STATES` and the two kind
 * tables. `event-pump-wake-classification.test.ts` reports the wider spelled-kind population from source without
 * asserting over it, for exactly this reason.
 */
function semanticKindPopulation(): readonly string[] {
  return [...new Set([...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS), ...Object.keys(HOST_MINTED_WAKE_KINDS)])].sort();
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
    "decision",
    "a finished node is an outcome: nothing in the table asks which programme is running, so it opens the turn that states it",
  );
  assert.equal(
    factTurnConsequence(programSettled()),
    "decision",
    "and a programme that did every node is the programme's ONE answer: the turn it opens carries the verdict and its evidence",
  );
  assert.equal(
    factTurnConsequence(settledFactOf("refused")),
    "decision",
    "a settlement that refused a node is the same answer with a different reason, so the same shape",
  );
  assert.equal(factTurnConsequence(nodeRejected("60,10", 60)), "decision", "and so is every refusal receipt");
  // THE SUPPRESSOR IS EMPTY, and that is the ruling rather than a gap: nothing is discarded because a programme is in
  // flight. `tools/check-fact-authority.mjs` reads this table by name, so the place a future author would write such a
  // suppressor into is still read - and it fails the gate by name the moment a Mod fact kind appears in it.
  assert.deepEqual(
    Object.keys(IN_FLIGHT_RECEIPT_PROGRESS_STATES),
    [],
    "no receipt state is suppressed by a programme being in flight: the answer opens its turn, and the steps are progress",
  );
});

test("the classification table, printed with its population", () => {
  // The table itself, as the reading a commit message and a run audit quote. Names and counts only: a shape the pump
  // classifies is one a rerun's account can attribute a turn to.
  const rows = Object.entries(FACT_TURN_CONSEQUENCE).sort(([left], [right]) => left.localeCompare(right));
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
    rows
      .filter((row) => row[0].startsWith("settled:"))
      .map(([shape, consequence]) => `${shape}=${consequence}`)
      .sort(),
    (Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[])
      .map((outcome) => `settled:${outcome}=decision`)
      .sort(),
    "every settlement outcome is a DECISION: one answer per call, and the turn that carries it is not optional - so an outcome added to SETTLED_PROGRAM_OUTCOMES is examined here rather than remembered",
  );
});

// ---------------------------------------------------------------------------------------------------------------
