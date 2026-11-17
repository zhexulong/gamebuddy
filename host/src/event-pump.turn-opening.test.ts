import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  ASSISTANT_TURNS_EXAMINED,
  ASSISTANT_TURNS_TOOL_ONLY,
  ASSISTANT_TURNS_WITH_TEXT,
  assistantTurnsToolOnly,
  assistantTurnsWithText,
  AUTO_OBSERVE_AGED_TURNS,
  AUTO_OBSERVE_ON_STALE,
  AUTO_OBSERVE_REARM,
  AUTO_OBSERVE_REARM_REASONS,
  AUTO_OBSERVE_REARMED,
  AUTO_OBSERVE_UNAVAILABLE,
  AUTO_OBSERVE_UNAVAILABLE_REASONS,
  AUTO_OBSERVE_UNAVAILABLE_TOKEN,
  BUBBLES_DELIVERED,
  CARRIED,
  CompanionEventPump,
  EXECUTION_STALL_SEMANTIC_KIND,
  emptyTurnShapes,
  FACT_PRODUCER,
  FACT_PRODUCERS,
  factContentIdentity,
  FLUSHES_EXAMINED,
  HOST_MINTED_FACT_SOURCE,
  LOST,
  MAX_DELIVERED_FACT_IDENTITIES,
  NOT_OWED_LABEL,
  type PendingBatch,
  PER_DELIVERED_BATCH,
  RECEIPTS_WITH_PROVENANCE,
  SILENT_SETTLED_OPENINGS,
  TRACES,
  TURN_OPENING,
  TURN_OPENINGS,
  TURN_PRODUCTION,
  TURN_PRODUCTIONS,
  TURN_SETTLED_SILENT,
  TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT,
  NOT_OWED,
  NOT_OWED_REASONS,
  TURN_WITHOUT_ACTION,
  TURN_WITHOUT_ACTION_REASON,
  type TurnAccount,
  type FactProducer,
  type TurnProduction,
  turnAccountLine,
  turnWithoutActionShape,
  turnWithoutActionToken,
  UNATTRIBUTED_EXECUTION_TOKEN,
  type WorldFact,
} from "./event-pump.js";
import { createProgramProgressObserver } from "./program-status-wait.js";

/**
 * A turn opens only when the batch carries at least one thing she did not have and that can change what she does next.
 *
 * <p>
 * THE WINDOW THIS REPLAYS IS A REAL ONE. `round46b` (`.live-runs/game-ladder/2026-11-11T07-25-21-883Z-multiday_routine`,
 * session `2026-11-11T07-25-22-940Z_01a1c97f`) contains two consecutive prompt turns, `07:28:19.998Z` and
 * `07:30:43.718Z`, whose batches are byte-identical in content: the same world reading (`revision 14`,
 * `本轮无新观察`, `这是 3 轮之前看到的`) and the same `<execution-result>` re-stating one `for_each` settlement
 * (`no_row_matched_where:occupant_eq_stone:none_object`, `decided=60`). The second turn existed because the settlement
 * was published again under a fresh event id; nothing in it could have changed what she did next, and the run paid a
 * provider turn and a bubble for it.
 * </p>
 * <p>
 * The facts below are that window in the pump's own vocabulary - one settlement digest, published twice. The artifact is
 * prose the brief rendered FROM these facts, so the fixture is the source and the artifact is the derivable copy.
 * </p>
 */
const RECORDED_SETTLEMENT = Object.freeze({
  programId: "plan_r46_weed_row",
  state: "failed",
  reasonCode: "no_row_matched_where:occupant_eq_stone:none_object",
  decided: 60,
  succeeded: 0,
  failed: 0,
  refused: 0,
  not_matched: 60,
});

const WINDOW_AT_MS = Date.UTC(2026, 10, 11, 7, 28, 19);
const REPLAY_END_AT_MS = WINDOW_AT_MS + 144_000;

function settlementFact(eventId: string, occurredAtMs: number): WorldFact {
  return {
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: RECORDED_SETTLEMENT.programId,
    observedTick: 60,
    revision: 14,
    occurredAtMs,
    semanticKind: "program_settled",
    payload: { ...RECORDED_SETTLEMENT },
  };
}

function readingFact(observedTick: number, revision = 14, payload?: Readonly<Record<string, unknown>>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: WINDOW_AT_MS,
    payload: payload ?? { location: "Farm", gameTime: "0740" },
  };
}

function milestoneFact(index: number, occurredAtMs: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `milestone_${String(index)}`,
    sourceEventId: `milestone_${String(index)}`,
    correlationId: `milestone_${String(index)}`,
    revision: 1,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: { milestone: index },
  };
}

/** A sink that keeps what each turn carried, in the unit the product paid for. */
function recordingSink(): Readonly<{
  batches: PendingBatch[];
  deliveredAtMs: number[];
  sink: { deliver(batch: PendingBatch): Promise<void> };
}> {
  const batches: PendingBatch[] = [];
  const deliveredAtMs: number[] = [];
  return {
    batches,
    deliveredAtMs,
    sink: {
      async deliver(batch) {
        batches.push(batch);
        deliveredAtMs.push(Date.now());
      },
    },
  };
}

/** What one prompt turn carried, as the sink saw it: the population the gate examines. */
type TurnReading = Readonly<{
  index: number;
  inputs: number;
  freshFacts: number;
  observationAdvanced: boolean;
  revision: number;
  ageMs: number;
}>;

const TURN_WITHOUT_NEW_CONTENT = "turn_without_new_content";

/**
 * Read the deliveries into the gate's population: one reading per prompt turn, with "fresh" decided by the pump's own
 * `factContentIdentity` - one spelling of "what this fact tells the model" for the product and for the gate.
 */
function readTurns(batches: readonly PendingBatch[], deliveredAtMs: readonly number[]): readonly TurnReading[] {
  const known = new Set<string>();
  let revision = -1;
  return batches.map((batch, at) => {
    const snapshot = batch.facts.find((fact) => fact.kind === "snapshot");
    const advanced = snapshot !== undefined && snapshot.revision > revision;
    if (advanced && snapshot !== undefined) revision = snapshot.revision;
    const facts = batch.facts.filter((fact) => fact.kind !== "snapshot");
    const freshFacts = facts.filter((fact) => !known.has(factContentIdentity(fact))).length;
    for (const fact of facts) known.add(factContentIdentity(fact));
    return Object.freeze({
      index: at + 1,
      inputs: batch.inputs.length,
      freshFacts,
      observationAdvanced: advanced,
      revision,
      ageMs: Math.max(0, (deliveredAtMs[at] ?? 0) - (snapshot?.occurredAtMs ?? 0)),
    });
  });
}

/**
 * `turn_without_new_content`: every prompt turn carries at least one member of the closed list, and not a re-statement
 * of something already delivered.
 *
 * <p>
 * THE POPULATION IS THE DELIVERIES, and the gate lives in this suite rather than in `tools/check-*` because that is the
 * only place the population exists in CI: a run's turns are what sinks received, and the run artifact records the batch
 * TEXT, not the facts that opened it. A `tools/check-*` gate would have to read a session file from a live run, so it
 * would be blocked (no population) on every CI run and green on none - a check that is not measuring anything. The run's
 * own `GAME_TURN_ACCOUNT` line is the artifact-side counterpart: it carries the same account out to a log a future gate
 * can read when a run is present, without this one having to invent a population.
 * </p>
 *
 * An EMPTY population is blocked rather than green - a run that delivered nothing has not shown that its turns are
 * content-driven. The failure names the turn, the member that was present only as a re-statement, the reading she was on,
 * and how old it was.
 */
function turnWithoutNewContent(
  turns: readonly TurnReading[],
): Readonly<{ examined: number; violations: readonly string[]; blocked: string | null }> {
  if (turns.length === 0)
    return Object.freeze({
      examined: 0,
      violations: Object.freeze([]),
      blocked: "zero_population:no_prompt_turn_was_delivered",
    });
  const violations = turns
    .filter((turn) => turn.inputs === 0 && !turn.observationAdvanced && turn.freshFacts === 0)
    .map((turn) => {
      // The population is filtered to batches no person opened, so the only question left is whether the batch carried a
      // fact she had already received or nothing at all. A reading cannot be the answer any more: it opens no turn.
      const reason = turn.revision >= 0 ? NOT_OWED.worldFactRestated : NOT_OWED.nothingPending;
      return `${TURN_WITHOUT_NEW_CONTENT}:#${String(turn.index)}:${reason}:${String(turn.revision)}:${String(turn.ageMs)}`;
    });
  return Object.freeze({ examined: turns.length, violations: Object.freeze(violations), blocked: null });
}

/** Drive the recorded window through the pump, exactly as the Host did: a re-stated reading, then a settlement. */
async function replayRecordedWindow(): Promise<
  Readonly<{ pump: CompanionEventPump; batches: PendingBatch[]; deliveredAtMs: number[] }>
> {
  const pump = new CompanionEventPump();
  const recorder = recordingSink();
  // Turn one: the reading, and the settlement that arrived with it.
  pump.enqueueFact(readingFact(0), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(recorder.sink);
  // Turn two: the Host re-states the last reading before every turn, and the same settlement is published again.
  pump.enqueueFact(readingFact(1), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", REPLAY_END_AT_MS),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(recorder.sink);
  return { pump, batches: recorder.batches, deliveredAtMs: recorder.deliveredAtMs };
}

test("turn_without_new_content: a batch that only re-states what she has is not a turn", async () => {
  const replay = await replayRecordedWindow();
  const reading = turnWithoutNewContent(readTurns(replay.batches, replay.deliveredAtMs));

  assert.deepEqual(
    reading.violations,
    [],
    "the 07:30:43 turn of the recorded window existed only for a re-statement: the pump must not open it",
  );
  assert.equal(reading.examined, 1, "the window is two prompt turns, of which only the first carried news");
});

test("turn_without_new_content: the gate is red on the recorded turn it exists to catch", () => {
  // The same population, with the second turn re-stated by hand: this is the defect the gate is FOR, and it must fail
  // loudly and name the turn rather than pass because today's pump no longer produces it.
  const turns: readonly TurnReading[] = [
    { index: 1, inputs: 0, freshFacts: 3, observationAdvanced: true, revision: 14, ageMs: 0 },
    { index: 2, inputs: 0, freshFacts: 0, observationAdvanced: false, revision: 14, ageMs: 144_000 },
  ];
  const reading = turnWithoutNewContent(turns);

  assert.deepEqual(reading.violations, [`${TURN_WITHOUT_NEW_CONTENT}:#2:${NOT_OWED.worldFactRestated}:14:144000`]);
  assert.equal(reading.examined, 2, "and it says what it examined, so `0 violations` can be told from `0 examined`");
});

test("turn_without_new_content: zero population is blocked, never green", () => {
  const reading = turnWithoutNewContent([]);
  assert.equal(reading.violations.length, 0);
  assert.match(String(reading.blocked), /^zero_population:/u, "nothing examined is not nothing wrong");
});

/**
 * `fact_identity_is_the_statement`: the identity is the STATEMENT, not the bytes that carried it.
 *
 * <p>
 * THE MEMBER ORDER OF A PAYLOAD IS THE PRODUCER'S LAYOUT, NOT HER NEWS. Measured 2026-11-11: the Mod's own snapshot
 * gate failed on the same twelve thousand values laid out differently - `targetId` moved from the front of its row to
 * the back - and the payload is the PARSED frame, so an identity computed over its encoded form makes every re-laid-out
 * copy a new fact. The turn that copy opens is the 07:30:43 re-statement this suite exists to suppress, one layer down.
 * </p>
 */
test("fact_identity_is_the_statement: one statement in two member orders is one identity", () => {
  const settlement: Record<string, unknown> = { ...RECORDED_SETTLEMENT };
  const reordered = Object.fromEntries(Object.entries(settlement).reverse());
  const first = settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS);
  const restated: WorldFact = {
    ...settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 90_000),
    payload: reordered,
  };

  assert.equal(
    factContentIdentity(restated),
    factContentIdentity(first),
    "the same settlement under a fresh event id and a re-laid-out payload is the SAME fact; counting it as new pays a " +
      "provider turn and a bubble for nothing",
  );

  const changed: WorldFact = { ...restated, payload: { ...reordered, decided: 61 } };
  assert.notEqual(
    factContentIdentity(changed),
    factContentIdentity(first),
    "a changed value is a different fact, so the canonical form must not be collapsing what the payload says",
  );
});

