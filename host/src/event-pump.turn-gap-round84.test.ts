import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_program_ends_and_the_body_waits:<plan>` - `round84`'s own reading, and the two waits the one number was hiding.
 *
 * <p>
 * THE POPULATION IS A REAL RUN. The fixture is `round84`'s `result.json` (`programOutcomes`: each programme's node count and
 * the millisecond span its nodes ran in) and its `run-trace.json` (`delivery` and `turn.tail` spans: each delivered turn's own
 * wall time and the window it was open in), excerpted verbatim.
 * </p>
 * <p>
 * WHAT IT REPRODUCES: **57 programmes, 56 switches, 1 overlap, 1,702.7 s spent between programmes**, gap median 9.68 s / p75
 * 18.26 s / max 249.5 s, a delivered turn of **10.12 s**, and 51 of the 57 programmes shorter than one turn.
 * </p>
 * <p>
 * AND THE SPLIT IS THE FINDING OF THIS ROUND. `1,702.7 s` was reported as one number for two rounds, so a wake rule was
 * tuned against it twice. It is **437.5 s of QUEUE WAIT** - the programme drained and the turn that composed the next one had
 * not settled yet, which is the only part a wake rule can move - and **1,265.2 s of TURN GAP** - a turn closed having
 * composed nothing, and nobody opened the next one. A reader who has one number will aim the next fix at the small one.
 * </p>
 * <p>
 * THE GATE THAT REPLACED THE THRESHOLD IS NOT HERE: `event-pump.wake-rule-reachability.test.ts` holds the property that was
 * missing (a wake rule needs a fact kind that reaches `#opensTurn`). What this file keeps is the measurement, including the
 * number the next unit needs: how many of the turns that composed nothing closed with a plan still able to run.
 * </p>
 */

type RecordedProgramme = Readonly<{
  programId: string;
  nodes: number;
  firstAtMs: number;
  lastSettledMs: number;
}>;

type RecordedTurn = Readonly<{ batchId: string; disposition: string; startMs: number; endMs: number }>;

type Round84 = Readonly<{
  source: string;
  run: string;
  programmes: readonly RecordedProgramme[];
  turns: readonly RecordedTurn[];
}>;

const ROUND84: Round84 = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/round84-turn-gap.json"), "utf8"),
) as Round84;

/** The node mark the pump carried from `8e8e625f` to `round84`, kept only to record what it would have done. */
const RETIRED_NODE_LOW_WATER = 2;

/** The median of one run's delivered turns: the think time a wake has to beat, as the run itself measured it. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const upper = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[upper] ?? 0;
  return ((sorted[upper - 1] ?? 0) + (sorted[upper] ?? 0)) / 2;
}

const THINK_MS = median(ROUND84.turns.map((turn) => turn.endMs - turn.startMs));
const lifeMsOf = (programme: RecordedProgramme): number => programme.lastSettledMs - programme.firstAtMs;
const paceOf = (programme: RecordedProgramme): number => lifeMsOf(programme) / programme.nodes;

/**
 * The turn that composed the plan this programme started with: the last delivery that began before the programme's first
 * node. A turn can compose a plan and then keep talking, so its window is CLIPPED to the gap - the part that overlapped the
 * programme was not waiting at all.
 */
function composingTurn(next: RecordedProgramme): RecordedTurn | undefined {
  const prior = ROUND84.turns.filter((turn) => turn.startMs < next.firstAtMs);
  return prior[prior.length - 1];
}

/** One wait between two consecutive programmes, split into its two defects. */
type Wait = Readonly<{ after: string; before: string; gapMs: number; queueMs: number; turnGapMs: number }>;

