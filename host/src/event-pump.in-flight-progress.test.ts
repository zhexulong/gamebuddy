import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factTurnConsequence,
  HELD_RECEIPT_PROGRESS_STATES,
  HELD_SEMANTIC_PROGRESS_KINDS,
  PUMP_MINTED_WAKE_KINDS,
  IN_FLIGHT_RECEIPT_PROGRESS_STATES,
  type PendingBatch,
  SETTLED_PROGRAM_OUTCOMES,
  type SettledProgramOutcome,
  NOT_OWED,
  type WorldFact,
} from "./event-pump.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND, programSettledDigest } from "./program-settlement-digest.js";
import type { PlanAnswerNode } from "./program-status-wait.js";
import { EXECUTION_STATES } from "./protocol.js";

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
 * more. `04598eda` removed the body traces (per-tile advance, execution start, settled restatements), the pump lane removed
 * the `<in-flight>` block and the ledger port, and this lane emptied `IN_FLIGHT_RECEIPT_PROGRESS_STATES`: no shape is
 * suppressed because a programme is in flight, because "a programme is in flight" is a judgement about TURNS and never a
 * suppressor of a fact. `round64` measures what is left: about 16 real receipts and 22 settlements in a run - a settlement
 * per plan, not a turn per node.
 */
test("a settlement is the programme's ONE answer: exactly one turn, carrying its verdict and its bounded evidence", async () => {
  // FALSIFIER 1a, derived over every outcome the pump declares so an outcome added to SETTLED_PROGRAM_OUTCOMES is
  // examined rather than remembered.
  const outcomes = Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[];
  assert.ok(outcomes.length > 0, "an empty population proves nothing");
  for (const outcome of outcomes) {
    const pump = new CompanionEventPump();
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
    const pump = new CompanionEventPump();
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
      "not_owed",
      `the flush is still decided and named, got ${JSON.stringify(pump.turnAccount.lastDecision)}`,
    );
    assert.equal(
      pump.turnAccount.notOwed[NOT_OWED.progress],
      1,
      `and COUNTED as progress - not as in_flight_progress, which no shape is filed as any more (${state})`,
    );
    assert.equal(
      pump.turnAccount.notOwed[NOT_OWED.inFlightProgress],
      0,
      `nothing is suppressed because a programme is in flight (${state})`,
    );
  }
});

test("a finished node is an outcome: it is carried into the turn that can state it", async () => {
  // THE DEFECT THIS CLOSES, and it is the opposite direction to `round57`. Fifty-seven of that run's sixty-six turns were
  // one adapter fact opening a turn per finished NODE; the suppressor that answered them said "a programme is in flight",
  // which is a judgement about the TURN, not a statement about the fact - so it also silenced facts nothing else would
  // ever state. A node that ran is a change of the world: its receipt is the one fact that says so. What it is NOT is a
  // turn: `protocol/bridge-v1.schema.json#receipt` carries no event identity, so a turn opened on it attaches no projection
  // and its words are never presented (`round66`: `lost 12 {no_presentation_lease}`). It waits in its window and the next
  // turn the surface can show states it.
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  const refused = await pump.flush(turns.sink);
  assert.equal(refused.kind, "not_owed", `a terminal receipt cannot present, so it opens no turn (${refused.kind})`);
  assert.equal(pump.turnAccount.opened, 0, "no turn is invited where nothing can be shown");
  assert.equal(
    pump.turnAccount.notOwed[NOT_OWED.inFlightProgress],
    0,
    "and nothing was suppressed as a step of a programme: no shape is filed as `in_flight_progress`",
  );
  assert.equal(
    pump.turnAccount.executionProvenance.facts.programme,
    1,
    "while the fact's own statement of its programme is still counted - that is what the account is for",
  );

  pump.enqueueFact(milestoneFact(), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.opened, 1, "and the next fact the surface can show opens the turn that states it");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u, "in the Mod's own words: the node is not silent");
});

