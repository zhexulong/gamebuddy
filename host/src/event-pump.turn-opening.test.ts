import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  AUTO_OBSERVE_ON_STALE,
  AUTO_OBSERVE_UNAVAILABLE,
  AUTO_OBSERVE_UNAVAILABLE_REASONS,
  AUTO_OBSERVE_UNAVAILABLE_TOKEN,
  CompanionEventPump,
  EXECUTION_STALL_SEMANTIC_KIND,
  emptyTurnShapes,
  factContentIdentity,
  HOST_MINTED_FACT_SOURCE,
  MAX_DELIVERED_FACT_IDENTITIES,
  type PendingBatch,
  SILENT_SETTLED_OPENINGS,
  TURN_OPENING,
  TURN_OPENINGS,
  TURN_PRODUCTION,
  TURN_SETTLED_SILENT,
  TURN_SUPPRESSION,
  TURN_SUPPRESSIONS,
  TURN_WITHOUT_ACTION,
  TURN_WITHOUT_ACTION_REASON,
  type TurnAccount,
  type TurnProduction,
  turnAccountLine,
  turnWithoutActionShape,
  turnWithoutActionToken,
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

/** One `label N {counts}` segment, or one `label N` segment with no histogram. */
function parseSegment(segment: string): Readonly<{ label: string; total: number; counts: Record<string, number> }> {
  const matched = /^([\w ]+) (\d+)(?: \{(.*)\})?$/u.exec(segment);
  assert.ok(matched !== null, `the account line carries a segment this reader cannot parse: ${segment}`);
  const label = matched[1];
  const total = matched[2];
  assert.ok(
    typeof label === "string" && typeof total === "string",
    `the account line carries a segment this reader cannot parse: ${segment}`,
  );
  return Object.freeze({ label, total: Number(total), counts: parseCounts(matched[3] ?? "") });
}

/**
 * The account line READ BACK, so the assertion is the inverse of the printer rather than a copy of its output.
 *
 * A hand-written expected string can only pin what its author remembered; this reader refuses a line that lost a
 * segment, so a printer that silently dropped the opener histogram fails here by name. The six labels are the things a
 * run's account has to answer: how many turns opened and why, how many flushes were suppressed and why, how many were
 * examined, how many turns closed on speech alone and of which shape, how many settled with nothing said and what opened
 * them, and what the stale path did instead of a turn.
 */
