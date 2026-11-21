import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PLAN_SELF_WAIT_BUDGET_MS } from "../body-program-script.js";
import type { GameConnection } from "../game-connection.js";
import {
  createProgramSettlementReporter,
  PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS,
  PROGRAM_SETTLEMENT_WATCH_MAX_MS,
  type SettledProgramAnswer,
  watchProgramSettlement,
} from "../program-settlement-digest.js";
import {
  isTerminalProgramStatus,
  type PlanAnswerNode,
  waitForTerminalProgramStatus,
} from "../program-status-wait.js";
import type { Snapshot } from "../protocol.js";
import { ROOT } from "../wire-declaration.test-support.js";
import { planSelfWaitDecision, readPlanWorldSnapshot } from "./continuity-semantic-game-runtime-materializer.js";

/**
 * `a_settlement_delivered_in_the_tool_is_not_delivered_again:<program>` - one settlement, one delivery, whichever path
 * took it.
 *
 * <p>
 * THE DEFECT, AND HOW IT WAS FOUND. `submitProgram` starts a settlement watch for every accepted submission, and
 * `stardew_plan_work` then holds its own turn for a short plan's settlement (`planSelfWaitDecision`). Both paths read the
 * same terminal journal, so a plan answered INSIDE the tool call was announced again by the watch up to a second later -
 * a `program_settled` fact with a presentation lease, waking a second turn to re-read an outcome the model already held.
 * Measured `round84`: 40 of its 57 programmes fit one wait, so most of the run's settlements were delivered twice. The
 * second half of the same reading: the answer that came back first was a node LEDGER, so a model that read
 * `settled: true` and carried on was holding the world from before the work - `plan_5` had harvested the ripe crops into
 * the bag and `plan_127` had hoed the tile at 70,18 that `plan_137` plants on next, and neither fact is in a node row.
 * </p>
 *
 * <p>
 * POPULATION AND MECHANISM, BOTH FROM THE PRODUCT. It is every programme `round84` submitted (`plan-self-wait-round84`,
 * the same fixture `plan-self-wait.test.ts` reads, so the two gates cannot disagree about the run). Each one is replayed
 * through the REAL machinery: `createProgramSettlementReporter` (the claim), `watchProgramSettlement` (the unprompted
 * delivery), `waitForTerminalProgramStatus` (the turn-holding wait) and `readPlanWorldSnapshot` (the observation). The
 * hold is the product's own (`ProgramSettlementHold`), and so is the wait's bound; only the clock is virtual.
 * </p>
 *
 * <p>
 * WHAT FAILS. `reported-again` counts programmes with BOTH deliveries - a fact announced AND the settlement in a tool
 * result - and must be `0`, naming the programme and both paths when it is not. `snapshot-carried` must equal the
 * programmes whose held answer came back settled: a ledger-only return carries the node rows and nothing about the
 * world, which is the falsifier the third arm drives.
 * </p>
 *
 * <p>
 * WHAT IT DOES NOT MEASURE, said rather than implied. The clock is virtual, so a span is the run's recorded work time,
 * not the wall time a wait would have held; and the two loops are interleaved by this file's scheduler rather than by the
 * Host's event loop. Neither can change the verdict: R is 0 because the claim is taken by whichever path reads terminal
 * first and `report` refuses a claimed programme, which is an ordering-independent statement. The live confirmation is a
 * later run in this tree.
 * </p>
 */

type Programme = Readonly<{ programId: string; nodes: number; spanMs: number; continuedInTheSameTurn: boolean }>;

type Fixture = Readonly<{ source: string; run: string; programmes: readonly Programme[] }>;

const ROUND84: Fixture = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/plan-self-wait-round84.json"), "utf8"),
) as Fixture;

