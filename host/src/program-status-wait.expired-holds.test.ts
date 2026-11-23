import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PLAN_SELF_WAIT_BUDGET_MS } from "./body-program-script.js";
import { planSelfWaitDecision } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { PROGRAM_STATUS_WAIT_SETTLEMENTS, waitForTerminalProgramStatus } from "./program-status-wait.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * THE NINE HOLDS THAT ENDED IN A WORD, and the fact each one now carries instead.
 *
 * <p>
 * MEASURED 2026-11-23 (`round94`, `.live-runs/game-ladder/2026-11-23T03-13-05-598Z-multiday_routine`), from the run's
 * own session record and its journal trace: of 62 `stardew_plan_work` calls, 49 held their turn for the plan to settle.
 * **The median hold was 1,686 ms and 40 of the 49 were answered by it** - the wait is usually right. Nine spent 6,057 to
 * 6,148 ms of the 6,000 ms budget (`PLAN_SELF_WAIT_BUDGET_MS`) and every one of them came back `in_flight_not_done`:
 * 54.9 s of the run's waiting that ended with no statement of what was being waited for.
 * </p>
 * <p>
 * WHAT THE NINE WERE, answered from the artifacts rather than assumed. Not a stuck node and not a lost receipt: every one
 * of them is in `programTrace.jsonl` with its own `settledAtMs`, so the journal published a terminal state for all nine
 * and the pump owed nothing. Each is one dispatched node still `running` at the bound, in a plan whose own span ran from
 * 6,865 ms (`refill_watering_can`) to 328,317 ms (`sleep`) - `navigate_to_destination` at 55 s and 19 s, `ship_item` at
 * 22 s. The budget is derived from the plan's NODE COUNT (`planSelfWaitDecision`: nodes x `PLAN_NODE_PACE_MS`), so a
 * one-node plan is predicted at 629 ms and held for the 6,000 ms budget whatever its action is; the nine are the actions
 * that prediction does not describe, and waiting longer for them is what the run already paid for.
 * </p>
 * <p>
 * SO THE READINGS THIS FILE PROTECTS ARE TWO, and they pull in opposite directions. The median - 1,686 ms - must not
 * move: the wait is the right shape for the forty. The nine must stop answering with a bare word. A change that bought
 * the nine by holding the forty longer would fail here, which is why the replay below drives the recorded bound and
 * asserts the same clock.
 * </p>
 */

/** One call that held its turn, as the run recorded it. */
type Hold = Readonly<{
  programId: string;
  /** With what the caller asked to be answered: the whole bound is spent unless the plan settles inside it. */
  waitedMs: number;
  terminality: "terminal" | "active" | "unknown";
  snapshotChanged: boolean;
  /** The script the call submitted - what makes a node long, for the holds that ran out. */
  script: string;
  /** The last read of the wait, for the holds that ran out: the journal's own rows, verbatim. */
  lastRead?: Readonly<{
    code: string;
    snapshot: Readonly<{
      programId: string;
      state: string;
      stopEpoch: number;
      nodes: readonly Readonly<{ nodeId: string; actionId: string; state: string; x?: number; y?: number }>[];
    }>;
  }>;
  /** The node the answer's own `elapsedMs` was about. */
  node?: string;
  /** How long this Host had watched that node in its state when the hold expired. */
  observedInStateMs?: number;
  /** The journal's own span for the plan: its first `atMs` to its last `settledAtMs`. */
  journalSpanMs?: number;
}>;

type Fixture = Readonly<{
  source: string;
  run: string;
  recorded: Readonly<{
    planWorkCalls: number;
    held: number;
    medianHeldMs: number;
    atOrAbove5500: number;
    settledByTheHold: number;
    budgetMs: number;
    /** The keys every one of the 49 answers carried BESIDE the payload - what the caller was told. */
    waitedKeys: readonly string[];
  }>;
  holds: readonly Hold[];
}>;

const ROUND94: Fixture = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/program-status-wait-round94.json"), "utf8"),
) as Fixture;