test("one answer: the settlement's turn states the step that led to it", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  pump.enqueueFact(settledFact([{ nodeId: "n001", state: "succeeded" }]), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    1,
    "the programme's settlement is the DECISION, and the node's receipt rides it: one call, one answer",
  );
  assert.equal(turns.batches.length, 1, "and one flush is one turn");
  assert.match(turns.batches[0]!.text, /1\/1 步做成了/u, "the settlement's counts are stated");
  assert.match(
    turns.batches[0]!.text,
    /harvest_crop 做成了/u,
    "and the node's own receipt arrives in the same turn, so neither answer is silent",
  );
});

test("a settlement that REFUSED a node still opens the turn: a refusal is a decision, and this change must not silence it", async () => {
  // THE FALSIFIER THAT MATTERS. If this direction is not proven, the change does not remove narration - it removes bad
  // news. A refused node is the one thing inside a plan she can act on, so the settlement states it and opens.
  const pump = new CompanionEventPump();
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
  // THE SENTENCE IS WORDS AND THE CODE IS AN ADDRESS. `a-line-the-model-reads-is-not-a-machine-token.test.ts` is the
  // invariant on the other side of this pair (`reason_codes_no_longer_reach_her_as_tokens, and stay addressable in the
  // delivery`): no refusal code may stay in the prose she reads, and every one of them must still be on the address line,
  // because that is the id the next argument copies. An inline code is the `round78` defect this pair exists to keep out.
  assert.match(batch.text, /move_to_tile 没做成/u, "and the refusal is stated in words");
  assert.match(
    batch.text,
    /可指代的字段：move_to_tile reasonCode=tool_not_held/u,
    "with the Mod's own code addressable in the same block, beside the sentence and never inside it",
  );
});

test("a settlement that only PARTIALLY did a node opens the turn too", async () => {
  // `partially_succeeded` is the polite lie the state exists to refuse (`settledSummary`): it did part of its work, so it
  // is not success - and now it is not progress either: BOTH outcomes are `decision`, and the answer carries which it is.
  const pump = new CompanionEventPump();
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
  assert.match(turns.batches[0]!.text, /move_to_tile 没做成/u, "the partial node is a sentence too");
  assert.match(turns.batches[0]!.text, /可指代的字段：move_to_tile reasonCode=partially_watered/u);
});

test("a plan still running carries its finished steps, and no in-flight block is written", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(nodeSucceeded("60,11", 61), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  // Both nodes are waiting: two finished steps in one window are not two turns, and they are not a turn of their own either.
  pump.enqueueFact(milestoneFact(), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "two finished nodes in one window are one turn, not two");
  const batch = turns.batches[0]!;
  // THE BLOCK IS GONE. A plan in flight is not narrated: its settlement states the nodes, with their bounded evidence,
  // and a turn that opened for another reason carries no progress line (measured `round64`: 8 turns for 401 facts).
  assert.equal(batch.text.includes("<in-flight>"), false, `no in-flight block exists any more: ${batch.text}`);
  assert.equal(batch.text.includes("in_flight:"), false, `and no row-per-node line either: ${batch.text}`);
  assert.equal(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").length,
    2,
    "and so do both finished nodes: one turn, both answers",
  );
  assert.match(batch.text, /harvest_crop 做成了/u, "stated in the Mod's own words");
});

test("a lone action's success is news, and it reaches her in the next turn that can be shown", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(loneSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  const refused = await pump.flush(turns.sink);
  assert.equal(refused.kind, "not_owed", `a lone receipt has no surface either (${refused.kind})`);
  assert.equal(
    pump.turnAccount.executionProvenance.facts.standalone,
    1,
    "and the account counted it as what it is: an execution no programme owns",
  );
  pump.enqueueFact(milestoneFact(), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.opened, 1, "the next presentable fact states it, so nothing is lost");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u);
});

