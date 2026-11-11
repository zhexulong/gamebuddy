import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  EXECUTION_STALL_SEMANTIC_KIND,
  HOST_MINTED_FACT_SOURCE,
  MAX_DELIVERED_FACT_IDENTITIES,
  TURN_OPENING,
  TURN_OPENINGS,
  TURN_SUPPRESSION,
  TURN_SUPPRESSIONS,
  factContentIdentity,
  turnAccountLine,
  type PendingBatch,
  type TurnAccount,
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

function readingFact(observedTick: number, revision = 14): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: WINDOW_AT_MS,
    payload: { location: "Farm", gameTime: "0740" },
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
      const reason =
        turn.inputs > 0
          ? TURN_SUPPRESSION.observationRestated
          : turn.revision >= 0
            ? TURN_SUPPRESSION.worldFactRestated
            : TURN_SUPPRESSION.nothingPending;
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
  pump.enqueueFact(readingFact(0));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS + 1_000));
  await pump.flush(recorder.sink);
  // Turn two: the Host re-states the last reading before every turn, and the same settlement is published again.
  pump.enqueueFact(readingFact(1));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", REPLAY_END_AT_MS));
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

  assert.deepEqual(reading.violations, [
    `${TURN_WITHOUT_NEW_CONTENT}:#2:${TURN_SUPPRESSION.worldFactRestated}:14:144000`,
  ]);
  assert.equal(reading.examined, 2, "and it says what it examined, so `0 violations` can be told from `0 examined`");
});

test("turn_without_new_content: zero population is blocked, never green", () => {
  const reading = turnWithoutNewContent([]);
  assert.equal(reading.violations.length, 0);
  assert.match(String(reading.blocked), /^zero_population:/u, "nothing examined is not nothing wrong");
});