/** The nodes a programme of this size carries, as the answer joins on them (`PlanAnswerNode`). */
function compiledNodes(programme: Programme): readonly PlanAnswerNode[] {
  return Object.freeze(
    Array.from({ length: programme.nodes }, (_, index) =>
      Object.freeze({
        nodeId: `n${String(index + 1).padStart(2, "0")}`,
        actionId: "move_to_tile",
        arguments: Object.freeze({}),
      }),
    ),
  );
}

/** The journal at the virtual instant `clockMs`: `active` with one node running until the recorded span has passed. */
function journalAt(programme: Programme, clockMs: number): unknown {
  const settled = clockMs >= programme.spanMs;
  return {
    code: "found",
    snapshot: {
      programId: programme.programId,
      state: settled ? "succeeded" : "active",
      catalogRevision: 1,
      stopEpoch: 0,
      eventHighWater: settled ? 2 : 1,
      nodes: compiledNodes(programme).map((node, index) => ({
        nodeId: node.nodeId,
        actionId: node.actionId,
        state: settled ? "succeeded" : index === 0 ? "running" : "pending",
        nodeAttempt: 1,
        admissionAttempt: 1,
      })),
    },
    programs: null,
    programCount: 1,
  };
}

/**
 * A connection whose `observe` publishes `after` and whose held state is `before`.
 *
 * The same route `stardew_observe` calls, so the answer this gate measures is produced by the product's own reading
 * rather than a fixture's idea of it. `before: null` is the ordinary case (nothing was cached yet); the harvest case
 * passes the pre-work world to prove the answer is the FRESH one.
 */
function worldConnection(after: Snapshot, before: Snapshot | null = null): GameConnection {
  const state: { snapshot: Snapshot | null } = { snapshot: before };
  return {
    scope: { integrationId: "stardew" },
    module: {} as never,
    state,
    observe: async () => {
      state.snapshot = after;
      return after;
    },
  } as unknown as GameConnection;
}

/**
 * A virtual clock two loops can share without either one starving the other.
 *
 * <p>
 * `sleep` registers the instant its loop wants to wake instead of waiting; the clock advances to the EARLIEST pending
 * wake once every loop that can run has run - `setImmediate` is what says so, because all of the loops' own progress is
 * microtask work and drains before a macrotask. A shared clock that simply summed both sleep requests would let the
 * watch's one-second poll steal four of the wait's 250 ms polls per round, and the wait would expire on plans that really
 * do settle; that difference is why this exists rather than `clock += ms`.
 * </p>
 */
function virtualClock(): Readonly<{ now: () => number; sleep: (milliseconds: number) => Promise<void> }> {
  let clockMs = 0;
  let advancing = false;
  const sleepers: Array<{ at: number; wake: () => void }> = [];
  const advance = (): void => {
    if (advancing || sleepers.length === 0) return;
    advancing = true;
    setImmediate(() => {
      advancing = false;
      sleepers.sort((left, right) => left.at - right.at);
      const next = sleepers.shift();
      if (next === undefined) return;
      clockMs = Math.max(clockMs, next.at);
      next.wake();
      advance();
    });
  };
  return Object.freeze({
    now: () => clockMs,
    sleep: (milliseconds: number) =>
      new Promise<void>((wake) => {
        sleepers.push({ at: clockMs + Math.max(1, milliseconds), wake });
        advance();
      }),
  });
}

/** Which of the two halves of the contract a replay is driven with. Both `false` is the code this unit replaces. */
type Protocol = Readonly<{
  /** The waiting call takes `holdDelivery`, claims what it answers, and releases what it did not. */
  tellsTheWatch: boolean;
  /** The held answer carries `readPlanWorldSnapshot`'s reading of the world. */
  carriesTheWorld: boolean;
}>;

type Replay = Readonly<{
  programId: string;
  /** The product's own rule held this plan's turn (`planSelfWaitDecision`). */
  held: boolean;
  /** The wait ended on a terminal read, so the settlement is in the tool result. */
  settledInTheCall: boolean;
  /** How many `program_settled` facts reached the pump for this programme. */
  announced: number;
  /** The tool result carried an observation of the world. */
  snapshotCarried: boolean;
}>;

