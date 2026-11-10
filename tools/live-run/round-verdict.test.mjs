// The efficiency block has to be refutable, and every number in it has to be read rather than assumed.
//
// Each fixture here is a run directory plus a session record, fabricated on purpose, so one property is stated per test:
// the two independent status-call counts agree (and DISAGREE out loud when they cannot), the same actions in fewer and
// larger plans price lower on both the floor and the ratio, and a run whose bundle never reached its directory still
// prints what it can measure with `not_measured` naming what it cannot. No game, and nothing read from `.live-runs`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..");
const VERDICT = join(REPO, "tools", "live-run", "round-verdict.mjs");
const START = Date.parse("2026-11-10T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const RECORD = "session-1.jsonl";
const SESSION_RELATIVE = ["runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", RECORD];

const assistantTurn = (atMs, calls) => ({
  type: "message",
  timestamp: iso(atMs),
  message: {
    role: "assistant",
    durationMs: 1000,
    content: [
      { type: "text", text: "ok" },
      ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
    ],
  },
});

const answer = (atMs, call, text) => ({
  type: "message",
  timestamp: iso(atMs),
  message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }] },
});

const planCall = (id, nodes, actionId) => ({
  id,
  name: "stardew_plan_work",
  arguments: { script: `builder.${actionId}({});` },
  answer: {
    accepted: true,
    nodeCount: nodes,
    programId: `plan_${id}`,
    nodes: Array.from({ length: nodes }, () => ({ actionId })),
  },
});
const refusedPlanCall = (id) => ({
  id,
  name: "stardew_plan_work",
  arguments: { script: "builder.nope();" },
  answer: { accepted: false, nodeCount: 0, reasonCode: "plan_script_unknown_action" },
});
const statusCall = (id, programme, states) => ({
  id,
  name: "stardew_action_program_status",
  arguments: { programId: programme },
  answer: {
    code: "found",
    snapshot: {
      programId: programme,
      nodes: states.map(([nodeId, state, actionId]) => ({ nodeId, state, actionId })),
    },
  },
});
const observeCall = (id) => ({ id, name: "stardew_observe", arguments: {}, answer: { location: "Farm" } });
const stopCall = (id) => ({
  id,
  name: "stardew_stop_action",
  arguments: {},
  answer: "Game action was not created: no_active_execution.",
});

const playerTask = (atMs, text) => ({
  type: "message",
  timestamp: iso(atMs),
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

/**
 * Lay the turns out one per `stepMs`, writing each call's answer just before the next turn starts.
 *
 * `answered` decides which calls get an answer - a run killed inside a call is a real shape (its session ends on the
 * question), and it is the one case where the two status counts must disagree rather than be reconciled.
 */
function sessionFile({ steps, stepMs = 2000, answered = () => true }) {
  const entries = [{ type: "session", timestamp: iso(START) }];
  const at = (index) => START + (index + 1) * stepMs;
  entries.push(playerTask(START + 500, "门前横着开一条长地，三格宽、二十格长，清出来种上。"));
  steps.forEach((step, index) => {
    entries.push(assistantTurn(at(index), step.calls));
    for (const call of step.calls) {
      if (call.answer === undefined || !answered(index, call)) continue;
      const text = typeof call.answer === "string" ? call.answer : JSON.stringify(call.answer);
      entries.push(answer(at(index) + 400, call, text));
    }
  });
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function writeRun({ root, session, withResult, record = RECORD }) {
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "launch.json"), JSON.stringify({ schema: "gamebuddy-live-run-launch/v1" }));
  if (withResult === true)
    writeFileSync(join(runDir, "result.json"), JSON.stringify({ state: "blocked", toolTiming: { record } }));
  if (session !== null) {
    const path = join(runDir, ...SESSION_RELATIVE);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, session);
  }
  return runDir;
}

function runVerdict(runDir, { cwd = REPO, extraArgs = [] } = {}) {
  const appData = join(runDir, "..", "appdata");
  mkdirSync(appData, { recursive: true });
  const result = spawnSync(process.execPath, [VERDICT, runDir, ...extraArgs], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, APPDATA: appData },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 2, `the verdict refused the run directory:\n${output}`);
  return output;
}

