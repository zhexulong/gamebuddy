// THE STANDSTILL PARTITION HAS TO ADD UP, and every reading in it has to be readable from the artifacts alone.
//
// Each fixture is a run directory fabricated on purpose, so one property is stated per test: the four standstill causes
// plus the body's own execution reach every millisecond of the wall and the residue is the run's head and tail; the split
// charges the composing turn's window to queue wait and the rest to turn gap; a run whose Host trace never reached its
// directory prints `not_measured` per reading instead of pricing a share of a wall it cannot see; a programme shorter than
// one turn is counted as work no wake can reach; and a speech dropped for want of a lease is counted against the delivered
// turns rather than folded into the ones that worked.
//
// The falsifier is `round84` itself, checked in the last test against the live run directory: the four numbers the loop
// quoted by hand (261.1 / 1,265.2 / 437.5 / 43.7) must come back out of the reading, and the buckets plus the residue must
// equal the wall clock exactly. If they do not, the reading is measuring something else - which is what the last assertion
// says out loud instead of failing on a bare "expected true".
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

function writeRun({ root, withTrace = true, withSession = true, withBundle = true }) {
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
  if (withBundle) writeFileSync(join(runDir, "result.json"), JSON.stringify(bundle()));
  if (withTrace) writeFileSync(join(runDir, "run-trace.json"), JSON.stringify({ traceEvents: traceEvents() }));
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

test("every millisecond of the wall lands in a named bucket, and the residue is the run's head and tail", () => {
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
    // THE ACCOUNTING: 5.9 + 27.0 + 20.0 + 0.1 = 53.0 s of the 100.0 s wall, and the 47.0 s residue is the head and the tail.
    assert.match(
      block,
      /accounted\s+body 5\.9s \+ turn gap 27\.0s \+ queue wait 20\.0s \+ intra-program 0\.1s = 53\.0s of the 100\.0s wall; unexplained 47\.0s = run head 10\.0s \+ run tail 37\.0s - 0\.0s counted twice/u,
      block,
    );
    // THE GATE, with the population printed and the largest unexplained stretch located.
    assert.match(
      block,
      /a_standstill_is_attributed_to_a_named_cause wall 100000 · body 5900 · turn gap 27000 · queue wait 20000 · intra-program 100 · blocked\/modal not_measured · unexplained 47000/u,
      block,
    );
    assert.match(
      block,
      /a_standstill_is_attributed_to_a_named_cause:unexplained 47000 ms of the 100000 ms wall is in no bucket \(47\.0%\) - the largest single stretch is 37\.0s from .*the body drained/u,
      block,
    );
    // A residue of 47 % of the wall is a FAILED verdict, not a footnote.
    assert.equal(result.status, 1, `a wall with 47 % of its seconds in no bucket must not exit 0:\n${block}`);
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
    assert.match(block, /a_standstill_is_attributed_to_a_named_cause:blocked/u, block);
    // A reading that could not be taken is not a failure of the run: the block is visibly not green, and the verdict does
    // not turn an absent file into either a pass or a defect.
    assert.match(block, /blocked\/modal not_measured/u, block);
  });
});

test("a run that published no bundle has no wall clock to attribute, and the gate says so by name", () => {
  withFixture({ withBundle: false }, (runDir) => {
    const block = standstillBlock(`${verdictProcess(runDir).stdout}${verdictProcess(runDir).stderr}`);
    assert.match(block, /^standstill\s+wall not_measured/mu, block);
    assert.match(block, /^body\s+not_measured/mu, block);
    assert.match(
      block,
      /a_standstill_is_attributed_to_a_named_cause:blocked - result\.json published no readable startedAtMs\.\.endedAtMs/u,
      block,
    );
  });
});

/**
 * THE FALSIFIER: `round84` ITSELF.
 *
 * The four numbers this block exists for were read by hand from this run's artifacts (261.1 s of native execution, 1,265.2 s
 * of turn gap, 437.5 s of queue wait, 43.7 s across 272 node switches). If the reading does not return them it is measuring
 * something else, so the assertion prints what it measured beside what the run says.
 *
 * The run directory is the loop's own `.live-runs` tree, which a fresh checkout does not carry: absent, this test SKIPS with
 * that reason rather than passing - an unwatched check that reports green is the defect the gate exists to prevent.
 */
const round84Skip = existsSync(join(ROUND84, "result.json"))
  ? false
  : `round84's artifacts are not on this machine (${ROUND84}), so the falsifier was not exercised`;

test(
  "round84's own artifacts reproduce 261.1 / 1265.2 / 437.5 / 43.7, and the buckets plus the residue are the wall",
  { skip: round84Skip },
  () => {
    const result = spawnSync(process.execPath, [VERDICT, ROUND84], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, APPDATA: join(ROUND84, "..", "appdata") },
      maxBuffer: 32 * 1024 * 1024,
    });
    const block = standstillBlock(`${result.stdout}${result.stderr}`);
    const measured =
      /a_standstill_is_attributed_to_a_named_cause wall (\d+) · body (\d+) · turn gap (\d+) · queue wait (\d+) · intra-program (\d+) · blocked\/modal not_measured · unexplained (-?\d+)/u.exec(
        block,
      );
    assert.ok(measured !== null, `the gate printed no readable partition:\n${block}`);
    const [wall, body, turnGap, queueWait, intra, unexplained] = measured.slice(1).map(Number);
    const asSeconds = (ms) => (ms / 1000).toFixed(1);
    assert.deepEqual(
      {
        body: asSeconds(body),
        turnGap: asSeconds(turnGap),
        queueWait: asSeconds(queueWait),
        intra: asSeconds(intra),
        unexplained: asSeconds(unexplained),
      },
      { body: "261.1", turnGap: "1265.2", queueWait: "437.5", intra: "43.7", unexplained: "58.4" },
      "the reading is measuring something other than what the loop read by hand",
    );
    assert.equal(
      body + turnGap + queueWait + intra + unexplained,
      wall,
      "the partition must reach every millisecond of the wall",
    );
    assert.match(block, /272 node switch\(es\) \(161 ms each\)/u, block);
    assert.match(block, /51 of 57 programme\(s\) are shorter than one turn/u, block);
    assert.match(block, /27 made no call · 21 of 91 produced speeches dropped \(no_presentation_lease\)/u, block);
    assert.match(block, /plant_seed 0 of 22/u, block);
    assert.match(block, /55 aged reading\(s\) · auto_observe_on_stale 48 · refresh_attempts_spent 7/u, block);
    assert.equal(result.status, 1, "58.4 s of this run's wall is in no bucket, so the gate must fail on it");
  },
);