/** One programme through the real machinery: the watch the submit starts, and the turn the plan tool holds. */
async function replay(programme: Programme, protocol: Protocol): Promise<Replay> {
  const announced: string[] = [];
  const reporter = createProgramSettlementReporter((fact) => announced.push(fact.eventId ?? ""));
  const clock = virtualClock();
  const read = async () => journalAt(programme, clock.now());
  const nodes = compiledNodes(programme);
  const decision = planSelfWaitDecision(programme.nodes, undefined);
  const watching = watchProgramSettlement({
    read,
    onSettled: async (status) => {
      if (reporter.delivered(programme.programId)) return;
      reporter.report({
        programId: programme.programId,
        settledAtMs: programme.spanMs,
        compiled: nodes,
        status,
        nowMs: clock.now(),
      });
    },
    // THE GATE. While the call holds the program, the watch polls and announces nothing.
    ...(protocol.tellsTheWatch ? { heldByToolCall: () => reporter.heldByToolCall(programme.programId) } : {}),
    now: clock.now,
    sleep: clock.sleep,
    intervalMs: PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS,
    maxMs: PROGRAM_SETTLEMENT_WATCH_MAX_MS,
  });
  let settledInTheCall = false;
  let snapshotCarried = false;
  if (decision.wait) {
    const delivery = protocol.tellsTheWatch ? reporter.holdDelivery(programme.programId) : undefined;
    try {
      const first = await read();
      const outcome: Readonly<{ result: unknown; waited: Readonly<{ terminality: string }> }> =
        isTerminalProgramStatus(first)
          ? Object.freeze({ result: first, waited: Object.freeze({ terminality: "terminal" }) })
          : await waitForTerminalProgramStatus(read, first, decision.boundMs, clock.now, clock.sleep);
      settledInTheCall = outcome.waited.terminality === "terminal";
      if (settledInTheCall) delivery?.answerInTool();
      if (protocol.carriesTheWorld) {
        const reading = await readPlanWorldSnapshot(worldConnection(worldSnapshot(programme)));
        snapshotCarried = reading.snapshot !== undefined;
      }
    } finally {
      delivery?.release();
    }
  }
  await watching;
  return Object.freeze({
    programId: programme.programId,
    held: decision.wait,
    settledInTheCall,
    announced: announced.length,
    snapshotCarried,
  });
}

/** The world a held answer carries in this replay: a fresh reading, with the actor on the farm. */
function worldSnapshot(programme: Programme): Snapshot {
  return {
    revision: 1,
    catalogRevision: 1,
    location: "Farm",
    tile: { x: 69, y: 18 },
    inventoryItemFacts: [],
    seedTargets: [],
    note: programme.programId,
  } as unknown as Snapshot;
}

type Verdict = Readonly<{
  programmes: readonly Replay[];
  /** Programmes the rule holds, with the waiver it obeys. */
  waited: number;
  /** Of those, the ones whose settlement the call itself answered. */
  waitedAndSettled: number;
  /** Programmes with BOTH deliveries: the fact, and the tool result. Must be empty. */
  reportedAgain: readonly string[];
  /** Programmes whose tool answer carried an observation of the world. */
  snapshotCarried: number;
  /** Programmes whose hold gave up and whose settlement the watch then announced: the watch still has a job. */
  expiredAndDelivered: readonly string[];
  report: string;
}>;