test("a refusal inside a running programme is a decision, not progress - and it is carried, not dropped", async () => {
  assert.equal(
    factTurnConsequence(nodeRejected("60,10", 60)),
    "decision",
    "a rejected node is the one thing mid-plan she can act on, so its shape is a decision",
  );
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeRejected("60,10", 60), FACT_PRODUCER.adapterIngress);
  const refused = await pump.flush(turns.sink);
  assert.equal(refused.kind, "not_owed");
  assert.equal(
    pump.turnAccount.notOwed[NOT_OWED.progress],
    0,
    "filed as the surface's refusal, never as progress: the classification says decision and the reason must agree",
  );
  pump.enqueueFact(milestoneFact(), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.match(turns.batches[0]!.text, /harvest_crop 没做成/u, "and the refusal is stated to her");
  assert.match(
    turns.batches[0]!.text,
    /可指代的字段：harvest_crop reasonCode=tool_not_held/u,
    "while the code the next step copies stays on the block's address line",
  );
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
 * The semantic kinds this pump declares - a kind added to ANY of the three tables must be classified here.
 *
 * THE BOUNDARY IS WHAT THIS GATE READS, and it is worth naming: the Mod's semantic vocabulary is open, so a kind no Host
 * table mentions reaches the pump as an unclassified shape and takes the `decision` default (one extra turn, never a
 * lost fact). What is closed here is the pump's own vocabulary: the protocol's `EXECUTION_STATES` and the receipt and
 * kind tables beside it. `event-pump-wake-classification.test.ts` reports the wider spelled-kind population from source without
 * asserting over it, for exactly this reason.
 */
function semanticKindPopulation(): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS),
      // THE UNION THE CLASSIFICATION ITSELF READS, not the two tables it was built from when this file was written: a
      // third authority (the pump's own ledger, `PUMP_OWNED_WAKE_KINDS`) is a kind the ingress can deliver, so a list of
      // the tables beside it would examine one fewer shape than the table has rows.
      ...Object.keys(PUMP_MINTED_WAKE_KINDS),
    ]),
  ].sort();
}

/**
 * Every receipt state the pump declares a classification for, from the protocol's list and the two tables beside it.
 *
 * `IN_FLIGHT_RECEIPT_PROGRESS_STATES` is empty by ruling and is read here anyway: the table that would file a state as
 * `in_flight_progress` is the one a future author would write into, so its emptiness is examined rather than assumed.
 */
function receiptStatePopulation(): readonly string[] {
  return [
    ...new Set([
      ...EXECUTION_STATES,
      ...Object.keys(HELD_RECEIPT_PROGRESS_STATES),
      ...Object.keys(IN_FLIGHT_RECEIPT_PROGRESS_STATES),
    ]),
  ];
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
  for (const state of receiptStatePopulation()) cases.push({ shape: `receipt:${state}`, fact: receiptOf(state) });
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
    "a finished node is an outcome: its receipt is the one fact that says the node ran, so no liveness rule may file it as progress - it is carried into the next turn that can show it (`event-pump.turn-surface.test.ts`)",
  );
  assert.equal(
    factTurnConsequence(programSettled()),
    "decision",
    "and a programme that did every node is its ONE answer - an answer nobody is handed is a description",
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
    rows
      .filter((row) => shapeStartsWithSettled(row) && row[1] !== "decision")
      .map(([shape, consequence]) => `${shape}=${consequence}`),
    [],
    "no settlement outcome is progress or in flight: both are the answer to one call, so both are delivered",
  );
  assert.deepEqual(
    rows
      .filter((row) => shapeStartsWithSettled(row))
      .map(([shape]) => shape)
      .sort(),
    (Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[]).sort().map((outcome) => `settled:${outcome}`),
    "and every outcome the pump DECLARES is one of those rows, so a second spelling cannot drift",
  );
});

// ---------------------------------------------------------------------------------------------------------------
