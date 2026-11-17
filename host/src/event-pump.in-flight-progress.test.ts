import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factTurnConsequence,
  HELD_SEMANTIC_PROGRESS_KINDS,
  HOST_MINTED_WAKE_KINDS,
  MOD_VERDICT_WAKE_KINDS,
  IN_FLIGHT_SEMANTIC_PROGRESS_KINDS,
  type PendingBatch,
  SETTLED_PROGRAM_OUTCOMES,
  type SettledProgramOutcome,
  NOT_OWED,
  type WorldFact,
} from "./event-pump.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import { type PlanAnswerNode } from "./program-status-wait.js";
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

test("a node's success inside a still-running programme does not open a turn", async () => {
  const pump = new CompanionEventPump();
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
    "not_owed",
    `the flush must still be decided and named, got ${JSON.stringify(pump.turnAccount.lastDecision)}`,
  );
  assert.equal(
    pump.turnAccount.notOwed[NOT_OWED.inFlightProgress],
    1,
    "and named as a step, so a rerun's account can count how many turns this rule removed",
  );
  assert.equal(
    pump.turnAccount.notOwedByProducer[NOT_OWED.inFlightProgress][FACT_PRODUCER.adapterIngress],
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
  const pump = new CompanionEventPump();
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
    pump.turnAccount.notOwed[NOT_OWED.progress],
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
  const pump = new CompanionEventPump();
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
  // THE RECEIPT IS NOT PUSHED INTO THE TEXT ANY MORE: it is a step of her own call, and the settlement states the outcome
  // in `<execution-result>` (`design/fact-authority.md` §1b). It is still DELIVERED in the batch's frame, so the change
  // moved WHERE it arrives, never whether.
  assert.equal(
    batch.text.includes("harvest_crop 做成了"),
    false,
    `a programme's step is not narrated: its settlement is the statement (${batch.text})`,
  );
  assert.match(batch.text, /<execution-result>\n/u, "beside the settlement that states it");
  assert.match(batch.text, /1\/1 步做成了/u);
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
  assert.match(batch.text, /move_to_tile 没做成（tool_not_held）/u, "and the refusal is named with the Mod's own code");
});

test("a settlement that only PARTIALLY did a node opens the turn too", async () => {
  // `partially_succeeded` is the polite lie the state exists to refuse (`settledSummary`): it did part of its work, so it
  // is not success, and a settlement carrying one is not progress.
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
  assert.match(turns.batches[0]!.text, /move_to_tile 没做成（partially_watered）/u);
});

test("the step that CLOSES a programme is progress: the boundary receipt does not open a turn", async () => {
  // THE OTHER HALF OF THE 79. `in_flight_progress` caught 290 receipts while the journal showed the plan running; the ones
  // that arrived after its last node went terminal did not match `remaining > 0`, so each opened a turn - and the plan was
  // still ACTIVE in the journal, which is why `harvestPlan(0)` (every node terminal, programme still named) is the reading
  // this test drives. Those are the boundary receipts of round59: 79 ingress-opened turns against 72 submissions.
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    0,
    "the last node of a plan still named by the journal is a step: the settlement is what states it",
  );
  assert.equal(
    pump.turnAccount.notOwed[NOT_OWED.inFlightProgress],
    1,
    "and it is COUNTED as that step, so a rerun can see how many boundary turns the rule removed",
  );
});

test("a plan still running when a turn opens for another reason states the programme AND its finished steps", async () => {
  const pump = new CompanionEventPump();
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
  // THE BLOCK IS GONE. A plan in flight is not narrated: its settlement states the nodes, with their bounded evidence,
  // and a turn that opened for another reason carries no progress line (measured `round64`: 8 turns for 401 facts).
  assert.equal(batch.text.includes("<in-flight>"), false, `no in-flight block exists any more: ${batch.text}`);
  assert.equal(batch.text.includes("in_flight:"), false, `and no row-per-node line either: ${batch.text}`);
  assert.equal(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").length,
    2,
    "and so do both finished nodes",
  );
});

test("a lone action's success is news: no programme owns it, so its own receipt is the only fact that states it", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(loneSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a single action that finished is the only fact that will ever say so");
  assert.match(turns.batches[0]!.text, /harvest_crop 做成了/u);
  assert.equal(pump.turnAccount.executionProvenance.facts.standalone, 1, "and the account counted it as what it is");
});

/**
 * THE SAME FACT, TWICE, WITH ONLY THE PROGRAMME IN FLIGHT CHANGED.
 *
 * This is the pair that the ten-second window could not answer and that no timer can: a standalone receipt is a lone
 * outcome whether or not another programme happens to be running. Both directions are asserted here because they fail
 * differently - silencing the first hides work nothing else will state, and opening the second restores the 82 turns.
 */
test("a standalone outcome speaks while ANOTHER programme is in flight, and a programme's own step stays silent", async () => {
  const lone = new CompanionEventPump();
  lone.enqueueFact(loneSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await lone.flush(recorder().sink);
  assert.equal(
    lone.turnAccount.opened,
    1,
    "a programme in flight is not this execution's programme: its receipt is the only statement of a lone outcome",
  );

  const step = new CompanionEventPump();
  step.enqueueFact(nodeSucceeded("60,10", 60), FACT_PRODUCER.adapterIngress);
  await step.flush(recorder().sink);
  assert.equal(
    step.turnAccount.opened,
    0,
    "and with NOTHING read, a programme's step is still a step: the receipt states its programme, the ledger is not asked",
  );
  assert.equal(step.turnAccount.notOwed[NOT_OWED.inFlightProgress], 1);
});

test("a refusal inside a running programme is a decision, not progress", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();

  pump.enqueueFact(nodeRejected("60,10", 60), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  assert.equal(pump.turnAccount.opened, 1, "a rejected node is the one thing mid-plan she can act on");
  assert.match(turns.batches[0]!.text, /harvest_crop 没做成：tool_not_held/u);
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
      ...Object.keys(MOD_VERDICT_WAKE_KINDS),
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