async function verdictOver(programmes: readonly Programme[], protocol: Protocol): Promise<Verdict> {
  const replays: Replay[] = [];
  for (const programme of programmes) replays.push(await replay(programme, protocol));
  const waited = replays.filter((entry) => entry.held);
  const waitedAndSettled = waited.filter((entry) => entry.settledInTheCall);
  const reportedAgain = replays.filter((entry) => entry.announced > 0 && entry.settledInTheCall);
  const snapshotCarried = waited.filter((entry) => entry.snapshotCarried);
  const expiredAndDelivered = replays.filter((entry) => entry.held && !entry.settledInTheCall && entry.announced > 0);
  return Object.freeze({
    programmes: Object.freeze(replays),
    waited: waited.length,
    waitedAndSettled: waitedAndSettled.length,
    reportedAgain: Object.freeze(reportedAgain.map((entry) => entry.programId)),
    snapshotCarried: snapshotCarried.length,
    expiredAndDelivered: Object.freeze(expiredAndDelivered.map((entry) => entry.programId)),
    report:
      `a_settlement_delivered_in_the_tool_is_not_delivered_again: source ${ROUND84.run} · ` +
      `programs ${String(replays.length)} · held ${String(waited.length)} · ` +
      `waited-and-settled ${String(waitedAndSettled.length)} · ` +
      `reported-again ${String(reportedAgain.length)} · snapshot-carried ${String(snapshotCarried.length)} · ` +
      `expired-and-delivered ${String(expiredAndDelivered.length)}`,
  });
}

test("a_settlement_delivered_in_the_tool_is_not_delivered_again", async () => {
  const verdict = await verdictOver(ROUND84.programmes, { tellsTheWatch: true, carriesTheWorld: true });
  assert.equal(
    verdict.programmes.length,
    ROUND84.programmes.length,
    `the population is every programme the run submitted: ${verdict.report}`,
  );
  assert.ok(
    verdict.waitedAndSettled > 0,
    `blocked: no programme was both held and settled, so this gate examined nothing: ${verdict.report}`,
  );
  // THE LINE THIS FILE EXISTS FOR. A programme here was answered inside the tool call AND announced as a fact, so the
  // model was handed one settlement twice; the message names the programme and both paths, because that is what the next
  // reader has to look at.
  assert.deepEqual(
    verdict.reportedAgain,
    [],
    `a_settlement_delivered_in_the_tool_is_not_delivered_again: the same settlement reached the model twice - once ` +
      `inside the \`stardew_plan_work\` result (the held wait read it terminal) and once as the \`program_settled\` fact ` +
      `the settlement watch announced <= ${String(PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS)} ms later: ` +
      `${verdict.reportedAgain.join(", ")} · ${verdict.report}`,
  );
  // AND THE WORLD CAME WITH IT: an answer that holds the turn for the work it did and then returns only the node ledger
  // sends the model into its next decision holding the bag and the soil of before.
  assert.equal(
    verdict.snapshotCarried,
    verdict.waited,
    `every answer that held the turn for its own settlement must carry the observation \`stardew_observe\` would have ` +
      `made - the settled ones and the ones whose wait gave up alike: ${verdict.report}`,
  );
  // The watch still has a job: a hold whose wait gave up is released unclaimed, and the watch delivers that settlement.
  assert.ok(
    verdict.expiredAndDelivered.length > 0,
    `blocked: no held programme outlived its bound, so the watch's remaining delivery was never examined: ${verdict.report}`,
  );
  process.stdout.write(`\n${verdict.report}\n`);
});

/**
 * THE FALSIFIER, on this run's own programmes: the code this unit replaced - a wait that answers the settlement and
 * tells the watch nothing. Every held-and-settled programme is then delivered twice, and the ledger-only answer carries
 * no snapshot, so the same counting that reads green above reads red here.
 */
test("the pre-change delivery - a wait that does not tell the watch - is red on this run's own programmes", async () => {
  const before = await verdictOver(ROUND84.programmes, { tellsTheWatch: false, carriesTheWorld: false });
  assert.ok(before.waitedAndSettled > 0, `blocked: nothing was held, so nothing could be delivered twice: ${before.report}`);
  assert.equal(
    before.reportedAgain.length,
    before.waitedAndSettled,
    `every settlement the tool answered in-call must also be announced by the watch once nobody claims it: ${before.report}`,
  );
  assert.equal(before.snapshotCarried, 0, "a ledger-only return carries no observation at all");
});