function readTurnAccountLine(line: string): Readonly<{
  opened: number;
  byReason: Record<string, number>;
  suppressed: Readonly<{ total: number; counts: Record<string, number> }>;
  examined: number;
  emptyTurns: Readonly<{ total: number; counts: Record<string, number> }>;
  silentSettled: Readonly<{ total: number; counts: Record<string, number> }>;
  autoObserve: Readonly<{
    refreshed: Readonly<{ total: number; counts: Record<string, number> }>;
    unavailable: Readonly<{ total: number; counts: Record<string, number> }>;
  }>;
}> {
  const segments = line.split(SEGMENT_SEPARATOR).map(parseSegment);
  const labels = [
    "turns opened",
    "suppressed",
    "flushes examined",
    TURN_WITHOUT_ACTION,
    TURN_SETTLED_SILENT,
    AUTO_OBSERVE_ON_STALE,
    AUTO_OBSERVE_UNAVAILABLE_TOKEN,
  ];
  assert.deepEqual(
    segments.map((segment) => segment.label),
    labels,
    `the account line's segments are ${labels.join(", ")}: a missing one is a reading nobody can recover`,
  );
  const [
    openedSegment,
    suppressedSegment,
    examinedSegment,
    emptySegment,
    silentSegment,
    observedSegment,
    declinedSegment,
  ] = segments as [
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
    ReturnType<typeof parseSegment>,
  ];
  return Object.freeze({
    opened: openedSegment.total,
    byReason: openedSegment.counts,
    suppressed: Object.freeze({ total: suppressedSegment.total, counts: suppressedSegment.counts }),
    examined: examinedSegment.total,
    emptyTurns: Object.freeze({ total: emptySegment.total, counts: emptySegment.counts }),
    silentSettled: Object.freeze({ total: silentSegment.total, counts: silentSegment.counts }),
    autoObserve: Object.freeze({
      refreshed: Object.freeze({ total: observedSegment.total, counts: observedSegment.counts }),
      unavailable: Object.freeze({ total: declinedSegment.total, counts: declinedSegment.counts }),
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

/** The stale path's own account, with every declared unavailability reason printed even at zero. */
function autoObserveAccount(
  refreshed: Readonly<{ refreshed: number; lastAgeTurns: number | undefined }>,
  unavailable: Readonly<Record<string, number>> = {},
): TurnAccount["autoObserve"] {
  const byReason: Record<string, number> = {};
  for (const reason of AUTO_OBSERVE_UNAVAILABLE_REASONS) byReason[reason] = unavailable[reason] ?? 0;
  return Object.freeze({
    refreshed: refreshed.refreshed,
    lastAgeTurns: refreshed.lastAgeTurns,
    unavailable: Object.freeze(byReason),
  });
}

test("the account line reads back into the account it names", () => {
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
    autoObserve: autoObserveAccount({ refreshed: 4, lastAgeTurns: 20 }, { [AUTO_OBSERVE_UNAVAILABLE.refused]: 1 }),
    lastDecision: undefined,
  });
  const parsed = readTurnAccountLine(turnAccountLine(account));

  assert.equal(parsed.opened, account.opened);
  assert.deepEqual(parsed.byReason, account.byReason, "every opener is printed WITH its count, not only the total");
  assert.equal(parsed.suppressed.total, 12);
  assert.deepEqual(parsed.suppressed.counts, account.suppressed);
  assert.equal(parsed.examined, account.examined);
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
});

test("the account line names a member that never fired, in both histograms", () => {
  // `opened 55` with no histogram was the measured line: it said how many turns the run paid for and nothing about what
  // opened them. The population is the closed lists, so a member at zero is printed as `0` rather than left out.
  const account: TurnAccount = Object.freeze({
    opened: 1,
    byReason: Object.freeze({
      [TURN_OPENING.playerInput]: 1,
      [TURN_OPENING.worldFact]: 0,
      [TURN_OPENING.observation]: 0,
      [TURN_OPENING.due]: 0,
    }),
    suppressed: Object.freeze({
      [TURN_SUPPRESSION.observationRestated]: 0,
      [TURN_SUPPRESSION.worldFactRestated]: 0,
      [TURN_SUPPRESSION.nothingPending]: 0,
    }),
    examined: 1,
    emptyTurns: Object.freeze({ total: 0, byShape: Object.freeze(emptyTurnShapeCounts({})) }),
    silentSettled: Object.freeze({ total: 0, byOpener: Object.freeze(silentSettledCounts({})) }),
    autoObserve: autoObserveAccount({ refreshed: 0, lastAgeTurns: undefined }),
    lastDecision: undefined,
  });
  const parsed = readTurnAccountLine(turnAccountLine(account));

  assert.deepEqual(
    Object.keys(parsed.byReason),
    [...TURN_OPENINGS],
    "the opener population is the closed list itself, so a new opener cannot be opened without being counted",
  );
  assert.deepEqual(Object.keys(parsed.emptyTurns.counts), [...emptyTurnShapes()]);
  assert.deepEqual(
    Object.keys(parsed.silentSettled.counts),
    [...SILENT_SETTLED_OPENINGS],
    "the silent openers are derived from the opener list, so the one a turn cannot fall silent on never appears",
  );
  assert.deepEqual(Object.keys(parsed.suppressed.counts), [...TURN_SUPPRESSIONS]);
  assert.deepEqual(
    Object.keys(parsed.autoObserve.unavailable.counts),
    [...AUTO_OBSERVE_UNAVAILABLE_REASONS],
    "and the reasons a refresh could not be asked are all printed, so `nobody asked` is a stated zero",
  );
});

test("the account line this repo printed before the change is REFUSED by the reader", () => {
  // THE FALSIFIER for the shape above. This is the exact line `round47` printed for 55 turns - `turns opened 55` with
  // no histogram of what opened them and no statement about how those turns ended.
  const measured =
    "turns opened 55 · suppressed 0 {observation_restated: 0, world_fact_restated: 0, nothing_pending: 0} · flushes examined 55";
  assert.throws(
    () => readTurnAccountLine(measured),
    /turns opened, suppressed, flushes examined, turn_closed_without_action, turn_settled_silent, auto_observe_on_stale, auto_observe_unavailable/u,
    "a line that cannot say what opened its turns is not an account, and must not read as one",
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
    /turn_settled_silent, auto_observe_on_stale, auto_observe_unavailable/u,
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
  pump.enqueueFact(readingAt(14, 0, BODY_FREE));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS + 1_000));
  await pump.flush(sink);
  assert.equal(pump.turnAccount.opened, 1);
  assert.equal(
    pump.turnAccount.emptyTurns.byShape[`${TURN_OPENING.worldFact}:${TURN_WITHOUT_ACTION_REASON.nothingPending}`],
    1,
    "a fresh reading and a free body, and she only spoke: that is the zero-cost exit with nothing in its way",
  );

  // Turn two: the Host re-states the same reading and publishes a clock milestone - the turn opens, the reading is old.
  pump.enqueueFact(readingAt(14, 1, BODY_FREE));
  pump.enqueueFact(milestoneFact(600, WINDOW_AT_MS + 60_000));
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
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 120_000));
  await pump.flush(sink);

  const afterSuppression = pump.turnAccount;
  assert.equal(afterSuppression.opened, 2, "a suppressed flush opens no turn");
  assert.equal(afterSuppression.emptyTurns.total, 2, "and an empty turn that never ran is not an empty turn");
  assert.equal(afterSuppression.lastDecision?.kind, "suppressed");
  assert.equal(afterSuppression.lastDecision?.reason, TURN_SUPPRESSION.worldFactRestated);
  assert.equal(
    readTurnAccountLine(turnAccountLine(afterSuppression)).suppressed.counts[TURN_SUPPRESSION.worldFactRestated],
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
  pump.enqueueFact(readingAt(14, 0, BODY_FREE));
  pump.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await pump.flush(sink);
  assert.equal(pump.turnAccount.emptyTurns.total, 1);

  const suppressed = new CompanionEventPump();
  suppressed.enqueueFact(readingAt(14, 0, BODY_FREE));
  suppressed.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await suppressed.flush(speakingSink(suppressed));
  const before = suppressed.turnAccount.emptyTurns.total;

  // Now the same content again: nothing pending that she does not already have.
  suppressed.enqueueFact(readingAt(14, 1, BODY_FREE));
  suppressed.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_2", WINDOW_AT_MS + 60_000));
  await suppressed.flush(speakingSink(suppressed));

  const account = suppressed.turnAccount;
  assert.equal(account.lastDecision?.kind, "suppressed");
  assert.equal(account.emptyTurns.total, before, "a suppressed flush moved no count");
  const parsed = readTurnAccountLine(turnAccountLine(account));
  assert.equal(
    parsed.suppressed.counts[TURN_SUPPRESSION.worldFactRestated],
    1,
    "and the line says which reason answered the flush instead",
  );
});

test("turn_closed_without_action: a turn that ran a tool, or said nothing, is not one", async () => {
  // THE FALSIFIERS for the count above: the same fixture, with only the turn's production changed. A counter that
  // counted every turn would pass the test above and answer nothing.
  const worked = new CompanionEventPump();
  worked.enqueueFact(readingAt(14, 0, BODY_FREE));
  worked.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await worked.flush(speakingSink(worked, TURN_PRODUCTION.worked));
  assert.equal(worked.turnAccount.emptyTurns.total, 0, "a turn that moved something is not an empty turn");

  const silent = new CompanionEventPump();
  silent.enqueueFact(readingAt(14, 0, BODY_FREE));
  silent.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
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
  held.enqueueFact(readingAt(14, 0, { ...BODY_FREE, actionable: false, actorDispositionKind: "modal" }));
  held.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
  await held.flush(speakingSink(held));

  const heldShape = turnWithoutActionShape(TURN_OPENING.worldFact, TURN_WITHOUT_ACTION_REASON.bodyHeld);
  assert.equal(held.turnAccount.emptyTurns.byShape[heldShape], 1);
  assert.equal(
    held.turnAccount.emptyTurns.byShape[`${TURN_OPENING.worldFact}:${TURN_WITHOUT_ACTION_REASON.worldStale}`],
    0,
    "this turn BROUGHT the reading, so the world was not the reason it ended without an action",
  );

  const fresh = new CompanionEventPump();
  fresh.enqueueFact(readingAt(14, 0, BODY_FREE));
  fresh.enqueueFact(settlementFact("program_settled_plan_r46_weed_row_1", WINDOW_AT_MS));
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
 * `turn_settled_silent` is a turn that delivered NO speech and ran no action, counted by the opener that owed it one.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`): 188 planned nodes across 55 turns, 41 of 64 assistant turns counted as
 * `turn_closed_without_action`, 376 s of model turns that acted against 239 s of pure talk. Those 41 are one statement -
 * she spoke and did nothing. But the plan tool's description ends with "…end your turn and speak to the player", and a
 * terminal receipt is a non-held fact that opens a follow-up turn, so a turn whose outstanding work had ALL settled
 * arrives with nothing in it to do, and speech was the only sanctioned thing to spend it on. Nothing in the run's account
 * could separate that turn from one she chose to spend talking, which is what this reading exists to do.
 * </p>
 * <p>
 * It is a READING and not a ban: no prompt rule, no suppression, no refusal. The falsifiers below hold the two halves
 * apart - a turn that spoke is `turn_closed_without_action` and never this, a turn that acted is neither, a body still
 * working is silence-as-waiting rather than nothing to say, and the person's own opener is never silence.
 * </p>
 */

/** A sink that reports how the turn it was handed ended; `saidNothing` is the silence this unit measures. */
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
 * The window in the brief: one free body reading, one settlement, and a turn that delivered neither speech nor action.
 *
 * The receipt batch is the fact that opens it (`world_fact`), and `saidNothing` is the loop's own report that the delivery
 * carried no assistant text - so this fixture is the shape the run could not count, not a shape invented for the counter.
 */
test("turn_settled_silent: a receipt batch that carried no speech is named, with the opener that owed the turn", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE));
  pump.enqueueFact(settlementFact("program_settled_plan_r47_silent", WINDOW_AT_MS + 1_000));
  await pump.flush(settledSink(pump, TURN_PRODUCTION.saidNothing));

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

test("turn_settled_silent: an observation refresh that found nothing to say is counted under its own opener", async () => {
  // The other opener the brief names. `#snapshotAdvanced` decides it: a revision she has not been shown, delivered alone,
  // with no tool run and no speech. The counter must name `observation`, not `world_fact`, or the histogram says the Host
  // owed every silent turn when half of them were the world.
  const pump = new CompanionEventPump();
  pump.enqueueFact(readingAt(14, 0, BODY_FREE));
  pump.enqueueFact(settlementFact("program_settled_plan_r47_refresh", WINDOW_AT_MS + 1_000));
  await pump.flush(settledSink(pump, TURN_PRODUCTION.spoke));
  assert.equal(pump.turnAccount.silentSettled.total, 0, "the first turn spoke, so nothing is counted yet");

  pump.enqueueFact(readingAt(15, 1, { ...BODY_FREE, gameTime: "0741" }));
  await pump.flush(settledSink(pump, TURN_PRODUCTION.saidNothing));

  const account = pump.turnAccount;
  assert.equal(account.opened, 2);
  assert.equal(account.silentSettled.total, 1);
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.observation], 1);
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.worldFact], 0);
  assert.equal(
    account.emptyTurns.total,
    1,
    "and the spoken turn is the empty one, so the two readings disagree by design",
  );
});