test("fact_identity_is_the_statement: a nested row's member order is not news either", () => {
  const fact = (bodyTrace: Readonly<Record<string, unknown>>): WorldFact => ({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "route_progress_1",
    revision: 348,
    observedTick: 900,
    occurredAtMs: WINDOW_AT_MS,
    payload: { kind: "route_progress", bodyTrace },
  });

  assert.equal(
    factContentIdentity(fact({ location: "Farm", x: 64, y: 15 })),
    factContentIdentity(fact({ y: 15, x: 64, location: "Farm" })),
    "the order is not content at any depth: a nested row is still the same observation of the same tile",
  );
  assert.notEqual(
    factContentIdentity(fact({ location: "Farm", x: 64, y: 15 })),
    factContentIdentity(fact({ location: "Farm", x: 64, y: 16 })),
    "and the tile she moved to IS news, so the nested form is compared by value and not discarded",
  );
});

test("not_owed_is_named: every flush call opens a turn or names why it owed none", async () => {
  const pump = new CompanionEventPump();
  const recorder = recordingSink();
  // THE INVARIANT, IN THE UNIT IT NOW HAS. A call either opens a turn (and composes exactly one batch) or names, from the
  // closed list, why no turn was owed - and the two are different counters. `flushes examined` no longer counts the calls
  // that owed nothing: `round64` printed `examined 134 · opened 8` and every one of the 126 was a batch it built and threw
  // away.
  const step = async (): Promise<void> => {
    const before = pump.turnAccount;
    const outcome = await pump.flush(recorder.sink);
    const after = pump.turnAccount;
    const notOwedBefore = NOT_OWED_REASONS.reduce((total, reason) => total + before.notOwed[reason], 0);
    const notOwedAfter = NOT_OWED_REASONS.reduce((total, reason) => total + after.notOwed[reason], 0);
    const openedDelta = after.opened - before.opened;
    const notOwedDelta = notOwedAfter - notOwedBefore;
    assert.equal(
      after.examined - before.examined,
      openedDelta,
      "a flush is examined only when it composes a batch, and a batch is composed only when a turn is owed",
    );
    assert.equal(openedDelta + notOwedDelta, 1, "every call is answered exactly once: opened, or not owed");
    assert.equal(
      outcome.kind === "opened",
      openedDelta === 1,
      `the answer and the account must agree: ${JSON.stringify(after.lastDecision)}`,
    );
    if (notOwedDelta === 1) {
      assert.ok(
        NOT_OWED_REASONS.includes(after.lastDecision?.reason as never),
        `a call that owed no turn must carry a reason from the closed list, got ${String(after.lastDecision?.reason)}`,
      );
      assert.equal(outcome.kind, "not_owed", "and the caller gets the ticket, not `undefined`");
    }
  };

  await step(); // nothing pending at all
  pump.enqueueFact(readingFact(0, 14), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(milestoneFact(600, WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await step(); // the world-fact member, carrying the first reading
  pump.enqueueFact(readingFact(1, 14), FACT_PRODUCER.adapterIngress);
  await step(); // the reading re-stated and nothing else: suppressed, and named as state
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await step(); // the world-fact member again
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await step(); // the re-statement of it: suppressed, and named

  const account = pump.turnAccount;
  assert.equal(account.notOwed[NOT_OWED.nothingPending], 1);
  assert.equal(account.notOwed[NOT_OWED.observationRestated], 1);
  assert.equal(account.notOwed[NOT_OWED.worldFactRestated], 1);
  assert.equal(account.opened, 2, "two turns: the first reading and the settlement");
});

test("the closed list is what opens turns: every member has a producer, and nothing else opens one", async () => {
  const produced = new Set<string>();
  const open = async (
    pump: CompanionEventPump,
    sink: { deliver(batch: PendingBatch): Promise<void> },
  ): Promise<void> => {
    await pump.flush(sink);
    const decision = pump.turnAccount.lastDecision;
    if (decision?.kind === "opened") produced.add(decision.reason);
  };
  const recorder = recordingSink();

  // player_input: the person spoke, and a re-stated world rides along without being lost.
  const spoken = new CompanionEventPump();
  spoken.enqueueFact(readingFact(0), FACT_PRODUCER.adapterIngress);
  spoken.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await open(spoken, recorder.sink);
  spoken.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  spoken.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_1",
    text: "东头那地儿，先弄草还是先搬石头？",
    locale: "zh-CN",
    timestampMs: WINDOW_AT_MS + 2_000,
  });
  await open(spoken, recorder.sink);
  assert.deepEqual(spoken.turnAccount.lastDecision, { kind: "opened", index: 2, reason: TURN_OPENING.playerInput });

  // world_fact: content she has not received.
  const factPump = new CompanionEventPump();
  factPump.enqueueFact(milestoneFact(1200, WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await open(factPump, recorder.sink);

  // A READING IS NOT AN OPENER. The same world moved (a clock, a location, a new revision) and the flush is suppressed,
  // because the snapshot is the `<world-state>` block that every turn re-states: `round55` paid 90 model turns for these
  // and 87 of them ended with speech and no action. The population below is `TURN_OPENINGS` itself, so a reading that
  // crept back in as a fifth member would fail here by name.
  const observationPump = new CompanionEventPump();
  observationPump.enqueueFact(readingFact(0, 14), FACT_PRODUCER.adapterIngress);
  observationPump.enqueueFact(milestoneFact(600, WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await open(observationPump, recorder.sink);
  observationPump.enqueueFact(readingFact(1, 15, { location: "Farm", gameTime: "0750" }), FACT_PRODUCER.adapterIngress);
  await open(observationPump, recorder.sink);
  assert.deepEqual(observationPump.turnAccount.lastDecision, {
    kind: "not_owed",
    reason: NOT_OWED.observationMoved,
  });
  assert.equal(
    observationPump.turnAccount.opened,
    1,
    "the reading it held opened nothing, because the milestone already had",
  );

  // due: a Host-owned schedule coming due - the stall watch's own fact.
  const duePump = new CompanionEventPump();
  duePump.enqueueFact(
    {
      ...settlementFact("execution_stalled_exec_1_1", WINDOW_AT_MS),
      semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
      correlationId: "exec_1",
      executionId: "exec_1",
      payload: { kind: EXECUTION_STALL_SEMANTIC_KIND, executionId: "exec_1", elapsedMs: 120_000, stallFactsSoFar: 1 },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await open(duePump, recorder.sink);

  // The population is the closed list itself: a member added to it without a producer here fails by name.
  const unreachable = TURN_OPENINGS.filter((reason) => !produced.has(reason));
  assert.deepEqual(
    unreachable.map((reason) => `declared_reason_unreachable:${reason}`),
    [],
    "every declared opening reason must be reachable, and a suppression rule that makes one unreachable must say so",
  );
});

test("suppression holds the facts: the next turn that opens carries what a suppressed flush did not", async () => {
  const pump = new CompanionEventPump();
  const recorder = recordingSink();
  pump.enqueueFact(readingFact(0), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder.sink);
  const queueAfterFirstTurn = pump.pendingCount;

  // The settlement is published again, and the stall watch's fact arrives in the same breath: nothing may be lost by
  // the suppression that follows, and the watchdog's fact must not be swallowed by the re-statement beside it.
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  const stall = pump.takeStallFact();
  assert.equal(stall, undefined, "the watch has nothing to say about an execution it never timed");
  pump.enqueueFact(
    {
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact",
      eventId: "execution_stalled_exec_7_1",
      sourceEventId: "execution_stalled_exec_7_1",
      correlationId: "exec_7",
      revision: 1,
      occurredAtMs: WINDOW_AT_MS + 121_000,
      executionId: "exec_7",
      semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
      payload: { kind: EXECUTION_STALL_SEMANTIC_KIND, executionId: "exec_7", elapsedMs: 121_000, stallFactsSoFar: 1 },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(recorder.sink);

  assert.equal(pump.turnAccount.lastDecision?.kind, "opened", "a stall fact is due, so it opens the turn it needs");
  const delivered = recorder.batches.at(-1)!;
  const kinds = delivered.facts.map((fact) => fact.semanticKind ?? fact.kind);
  assert.ok(
    kinds.includes(EXECUTION_STALL_SEMANTIC_KIND),
    `the watchdog's fact is delivered: ${JSON.stringify(kinds)}`,
  );
  assert.ok(
    delivered.facts.some((fact) => fact.payload.kind === EXECUTION_STALL_SEMANTIC_KIND),
    "and it is delivered as itself, not as the re-statement beside it",
  );
  assert.equal(pump.pendingCount, 0, `nothing is left queued behind the suppression: ${String(queueAfterFirstTurn)}`);
});

test("suppression leaves the settlement observer alone: it runs on its own timer, and its reading reaches the next turn", async () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    {
      code: "found",
      snapshot: {
        programId: "plan_r46_weed_row",
        state: "active",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 7,
        nodes: [
          { nodeId: "n001", state: "running", nodeAttempt: 0, admissionAttempt: 0, actionId: "cut_weeds" },
          { nodeId: "n002", state: "pending", nodeAttempt: 0, admissionAttempt: 0, actionId: "cut_weeds" },
        ],
      },
    },
    0,
  );
  let reads = 0;
  const pump = new CompanionEventPump(() => {
    reads += 1;
    return observer.inFlight(11_000);
  });
  const recorder = recordingSink();

  pump.enqueueFact(readingFact(0), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder.sink);
  const readsAfterTurn = reads;
  assert.ok(readsAfterTurn > 0, "a delivered batch states the programme in flight");

  // A suppressed flush is not an observation of the journal, and must not consume or clear its reading.
  pump.enqueueFact(readingFact(1), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(recorder.sink);
  assert.equal(pump.turnAccount.lastDecision?.kind, "suppressed");
  assert.equal(
    reads,
    readsAfterTurn,
    "the ledger is read when a batch is composed, never to decide whether to compose",
  );

  // The next turn that opens still carries it: suppression neither starved the observer nor hid its result.
  pump.enqueueFact(milestoneFact(1200, WINDOW_AT_MS + 2_000), FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder.sink);
  assert.match(recorder.batches.at(-1)!.text, /<in-flight>\n/u, "the programme in flight reaches the next turn");
  assert.match(recorder.batches.at(-1)!.text, /plan_r46_weed_row/u);
});

test("the delivered-content memory is bounded, and its drain errs toward a turn", async () => {
  // The collection this rule adds is the one thing that could grow with a run, so it has a bound and a drain - and the
  // drain's failure direction is asserted rather than assumed: forgetting an identity costs a TURN, never a FACT.
  const pump = new CompanionEventPump();
  const recorder = recordingSink();
  const first = settlementFact("program_settled_plan_drain_first", WINDOW_AT_MS);
  pump.enqueueFact(first, FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder.sink);

  for (let index = 1; index <= MAX_DELIVERED_FACT_IDENTITIES; index += 1) {
    pump.enqueueFact(
      {
        ...settlementFact(`program_settled_plan_drain_${String(index)}`, WINDOW_AT_MS + index),
        payload: { ...RECORDED_SETTLEMENT, programId: `plan_drain_${String(index)}` },
      },
      FACT_PRODUCER.adapterIngress,
    );
    await pump.flush(recorder.sink);
  }
  const opened = pump.turnAccount.opened;

  // The newest identity is still remembered: re-stating it is the defect this gate removes.
  pump.enqueueFact(
    {
      ...settlementFact("program_settled_plan_drain_repeat", WINDOW_AT_MS + 1_000),
      payload: { ...RECORDED_SETTLEMENT, programId: `plan_drain_${String(MAX_DELIVERED_FACT_IDENTITIES)}` },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(recorder.sink);
  assert.equal(pump.turnAccount.opened, opened, "a re-statement inside the memory is still suppressed");

  // The first identity has been drained out, so it reads as news again: one extra turn, and nothing lost.
  pump.enqueueFact(first, FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder.sink);
  assert.equal(
    pump.turnAccount.opened,
    opened + 1,
    "the drained identity opens a turn rather than silencing a fact for the rest of the run",
  );
});

const SEGMENT_SEPARATOR = " · ";

/** One `name: count, name: count` histogram as the line prints it, read back into the counts. */
function parseCounts(inner: string): Record<string, number> {
  if (inner.trim() === "") return {};
  return Object.fromEntries(
    inner.split(", ").map((entry) => {
      const at = entry.lastIndexOf(": ");
      assert.ok(at > 0, `an entry in the printed histogram is not "<name>: <count>": ${entry}`);
      return [entry.slice(0, at), Number(entry.slice(at + 2))];
    }),
  );
}

/** One printed block's entries, split at its TOP level so a nested `{…}` does not split in half. */
function splitEntries(inner: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(inner.slice(from, at).trim());
      from = at + 1;
    }
  }
  const last = inner.slice(from).trim();
  if (last !== "") entries.push(last);
  return entries;
}

/**
 * One histogram read back, WITH the producer block a fact-decided reason carries inside its own braces.
 *
 * The inverse of the printer, and it refuses anything it cannot read: an entry is `<name>: <count>` or
 * `<name>: <count> {<producer>: <count>, …}` and nothing else. A reader that fell back to a substring would read
 * `world_fact: 28 {adapter_ingress: 26}` as `world_fact: NaN`, which is the shape this whole segment exists to end.
 */
function parseCountsAndProducers(inner: string): Readonly<{
  counts: Record<string, number>;
  producers: Record<string, Record<string, number>>;
}> {
  const counts: Record<string, number> = {};
  const producers: Record<string, Record<string, number>> = {};
  for (const entry of splitEntries(inner)) {
    const nested = /^(.+?): (\d+) \{(.*)\}$/u.exec(entry);
    if (nested === null) {
      const at = entry.lastIndexOf(": ");
      assert.ok(at > 0, `an entry in the printed histogram is not "<name>: <count>": ${entry}`);
      counts[entry.slice(0, at)] = Number(entry.slice(at + 2));
      continue;
    }
    const name = nested[1] ?? "";
    counts[name] = Number(nested[2]);
    producers[name] = parseCounts(nested[3] ?? "");
  }
  return Object.freeze({ counts, producers });
}

/**
 * One `label N {counts}` segment, or one `label N` segment with no histogram.
 *
 * The label is whatever the printer wrote, including a colon or a hyphen: `per delivered batch: turns opened` carries the
 * unit in its own name, and `tool-only` is hyphenated on purpose. The ordered list asserted below is what pins the segments
 * - a character class here would only pin the alphabet.
 */
function parseSegment(segment: string): Readonly<{
  label: string;
  total: number;
  counts: Record<string, number>;
  producers: Record<string, Record<string, number>>;
}> {
  const matched = /^(.+?) (\d+)(?: \{(.*)\})?$/u.exec(segment);
  assert.ok(matched !== null, `the account line carries a segment this reader cannot parse: ${segment}`);
  const label = matched[1];
  const total = matched[2];
  assert.ok(
    typeof label === "string" && typeof total === "string",
    `the account line carries a segment this reader cannot parse: ${segment}`,
  );
  const read = parseCountsAndProducers(matched[3] ?? "");
  return Object.freeze({ label, total: Number(total), counts: read.counts, producers: read.producers });
}

/**
 * The account line READ BACK, so the assertion is the inverse of the printer rather than a copy of its output.
 *
 * A hand-written expected string can only pin what its author remembered; this reader refuses a line that lost a
 * segment, so a printer that silently dropped the opener histogram fails here by name. The labels are the things a run's
 * account has to answer, IN THE ORDER THE LINE PRINTS THEM - the assistant turns Pi wrote, the two readings derived from
 * them, and then the delivered batches: how many turns opened and why, how many flushes were suppressed and why, how many
 * were examined, how many turns closed on speech alone and of which shape, how many settled with work and no word and what
 * opened them, how many of those settlements had her own execution still running, and what the stale path did instead of a
 * turn.
 */
function readTurnAccountLine(line: string): Readonly<{
  assistantTurns: Readonly<{
    examined: number;
    counts: Record<string, number>;
    withText: number;
    toolOnly: number;
  }>;
  opened: number;
  byReason: Record<string, number>;
  /** The producers printed inside each opener's braces: the reasons a FACT opened, and which entrance it came in by. */
  openedProducers: Record<string, Record<string, number>>;
  notOwed: Readonly<{
    total: number;
    counts: Record<string, number>;
    producers: Record<string, Record<string, number>>;
  }>;
  examined: number;
  carried: Readonly<{ total: number; pending: number }>;
  traces: number;
  delivery: Readonly<{ bubbles: number; lostTotal: number; lost: Record<string, number> }>;
  emptyTurns: Readonly<{ total: number; counts: Record<string, number> }>;
  silentSettled: Readonly<{ total: number; counts: Record<string, number> }>;
  settledWithExecutionInFlight: number;
  autoObserve: Readonly<{
    agedTurns: number;
    refreshed: Readonly<{ total: number; counts: Record<string, number> }>;
    unavailable: Readonly<{ total: number; counts: Record<string, number> }>;
    rearmed: Readonly<{ total: number; counts: Record<string, number> }>;
  }>;
}> {
  const segments = line.split(SEGMENT_SEPARATOR).map(parseSegment);
  const labels = [
    ASSISTANT_TURNS_EXAMINED,
    ASSISTANT_TURNS_WITH_TEXT,
    ASSISTANT_TURNS_TOOL_ONLY,
    `${PER_DELIVERED_BATCH} turns opened`,
    FLUSHES_EXAMINED,
    NOT_OWED_LABEL,
    CARRIED,
    TRACES,
    BUBBLES_DELIVERED,
    LOST,
    TURN_WITHOUT_ACTION,
    TURN_SETTLED_SILENT,
    TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT,
    AUTO_OBSERVE_AGED_TURNS,
    AUTO_OBSERVE_ON_STALE,
    AUTO_OBSERVE_UNAVAILABLE_TOKEN,
    AUTO_OBSERVE_REARMED,
    // The provenance reading and the defect it names: `round62` could not say how many of its receipts even claimed a
    // programme, which is why the field that states it had to be added. Both segments are asserted present here so a run's
    // account keeps answering `receipts with provenance N {…}` and `unattributed_execution U {ids}`.
    RECEIPTS_WITH_PROVENANCE,
    UNATTRIBUTED_EXECUTION_TOKEN,
  ];
  assert.deepEqual(
    segments.map((segment) => segment.label),
    labels,
    `the account line's segments are ${labels.join(", ")}: a missing one is a reading nobody can recover`,
  );
  const [
    assistantSegment,
    withTextSegment,
    toolOnlySegment,
    openedSegment,
    examinedSegment,
    notOwedSegment,
    carriedSegment,
    tracesSegment,
    bubblesSegment,
    lostSegment,
    emptySegment,
    silentSegment,
    inFlightSegment,
    agedSegment,
    observedSegment,
    declinedSegment,
    rearmedSegment,
  ] = segments as [
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
  ];
  return Object.freeze({
    assistantTurns: Object.freeze({
      examined: assistantSegment.total,
      counts: assistantSegment.counts,
      withText: withTextSegment.total,
      toolOnly: toolOnlySegment.total,
    }),
    opened: openedSegment.total,
    byReason: openedSegment.counts,
    openedProducers: openedSegment.producers,
    notOwed: Object.freeze({
      total: notOwedSegment.total,
      counts: notOwedSegment.counts,
      producers: notOwedSegment.producers,
    }),
    examined: examinedSegment.total,
    carried: Object.freeze({ total: carriedSegment.total, pending: carriedSegment.counts.pending ?? 0 }),
    traces: tracesSegment.total,
    delivery: Object.freeze({ bubbles: bubblesSegment.total, lostTotal: lostSegment.total, lost: lostSegment.counts }),
    emptyTurns: Object.freeze({ total: emptySegment.total, counts: emptySegment.counts }),
    silentSettled: Object.freeze({ total: silentSegment.total, counts: silentSegment.counts }),
    settledWithExecutionInFlight: inFlightSegment.total,
    executionProvenance: Object.freeze({
      facts: Object.freeze({ programme: 0, standalone: 0, unattributed: 0, unstated: 0 }),
      unattributedExecutions: Object.freeze([]),
      omittedUnattributed: 0,
    }),
    autoObserve: Object.freeze({
      agedTurns: agedSegment.total,
      refreshed: Object.freeze({ total: observedSegment.total, counts: observedSegment.counts }),
      unavailable: Object.freeze({ total: declinedSegment.total, counts: declinedSegment.counts }),
      rearmed: Object.freeze({ total: rearmedSegment.total, counts: rearmedSegment.counts }),
    }),
  });
}

/** Every opener a silent settlement can have, with the given ones counted: the population is the pump's own list. */
function silentSettledCounts(overrides: Readonly<Record<string, number>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const opener of SILENT_SETTLED_OPENINGS) counts[opener] = overrides[opener] ?? 0;
  return counts;
}

/** Every shape an empty turn can have, with the given ones counted: the population comes from the pump's own list. */
function emptyTurnShapeCounts(overrides: Readonly<Record<string, number>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const shape of emptyTurnShapes()) counts[shape] = overrides[shape] ?? 0;
  return counts;
}

/** Every production member, with the given ones counted: the population is the pump's own closed list. */
function assistantProductionCounts(overrides: Readonly<Record<string, number>>): Record<TurnProduction, number> {
  const counts = {} as Record<TurnProduction, number>;
  for (const production of TURN_PRODUCTIONS) counts[production] = overrides[production] ?? 0;
  return counts;
}

/** One reason's producer histogram, over the pump's own closed producer set. */
function producerCounts(overrides: Readonly<Record<string, number>>): Record<FactProducer, number> {
  const counts = {} as Record<FactProducer, number>;
  for (const producer of FACT_PRODUCERS) counts[producer] = overrides[producer] ?? 0;
  return counts;
}

/** Every reason's producer histogram with the given ones counted - the population is the pump's own reason list. */
function producerHistograms<Reason extends string>(
  reasons: readonly Reason[],
  overrides: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
): Record<Reason, Record<FactProducer, number>> {
  const histograms = {} as Record<Reason, Record<FactProducer, number>>;
  for (const reason of reasons) histograms[reason] = producerCounts(overrides[reason] ?? {});
  return histograms;
}

/** What the printer writes for one reason's producers: only the ones that fired, so `{}` is `no producer decided it`. */
function firedProducers(counts: Readonly<Record<FactProducer, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

/** The stale path's own account, with every declared unavailability reason printed even at zero. */
function autoObserveAccount(
  refreshed: Readonly<{ refreshed: number; lastAgeTurns: number | undefined; agedTurns?: number }>,
  unavailable: Readonly<Record<string, number>> = {},
  rearmed: Readonly<Record<string, number>> = {},
): TurnAccount["autoObserve"] {
  const byReason: Record<string, number> = {};
  for (const reason of AUTO_OBSERVE_UNAVAILABLE_REASONS) byReason[reason] = unavailable[reason] ?? 0;
  const byRearm: Record<string, number> = {};
  for (const reason of AUTO_OBSERVE_REARM_REASONS) byRearm[reason] = rearmed[reason] ?? 0;
  const declined = AUTO_OBSERVE_UNAVAILABLE_REASONS.reduce((total, reason) => total + (byReason[reason] ?? 0), 0);
  return Object.freeze({
    // The population is the sum by construction here: an account that named aged turns and then neither refreshed nor
    // declined them is the arithmetic break `event-pump.stale-observation.test.ts` reds by name.
    agedTurns: refreshed.agedTurns ?? refreshed.refreshed + declined,
    refreshed: refreshed.refreshed,
    lastAgeTurns: refreshed.lastAgeTurns,
    unavailable: Object.freeze(byReason),
    rearmed: Object.freeze(byRearm),
  });
}

test("the account line reads back into the account it names", () => {
  const account: TurnAccount = Object.freeze({
    opened: 12,
    byReason: Object.freeze({
      [TURN_OPENING.playerInput]: 2,
      [TURN_OPENING.worldFact]: 7,
      [TURN_OPENING.due]: 3,
    }),
    openedByProducer: Object.freeze(
      producerHistograms(TURN_OPENINGS, {
        [TURN_OPENING.worldFact]: { [FACT_PRODUCER.adapterIngress]: 5, [FACT_PRODUCER.narrationWithoutWork]: 2 },
        [TURN_OPENING.due]: { [FACT_PRODUCER.stallWatch]: 3 },
      }),
    ),
    notOwed: Object.freeze({
      [NOT_OWED.observationRestated]: 2,
      [NOT_OWED.observationMoved]: 1,
      [NOT_OWED.worldFactRestated]: 4,
      [NOT_OWED.inFlightProgress]: 3,
      [NOT_OWED.progress]: 6,
      [NOT_OWED.nothingPending]: 5,
    }),
    notOwedByProducer: Object.freeze(
      producerHistograms(NOT_OWED_REASONS, {
        [NOT_OWED.observationRestated]: { [FACT_PRODUCER.snapshotRestate]: 2 },
        [NOT_OWED.observationMoved]: { [FACT_PRODUCER.adapterIngress]: 1 },
        [NOT_OWED.worldFactRestated]: { [FACT_PRODUCER.adapterIngress]: 4 },
        [NOT_OWED.inFlightProgress]: { [FACT_PRODUCER.adapterIngress]: 3 },
      }),
    ),
    examined: 12,
    assistantTurns: Object.freeze({
      examined: 6,
      byProduction: Object.freeze(
        assistantProductionCounts({
          [TURN_PRODUCTION.worked]: 2,
          [TURN_PRODUCTION.workedSilently]: 1,
          [TURN_PRODUCTION.spoke]: 3,
        }),
      ),
    }),
    emptyTurns: Object.freeze({
      total: 3,
      byShape: Object.freeze(
        emptyTurnShapeCounts({
          [turnWithoutActionShape(TURN_OPENING.worldFact, TURN_WITHOUT_ACTION_REASON.worldStale)]: 3,
        }),
      ),
    }),
    silentSettled: Object.freeze({
      total: 2,
      byOpener: Object.freeze(silentSettledCounts({ [TURN_OPENING.worldFact]: 2 })),
    }),
    settledWithExecutionInFlight: 3,
    executionProvenance: Object.freeze({
      facts: Object.freeze({ programme: 0, standalone: 0, unattributed: 0, unstated: 0 }),
      unattributedExecutions: Object.freeze([]),
      omittedUnattributed: 0,
    }),
    carry: Object.freeze({ carried: 9, pending: 2 }),
    traces: 4,
    delivery: Object.freeze({ bubbles: 7, lost: Object.freeze({ no_presentation_lease: 1 }), lostTotal: 1 }),
    autoObserve: autoObserveAccount(
      { refreshed: 4, lastAgeTurns: 20 },
      { [AUTO_OBSERVE_UNAVAILABLE.refused]: 1 },
      { [AUTO_OBSERVE_REARM.readingMoved]: 2, [AUTO_OBSERVE_REARM.worldMoved]: 1 },
    ),
    lastDecision: undefined,
  });
  const parsed = readTurnAccountLine(turnAccountLine(account));

  assert.equal(parsed.opened, account.opened);
  assert.deepEqual(parsed.byReason, account.byReason, "every opener is printed WITH its count, not only the total");
  for (const opener of TURN_OPENINGS)
    assert.deepEqual(
      parsed.openedProducers[opener] ?? {},
      firedProducers(account.openedByProducer[opener]),
      `the producers under \`${opener}\` read back: only the ones that fired are printed, and a decision no fact made carries none`,
    );
  for (const reason of NOT_OWED_REASONS)
    assert.deepEqual(
      parsed.notOwed.producers[reason] ?? {},
      firedProducers(account.notOwedByProducer[reason]),
      `the producers under \`${reason}\` read back, so \`why was this flush suppressed\` is a query and not an investigation`,
    );
  assert.equal(
    Object.values(account.openedByProducer[TURN_OPENING.worldFact]).reduce((total, count) => total + count, 0),
    account.byReason[TURN_OPENING.worldFact],
    "the block inside `world_fact`'s braces IS its count: a turn cannot be opened and attributed to no producer",
  );
  for (const readingHeld of [NOT_OWED.observationRestated, NOT_OWED.observationMoved])
    assert.equal(
      Object.values(account.notOwedByProducer[readingHeld]).reduce((total, count) => total + count, 0),
      account.notOwed[readingHeld],
      `and the same for \`${readingHeld}\`: every flush that held a reading names the producer that put it there`,
    );
  assert.equal(
    parsed.notOwed.total,
    Object.values(account.notOwed).reduce((total, count) => total + count, 0),
    "the suppressed total is the SUM of its reasons, derived: a member added to `NOT_OWED` cannot leave the printed total behind",
  );
  assert.deepEqual(parsed.notOwed.counts, account.notOwed);
  assert.equal(parsed.examined, account.examined);
  assert.equal(
    parsed.assistantTurns.examined,
    account.assistantTurns.examined,
    "the assistant-turn population reads back: the unit Pi writes, not the batch the pump counts in",
  );
  assert.deepEqual(parsed.assistantTurns.counts, account.assistantTurns.byProduction);
  assert.equal(
    parsed.assistantTurns.examined,
    Object.values(parsed.assistantTurns.counts).reduce((total, count) => total + count, 0),
    "the assistant-turn total is the SUM of its members, so an assistant turn cannot be counted and then disappear",
  );
  assert.equal(
    parsed.assistantTurns.withText,
    (parsed.assistantTurns.counts[TURN_PRODUCTION.worked] ?? 0) +
      (parsed.assistantTurns.counts[TURN_PRODUCTION.spoke] ?? 0),
    "`with text` is derived from the members beside it, not a second count of the same turns",
  );
  assert.equal(
    parsed.assistantTurns.toolOnly,
    parsed.assistantTurns.counts[TURN_PRODUCTION.workedSilently] ?? 0,
    "and `tool-only` is work without text, asked of the same closed list",
  );
  assert.equal(
    parsed.assistantTurns.withText +
      parsed.assistantTurns.toolOnly +
      (parsed.assistantTurns.counts[TURN_PRODUCTION.saidNothing] ?? 0),
    parsed.assistantTurns.examined,
    "the trio + `said_nothing` IS the population: the three readings cannot be added to the batch group below them",
  );
  assert.equal(parsed.emptyTurns.total, account.emptyTurns.total);
  assert.deepEqual(parsed.emptyTurns.counts, account.emptyTurns.byShape);
  assert.equal(
    parsed.emptyTurns.total,
    Object.values(parsed.emptyTurns.counts).reduce((total, count) => total + count, 0),
    "the empty-turn total is the sum of its shapes, so a turn cannot be counted and then disappear from the account",
  );
  assert.equal(parsed.silentSettled.total, account.silentSettled.total);
  assert.deepEqual(parsed.silentSettled.counts, account.silentSettled.byOpener);
  assert.equal(
    parsed.silentSettled.total,
    Object.values(parsed.silentSettled.counts).reduce((total, count) => total + count, 0),
    "and the silent total is the sum of its openers, for the same reason",
  );
  assert.equal(
    parsed.settledWithExecutionInFlight,
    account.settledWithExecutionInFlight,
    "and the in-flight settlement count reads back: the condition that used to exclude silence is now a number on the line",
  );
  assert.equal(parsed.autoObserve.agedTurns, account.autoObserve.agedTurns);
  assert.equal(
    parsed.autoObserve.agedTurns,
    parsed.autoObserve.refreshed.total +
      Object.values(parsed.autoObserve.unavailable.counts).reduce((total, count) => total + count, 0),
    "every aged turn is printed as refreshed or as a named reason, so a turn cannot be aged and then unaccounted for",
  );
  assert.deepEqual(
    parsed.autoObserve.rearmed.counts,
    account.autoObserve.rearmed,
    "and WHICH signal earned a spent budget reads back: `the reading moved` and `the world moved` are different readings",
  );
  assert.equal(
    parsed.autoObserve.rearmed.total,
    Object.values(parsed.autoObserve.rearmed.counts).reduce((total, count) => total + count, 0),
    "the re-arm total is the sum of its signals, so a budget cannot be earned back without the account saying how",
  );
});

test("the account line names a member that never fired, in both histograms", () => {
  // `opened 55` with no histogram was the measured line: it said how many turns the run paid for and nothing about what
  // opened them. The population is the closed lists, so a member at zero is printed as `0` rather than left out.
  const account: TurnAccount = Object.freeze({
    opened: 1,
    byReason: Object.freeze({
      [TURN_OPENING.playerInput]: 1,
      [TURN_OPENING.worldFact]: 0,
      [TURN_OPENING.due]: 0,
    }),
    openedByProducer: Object.freeze(producerHistograms(TURN_OPENINGS)),
    notOwed: Object.freeze({
      [NOT_OWED.observationRestated]: 0,
      [NOT_OWED.observationMoved]: 0,
      [NOT_OWED.worldFactRestated]: 0,
      [NOT_OWED.inFlightProgress]: 0,
      [NOT_OWED.progress]: 0,
      [NOT_OWED.nothingPending]: 0,
    }),
    notOwedByProducer: Object.freeze(producerHistograms(NOT_OWED_REASONS)),
    examined: 1,
    assistantTurns: Object.freeze({
      examined: 0,
      byProduction: Object.freeze(assistantProductionCounts({})),
    }),
    emptyTurns: Object.freeze({ total: 0, byShape: Object.freeze(emptyTurnShapeCounts({})) }),
    silentSettled: Object.freeze({ total: 0, byOpener: Object.freeze(silentSettledCounts({})) }),
    settledWithExecutionInFlight: 0,
    executionProvenance: Object.freeze({
      facts: Object.freeze({ programme: 0, standalone: 0, unattributed: 0, unstated: 0 }),
      unattributedExecutions: Object.freeze([]),
      omittedUnattributed: 0,
    }),
    carry: Object.freeze({ carried: 0, pending: 0 }),
    traces: 0,
    delivery: Object.freeze({ bubbles: 0, lost: Object.freeze({}), lostTotal: 0 }),
    autoObserve: autoObserveAccount({ refreshed: 0, lastAgeTurns: undefined }),
    lastDecision: undefined,
  });
  const parsed = readTurnAccountLine(turnAccountLine(account));

  assert.deepEqual(
    Object.keys(parsed.byReason),
    [...TURN_OPENINGS],
    "the opener population is the closed list itself, so a new opener cannot be opened without being counted",
  );
  assert.equal(
    parsed.openedProducers[TURN_OPENING.playerInput],
    undefined,
    "a person's word is not a fact, so it prints with NO producer block rather than eleven invented zeroes",
  );
  assert.deepEqual(Object.keys(parsed.emptyTurns.counts), [...emptyTurnShapes()]);
  assert.deepEqual(
    Object.keys(parsed.silentSettled.counts),
    [...SILENT_SETTLED_OPENINGS],
    "the silent openers are derived from the opener list, so the one a turn cannot fall silent on never appears",
  );
  assert.deepEqual(
    Object.keys(parsed.assistantTurns.counts),
    [...TURN_PRODUCTIONS],
    "the assistant-turn population is the production list itself: a member nobody reached is a declared zero",
  );
  assert.deepEqual(Object.keys(parsed.notOwed.counts), [...NOT_OWED_REASONS]);
  assert.deepEqual(
    Object.keys(parsed.autoObserve.unavailable.counts),
    [...AUTO_OBSERVE_UNAVAILABLE_REASONS],
    "and the reasons a refresh could not be asked are all printed, so `nobody asked` is a stated zero",
  );
  assert.deepEqual(
    Object.keys(parsed.autoObserve.rearmed.counts),
    [...AUTO_OBSERVE_REARM_REASONS],
    "and so is every signal that can earn a spent budget back: a re-arm nobody can see is a budget that looks deaf",
  );
});

test("the account line this repo printed before the change is REFUSED by the reader", () => {
  // THE FALSIFIER for the shape above. This is the exact line `round47` printed for 55 turns - `turns opened 55` with
  // no histogram of what opened them and no statement about how those turns ended.
  const measured =
    "turns opened 55 · suppressed 0 {observation_restated: 0, world_fact_restated: 0, nothing_pending: 0} · flushes examined 55";
  assert.throws(
    () => readTurnAccountLine(measured),
    /assistant turns examined, with text, tool-only, per delivered batch: turns opened, suppressed, flushes examined, turn_closed_without_action, turn_settled_silent, turn_settled_with_execution_in_flight, aged readings, auto_observe_on_stale, auto_observe_unavailable, refresh_rearmed/u,
    "a line that cannot say what opened its turns is not an account, and must not read as one",
  );
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Silence in the unit it happens in: one assistant turn, inside whatever batch it landed in.                        */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * The two units answer different questions, and the same run can only be read if both are on the line.
 *
 * <p>
 * THE MEASUREMENT THIS EXISTS FOR (`round60`, one Game session): **169** assistant records - 84 ended `stop` and all 84
 * carried a line, 85 ended `tool_use` and 49 of those carried one too, so **133 with text** and **36 tool-only**. The pump
 * re-segmented the same run into **86** delivered batches: 29 spoke, 57 worked, and `turn_settled_silent` printed **0**
 * because every one of the 36 silent turns sat inside a `worked` batch - a batch carrying any line cannot be tool-only by
 * construction (`turnProduction` ORs `producedText` over the whole batch).
 * </p>
 * <p>
 * The replay below is that population, fed in the unit Pi wrote it: the same 169 records, the same one delivered batch
 * that carried text. It does NOT re-read the session file - that artifact lives outside this worktree - so the provenance of
 * the numbers is the measurement above, and what this test proves is that the counter reproduces them.
 * </p>
 */
test("assistant turns: round60's 169 records reproduce as 169 examined / 133 with text / 36 tool-only", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r60_replay", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  // 84 records that only spoke, 49 that acted and spoke, 36 that acted and said nothing.
  for (let index = 0; index < 84; index += 1) pump.noteAssistantTurn({ hasText: true, hasToolCall: false });
  for (let index = 0; index < 49; index += 1) pump.noteAssistantTurn({ hasText: true, hasToolCall: true });
  for (let index = 0; index < 36; index += 1) pump.noteAssistantTurn({ hasText: false, hasToolCall: true });
  // The batch those records landed in carried a line, so the batch counter reads `worked` - which is the whole defect.
  await pump.flush(settledSink(pump, TURN_PRODUCTION.worked));

  const account = pump.turnAccount;
  assert.deepEqual(
    account.assistantTurns.byProduction,
    {
      [TURN_PRODUCTION.worked]: 49,
      [TURN_PRODUCTION.workedSilently]: 36,
      [TURN_PRODUCTION.spoke]: 84,
      [TURN_PRODUCTION.saidNothing]: 0,
    },
    "every assistant record is classified once, in the same vocabulary the batch uses",
  );
  assert.equal(account.assistantTurns.examined, 169, "the population is the records Pi wrote");
  assert.equal(assistantTurnsWithText(account.assistantTurns), 133, "133 carried text: 49 acting + 84 narrating");
  assert.equal(assistantTurnsToolOnly(account.assistantTurns), 36, "and 36 ran a tool and said nothing");
  assert.equal(
    account.silentSettled.total,
    0,
    "while the batch counter says 0 - both numbers are true, and neither is the other's unit",
  );
  const printed = turnAccountLine(account);
  const parsed = readTurnAccountLine(printed);
  assert.equal(parsed.assistantTurns.examined, 169);
  assert.equal(parsed.assistantTurns.withText, 133);
  assert.equal(parsed.assistantTurns.toolOnly, 36);
  assert.equal(parsed.silentSettled.total, 0, "and the batch reading is printed beside it under its own unit");
  assert.ok(
    printed.startsWith(`${ASSISTANT_TURNS_EXAMINED} 169 {`),
    `the unit is stated at the head of the line: ${printed}`,
  );
  assert.ok(
    printed.includes(`· ${PER_DELIVERED_BATCH} turns opened 1 {`),
    `and again at the head of the batch group: ${printed}`,
  );
});

/**
 * THE FALSIFIER: a batch carrying two assistant records, one with a line and one without.
 *
 * <p>
 * This is the case that could not be counted before, in its smallest form. Through the BATCH it is one `worked` turn -
 * "with text 2, tool-only 0" - because any text in the batch speaks for all of it. Per assistant turn it is one that
 * carried text and one that ran a tool and said nothing. A counter that fired per batch would give `2 / 0` here and would
 * have passed the round60 replay above by accident of the batch it landed in.
 * </p>
 */
test("assistant turns: TWO records in one batch read as with text 1 · tool-only 1, not with text 2 · tool-only 0", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_two_records", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  pump.noteAssistantTurn({ hasText: true, hasToolCall: false });
  pump.noteAssistantTurn({ hasText: false, hasToolCall: true });
  await pump.flush(settledSink(pump, TURN_PRODUCTION.worked));

  const account = pump.turnAccount;
  assert.equal(account.opened, 1, "one delivered batch carried both records");
  assert.equal(assistantTurnsWithText(account.assistantTurns), 1, "the first record carried a line");
  assert.equal(assistantTurnsToolOnly(account.assistantTurns), 1, "the second ran a tool and said nothing");
  assert.equal(
    account.silentSettled.total,
    0,
    "the batch reading is what this unit corrects: a batch with any line is never silent, whatever its records did",
  );
  assert.equal(
    account.emptyTurns.total,
    0,
    "and it is not `turn_closed_without_action` either: the batch ran a tool, so no batch-level counter sees the silence",
  );
});

/**
 * The same two records the OTHER way round, and both speaking: the counter must follow the records, not the batch.
 *
 * Without this, `with text 1 · tool-only 1` above could be a counter that simply split every batch in half.
 */
test("assistant turns: two records that both spoke read as with text 2 · tool-only 0", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_both_spoke", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  pump.noteAssistantTurn({ hasText: true, hasToolCall: false });
  pump.noteAssistantTurn({ hasText: true, hasToolCall: true });
  await pump.flush(settledSink(pump, TURN_PRODUCTION.worked));

  const account = pump.turnAccount;
  assert.equal(account.assistantTurns.examined, 2);
  assert.equal(assistantTurnsWithText(account.assistantTurns), 2);
  assert.equal(
    assistantTurnsToolOnly(account.assistantTurns),
    0,
    "nothing was silent here, so nothing is counted as silence",
  );
});

/**
 * A message with neither text nor a tool call is counted as `said_nothing`, not dropped.
 *
 * It is the member `PROVIDER_EMPTY_COMPLETION` already refuses to bless: a provider that answered with nothing. Dropping
 * it would make `examined` a population that silently lost a member - `round60`'s "neither 0" is a measurement, and a
 * measurement has to be able to come out non-zero.
 */
test("assistant turns: a record with neither text nor a tool call is `said_nothing`, and the population still adds up", () => {
  const pump = new CompanionEventPump();
  pump.noteAssistantTurn({ hasText: false, hasToolCall: false });
  pump.noteAssistantTurn({ hasText: true, hasToolCall: false });

  const tally = pump.turnAccount.assistantTurns;
  assert.equal(tally.byProduction[TURN_PRODUCTION.saidNothing], 1);
  assert.equal(tally.examined, 2);
  assert.equal(
    Object.values(tally.byProduction).reduce((total, count) => total + count, 0),
    tally.examined,
    "every member is in the population, so an empty message cannot vanish into the difference",
  );
});

/**
 * `clear()` is a session boundary: nothing carries across it, in either unit.
 */
test("assistant turns: a cleared pump carries no assistant turn into the next session", () => {
  const pump = new CompanionEventPump();
  pump.noteAssistantTurn({ hasText: false, hasToolCall: true });
  assert.equal(pump.turnAccount.assistantTurns.examined, 1);
  pump.clear();
  const tally = pump.turnAccount.assistantTurns;
  assert.equal(tally.examined, 0);
  assert.deepEqual(tally.byProduction, assistantProductionCounts({}));
});

test("the account line that counts its turns but not the reading it aged is REFUSED: a diagnosis needs its numerator", () => {
  // THE FALSIFIER for the segment this unit adds, and the exact line `round50b` printed: every turn, every shape, and a
  // refresh pair that said `0` twice. Both zeros were true and the line could not distinguish "the cure never fired" from
  // "no turn was aged" - which is why the population is printed before the counters rather than instead of them.
  const measured =
    "turns opened 2 {player_input: 1, world_fact: 1, observation: 0, due: 0} · suppressed 0 {observation_restated: 0, " +
    "world_fact_restated: 0, nothing_pending: 0} · flushes examined 2 · turn_closed_without_action 2 " +
    "{player_input:world_stale: 1, player_input:body_held: 0, player_input:nothing_pending: 0, world_fact:world_stale: 0, " +
    "world_fact:body_held: 0, world_fact:nothing_pending: 1, observation:world_stale: 0, observation:body_held: 0, " +
    "observation:nothing_pending: 0, due:world_stale: 0, due:body_held: 0, due:nothing_pending: 0} · turn_settled_silent 0 " +
    "{world_fact: 0, observation: 0, due: 0} · auto_observe_on_stale 0 · auto_observe_unavailable 0 {no_bridge: 0, " +
    "refresh_attempts_spent: 0, refresh_refused: 0}";
  assert.throws(
    () => readTurnAccountLine(measured),
    new RegExp(`turn_settled_silent, ${TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT}, ${AUTO_OBSERVE_AGED_TURNS}`, "u"),
    "a run whose one aged turn is not printed cannot say whether the world was ever asked about it",
  );
});

test("the account line that named its turns but not its refreshes is REFUSED: a removed turn must be countable", () => {
  // THE FALSIFIER for the two segments, and the exact line this repo printed for `round47` after `04301c28`: every
  // opener, every suppression, every empty-turn shape - and not one word about a stale notice. A refresh costs no turn,
  // so a line without these two segments cannot tell "the stale notices stopped opening turns" from "the stale notices
  // stopped happening".
  const previous =
    "turns opened 64 {player_input: 1, world_fact: 55, observation: 6, due: 2} · suppressed 12 {observation_restated: 6, " +
    "world_fact_restated: 3, nothing_pending: 3} · flushes examined 76 · turn_closed_without_action 41 " +
    "{player_input:world_stale: 0, player_input:body_held: 0, player_input:nothing_pending: 0, world_fact:world_stale: 11, " +
    "world_fact:body_held: 9, world_fact:nothing_pending: 21, observation:world_stale: 0, observation:body_held: 0, " +
    "observation:nothing_pending: 0, due:world_stale: 0, due:body_held: 0, due:nothing_pending: 0}";
  assert.throws(
    () => readTurnAccountLine(previous),
    new RegExp(`turn_settled_silent, ${TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT}, ${AUTO_OBSERVE_AGED_TURNS}`, "u"),
    "a turn the refresh removed leaves no trace in that line, which is why the removal was uncountable",
  );
});

/** A sink that says how the turn it was handed ended, which is what the loop's own sink publishes to the pump. */
function speakingSink(
  pump: CompanionEventPump,
  production: (typeof TURN_PRODUCTION)[keyof typeof TURN_PRODUCTION] = TURN_PRODUCTION.spoke,
  batches: PendingBatch[] = [],
): { deliver(batch: PendingBatch): Promise<"completed"> } {
  return {
    async deliver(batch) {
      batches.push(batch);
      pump.turnProduction = production;
      return "completed" as const;
    },
  };
}

const BODY_FREE = Object.freeze({ location: "Farm", gameTime: "0740", actionable: true });

function readingAt(revision: number, observedTick: number, payload: Readonly<Record<string, unknown>>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: WINDOW_AT_MS + observedTick,
    payload,
  };
}

test("turn_closed_without_action: a speaking turn with a stale reading is counted, and its opener is named", async () => {
  // THE MEASURED SHAPE (round47): 41 of 64 turns delivered speech and no action, while the reading stood still for
  // eighteen turns. The turn itself was legitimate - the pump opened it for news - so the defect is that nothing in the
  // run's account could say how many turns were this shape.
  const pump = new CompanionEventPump();
  const sink = speakingSink(pump);

  // Turn one: the reading arrives with a settlement. The batch brings the observation, and the body is free.
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(sink);
  assert.equal(pump.turnAccount.opened, 1);
  assert.equal(
    pump.turnAccount.emptyTurns.byShape[`${TURN_OPENING.worldFact}:${TURN_WITHOUT_ACTION_REASON.nothingPending}`],
    1,
    "a fresh reading and a free body, and she only spoke: that is the zero-cost exit with nothing in its way",
  );

  // Turn two: the Host re-states the same reading and publishes a clock milestone - the turn opens, the reading is old.
  pump.enqueueFact(readingAt(14, 1, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(milestoneFact(600, WINDOW_AT_MS + 60_000), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);

  const account = pump.turnAccount;
  const staleShape = turnWithoutActionShape(TURN_OPENING.worldFact, TURN_WITHOUT_ACTION_REASON.worldStale);
  assert.equal(account.emptyTurns.byShape[staleShape], 1, "a turn that acted on a reading it did not bring");
  assert.equal(account.emptyTurns.total, 2);

  const printed = turnAccountLine(account);
  const parsed = readTurnAccountLine(printed);
  assert.equal(parsed.emptyTurns.total, 2);
  assert.equal(parsed.emptyTurns.counts[staleShape], 1);
  assert.equal(parsed.byReason[TURN_OPENING.worldFact], 2, "and the line says WHICH opener produced them");
  assert.ok(
    printed.includes(`${TURN_WITHOUT_ACTION} 2 {`),
    "the empty-turn count and its shapes are on the same line, so one grep answers both halves",
  );
  assert.equal(
    parsed.emptyTurns.counts[staleShape],
    1,
    `the shape printed is ${turnWithoutActionToken(TURN_OPENING.worldFact, TURN_WITHOUT_ACTION_REASON.worldStale)}`,
  );

  // Turn three: the same settlement re-stated, and the reading re-stated - the flush is suppressed, so it is not a turn
  // and must not be counted as one. The count stays where it was and the suppression names its reason.  pump.enqueueFact(readingAt(14, 2, BODY_FREE));
  pump.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 120_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(sink);

  const afterSuppression = pump.turnAccount;
  assert.equal(afterSuppression.opened, 2, "a suppressed flush opens no turn");
  assert.equal(afterSuppression.emptyTurns.total, 2, "and an empty turn that never ran is not an empty turn");
  assert.equal(afterSuppression.lastDecision?.kind, "not_owed");
  assert.equal(afterSuppression.lastDecision?.reason, NOT_OWED.worldFactRestated);
  assert.equal(
    readTurnAccountLine(turnAccountLine(afterSuppression)).notOwed.counts[NOT_OWED.worldFactRestated],
    1,
    "the line names the reason the flush was suppressed, so `fewer turns` stays distinguishable from `lost turns`",
  );
});

test("turn_closed_without_action: the same flush suppressed rather than opened counts nothing", async () => {
  // The other half of the red proof: the SAME flush that produced a count above, suppressed, leaves the count at zero
  // and names the reason. A counter that incremented on every examined flush would pass the test above and be blind to
  // the difference between a turn that happened and one that did not.
  const pump = new CompanionEventPump();
  const sink = speakingSink(pump);
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  assert.equal(pump.turnAccount.emptyTurns.total, 1);

  const suppressed = new CompanionEventPump();
  suppressed.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  suppressed.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS),
    FACT_PRODUCER.adapterIngress,
  );
  await suppressed.flush(speakingSink(suppressed));
  const before = suppressed.turnAccount.emptyTurns.total;

  // Now the same content again: nothing pending that she does not already have.
  suppressed.enqueueFact(readingAt(14, 1, BODY_FREE), FACT_PRODUCER.adapterIngress);
  suppressed.enqueueFact(
    settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 60_000),
    FACT_PRODUCER.adapterIngress,
  );
  await suppressed.flush(speakingSink(suppressed));

  const account = suppressed.turnAccount;
  assert.equal(account.lastDecision?.kind, "suppressed");
  assert.equal(account.emptyTurns.total, before, "a suppressed flush moved no count");
  const parsed = readTurnAccountLine(turnAccountLine(account));
  assert.equal(
    parsed.notOwed.counts[NOT_OWED.worldFactRestated],
    1,
    "and the line says which reason answered the flush instead",
  );
});

test("turn_closed_without_action: a turn that ran a tool, or said nothing, is not one", async () => {
  // THE FALSIFIERS for the count above: the same fixture, with only the turn's production changed. A counter that
  // counted every turn would pass the test above and answer nothing.
  const worked = new CompanionEventPump();
  worked.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  worked.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await worked.flush(speakingSink(worked, TURN_PRODUCTION.worked));
  assert.equal(worked.turnAccount.emptyTurns.total, 0, "a turn that moved something is not an empty turn");

  const silent = new CompanionEventPump();
  silent.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  silent.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await silent.flush(speakingSink(silent, TURN_PRODUCTION.saidNothing));
  assert.equal(
    silent.turnAccount.emptyTurns.total,
    0,
    "a turn that carried no text said nothing, and is not this shape",
  );
});

test("turn_closed_without_action: a held body is its own reason, and a fresh observation is not stale", async () => {
  // The three reasons have to be told apart or the count says one number for three different conditions. `body_held` is
  // the shape round47 named in her own account: the farmhouse door put her in `身体: 忙（不可行动）` and she read it as
  // "nothing may be submitted this turn".
  const held = new CompanionEventPump();
  held.enqueueFact(
    readingAt(14, 0, { ...BODY_FREE, actionable: false, actorDispositionKind: "modal" }),
    FACT_PRODUCER.adapterIngress,
  );
  held.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await held.flush(speakingSink(held));

  const heldShape = turnWithoutActionShape(TURN_OPENING.worldFact, TURN_WITHOUT_ACTION_REASON.bodyHeld);
  assert.equal(held.turnAccount.emptyTurns.byShape[heldShape], 1);
  assert.equal(
    held.turnAccount.emptyTurns.byShape[`${TURN_OPENING.worldFact}:${TURN_WITHOUT_ACTION_REASON.worldStale}`],
    0,
    "this turn BROUGHT the reading, so the world was not the reason it ended without an action",
  );

  const fresh = new CompanionEventPump();
  fresh.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  fresh.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await fresh.flush(speakingSink(fresh));
  assert.equal(
    fresh.turnAccount.emptyTurns.byShape[`${TURN_OPENING.worldFact}:${TURN_WITHOUT_ACTION_REASON.nothingPending}`],
    1,
    "a current picture and a free body is `nothing_pending`, which is the shape the measurement exists to expose",
  );
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The other half of the same settlement: the turn that had nothing to say.                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * `turn_settled_silent` is a turn that delivered NO speech, counted by the opener that owed it one - acting or not.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`): 188 planned nodes across 55 turns, 41 of 64 assistant turns counted as
 * `turn_closed_without_action`, 376 s of model turns that acted against 239 s of pure talk. Those 41 are one statement -
 * she spoke and did nothing. But the plan tool's description ended "…end your turn and speak to the player", and a
 * terminal receipt is a non-held fact that opens a follow-up turn, so a turn whose outstanding work had ALL settled
 * arrives with nothing in it to do, and speech was the only sanctioned thing to spend it on. Nothing in the run's account
 * could separate that turn from one she chose to spend talking, which is what this reading exists to do.
 * </p>
 * <p>
 * MEASURED 2026-11-15 (`round58`): the other shape had no name at all. 21 turns opened, 21 bubbles, this counter `0` -
 * and every one of those turns both acted and spoke. The acting turn that says NOTHING is `workedSilently`, and it lands
 * here; that is the half of the vocabulary this unit added (`turnProduction`).
 * </p>
 * <p>
 * It is a READING and not a ban: no prompt rule, no suppression, no refusal. The falsifiers below hold the halves apart -
 * a turn that spoke is `turn_closed_without_action` and never this, a turn that acted AND spoke is neither, a turn that
 * acted and said nothing IS this whether or not its own receipt is still open, a turn that did nothing at all is neither,
 * and the person's own opener is never silence.
 * </p>
 */

/** A sink that reports how the turn it was handed ended; the two silent members are the silence this unit measures. */
function settledSink(
  pump: CompanionEventPump,
  production: TurnProduction,
  outcome: "completed" | "error" = "completed",
  batches: PendingBatch[] = [],
): { deliver(batch: PendingBatch): Promise<"completed" | "error"> } {
  return {
    async deliver(batch) {
      batches.push(batch);
      pump.turnProduction = production;
      return outcome;
    },
  };
}

/**
 * The window in the brief: one free body reading, one settlement, and a turn that delivered work with no word about it.
 *
 * The receipt batch is the fact that opens it (`world_fact`), and `workedSilently` is the loop's own report that the
 * delivery ran a tool and carried no assistant text - so this fixture is the shape the run could not count, not a shape
 * invented for the counter.
 */
test("turn_settled_silent: a receipt batch that carried no speech is named, with the opener that owed the turn", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r47_silent", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(settledSink(pump, TURN_PRODUCTION.workedSilently));

  const account = pump.turnAccount;
  assert.equal(
    account.opened,
    1,
    "a receipt opened a turn, which is the whole premise: silence happened INSIDE a turn",
  );
  assert.equal(account.silentSettled.total, 1);
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.worldFact], 1, "and the line says what owed it");
  assert.equal(
    account.emptyTurns.total,
    0,
    "a turn that said nothing is not `turn_closed_without_action`: that one is the turn she spent on speech",
  );

  const printed = turnAccountLine(account);
  const parsed = readTurnAccountLine(printed);
  assert.equal(parsed.silentSettled.total, 1);
  assert.deepEqual(parsed.silentSettled.counts, account.silentSettled.byOpener);
  assert.ok(
    printed.includes(`· ${TURN_SETTLED_SILENT} 1 {world_fact: 1,`),
    `the silent count and its openers are on the account line: ${printed}`,
  );
});

test("turn_settled_silent: a due wake that worked without a word is counted under its own opener", async () => {
  // The other opener the closed list names. A Host-owned schedule coming due (`HOST_MINTED_WAKE_KINDS`) is not a receipt
  // and not a person: the counter must name `due`, or the histogram says the world owed every silent turn when a third of
  // them were her own schedule. The reading rides along and decides nothing, as it does on every turn.
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    settlementFact("program_settled_plan_r47_refresh", WINDOW_AT_MS + 1_000),
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(settledSink(pump, TURN_PRODUCTION.spoke));
  assert.equal(pump.turnAccount.silentSettled.total, 0, "the first turn spoke, so nothing is counted yet");

  pump.enqueueFact(readingAt(15, 1, { ...BODY_FREE, gameTime: "0741" }), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    {
      ...settlementFact("execution_stalled_exec_r47_1", WINDOW_AT_MS + 2_000),
      semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
      correlationId: "exec_r47",
      executionId: "exec_r47",
      payload: { kind: EXECUTION_STALL_SEMANTIC_KIND, executionId: "exec_r47", elapsedMs: 120_000, stallFactsSoFar: 1 },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await pump.flush(settledSink(pump, TURN_PRODUCTION.workedSilently));

  const account = pump.turnAccount;
  assert.equal(account.opened, 2);
  assert.equal(account.silentSettled.total, 1);
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.due], 1);
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.worldFact], 0);
  assert.equal(
    account.emptyTurns.total,
    1,
    "and the spoken turn is the empty one, so the two readings disagree by design",
  );
});

test("turn_settled_silent: spoke, acted-and-spoke and the person's own are not silence, in flight or not", async () => {
  // THE FALSIFIERS. Each case is the fixture above with exactly one thing changed, so a counter that fired on any
  // completed turn, or on any quiet one, would fail here while passing the test above.
  const spoke = new CompanionEventPump();
  spoke.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  spoke.enqueueFact(settlementFact("program_settled_plan_r47_spoke", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await spoke.flush(settledSink(spoke, TURN_PRODUCTION.spoke));
  assert.equal(
    spoke.turnAccount.silentSettled.total,
    0,
    "she spoke: that is `turn_closed_without_action`, not silence",
  );
  assert.equal(spoke.turnAccount.emptyTurns.total, 1);

  const acted = new CompanionEventPump();
  acted.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  acted.enqueueFact(settlementFact("program_settled_plan_r47_acted", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await acted.flush(settledSink(acted, TURN_PRODUCTION.worked));
  assert.equal(
    acted.turnAccount.silentSettled.total,
    0,
    "she acted and said what she did: `worked` is still the speaking member, so this turn is neither counter's",
  );
  assert.equal(acted.turnAccount.emptyTurns.total, 0);

  // The other half of the same falsifier, and the one `round58` could not distinguish: the SAME act with no word about it
  // is silence. If this counter fired on any acting turn, the case above would be red instead of this one being green.
  // The narration run is moved first (one speaking turn) so the reset below is a reading that changed rather than a zero
  // that was already there.
  const actedQuietly = new CompanionEventPump();
  actedQuietly.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  actedQuietly.enqueueFact(
    settlementFact("program_settled_plan_r47_narrated", WINDOW_AT_MS),
    FACT_PRODUCER.adapterIngress,
  );
  await actedQuietly.flush(settledSink(actedQuietly, TURN_PRODUCTION.spoke));
  assert.equal(
    actedQuietly.narrationWithoutWork.turns,
    1,
    "one speaking turn is the run this reset is measured against",
  );
  const emptyBefore = actedQuietly.turnAccount.emptyTurns.total;
  assert.equal(emptyBefore, 1, "and that speaking turn is the empty one, counted where it belongs");

  actedQuietly.enqueueFact(
    {
      ...settlementFact("program_settled_plan_r47_acted_quietly", WINDOW_AT_MS + 1_000),
      // A different plan, because the pump remembers what it has already handed her: the identical payload under a fresh
      // event id is `world_fact_restated` and opens no turn at all.
      payload: { ...RECORDED_SETTLEMENT, programId: "plan_r47_acted_quietly" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await actedQuietly.flush(settledSink(actedQuietly, TURN_PRODUCTION.workedSilently));
  assert.equal(
    actedQuietly.turnAccount.silentSettled.total,
    1,
    "work done without a word about it is the acting-and-silent turn, and it lands here rather than nowhere",
  );
  assert.equal(actedQuietly.turnAccount.silentSettled.byOpener[TURN_OPENING.worldFact], 1);
  assert.equal(
    actedQuietly.turnAccount.emptyTurns.total,
    emptyBefore,
    "and the silent working turn added nothing to `turn_closed_without_action`: she acted, she just did not say so",
  );
  assert.equal(
    actedQuietly.narrationWithoutWork.turns,
    0,
    "silent work still resets the narration run: what the counter separates is speech, not work",
  );

  // AND THE ONE THE IN-FLIGHT CONDITION USED TO DECIDE: the same open receipt, on a turn that SPOKE. `round59`'s probe B
  // could not tell "she said nothing" from "her own receipt was still open", because both produced `0`. This case keeps
  // the two apart from the other side: a receipt in flight is not what makes a turn silent, and it is not what stops a
  // speaking turn from counting here - only the speech does.
  const working = new CompanionEventPump();
  working.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  working.enqueueFact(settlementFact("program_settled_plan_r47_working", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await working.flush({
    async deliver() {
      working.turnProduction = TURN_PRODUCTION.worked;
      working.enqueueFact(
        {
          source: "stardew_mod",
          kind: "execution_receipt",
          correlationId: "execution_still_running",
          revision: 15,
          occurredAtMs: WINDOW_AT_MS + 2_000,
          payload: { state: "running" },
        },
        FACT_PRODUCER.adapterIngress,
      );
      return "completed" as const;
    },
  });
  assert.equal(working.hasExecutionInFlight, true, "the receipt that arrived DURING the turn is the one that matters");
  assert.equal(
    working.turnAccount.silentSettled.total,
    0,
    "she worked AND said what she did: the receipt still open changes neither reading",
  );
  assert.equal(working.turnAccount.settledWithExecutionInFlight, 1, "and the settlement says the receipt was open");

  // The person's own turn: a turn someone opened is owed an answer, and its emptiness is a different defect with its own
  // name. The counter's population is derived from `SILENT_SETTLED_OPENINGS`, which is `TURN_OPENINGS` minus this member.
  const asked = new CompanionEventPump();
  asked.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_input_silent",
    text: "接着做。",
    locale: "zh-CN",
    timestampMs: WINDOW_AT_MS,
  });
  await asked.flush(settledSink(asked, TURN_PRODUCTION.saidNothing));
  assert.equal(asked.turnAccount.lastDecision?.reason, TURN_OPENING.playerInput);
  assert.equal(asked.turnAccount.silentSettled.total, 0, "the person spoke, so this silence is not `nothing to say`");

  // A turn Pi reported as ended rather than completed: nothing here may read it as a settled one.
  const ended = new CompanionEventPump();
  ended.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  ended.enqueueFact(settlementFact("program_settled_plan_r47_ended", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await ended.flush(settledSink(ended, TURN_PRODUCTION.saidNothing, "error"));
  assert.equal(ended.turnAccount.silentSettled.total, 0, "an aborted or errored turn settled nothing at all");
});

/**
 * THE SHAPE THE COUNTER COULD NOT SEE: work delivered, no text, and her own programme still running when the turn closed.
 *
 * <p>
 * MEASURED 2026-11-15 (`round59`, `42 settled turns · with text 42 · tool-only 0`): this counter printed `0`, and the two
 * probes that produced it - one turn with an `accepted`/`running` receipt of its own in flight, one with nothing in flight -
 * differed in exactly one bit. The counter required that NOTHING was in flight, so the silent worker had nowhere to land:
 * she submits a programme on nearly every turn, which means her own receipt was in flight at settlement on 28 of 36
 * programme turns, and a run in which she said nothing on all of them would still have printed `turn_settled_silent 0`.
 * The `0` therefore measured the counter's own condition rather than her choice.
 * </p>
 * <p>
 * THE SHAPE OF SILENCE IS THE ONE `TURN_PRODUCTION` ALREADY NAMES: work delivered and no text (`workedSilently`). Whether
 * a receipt is still in flight says how long the turn's own work has left to run - it is not whether the turn was silent,
 * and it is now COUNTED rather than used to exclude: `turn_settled_with_execution_in_flight` says how many settled turns
 * closed with one of her executions running, so the next reader does not have to reconstruct the condition from logs.
 * </p>
 */
test("turn_settled_silent: a turn that submits a programme and settles with its own receipt in flight IS silence", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r59_self", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver() {
      // The turn ran the plan tool and delivered no text: that is `workedSilently`. Its programme is executing as it closes.
      pump.turnProduction = TURN_PRODUCTION.workedSilently;
      pump.enqueueFact(
        {
          source: "stardew_mod",
          kind: "execution_receipt",
          correlationId: "execution_r59_self_weed_row",
          revision: 15,
          occurredAtMs: WINDOW_AT_MS + 2_000,
          payload: { state: "running" },
        },
        FACT_PRODUCER.adapterIngress,
      );
      return "completed" as const;
    },
  });

  assert.equal(pump.hasExecutionInFlight, true, "the premise: her own programme is still running as the turn closes");
  const account = pump.turnAccount;
  assert.equal(
    account.silentSettled.total,
    1,
    `a turn that worked and said nothing is silence whether or not its receipt is still open: ${turnAccountLine(account)}`,
  );
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.worldFact], 1, "and under the opener that owed the turn");
  assert.equal(
    account.settledWithExecutionInFlight,
    1,
    "and the account says the receipt was open at settlement, which is the number a reader had to infer from logs",
  );
  assert.equal(account.emptyTurns.total, 0, "it delivered no speech, so it is not the turn spent on speech either");
});

test("turn_settled_silent: a settled turn that produced neither work nor text is not silence", async () => {
  // THE FALSIFIER for the shape above: the counter names WORK without a word, not the absence of both. A completed turn
  // that reached `said_nothing` asked for no tool and produced no text - it did nothing, and "there was nothing to say" is
  // a statement about a turn that had something to do. Reading it as silence would count a provider answering nothing as a
  // choice she made.
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r59_idle", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(settledSink(pump, TURN_PRODUCTION.saidNothing));
  assert.equal(pump.turnAccount.opened, 1, "the premise: the turn opened");
  assert.equal(
    pump.turnAccount.silentSettled.total,
    0,
    "nothing was done and nothing was said, which is not the shape this counter exists to name",
  );
  assert.equal(
    pump.turnAccount.settledWithExecutionInFlight,
    0,
    "and nothing of hers was running, so that number is zero",
  );
});

test("turn_settled_silent: the account line this tree printed before this unit cannot name a silent turn", () => {
  // THE FALSIFIER for the segment, on the exact line the printer produced before this unit: `round47`'s counted shapes,
  // the two refresh segments, and not one word about a turn that delivered nothing. A run reading that line can only
  // answer "41 turns closed on speech" - the shape the measurement never had a name for.
  const before =
    "turns opened 64 {player_input: 1, world_fact: 55, observation: 6, due: 2} · suppressed 12 {observation_restated: 6, " +
    "world_fact_restated: 3, nothing_pending: 3} · flushes examined 76 · turn_closed_without_action 41 " +
    "{player_input:world_stale: 0, player_input:body_held: 0, player_input:nothing_pending: 0, world_fact:world_stale: 11, " +
    "world_fact:body_held: 9, world_fact:nothing_pending: 21, observation:world_stale: 0, observation:body_held: 0, " +
    "observation:nothing_pending: 0, due:world_stale: 0, due:body_held: 0, due:nothing_pending: 0} · " +
    "auto_observe_on_stale 1 {ageTurns: 20} · auto_observe_unavailable 0 {no_bridge: 0, refresh_attempts_spent: 0, " +
    "refresh_refused: 0}";
  assert.throws(
    () => readTurnAccountLine(before),
    new RegExp(`${TURN_SETTLED_SILENT}, ${TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT}, ${AUTO_OBSERVE_AGED_TURNS}`, "u"),
    "a line that cannot say a turn settled with nothing said is refused rather than read as an account",
  );
});

/**
 * One revision's `event-pump.ts` - the module BEFORE a unit - emitted and made importable, or `undefined` when that
 * revision is not reachable from this clone.
 *
 * Written outside the repository: `dist-test` is a locked, inventoried artifact, and a stray module in it would be
 * indistinguishable from a half-written build. The relative imports are rewritten against this file's own directory, which
 * is the compiled tree at run time, so the pre-change module imports the SAME collaborators this one does.
 */
function compilePreChangePump(revision: string, mustNotCarry: string): string | undefined {
  let source: string;
  try {
    source = execFileSync("git", ["-C", HOST_ROOT, "show", `${revision}:host/src/event-pump.ts`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  // The pin must BE the pre-change module: if it ever named a tree that already carries the unit, the red proof below
  // would pass by agreeing with itself.
  assert.equal(
    source.includes(mustNotCarry),
    false,
    `${revision}:host/src/event-pump.ts already carries ${mustNotCarry}, so it is not the pre-change module`,
  );
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "event-pump.ts",
  }).outputText;
  const rewritten = emitted.replace(
    /from "(\.[^"]+)"/gu,
    (_match, specifier: string) => `from "${pathToFileURL(resolve(HERE, specifier)).href}"`,
  );
  const directory = mkdtempSync(join(tmpdir(), "gamebuddy-pre-change-silence-"));
  const file = join(directory, `event-pump.${revision}.pre-change.mjs`);
  writeFileSync(file, rewritten, "utf8");
  return file;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(HERE, "..");

/** The commit whose `event-pump.ts` is the module BEFORE this unit: `9bbadccf` is the tree this unit lands on. */
const PRE_CHANGE_REVISION = "9bbadccf";

/** The commit whose `event-pump.ts` is the module BEFORE the per-assistant-turn unit: `9c539da8` is the tree it lands on. */
const PRE_ASSISTANT_TURN_REVISION = "9c539da8";

test("turn_settled_silent: the pre-change module refuses the name, and this one prints it on the same fixture", async () => {
  // THE RED PROOF, on the REAL module: the same receipt batch, the same `workedSilently` delivery, one module compiled out
  // of `f11b519d` and one this tree. Before, the run's account had no `turn_settled_silent` at all and its account object
  // had no reading to ask - so the silent turn was invisible, not merely uncounted. After, the same turn is named.
  const before = compilePreChangePump(PRE_CHANGE_REVISION, TURN_SETTLED_SILENT);
  if (before === undefined) {
    console.log(
      `not_measured: the pre-change module was not compiled, so the red reading is BLOCKED - ` +
        `${PRE_CHANGE_REVISION}:host/src/event-pump.ts is not reachable from this clone`,
    );
  } else {
    const pre = (await import(pathToFileURL(before).href)) as {
      CompanionEventPump: new () => CompanionEventPump;
      turnAccountLine(account: never): string;
    };
    const pump = new pre.CompanionEventPump();
    pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(settlementFact("program_settled_plan_r47_before", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
    await pump.flush({
      async deliver() {
        pump.turnProduction = TURN_PRODUCTION.workedSilently;
        return "completed" as const;
      },
    });
    const beforeLine = pre.turnAccountLine(pump.turnAccount as never);
    assert.equal(
      beforeLine.includes(TURN_SETTLED_SILENT),
      false,
      `the pre-change account could not name this turn: ${beforeLine}`,
    );
    assert.equal(
      "silentSettled" in pump.turnAccount,
      false,
      "and nothing on its account answered the question, so the reader had to infer a shape from the line beside it",
    );
    assert.equal(
      pump.turnAccount.emptyTurns.total,
      0,
      "it also could not see the turn as an empty one: it said nothing",
    );
    console.log(`silent fixture BEFORE: ${beforeLine}`);
  }

  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r47_before", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(settledSink(pump, TURN_PRODUCTION.workedSilently));
  const afterLine = turnAccountLine(pump.turnAccount);
  assert.equal(pump.turnAccount.silentSettled.total, 1);
  assert.ok(afterLine.includes(TURN_SETTLED_SILENT), `the same turn, on this tree: ${afterLine}`);
  console.log(`silent fixture AFTER:  ${afterLine}`);
});

test("assistant turns: the module this unit replaced delivered the silent turns and could not name one", async () => {
  // THE RED PROOF, on the REAL pre-change module: the same receipt batch, a `worked` delivery, one module compiled out of
  // `9c539da8` and one this tree. Before, an assistant turn was not a thing the pump could record - no hook took one, and no
  // counter was keyed by it - so `round60`'s 36 tool-only records had nowhere to land while the account printed
  // `turn_settled_silent 0`.
  const before = compilePreChangePump(PRE_ASSISTANT_TURN_REVISION, ASSISTANT_TURNS_EXAMINED);
  if (before === undefined) {
    console.log(
      `not_measured: the pre-change module was not compiled, so the red reading is BLOCKED - ` +
        `${PRE_ASSISTANT_TURN_REVISION}:host/src/event-pump.ts is not reachable from this clone`,
    );
    return;
  }
  const pre = (await import(pathToFileURL(before).href)) as {
    CompanionEventPump: new () => CompanionEventPump;
    turnAccountLine(account: never): string;
  };
  const pump = new pre.CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_r60_before", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver() {
      // The batch carried a line AND the silent work after it: `worked`, which is what 57 of round60's 86 batches were.
      pump.turnProduction = TURN_PRODUCTION.worked;
      return "completed" as const;
    },
  });
  const beforeLine = pre.turnAccountLine(pump.turnAccount as never);
  assert.equal(
    "noteAssistantTurn" in pump,
    false,
    "the pre-change pump had no hook that could record one assistant turn, so the unit did not exist",
  );
  assert.equal(
    beforeLine.includes(ASSISTANT_TURNS_EXAMINED),
    false,
    `and its account line carries no such unit: ${beforeLine}`,
  );
  assert.equal(
    beforeLine.includes(ASSISTANT_TURNS_TOOL_ONLY),
    false,
    "so `ran a tool and said nothing` was not a count any reader could ask for",
  );
  assert.equal(
    "assistantTurns" in pump.turnAccount,
    false,
    "and nothing on its account answered the question, so the 36 could only be recovered by reading the session file",
  );
  assert.equal(
    pump.turnAccount.silentSettled.total,
    0,
    "its own silence counter reads 0 for the batch that carried the line - the `0` round60 printed",
  );
  console.log(`assistant-turn fixture BEFORE: ${beforeLine}`);

  // The same batch, the same two records, on this tree: one with text, one tool-only, counted where they happened.
  const after = new CompanionEventPump();
  after.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
  after.enqueueFact(settlementFact("program_settled_plan_r60_before", WINDOW_AT_MS), FACT_PRODUCER.adapterIngress);
  after.noteAssistantTurn({ hasText: true, hasToolCall: false });
  after.noteAssistantTurn({ hasText: false, hasToolCall: true });
  await after.flush(settledSink(after, TURN_PRODUCTION.worked));
  const afterLine = turnAccountLine(after.turnAccount);
  assert.equal(assistantTurnsWithText(after.turnAccount.assistantTurns), 1);
  assert.equal(assistantTurnsToolOnly(after.turnAccount.assistantTurns), 1);
  assert.ok(
    afterLine.includes(`${ASSISTANT_TURNS_EXAMINED} 2 {`),
    `the same batch and the same two records, on this tree: ${afterLine}`,
  );
  console.log(`assistant-turn fixture AFTER:  ${afterLine}`);
});
