// THE STANDSTILL PARTITION HAS TO ADD UP, and every reading in it has to be readable from the artifacts alone.
//
// Each fixture is a run directory fabricated on purpose, so one property is stated per test: the four standstill causes
// plus the run's own head and tail reach every millisecond of the wall and the residual is judged against what this run's
// own two clocks can misplace; the split charges the composing turn's window to queue wait and the rest to turn gap; a run
// whose Host trace never reached its directory prints `not_measured` per reading instead of pricing a share of a wall it
// cannot see; a programme shorter than one turn is counted as work no wake can reach; and a speech dropped for want of a
// lease is counted against the delivered turns rather than folded into the ones that worked.
//
// TWO THINGS THAT ARE NOT THE SAME ARE ASSERTED APART: a 5 s gap BETWEEN TWO DELIVERIES is `turn gap` and `queue wait` -
// the partition's largest buckets, and the finding the block exists to produce - so the gate must PASS it with the seconds
// named; a 5 s stretch that no bucket can charge is a residual and the gate must FAIL it. Collapsing the two is how a
// clean run got reddened: `round84`'s 58,383 ms was 38,265 ms of run head plus 24,604 ms of run tail with 4,486 ms
// counted twice.
//
// The falsifier is `round84` itself, checked in the last test against the live run directory: the four numbers the loop
// quoted by hand (261.1 / 1,265.2 / 437.5 / 43.7) must come back out of the reading, its head and tail must be NAMED, and
// the residual must be judged inside the 9,134 ms its own paired admissions span. If they do not, the reading is
// measuring something else - which is what the last assertion says out loud instead of failing on a bare "expected true".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..");
const VERDICT = join(REPO, "tools", "live-run", "round-verdict.mjs");
const START = Date.parse("2026-11-20T09:00:00.000Z");
const RECORD = "session-1.jsonl";
const SESSION_RELATIVE = ["runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", RECORD];
const ROUND84 = join(REPO, ".live-runs", "game-ladder", "2026-11-20T13-52-51-386Z-multiday_routine");

/** One trace span: `atMs` and `durationMs` in the run's own milliseconds, written as the microseconds the trace counts in. */
const span = (name, atMs, durationMs, args) => ({ name, ts: atMs * 1000, dur: durationMs * 1000, args });

const assistantTurn = (atMs, calls) => ({
  type: "message",
  timestamp: new Date(START + atMs).toISOString(),
  message: {
    role: "assistant",
    durationMs: 1_000,
    content: [
      { type: "text", text: "ok" },
      ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name })),
    ],
  },
});
const answer = (atMs, call) => ({
  type: "message",
  timestamp: new Date(START + atMs).toISOString(),
  message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "{}" }] },
});
const playerTask = (atMs, text) => ({
  type: "message",
  timestamp: new Date(START + atMs).toISOString(),
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "gamebuddy_fact_batch",
          batchId: `batch-${atMs}`,
          events: [{ eventId: `input-${atMs}`, kind: "player_input", input: { text } }],
        }),
      },
    ],
  },
});