/** The nine the run spent ~6 s on and never answered: the holds at or above the threshold the measurement named. */
const EXPIRED_HOLD_MS = 5_500;
const expired: readonly Hold[] = ROUND94.holds.filter((hold) => hold.waitedMs >= EXPIRED_HOLD_MS);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** The wait, driven with a fake clock over the read the run actually received, and nothing else. */
async function replay(hold: Hold) {
  assert.ok(hold.lastRead !== undefined, `${hold.programId} has no recorded last read to replay`);
  let clockMs = 0;
  let reads = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      reads += 1;
      return hold.lastRead;
    },
    hold.lastRead,
    hold.waitedMs,
    () => clockMs,
    async (milliseconds) => {
      clockMs += milliseconds;
    },
  );
  return { outcome, clockMs, reads };
}

test("the median hold is the run's own, and the nine are the minority it does not describe", () => {
  const holds = ROUND94.holds.map((hold) => hold.waitedMs);
  assert.equal(
    holds.length,
    ROUND94.recorded.held,
    `the fixture's rows disagree with its own held count: ${String(holds.length)}`,
  );
  assert.equal(
    ROUND94.recorded.budgetMs,
    PLAN_SELF_WAIT_BUDGET_MS,
    "the budget the holds were measured against is the product's",
  );
  // RE-DERIVED, not trusted: a fixture edited to flatter the change fails on the next three lines instead of passing.
  assert.equal(median(holds), ROUND94.recorded.medianHeldMs, `the median hold moved: ${String(median(holds))} ms`);
  assert.equal(
    holds.filter((waited) => waited >= EXPIRED_HOLD_MS).length,
    ROUND94.recorded.atOrAbove5500,
    "the population of expiries is not the one the run recorded",
  );
  assert.equal(
    ROUND94.holds.filter((hold) => hold.terminality === "terminal").length,
    ROUND94.recorded.settledByTheHold,
    "the holds the wait answered are not the run's own count",
  );
  // The two readings this file exists to keep apart, and the reason there is anything to fix: the median says the wait is
  // right nearly all the time, and the nine say that when it is not, the caller is handed a word.
  const report =
    `the_nine_holds_the_wait_could_not_answer: source ${ROUND94.run} · ` +
    `plan calls ${String(ROUND94.recorded.planWorkCalls)} · held ${String(holds.length)} · ` +
    `settled by the hold ${String(ROUND94.recorded.settledByTheHold)} · median hold ${String(median(holds))} ms · ` +
    `expired ${String(expired.length)} of ${String(holds.length)} · budget ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms`;
  assert.ok(expired.length > 0, `blocked: no hold expired, so this gate examined nothing: ${report}`);
  assert.ok(
    ROUND94.recorded.settledByTheHold > expired.length,
    `the wait is no longer usually right, so the nine are not the exception this file treats them as: ${report}`,
  );
  process.stdout.write(`\n${report}\n`);
});

/**
 * THE ANSWER, ON THE RUN'S OWN NINE.
 *
 * Each replay hands the wait the exact payload the call received at its deadline and the exact bound the call spent, so
 * what comes out is what the caller would have been told had the module already carried the block. The assertion is the
 * whole block rather than one field: the plan it names is the plan the call submitted, the node is the one the journal
 * had `running`, and the publication that would have ended it is that node's receipt.
 */
test("every one of the nine now answers with the node it was waiting on and what would settle it", async () => {
  const examined: string[] = [];
  for (const hold of expired) {
    const { outcome, clockMs } = await replay(hold);
    assert.equal(outcome.waited.terminality, "active", `${hold.programId} was not still running`);
    const row = hold.lastRead?.snapshot.nodes.find((node) => node.nodeId === hold.node);
    assert.ok(row !== undefined, `${hold.programId} has no recorded row for ${String(hold.node)}`);
    assert.deepEqual(
      outcome.waited.unsettled,
      {
        programId: hold.programId,
        node: { nodeId: hold.node, actionId: row.actionId, state: row.state },
        settlesWith: "node_receipt",
      },
      `${hold.programId}: the answer does not name the plan, the node and the publication that ends it`,
    );
    // THE HOLD IS THE RECORDED ONE. A change that bought the answer by reading or sleeping longer would move this.
    assert.equal(
      clockMs,
      hold.waitedMs,
      `${hold.programId}: the replay spent ${String(clockMs)} ms against a recorded ${String(hold.waitedMs)} ms`,
    );
    examined.push(
      `${hold.programId} ${String(hold.node)} ${row.actionId} ${row.state} observed ${String(hold.observedInStateMs)} ms · ` +
        `held ${String(hold.waitedMs)} ms · journal span ${String(hold.journalSpanMs)} ms · settles with ${outcome.waited.unsettled?.settlesWith ?? "?"}`,
    );
  }
  assert.equal(examined.length, ROUND94.recorded.atOrAbove5500, `examined ${String(examined.length)} expiries`);
  process.stdout.write(`\n${examined.join("\n")}\n`);
});