test("turn_settled_silent: the turns that are NOT silent - spoke, acted, still working, or the person's own", async () => {
  // THE FALSIFIERS. Each case is the fixture above with exactly one thing changed, so a counter that fired on any
  // completed turn, or on any quiet one, would fail here while passing the test above.
  const spoke = new CompanionEventPump();
  spoke.enqueueFact(readingAt(14, 0, BODY_FREE));
  spoke.enqueueFact(settlementFact("program_settled_plan_r47_spoke", WINDOW_AT_MS));
  await spoke.flush(settledSink(spoke, TURN_PRODUCTION.spoke));
  assert.equal(
    spoke.turnAccount.silentSettled.total,
    0,
    "she spoke: that is `turn_closed_without_action`, not silence",
  );
  assert.equal(spoke.turnAccount.emptyTurns.total, 1);

  const acted = new CompanionEventPump();
  acted.enqueueFact(readingAt(14, 0, BODY_FREE));
  acted.enqueueFact(settlementFact("program_settled_plan_r47_acted", WINDOW_AT_MS));
  await acted.flush(settledSink(acted, TURN_PRODUCTION.worked));
  assert.equal(acted.turnAccount.silentSettled.total, 0, "she acted, so the turn was not spent on nothing");
  assert.equal(acted.turnAccount.emptyTurns.total, 0);

  // Her body still working: the delivery carried no speech because there was something to WAIT for. Counting it as
  // "nothing to say" would name a busy companion silent, which is the mistake the narration counter already refuses.
  const working = new CompanionEventPump();
  working.enqueueFact(readingAt(14, 0, BODY_FREE));
  working.enqueueFact(settlementFact("program_settled_plan_r47_working", WINDOW_AT_MS));
  await working.flush({
    async deliver() {
      working.turnProduction = TURN_PRODUCTION.saidNothing;
      working.enqueueFact({
        source: "stardew_mod",
        kind: "execution_receipt",
        correlationId: "execution_still_running",
        revision: 15,
        occurredAtMs: WINDOW_AT_MS + 2_000,
        payload: { state: "running" },
      });
      return "completed" as const;
    },
  });
  assert.equal(working.hasExecutionInFlight, true, "the receipt that arrived DURING the turn is the one that matters");
  assert.equal(working.turnAccount.silentSettled.total, 0, "silence with work behind it is a wait, not an ending");

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
  ended.enqueueFact(readingAt(14, 0, BODY_FREE));
  ended.enqueueFact(settlementFact("program_settled_plan_r47_ended", WINDOW_AT_MS));
  await ended.flush(settledSink(ended, TURN_PRODUCTION.saidNothing, "error"));
  assert.equal(ended.turnAccount.silentSettled.total, 0, "an aborted or errored turn settled nothing at all");
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
    new RegExp(`${TURN_SETTLED_SILENT}, auto_observe_on_stale`, "u"),
    "a line that cannot say a turn settled with nothing said is refused rather than read as an account",
  );
});