const session = () =>
  `${[
    playerTask(900, "把这活儿干一下。"),
    assistantTurn(5_000, [{ id: "c1", name: "stardew_observe" }]),
    answer(5_400, { id: "c1", name: "stardew_observe" }),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;

// Two programmes and two delivered turns, on ONE clock (this fixture's journal stamps and trace spans agree, so the head and
// the tail are the only residue there can be):
//   plan_a  n1 10.0s..12.0s, n2 12.1s..13.0s      body 2.0s + 0.9s, one intra-programme switch of 0.1s
//   plan_b  n1 60.0s..63.0s                       body 3.0s, its only node failed
//   the switch from plan_a to plan_b is 47.0s, of which turn 2's own window covers 20.0s (queue wait) and 27.0s does not
//   the body's window is 10.0s..63.0s, so the head is 10.0s and the tail 37.0s of the 100.0s wall
const traceEvents = () => [
  span("delivery", 1_000, 100, { batchId: "b1", disposition: "follow_up" }),
  span("turn.tail", 19_990, 10, { batchId: "b1" }),
  span("stardew_observe", 5_000, 10, { tool: "stardew_observe" }),
  span("admission", 10_000, 2_000, { programId: "plan_a", nodeId: "n1" }),
  span("admission", 12_100, 900, { programId: "plan_a", nodeId: "n2" }),
  span("delivery", 40_000, 100, { batchId: "b2", disposition: "follow_up" }),
  span("admission", 60_000, 3_000, { programId: "plan_b", nodeId: "n1" }),
  span("turn.tail", 69_990, 10, { batchId: "b2" }),
];

// THE 5 s GAP BETWEEN TWO DELIVERIES, injected where such a gap really goes: delivery b2 and its own turn arrive 5 s
// later (45.0 s instead of 40.0 s), so the composing turn's window covers 15.0 s of the 47.0 s wait and leaves 32.0 s
// that no turn was open for. Neither number is a residual - they are the `turn gap` and `queue wait` buckets.
const traceEventsWithADeliveryFiveSecondsLater = () =>
  traceEvents().map((event) =>
    event.name === "delivery" && event.args.batchId === "b2"
      ? { ...event, ts: 45_000 * 1000 }
      : event.name === "turn.tail" && event.args.batchId === "b2"
        ? { ...event, ts: 74_990 * 1000 }
        : event,
  );

// THE 5 s NO BUCKET CAN CHARGE: the body's own published sum claims 5 s of execution that its own executions do not show
// (10.9 s against the 5.9 s its three nodes expose). This is the residual the gate exists for - a bucket counting seconds
// its record does not hold - and no gap between two deliveries can stand in for it.
const bundleWithFiveSecondsNoStepHolds = () => {
  const base = bundle();
  return { ...base, actionCadence: { ...base.actionCadence, execMs: { ...base.actionCadence.execMs, sum: 10_900 } } };
};

const bundle = () => ({
  state: "closed",
  startedAtMs: START,
  endedAtMs: START + 100_000,
  phaseTimings: { runStartedAtMs: START, runner_process_start: 0, totalMs: 100_000 },
  toolTiming: { record: RECORD },
  actionCadence: { actions: 3, measured: 3, execMs: { sum: 5_900, median: 2_000, max: 3_000 } },
  programOutcomes: [
    {
      programId: "plan_a",
      executions: [
        { nodeId: "n1", atMs: 10_000, settledAtMs: 12_000 },
        { nodeId: "n2", atMs: 12_100, settledAtMs: 13_000 },
      ],
      nodeOutcomes: [
        { nodeId: "n1", actionId: "equip_tool", state: "succeeded" },
        { nodeId: "n2", actionId: "till_soil", state: "succeeded" },
      ],
    },
    {
      programId: "plan_b",
      executions: [{ nodeId: "n1", atMs: 60_000, settledAtMs: 63_000 }],
      nodeOutcomes: [{ nodeId: "n1", actionId: "plant_seed", state: "failed" }],
    },
  ],
  presentation: { deliveryAccount: { parts: { produced: 5, suppressed: { no_presentation_lease: 2 } } } },
});

function writeRun({
  root,
  withTrace = true,
  withSession = true,
  withBundle = true,
  trace = traceEvents(),
  result = bundle(),
}) {
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "launch.json"),
    JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", startedAtMs: START }),
  );
  writeFileSync(
    join(runDir, "closure.json"),
    JSON.stringify({
      schema: "gamebuddy-live-run-closure/v1",
      run: "run",
      state: "closed",
      reasonCode: "runner_exited:0",
      endedAtMs: START + 100_000,
      durationMs: 100_000,
      result: "fresh",
      progress: { present: true, lines: 2 },
    }),
  );
  if (withBundle) writeFileSync(join(runDir, "result.json"), JSON.stringify(result));
  if (withTrace) writeFileSync(join(runDir, "run-trace.json"), JSON.stringify({ traceEvents: trace }));
  if (withSession) {
    const path = join(runDir, ...SESSION_RELATIVE);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, session());
  }
  return runDir;
}

function verdictProcess(runDir) {
  const appData = join(runDir, "..", "appdata");
  mkdirSync(appData, { recursive: true });
  return spawnSync(process.execPath, [VERDICT, runDir], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, APPDATA: appData },
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** The block, from its header to the source gate that closes the verdict. */
function standstillBlock(output) {
  const lines = output.split("\n");
  const from = lines.findIndex((line) => line.startsWith("standstill "));
  const to = lines.findIndex((line) => line.startsWith("a_reading_names_the_source_it_read"));
  assert.ok(from >= 0, `the verdict printed no standstill block:\n${output}`);
  return lines.slice(from, to < 0 ? undefined : to).join("\n");
}

function withFixture(build, assertion) {
  const root = mkdtempSync(join(tmpdir(), "round-verdict-standstill-"));
  try {
    return assertion(writeRun({ root, ...build }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every millisecond of the wall is in a bucket or in the named head and tail, with nothing unexplained", () => {
  withFixture({}, (runDir) => {
    const result = verdictProcess(runDir);
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    // THE FIVE READINGS, each with the number this fixture was built to produce.
    assert.match(block, /^standstill\s+wall 100\.0s/mu, block);
    assert.match(block, /^body\s+5\.9s = 5\.9% of the wall · longest single standstill 47\.0s/mu, block);
    assert.match(
      block,
      /^turn_gap\s+27\.0s = 27\.0% · queue_wait 20\.0s = 20\.0% over 1 gap\(s\) of 1 switch\(es\)/mu,
      block,
    );
    assert.match(block, /^ {4}intra_program\s+0\.1s = 0\.1% over 1 node switch\(es\) \(100 ms each\)/mu, block);
    assert.match(
      block,
      /^autonomy_horizon\s+0\.12 = median programme 3\.0s \/ median delivered turn 24\.5s · 2 of 2 programme\(s\) are shorter than one turn/mu,
      block,
    );
    assert.match(block, /^cognitive_tax\s+1 call\(s\) in 1 of 1 prompt turn\(s\) on stardew_observe/mu, block);
    assert.match(
      block,
      /intent_yield\s+1 of 2 delivered turn\(s\) carried a tool call \(50\.0%\) · 1 made no call/u,
      block,
    );
    assert.match(block, /2 of 5 produced speeches dropped \(no_presentation_lease\)/u, block);
    assert.match(block, /1 of 2 programme\(s\) had no successful node \(plant_seed 0 of 1\)/u, block);
    // THE ACCOUNTING: 5.9 + 27.0 + 20.0 + 0.1 = 53.0 s of the 100.0 s wall, and the other 47.0 s is NAMED: the head
    // before the first body step (10.0 s) and the tail after the last settlement (37.0 s).
    assert.match(
      block,
      /accounted\s+body 5\.9s \+ turn gap 27\.0s \+ queue wait 20\.0s \+ intra-program 0\.1s = 53\.0s of the 100\.0s wall; the other 47\.0s is named rather than assumed: run head 10\.0s before the first body step \+ run tail 37\.0s after the last settlement, which leaves a residual of 0\.0s - the middle buckets and the 53\.0s window those two leave agree to the millisecond/u,
      block,
    );
    // THE GATE: named and residual are different numbers, and the tolerance this run's own two clocks give is 0 ms because
    // every paired admission puts them at the same offset - so this wall must be partitioned exactly.
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded wall 100000 · named 47000 \(run head 10000 \+ run tail 37000\) · body 5900 · turn gap 27000 · queue wait 20000 · intra-program 100 · blocked\/modal not_measured · residual 0 · tolerance 0 \(the widest disagreement between the two clocks this run reads: 3 node admissions paired a run-trace\.json span with the same node's result\.json stamp, and the offsets span 0\.\.0 ms\)/u,
      block,
    );
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded:within 0 ms of the 100000 ms wall is in no bucket \(0\.0%\) and inside the 0 ms this run's own timestamps can misplace an instant by, so it is alignment error and not a finding: run head 10\.0s before the first body step and run tail 37\.0s after the last settlement are named, and the middle buckets fill their window exactly/u,
      block,
    );
    // A wall whose every second is named by a bucket, the head or the tail is a PASSED verdict, not a footnote.
    assert.equal(result.status, 0, `a fully named wall must exit 0:\n${block}`);
  });
});

// A GAP BETWEEN TWO DELIVERIES IS A BUCKET, NOT A RESIDUAL. The same 5 s, injected where such a gap actually falls, moves
// `turn gap` from 27.0 s to 32.0 s and `queue wait` from 20.0 s to 15.0 s - and the gate passes, naming where the seconds
// went. Failing here would be the false positive this whole unit removes: 1,265.2 s of `round84`'s 2,065.9 s wall is
// exactly this gap, and a partition that cannot tell a named 5 s from an unnamed one is not a partition.
test("a 5 s gap between two deliveries is named as turn gap, so the residual stays 0 and the gate passes", () => {
  withFixture({ trace: traceEventsWithADeliveryFiveSecondsLater() }, (runDir) => {
    const result = verdictProcess(runDir);
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    assert.match(
      block,
      /^turn_gap\s+32\.0s = 32\.0% · queue_wait 15\.0s = 15\.0% over 1 gap\(s\) of 1 switch\(es\)/mu,
      block,
    );
    assert.match(
      block,
      /named 47000 \(run head 10000 \+ run tail 37000\) · body 5900 · turn gap 32000 · queue wait 15000 · intra-program 100 · blocked\/modal not_measured · residual 0/u,
      block,
    );
    assert.match(block, /a_residual_is_either_named_or_bounded:within 0 ms/u, block);
    assert.equal(
      result.status,
      0,
      `a 5 s gap between two deliveries is charged to a bucket and must exit 0:\n${block}`,
    );
  });
});

// AND THE HALF THAT KEEPS THE GATE ALIVE: 5 s that NO bucket can charge - the body's own sum claiming executions its
// executions do not show - is a residual past the 0 ms tolerance, and the verdict fails on it, naming the window it
// overcharges.
test("5 s no bucket can charge is a residual past the tolerance, and the gate fails on it", () => {
  withFixture({ result: bundleWithFiveSecondsNoStepHolds() }, (runDir) => {
    const result = verdictProcess(runDir);
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    assert.match(block, /residual -5000 · tolerance 0/u, block);
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded:residual -5000 ms of the 100000 ms wall is in no bucket \(-5\.0%\), past the 0 ms tolerance this run's own timestamps allow - no middle stretch is unnamed - the buckets charge 5\.0s more than the 53\.0s window between the first step at .* and the last settlement at .*,? and no two programme windows overlapped, so a bucket counts seconds its own executions do not hold/u,
      block,
    );
    assert.equal(result.status, 1, `a residual 5 s past the tolerance must exit 1:\n${block}`);
  });
});

// A DELIVERY RECORD WITH NO ADMISSION IN IT CANNOT NAME A HEAD OR A TAIL: the wall and the four buckets are readable, but
// nothing placed the body's window, so the seconds head and tail would have named are unexplained and the verdict must fail
// on them rather than call them bounded.
test("a trace with no admission span cannot name the head and tail, and the seconds it cannot name still fail", () => {
  withFixture({ trace: traceEvents().filter((event) => event.name !== "admission") }, (runDir) => {
    const result = verdictProcess(runDir);
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    assert.match(block, /named not_measured · body 5900 · turn gap 27000 · queue wait 20000/u, block);
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded:residual 47000 ms of the 100000 ms wall is in no bucket \(47\.0%\) and cannot be named at all: no admission span placed the body's window/u,
      block,
    );
    assert.equal(result.status, 1, `an unnameable residue is not a bounded one, so this must exit 1:\n${block}`);
  });
});

test("the split charges the composing turn's own window to queue wait and the rest to turn gap", () => {
  withFixture({}, (runDir) => {
    const block = standstillBlock(`${verdictProcess(runDir).stdout}${verdictProcess(runDir).stderr}`);
    // 47.0 s between the programmes; turn 2 is open from 40.0 s to 70.0 s, so 20.0 s of that gap is a turn that had not
    // settled yet and 27.0 s is a turn that closed having composed nothing.
    const gapLine = /^turn_gap\s+(\S+) = \S+ · queue_wait (\S+) =/mu.exec(block);
    assert.ok(gapLine !== null, block);
    assert.equal(Number(gapLine[1].replace("s", "")), 27);
    assert.equal(Number(gapLine[2].replace("s", "")), 20);
    assert.match(block, /1 of them overlapped and left no wait|1 gap\(s\) of 1 switch\(es\)/u, block);
  });
});

test("a run whose Host trace never reached its directory prices no share and says what it could not read", () => {
  withFixture({ withTrace: false }, (runDir) => {
    const result = verdictProcess(runDir);
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    assert.match(block, /^turn_gap\s+not_measured \(this run has no run-trace\.json\)/mu, block);
    assert.match(block, /^autonomy_horizon\s+not_measured/mu, block);
    assert.match(block, /^intent_yield\s+not_measured \(this run has no run-trace\.json\)/mu, block);
    assert.match(block, /accounted\s+not_measured \(a bucket above could not be read/u, block);
    assert.match(block, /a_residual_is_either_named_or_bounded:blocked/u, block);
    // A reading that could not be taken is not a failure of the run: the block is visibly not green, and the verdict does
    // not turn an absent file into either a pass or a defect.
    assert.match(block, /blocked\/modal not_measured/u, block);
    assert.match(
      block,
      /residual not_measured · tolerance not_measured \(no admission span paired the two clocks/u,
      block,
    );
  });
});

test("a run that published no bundle has no wall clock to attribute, and the gate says so by name", () => {
  withFixture({ withBundle: false }, (runDir) => {
    const block = standstillBlock(`${verdictProcess(runDir).stdout}${verdictProcess(runDir).stderr}`);
    assert.match(block, /^standstill\s+wall not_measured/mu, block);
    assert.match(block, /^body\s+not_measured/mu, block);
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded:blocked - result\.json published no readable startedAtMs\.\.endedAtMs/u,
      block,
    );
  });
});

/**
 * THE FALSIFIER: `round84` ITSELF, the run the old gate failed for seconds that were not error.
 *
 * The four numbers this block exists for were read by hand from this run's artifacts (261.1 s of native execution, 1,265.2 s
 * of turn gap, 437.5 s of queue wait, 43.7 s across 272 node switches). If the reading does not return them it is measuring
 * something else, so the assertion prints what it measured beside what the run says.
 *
 * AND THE PART THAT WAS RED BEFORE: its 58,383 ms of "unexplained" is 38,265 ms of run head plus 24,604 ms of run tail with
 * 4,486 ms charged twice, so the residual is -4,486 ms and it is inside the 9,134 ms this run's own 328 paired admissions
 * span (13,639..22,774 ms: one dispatch is stamped 9.1 s from where the other clock puts it). The partition is therefore a
 * PASS on this run, and the verdict still exits 1 - for the compiler-inserted node it failed on, which is asserted apart so
 * the exit status cannot be read as the partition's.
 *
 * The run directory is the loop's own `.live-runs` tree, which a fresh checkout does not carry: absent, this test SKIPS with
 * that reason rather than passing - an unwatched check that reports green is the defect the gate exists to prevent.
 */
const round84Skip = existsSync(join(ROUND84, "result.json"))
  ? false
  : `round84's artifacts are not on this machine (${ROUND84}), so the falsifier was not exercised`;