const efficiencyBlock = (output) => output.slice(output.indexOf("efficiency"));
const floorTurns = (output) => Number(/floor_turns\s+(\d+) = ceil\(/u.exec(output)?.[1]);
const ratioTurns = (output) => Number(/ratio\s+turns (\S+) \|/u.exec(output)?.[1]?.replace("x", ""));
const bucketTurns = (output, name) => Number(new RegExp(`^    ${name} +(\\d+) `, "mu").exec(output)?.[1]);

function withFixture(build, assertion) {
  const root = mkdtempSync(join(tmpdir(), "round-verdict-"));
  try {
    assertion(writeRun({ root, ...build() }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the status-call count is read twice and the two readings are asserted to agree", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({
        steps: [
          { calls: [observeCall("c1")] },
          { calls: [planCall("c2", 4, "till_soil")] },
          {
            calls: [
              statusCall(
                "c3",
                "plan_c2",
                ["n1", "n2", "n3", "n4"].map((node) => [node, "succeeded", "till_soil"]),
              ),
            ],
          },
          { calls: [refusedPlanCall("c4")] },
          {
            calls: [
              statusCall(
                "c5",
                "plan_c2",
                ["n1", "n2", "n3", "n4"].map((node) => [node, "succeeded", "till_soil"]),
              ),
            ],
          },
          { calls: [stopCall("c6")] },
        ],
      }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.match(
        block,
        /stardew_action_program_status: 2 by the turn walk, 2 by a second parse of the raw file, 2 answers -> agree/u,
      );
      assert.equal(bucketTurns(block, "polls"), 2, "two status calls after a dispatch are two poll turns");
      assert.equal(bucketTurns(block, "questions"), 1);
      assert.equal(bucketTurns(block, "dispatches"), 1);
      assert.equal(bucketTurns(block, "refused_dispatches"), 1);
      assert.equal(bucketTurns(block, "other"), 1);
      assert.match(block, /accounting\s+6 bucket turns = 6 measured/u);
      assert.match(block, /actions_done\s+4 nodes reached `succeeded` of 4 with a known state/u);
      assert.match(block, /objectives_done\s+2 = 1 declared player task\(s\)[^+]*\+ 1 target families \(till_soil\)/u);
      assert.match(block, /floor_turns\s+3 = ceil\(4\/4\) \+ 2/u);
      assert.match(block, /floor_native\s+0\.8s\s+<- status-call wait in this session/u);
      assert.match(block, /floor_wall\s+6\.8s = 3 turns x 2\.0s \+ 0\.8s/u);
      assert.match(block, /reading\s+with the same work at 4 nodes per plan and zero polls/u);
    },
  ));

test("a call that was never answered is reported as a DISAGREEMENT, not reconciled", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({
        steps: [
          { calls: [observeCall("c1")] },
          { calls: [planCall("c2", 3, "cut_weeds")] },
          { calls: [statusCall("c3", "plan_c2", [["n1", "succeeded", "cut_weeds"]])] },
          { calls: [statusCall("c4", "plan_c2", [["n1", "succeeded", "cut_weeds"]])] },
        ],
        answered: (_index, call) => call.id !== "c4",
      }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.match(
        block,
        /2 by the turn walk, 2 by a second parse of the raw file, 1 answers -> DISAGREE \(1 call\(s\) never answered\)/u,
      );
      assert.match(block, /this verdict does not pick one/u);
    },
  ));