test("suppressed_turn_is_named: every examined flush is either an opened turn or one counted reason", async () => {
  const pump = new CompanionEventPump();
  const recorder = recordingSink();
  const step = async (): Promise<void> => {
    const before = pump.turnAccount;
    await pump.flush(recorder.sink);
    const after = pump.turnAccount;
    const suppressedBefore = TURN_SUPPRESSIONS.reduce((total, reason) => total + before.suppressed[reason], 0);
    const suppressedAfter = TURN_SUPPRESSIONS.reduce((total, reason) => total + after.suppressed[reason], 0);
    const openedDelta = after.opened - before.opened;
    const suppressedDelta = suppressedAfter - suppressedBefore;
    assert.equal(after.examined - before.examined, 1, "every flush is examined exactly once");
    assert.equal(
      openedDelta + suppressedDelta,
      1,
      `a flush that neither opened a turn nor named a suppression is a turn lost in silence: ${JSON.stringify(after.lastDecision)}`,
    );
    if (openedDelta === 0) {
      assert.ok(
        TURN_SUPPRESSIONS.includes(after.lastDecision?.reason as never),
        `a suppression must carry a reason from the closed list, got ${String(after.lastDecision?.reason)}`,
      );
    }
  };

  await step(); // nothing pending at all
  pump.enqueueFact(readingFact(0, 14));
  pump.enqueueFact(milestoneFact(600, WINDOW_AT_MS));
  await step(); // the world-fact member, carrying the first reading
  pump.enqueueFact(readingFact(1, 14));
  await step(); // the same revision again: suppressed, and named
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await step(); // the world-fact member again
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000));
  await step(); // the re-statement of it: suppressed, and named

  const account = pump.turnAccount;
  assert.equal(account.suppressed[TURN_SUPPRESSION.nothingPending], 1);
  assert.equal(account.suppressed[TURN_SUPPRESSION.observationRestated], 1);
  assert.equal(account.suppressed[TURN_SUPPRESSION.worldFactRestated], 1);
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
  spoken.enqueueFact(readingFact(0));
  spoken.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await open(spoken, recorder.sink);
  spoken.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000));
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
  factPump.enqueueFact(milestoneFact(1200, WINDOW_AT_MS));
  await open(factPump, recorder.sink);

  // observation: a revision that moved past the one she was DELIVERED.
  const observationPump = new CompanionEventPump();
  observationPump.enqueueFact(readingFact(0, 14));
  observationPump.enqueueFact(milestoneFact(600, WINDOW_AT_MS));
  await open(observationPump, recorder.sink);
  observationPump.enqueueFact(readingFact(1, 15));
  await open(observationPump, recorder.sink);
  assert.deepEqual(observationPump.turnAccount.lastDecision, {
    kind: "opened",
    index: 2,
    reason: TURN_OPENING.observation,
  });

  // due: a Host-owned schedule coming due - the stall watch's own fact.
  const duePump = new CompanionEventPump();
  duePump.enqueueFact({
    ...settlementFact("execution_stalled_exec_1_1", WINDOW_AT_MS),
    semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
    correlationId: "exec_1",
    executionId: "exec_1",
    payload: { kind: EXECUTION_STALL_SEMANTIC_KIND, executionId: "exec_1", elapsedMs: 120_000, stallFactsSoFar: 1 },
  });
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
  pump.enqueueFact(readingFact(0));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await pump.flush(recorder.sink);
  const queueAfterFirstTurn = pump.pendingCount;

  // The settlement is published again, and the stall watch's fact arrives in the same breath: nothing may be lost by
  // the suppression that follows, and the watchdog's fact must not be swallowed by the re-statement beside it.
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000));
  const stall = pump.takeStallFact();
  assert.equal(stall, undefined, "the watch has nothing to say about an execution it never timed");
  pump.enqueueFact({
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
  });
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

  pump.enqueueFact(readingFact(0));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await pump.flush(recorder.sink);
  const readsAfterTurn = reads;
  assert.ok(readsAfterTurn > 0, "a delivered batch states the programme in flight");

  // A suppressed flush is not an observation of the journal, and must not consume or clear its reading.
  pump.enqueueFact(readingFact(1));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 1_000));
  await pump.flush(recorder.sink);
  assert.equal(pump.turnAccount.lastDecision?.kind, "suppressed");
  assert.equal(
    reads,
    readsAfterTurn,
    "the ledger is read when a batch is composed, never to decide whether to compose",
  );

  // The next turn that opens still carries it: suppression neither starved the observer nor hid its result.
  pump.enqueueFact(milestoneFact(1200, WINDOW_AT_MS + 2_000));
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
  pump.enqueueFact(first);
  await pump.flush(recorder.sink);

  for (let index = 1; index <= MAX_DELIVERED_FACT_IDENTITIES; index += 1) {
    pump.enqueueFact({
      ...settlementFact(`program_settled_plan_drain_${String(index)}`, WINDOW_AT_MS + index),
      payload: { ...RECORDED_SETTLEMENT, programId: `plan_drain_${String(index)}` },
    });
    await pump.flush(recorder.sink);
  }
  const opened = pump.turnAccount.opened;

  // The newest identity is still remembered: re-stating it is the defect this gate removes.
  pump.enqueueFact({
    ...settlementFact("program_settled_plan_drain_repeat", WINDOW_AT_MS + 1_000),
    payload: { ...RECORDED_SETTLEMENT, programId: `plan_drain_${String(MAX_DELIVERED_FACT_IDENTITIES)}` },
  });
  await pump.flush(recorder.sink);
  assert.equal(pump.turnAccount.opened, opened, "a re-statement inside the memory is still suppressed");

  // The first identity has been drained out, so it reads as news again: one extra turn, and nothing lost.
  pump.enqueueFact(first);
  await pump.flush(recorder.sink);
  assert.equal(
    pump.turnAccount.opened,
    opened + 1,
    "the drained identity opens a turn rather than silencing a fact for the rest of the run",
  );
});

test("the account prints in the shape the invariant is read back in", () => {
  const account: TurnAccount = Object.freeze({
    opened: 12,
    byReason: Object.freeze({
      [TURN_OPENING.playerInput]: 2,
      [TURN_OPENING.worldFact]: 7,
      [TURN_OPENING.observation]: 2,
      [TURN_OPENING.due]: 1,
    }),
    suppressed: Object.freeze({
      [TURN_SUPPRESSION.observationRestated]: 3,
      [TURN_SUPPRESSION.worldFactRestated]: 4,
      [TURN_SUPPRESSION.nothingPending]: 5,
    }),
    examined: 24,
    lastDecision: undefined,
  });
  assert.equal(
    turnAccountLine(account),
    "turns opened 12 · suppressed 12 {observation_restated: 3, world_fact_restated: 4, nothing_pending: 5} · flushes examined 24",
  );
});