test(
  "round84's own artifacts reproduce 261.1 / 1265.2 / 437.5 / 43.7, and its head and tail are named rather than failed",
  { skip: round84Skip },
  () => {
    const result = spawnSync(process.execPath, [VERDICT, ROUND84], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, APPDATA: join(ROUND84, "..", "appdata") },
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout}${result.stderr}`;
    const block = standstillBlock(output);
    const measured =
      /a_residual_is_either_named_or_bounded wall (\d+) · named (\d+) \(run head (\d+) \+ run tail (\d+)\) · body (\d+) · turn gap (\d+) · queue wait (\d+) · intra-program (\d+) · blocked\/modal not_measured · residual (-?\d+) · tolerance (\d+)/u.exec(
        block,
      );
    assert.ok(measured !== null, `the gate printed no readable partition:\n${block}`);
    const [wall, named, head, tail, body, turnGap, queueWait, intra, residual, tolerance] = measured
      .slice(1)
      .map(Number);
    const asSeconds = (ms) => (ms / 1000).toFixed(1);
    assert.deepEqual(
      {
        body: asSeconds(body),
        turnGap: asSeconds(turnGap),
        queueWait: asSeconds(queueWait),
        intra: asSeconds(intra),
        head: asSeconds(head),
        tail: asSeconds(tail),
        residual: asSeconds(residual),
      },
      {
        body: "261.1",
        turnGap: "1265.2",
        queueWait: "437.5",
        intra: "43.7",
        head: "38.3",
        tail: "24.6",
        residual: "-4.5",
      },
      "the reading is measuring something other than what the loop read by hand",
    );
    assert.equal(named, head + tail, "`named` must be the two buckets it says it is made of, and nothing else");
    assert.equal(
      body + turnGap + queueWait + intra + named + residual,
      wall,
      "the partition must reach every millisecond of the wall: named + middle buckets + residual = wall",
    );
    // THE TOLERANCE IS THIS RUN'S OWN, not a number chosen here: the swing of its 328 paired clock offsets.
    assert.equal(tolerance, 9_134, `the tolerance must be the run's own measured skew:\n${block}`);
    assert.match(
      block,
      /a_residual_is_either_named_or_bounded:within -4486 ms of the 2065870 ms wall is in no bucket \(-0\.2%\) and inside the 9134 ms this run's own timestamps can misplace an instant by, so it is alignment error and not a finding: run head 38\.3s before the first body step and run tail 24\.6s after the last settlement are named, and the middle buckets charge more than their window holds/u,
      block,
    );
    assert.match(block, /272 node switch\(es\) \(161 ms each\)/u, block);
    assert.match(block, /51 of 57 programme\(s\) are shorter than one turn/u, block);
    assert.match(block, /27 made no call · 21 of 91 produced speeches dropped \(no_presentation_lease\)/u, block);
    assert.match(block, /plant_seed 0 of 22/u, block);
    assert.match(block, /55 aged reading\(s\) · auto_observe_on_stale 48 · refresh_attempts_spent 7/u, block);
    // THE VERDICT STILL FAILS THIS RUN, AND NOT ON ITS WALL: the compiler-inserted node `auto_walk_02` settled `pending`, so
    // the exit status is asserted together with the criterion that actually carries it.
    assert.equal(result.status, 1, "round84 still fails the verdict");
    assert.match(output, /inserted_node_failed:auto_walk_02:move_to_tile:pending/u, output);
  },
);