/** Every switch the run made, with the wait each one left behind. Overlaps are switches too, and they leave no wait. */
function waits(): readonly Wait[] {
  const found: Wait[] = [];
  for (let index = 1; index < ROUND84.programmes.length; index += 1) {
    const previous = ROUND84.programmes[index - 1];
    const next = ROUND84.programmes[index];
    assert.ok(previous !== undefined && next !== undefined, "the programmes are a dense array");
    const gapMs = next.firstAtMs - previous.lastSettledMs;
    if (gapMs <= 0) continue;
    const composing = composingTurn(next);
    assert.ok(composing !== undefined, `${next.programId}: a plan can only be composed inside a turn`);
    const composingMs = Math.max(
      0,
      Math.min(composing.endMs, next.firstAtMs) - Math.max(composing.startMs, previous.lastSettledMs),
    );
    found.push({
      after: previous.programId,
      before: next.programId,
      gapMs,
      queueMs: composingMs,
      turnGapMs: gapMs - composingMs,
    });
  }
  return found;
}

/** The programme a turn's own window says it started, if it started one: the first node is dispatched by its plan. */
function composedBy(turn: RecordedTurn, index: number): RecordedProgramme | undefined {
  const nextStart = ROUND84.turns[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
  return ROUND84.programmes.find(
    (programme) => programme.firstAtMs >= turn.startMs && programme.firstAtMs <= nextStart + 1,
  );
}

const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/**
 * `a_program_ends_and_the_body_waits:the_two_waits` - the reading, with the split in the same line so one cannot be mistaken
 * for the other.
 */
test("a_program_ends_and_the_body_waits: round84's own reading, with the gap split in two", () => {
  const switches = ROUND84.programmes.length - 1;
  const gaps = waits();
  const inHand = switches - gaps.length;
  const shorterThanATurn = ROUND84.programmes.filter((programme) => lifeMsOf(programme) < THINK_MS).length;
  const queueMs = total(gaps.map((wait) => wait.queueMs));
  const turnGapMs = total(gaps.map((wait) => wait.turnGapMs));
  const waitMs = total(gaps.map((wait) => wait.gapMs));

  assert.ok(ROUND84.programmes.length > 1, "an empty population agrees with itself: the fixture did not load");
  assert.ok(ROUND84.turns.length > 1, "no measured turn: the think time would be a guess");
  assert.equal(inHand + gaps.length, switches, "every switch is either a plan in hand or a gap");
  assert.equal(queueMs + turnGapMs, waitMs, "the two waits add back up to the run's own time between programmes");
  // The split is the finding: if either bucket ever swallowed the other, this line would report one defect and hide one.
  assert.ok(queueMs > 0, `a split with no queue is not a split (${String(queueMs)} ms)`);
  assert.ok(turnGapMs > 0, `a split with no turn gap is not a split (${String(turnGapMs)} ms)`);
  assert.ok(
    turnGapMs > queueMs,
    `the turn gap must stay the larger half or the next fix will be aimed at the small one ` +
      `(queue ${(queueMs / 1000).toFixed(1)} s vs turn gap ${(turnGapMs / 1000).toFixed(1)} s)`,
  );
  console.log(
    `a_program_ends_and_the_body_waits: programs ${String(ROUND84.programmes.length)} · drained-with-a-plan-in-hand ` +
      `${String(inHand)} · drained-into-a-gap ${String(gaps.length)} · shorter-than-a-turn ${String(shorterThanATurn)} · ` +
      `queue wait ${(queueMs / 1000).toFixed(1)} s · turn gap ${(turnGapMs / 1000).toFixed(1)} s · ` +
      `between programmes ${(waitMs / 1000).toFixed(1)} s · think ${(THINK_MS / 1000).toFixed(2)} s · ` +
      `source ${ROUND84.source}`,
  );
});

/**
 * `a_program_ends_and_the_body_waits:the_turn_gap` - what the 1,265.2 s is made of, and the number the next unit needs.
 *
 * <p>
 * A turn that composes no programme is the shape: it was opened, it closed, and nothing came of it. The question this round
 * can answer and the next one has to act on is WHY nothing could come of it - was a plan still able to run (the pump held the
 * world), or was there nothing in flight at all (the pump had no work and the model still opened a turn)? The two have
 * different fixes, and `round84` says which one the turn gap is: **40 of 43 closed with NOTHING in flight**, and only 3 with
 * a plan still running. A rule judged by "her own plan still had nodes" would have explained a twentieth of the wait.
 * </p>
 */
test("a_program_ends_and_the_body_waits: the turn gap is turns that composed nothing, and most had nothing in flight", () => {
  const idle: Array<Readonly<{ turn: RecordedTurn; planRunning: boolean }>> = [];
  ROUND84.turns.forEach((turn, index) => {
    if (composedBy(turn, index) !== undefined) return;
    const planRunning = ROUND84.programmes.some(
      (programme) => programme.firstAtMs <= turn.endMs && turn.endMs < programme.lastSettledMs,
    );
    idle.push({ turn, planRunning });
  });
  const withAPlan = idle.filter((entry) => entry.planRunning).length;
  const withNothing = idle.length - withAPlan;
  const drift = idle
    .filter((entry) => entry.planRunning)
    .map((entry) => `${entry.turn.batchId}:${(entry.turn.endMs - entry.turn.startMs).toFixed(0)} ms`);

  assert.ok(ROUND84.turns.length > 1, "an empty population agrees with itself: the fixture did not load");
  assert.ok(idle.length > 0, "no turn composed nothing: the property would pass over an empty population");
  assert.equal(withAPlan + withNothing, idle.length, "every actionless turn is one of the two, and counted once");
  assert.ok(
    withNothing > withAPlan,
    `the turn gap must not be attributed to a running plan: ${String(withNothing)} of ${String(idle.length)} turns ` +
      `closed with nothing in flight, and ${String(withAPlan)} with a plan still able to run (${drift.join(", ")})`,
  );
  console.log(
    `a_program_ends_and_the_body_waits: turns ${String(ROUND84.turns.length)} · composed-nothing ${String(idle.length)} · ` +
      `closed-with-a-plan-running ${String(withAPlan)} · closed-with-nothing-in-flight ${String(withNothing)} · ` +
      `the turn gap ${"1265.2 s"} · the next unit's number is the ${String(withNothing)}`,
  );
});

/**
 * `a_program_ends_and_the_body_waits:the_retired_mark` - what the node mark would have done, recorded rather than argued.
 *
 * <p>
 * `PLAN_LOW_WATER_NODES = 2` is retired, and this is why it was also WRONG: of the six programmes long enough for a wake to
 * beat a turn, the mark woke four with **4.7 s, 1.9 s, 3.5 s and 8.2 s** of tail in hand against a 10.1 s turn, so the answer
 * could not arrive before the work ended. The other two - a 52 s and a 19 s single-node programme - it woke in time, which is
 * the direction that kept it alive: the mark was not inert everywhere, it was inert on the fact that could carry it and
 * wrong on the ones it could not.
 * </p>
 */
test("a_program_ends_and_the_body_waits: the retired node mark was also wrong, on four of this run's programmes", () => {
  const late: string[] = [];
  const inTime: string[] = [];
  for (const programme of ROUND84.programmes) {
    if (lifeMsOf(programme) < THINK_MS) continue; // shorter than a turn: no wake can beat it, at any threshold
    const tailMs = Math.min(RETIRED_NODE_LOW_WATER, programme.nodes) * paceOf(programme);
    const reading = `${programme.programId} ${(tailMs / 1000).toFixed(1)} s`;
    if (tailMs >= THINK_MS) inTime.push(reading);
    else late.push(reading);
  }
  assert.deepEqual(
    late.map((entry) => entry.split(" ")[0]),
    ["plan_76_ab37f7051285e209", "plan_583_7a6cbbe44a7f4398", "plan_642_24e1c1cbde9e756c", "plan_698_81d801bd3df6d0c8"],
    `the mark must fail on exactly the programmes it failed on in the run, not on a set this test remembers: ${late.join(", ")}`,
  );
  assert.ok(inTime.length > 0, "and must still succeed somewhere, or the comparison proves nothing");
  console.log(
    `a_program_ends_and_the_body_waits: retired mark ${String(RETIRED_NODE_LOW_WATER)} nodes · woken short of a turn ` +
      `${String(late.length)} {${late.join(", ")}} · still in time ${String(inTime.length)} {${inTime.join(", ")}} · ` +
      `think ${(THINK_MS / 1000).toFixed(2)} s`,
  );
});