/**
 * THE SECOND FALSIFIER, with the delivery half already fixed: the claim is taken, the fact is silent, and the answer
 * still hands back a node ledger. `snapshot-carried` is what goes red - the line that says "I did the work" is not the
 * world it did the work to.
 */
test("a ledger-only answer is red on the snapshot line, with the delivery already fixed", async () => {
  const ledgerOnly = await verdictOver(ROUND84.programmes, { tellsTheWatch: true, carriesTheWorld: false });
  assert.deepEqual(ledgerOnly.reportedAgain, [], `the delivery half stays fixed: ${ledgerOnly.report}`);
  assert.ok(ledgerOnly.waited > 0, `blocked: nothing held the turn, so nothing could carry a reading: ${ledgerOnly.report}`);
  assert.equal(
    ledgerOnly.snapshotCarried,
    0,
    "a ledger-only return carries no snapshot, and the gate's `snapshot-carried == held` line fails on it",
  );
  assert.notEqual(
    ledgerOnly.waited,
    ledgerOnly.snapshotCarried,
    `this is the assertion the gate makes, and a ledger-only return is what makes it red: ${ledgerOnly.report}`,
  );
});

test("one settlement, one delivery, whichever path takes it first", () => {
  const announced: string[] = [];
  const reporter = createProgramSettlementReporter((fact) => announced.push(fact.eventId ?? ""));
  const input = {
    programId: "plan_once",
    settledAtMs: 1_000,
    compiled: compiledNodes({ programId: "plan_once", nodes: 1, spanMs: 1_000, continuedInTheSameTurn: false }),
    status: journalAt({ programId: "plan_once", nodes: 1, spanMs: 1_000, continuedInTheSameTurn: false }, 2_000),
  };
  // 1. THE TOOL ANSWERS IT: the claim is taken under the hold, the watch's report then says nothing at all.
  const hold = reporter.holdDelivery("plan_once");
  assert.equal(reporter.heldByToolCall("plan_once"), true, "the watch must see the hold while it is out");
  hold.answerInTool();
  hold.release();
  assert.equal(reporter.heldByToolCall("plan_once"), false, "and must be free again once the call is done");
  assert.equal(reporter.delivered("plan_once"), true, "the settlement reached the model inside the tool result");
  assert.equal(reporter.report(input), undefined, "so the pump announces nothing for it");
  assert.equal(announced.length, 0, "and no fact was minted, which is the whole contract");
  // A poll of that program answers from the journal: there is no digest, because none was minted.
  assert.equal(reporter.settled("plan_once"), null, "a settlement answered in a tool result has no digest ledger");
  // 2. THE WATCH ANSWERS IT FIRST: the fact is the delivery, and the tool's later claim cannot announce a second.
  const first = createProgramSettlementReporter((fact) => announced.push(fact.eventId ?? ""));
  assert.ok(first.report(input) !== undefined, "the watch's delivery mints the one fact");
  assert.equal(first.report(input), undefined, "and a second read of the same program mints nothing");
  assert.deepEqual(announced, ["program_settled_plan_once"], "one program, one fact");
  // 3. THE HOLD RELEASED WITHOUT A CLAIM: a wait that gave up. The watch still owes this program its delivery.
  const giving = createProgramSettlementReporter((fact) => announced.push(fact.eventId ?? ""));
  const gave = giving.holdDelivery("plan_once");
  gave.release();
  assert.equal(giving.delivered("plan_once"), false, "a released hold claims nothing");
  const settled: SettledProgramAnswer | null = giving.settled("plan_once");
  assert.equal(settled, null);
  assert.ok(giving.report(input) !== undefined, "so the watch announces it when the plan does settle");
});