/**
 * THE ANSWER TO (1), MEASURED: what these nine have in common is that they were all still going, not that any of them
 * was stuck.
 *
 * A stuck node would have no terminal state in the journal, and a lost receipt would have one the Host never read. Every
 * one of the nine carries its own `settledAtMs`, and every one of those is past the bound - so the class is the third
 * one, "it was settling, later than the bound", and the reason it was later is that the bound never looked at the action.
 */
test("all nine settled after the bound, and none of them was stuck", () => {
  const report: string[] = [];
  for (const hold of expired) {
    const span = hold.journalSpanMs;
    assert.ok(
      span !== undefined && Number.isFinite(span),
      `${hold.programId} has no journal settle, so it is a stuck node`,
    );
    assert.ok(
      span > PLAN_SELF_WAIT_BUDGET_MS,
      `${hold.programId} settled in ${String(span)} ms, inside the bound, so it was not one of the nine`,
    );
    // THE PREDICTION THAT HELD THE TURN, from the product's own rule: it knows the plan's node count and nothing else, so
    // a one-node plan is predicted at the per-node pace and held for the budget. Every one of the nine ran for longer than
    // that prediction, and that is the whole of what they have in common.
    const nodeCount = hold.lastRead?.snapshot.nodes.length ?? 0;
    const decision = planSelfWaitDecision(nodeCount, undefined);
    assert.equal(decision.wait, true, `${hold.programId} was not held, so it is not one of the nine`);
    assert.ok(
      span > decision.predictedMs,
      `${hold.programId}: predicted ${String(decision.predictedMs)} ms and ran ${String(span)} ms`,
    );
    report.push(
      `${hold.programId} (${String(nodeCount)} node, predicted ${String(decision.predictedMs)} ms) ` +
        `${hold.script.split("\n")[0] ?? ""} → ${String(span)} ms`,
    );
  }
  assert.ok(
    expired.every((hold) => hold.lastRead?.snapshot.state === "active"),
    "an expired hold on a plan the journal had already stopped would be a different defect",
  );
  process.stdout.write(
    `\nthe nine settled ${String(expired.length)} of ${String(ROUND94.holds.length)}: ${report.join(" · ")}\n`,
  );
});

/**
 * THE RED PROOF, ON REAL HISTORY.
 *
 * `recorded.waitedKeys` is read out of the run's own answers: every one of the 49 carried those five keys beside the
 * payload and no sixth. So the block above is not a fact the caller already had under another name - it is the fact the
 * nine were missing, and the population here is every answer the run produced.
 */
test("the run's own answers carried no statement of what was being waited on", async () => {
  assert.ok(ROUND94.recorded.waitedKeys.length > 0, "the fixture recorded no keys, so this proof examines nothing");
  assert.equal(
    ROUND94.recorded.waitedKeys.includes("unsettled"),
    false,
    `the run's answers already carried the block, so nothing here is new: ${ROUND94.recorded.waitedKeys.join(",")}`,
  );
  for (const hold of expired) {
    const { outcome } = await replay(hold);
    assert.ok(
      outcome.waited.unsettled !== null,
      `${hold.programId}: the replay has no block, so the gate above could pass without the code carrying it`,
    );
  }
  assert.ok(
    expired.every((hold) => hold.terminality === "active"),
    "an expiry's own answer was `active`, which is the word the block turns into something a caller can choose from",
  );
  // The vocabulary the block answers in, published here so a reader of the fixture knows the three without opening the
  // module - and so a fourth member fails on this line rather than reaching a caller undocumented.
  assert.deepEqual([...PROGRAM_STATUS_WAIT_SETTLEMENTS].sort(), ["node_dispatch", "node_receipt", "program_terminal"]);
});