test("the same actions in fewer, larger plans price lower on both the floor and the ratio", () => {
  const oneNodePlans = [];
  for (let index = 0; index < 12; index += 1) {
    oneNodePlans.push({ calls: [planCall(`p${index}`, 1, "cut_weeds")] });
    oneNodePlans.push({
      calls: [statusCall(`s${index}`, `plan_p${index}`, [[`n${index}`, "succeeded", "cut_weeds"]])],
    });
  }
  const sixNodePlans = [];
  for (let index = 0; index < 2; index += 1) {
    const states = Array.from({ length: 6 }, (_, node) => [`n${index}_${node}`, "succeeded", "cut_weeds"]);
    sixNodePlans.push({ calls: [planCall(`q${index}`, 6, "cut_weeds")] });
    sixNodePlans.push({ calls: [statusCall(`t${index}`, `plan_q${index}`, states)] });
  }

  const measure = (steps) => {
    let output = null;
    withFixture(
      () => ({ withResult: true, session: sessionFile({ steps }) }),
      (runDir) => {
        output = efficiencyBlock(runVerdict(runDir));
      },
    );
    return { output, floor: floorTurns(output), ratio: ratioTurns(output) };
  };

  const small = measure(oneNodePlans);
  const large = measure(sixNodePlans);
  assert.match(small.output, /W\s+measured 1 nodes/u);
  assert.match(large.output, /W\s+measured 6 nodes/u);
  assert.equal(small.floor, 12 + 2, "twelve one-node plans are twelve dispatches plus the two objectives");
  assert.equal(
    large.floor,
    2 + 2,
    "the same twelve actions in two six-node plans are two dispatches plus two objectives",
  );
  assert.equal(small.ratio, Number((24 / 14).toFixed(1)));
  assert.equal(large.ratio, Number((4 / 4).toFixed(1)));
  assert.ok(large.floor < small.floor, `floor did not fall: ${large.floor} vs ${small.floor}`);
  assert.ok(large.ratio < small.ratio, `ratio did not fall: ${large.ratio} vs ${small.ratio}`);
});

test("a run whose bundle and session never reached its directory says not_measured and names both fields", () =>
  withFixture(
    () => ({ withResult: false, session: null }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.match(block, /^efficiency {10}not_measured$/mu);
      assert.match(
        block,
        /field {13}result\.json toolTiming\.record, and runtime-root\/contexts\/\*\*\/sessions\/\*\.jsonl/u,
      );
      assert.doesNotMatch(block, /\b0 turns\b/u);
    },
  ));

test("a stopped run prints the buckets it can measure and not_measured for what it cannot", () =>
  withFixture(
    () => ({
      withResult: false,
      session: sessionFile({
        steps: [{ calls: [planCall("c1", 5, "plant_seed")] }, { calls: [observeCall("c2")] }],
      }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.match(block, /dispatches {11}1 /u);
      assert.match(block, /questions\s+1\s/u);
      assert.match(
        block,
        /actions_done\s+0 nodes reached `succeeded` of 0 with a known state {2}<- session status snapshots/u,
      );
      assert.match(
        block,
        /not_measured: 1 accepted plan\(s\) \(5 nodes\) were never polled, so their node states are unknown - not zero/u,
      );
      assert.match(block, /floor_turns\s+2 = ceil\(0\/5\) \+ 2/u);
      assert.match(
        block,
        /floor_native\s+not_measured\s+<- not_measured: neither result\.json programOutcomes\[\]\.executions\[\]\.atMs\/settledAtMs nor a status-call wait exists in this session/u,
      );
      assert.match(block, /floor_wall\s+not_measured = 2 turns x 2\.0s \+ not_measured/u);
    },
  ));

test("the declared cap is read from the file that enforces it, and named when it cannot be read", () =>
  withFixture(
    () => ({ withResult: false, session: sessionFile({ steps: [{ calls: [observeCall("c1")] }] }) }),
    (runDir, root) => {
      const fromRepo = efficiencyBlock(runVerdict(runDir));
      assert.match(fromRepo, /declared cap 256 nodes \(host\/src\/body-program-script\.ts\)/u);
      const elsewhere = efficiencyBlock(runVerdict(runDir, { cwd: root }));
      assert.match(
        elsewhere,
        /declared cap not_measured: host\/src\/body-program-script\.ts MAX_PLAN_NODES was not readable/u,
      );
    },
  ));