/**
 * `9bbadccf`'s `event-pump.ts` - the module BEFORE this unit - emitted and made importable, or `undefined` when that
 * revision is not reachable from this clone.
 *
 * Written outside the repository: `dist-test` is a locked, inventoried artifact, and a stray module in it would be
 * indistinguishable from a half-written build. The relative imports are rewritten against this file's own directory, which
 * is the compiled tree at run time, so the pre-change module imports the SAME collaborators this one does.
 */
function compilePreChangePump(): string | undefined {
  let source: string;
  try {
    source = execFileSync("git", ["-C", HOST_ROOT, "show", `${PRE_CHANGE_REVISION}:host/src/event-pump.ts`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  // The pin must BE the pre-change module: if it ever named a tree that already carries this unit, the red proof below
  // would pass by agreeing with itself.
  assert.equal(
    source.includes(TURN_SETTLED_SILENT),
    false,
    `${PRE_CHANGE_REVISION}:host/src/event-pump.ts already carries ${TURN_SETTLED_SILENT}, so it is not the pre-change module`,
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
  const file = join(directory, "event-pump.pre-change.mjs");
  writeFileSync(file, rewritten, "utf8");
  return file;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(HERE, "..");

/** The commit whose `event-pump.ts` is the module BEFORE this unit: `9bbadccf` is the tree this unit lands on. */
const PRE_CHANGE_REVISION = "9bbadccf";

test("turn_settled_silent: the pre-change module refuses the name, and this one prints it on the same fixture", async () => {
  // THE RED PROOF, on the REAL module: the same receipt batch, the same `saidNothing` delivery, one module compiled out
  // of `f11b519d` and one this tree. Before, the run's account had no `turn_settled_silent` at all and its account object
  // had no reading to ask - so the silent turn was invisible, not merely uncounted. After, the same turn is named.
  const before = compilePreChangePump();
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
    pump.enqueueFact(readingAt(14, 0, BODY_FREE));
    pump.enqueueFact(settlementFact("program_settled_plan_r47_before", WINDOW_AT_MS));
    await pump.flush({
      async deliver() {
        pump.turnProduction = TURN_PRODUCTION.saidNothing;
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
  pump.enqueueFact(readingAt(14, 0, BODY_FREE));
  pump.enqueueFact(settlementFact("program_settled_plan_r47_before", WINDOW_AT_MS));
  await pump.flush(settledSink(pump, TURN_PRODUCTION.saidNothing));
  const afterLine = turnAccountLine(pump.turnAccount);
  assert.equal(pump.turnAccount.silentSettled.total, 1);
  assert.ok(afterLine.includes(TURN_SETTLED_SILENT), `the same turn, on this tree: ${afterLine}`);
  console.log(`silent fixture AFTER:  ${afterLine}`);
});