/**
 * THE CONTENT PROOF FOR THE SNAPSHOT LINE, on `round84`'s own harvest-and-till pair.
 *
 * `plan_5` harvested the ripe crops into the bag (`harvestTargets` → `inventoryItemFacts`), `plan_127` hoed the tile at
 * 70,18 (`till_soil`), and `plan_137` then planted there - which the Mod can only offer as a `seedTargets` row once the
 * soil is hoed. So "I did the work" and "here is the world that work left" differ by exactly two rows, and a return that
 * carries neither is a return the model has to spend a `stardew_observe` to make sense of.
 */
test("the harvest-and-till pair comes back with a snapshot that shows the bag and the soil", async () => {
  const before = {
    revision: 12,
    catalogRevision: 1,
    location: "Farm",
    tile: { x: 69, y: 18 },
    inventoryItemFacts: [{ slot: 11, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", stack: 5 }],
    harvestTargets: [{ targetId: "crop_69_18", x: 69, y: 18, qualifiedItemId: "(O)24" }],
    seedTargets: [],
  } as unknown as Snapshot;
  const after = {
    revision: 13,
    catalogRevision: 1,
    location: "Farm",
    tile: { x: 69, y: 18 },
    inventoryItemFacts: [
      { slot: 3, qualifiedItemId: "(O)24", displayName: "Parsnip", stack: 3 },
      { slot: 11, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", stack: 5 },
    ],
    harvestTargets: [],
    seedTargets: [{ targetId: "seed_70_18", slot: 11, x: 70, y: 18, qualifiedItemId: "(O)472" }],
  } as unknown as Snapshot;
  const reading = await readPlanWorldSnapshot(worldConnection(after, before));
  // What the answer must SHOW: the harvested crop in the bag, and the hoed tile offered as a seed target.
  const shows = (answer: Readonly<Record<string, unknown>>): boolean => {
    const snapshot = answer.snapshot as
      | Readonly<{
          inventoryItemFacts?: readonly Readonly<{ qualifiedItemId: string }>[];
          seedTargets?: readonly Readonly<{ x: number; y: number }>[];
        }>
      | undefined;
    const inTheBag = (snapshot?.inventoryItemFacts ?? []).some((row) => row.qualifiedItemId === "(O)24");
    const soilReady = (snapshot?.seedTargets ?? []).some((row) => row.x === 70 && row.y === 18);
    return inTheBag && soilReady;
  };
  assert.equal(shows(reading), true, `the answer must carry both rows: ${JSON.stringify(reading)}`);
  assert.equal(reading.snapshotRevision, 13, "and it is the FRESH reading, not the pre-work one it replaced");
  assert.equal(reading.snapshotSource, "stardew_bridge_observe", "and it says where it came from");
  // The falsifier: the ledger-only return this unit replaces.
  assert.equal(shows({}), false, "a ledger-only return shows neither, so the assertion above is not vacuous");

  // A FAILED OBSERVATION IS NOT A CACHED ONE. The pre-work world is still in the connection and must not be handed over
  // as though it were current: what the model gets is the reason it has no reading.
  const stale = worldConnection(after, before);
  (stale as unknown as { observe: () => Promise<Snapshot> }).observe = async () => {
    throw new Error("bridge_response_timeout");
  };
  const failed = await readPlanWorldSnapshot(stale);
  assert.deepEqual(failed, { snapshotUnavailable: "snapshot_unavailable:observe_failed" }, "a stale world is never the answer");
  // And a connection with no observation route at all says that, rather than omitting the field: "no change" and "not
  // read" are different facts.
  assert.deepEqual(await readPlanWorldSnapshot({} as GameConnection), {
    snapshotUnavailable: "snapshot_unavailable:observation_route_unavailable",
  });
  // The bound the plan answer's turn and its observation share, stated once so the replay's bound is the product's.
  assert.ok(PLAN_SELF_WAIT_BUDGET_MS > 0, "the held turn has a bound, and it is the one the wait above used");
});
