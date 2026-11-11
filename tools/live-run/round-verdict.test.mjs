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
// One player task, repeated: the objectives count dedupes by TEXT, so a fixture that delivers the same words in every
// batch asks for one task however many turns it takes.
const TASK_TEXT = "门前横着开一条长地，三格宽、二十格长，清出来种上。";
const SESSION_RELATIVE = ["runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", RECORD];

const assistantTurn = (atMs, calls, text = "ok") => ({
  type: "message",
  // A turn whose timestamp cannot be read is a real shape (a killed run), and it is the one case where the bucket
  // seconds cannot add up to the measured wall - so the fixture has to be able to write one.
  timestamp: typeof atMs === "string" ? atMs : iso(atMs),
  message: {
    role: "assistant",
    durationMs: 1000,
    content: [
      { type: "text", text },
      ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
    ],
  },
});

const answer = (atMs, call, text) => ({
  type: "message",
  timestamp: iso(atMs),
  message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }] },
});

const planCall = (id, nodes, actionId, insertedNodeIds = []) => ({
  id,
  name: "stardew_plan_work",
  arguments: { script: `builder.${actionId}({});` },
  answer: {
    accepted: true,
    nodeCount: nodes,
    programId: `plan_${id}`,
    nodes: Array.from({ length: nodes }, () => ({ actionId })),
    ...(insertedNodeIds.length === 0 ? {} : { insertedNodeIds }),
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
 * Lay the prompt turns out one per `stepMs`, writing each call's answer just before the next turn starts.
 *
 * A step OPENS a prompt turn by delivering a fact batch, unless it says `prompt: false` - which is how a fixture writes
 * the second and third assistant message of ONE turn. `text` sets that message's own text, because the speech-only
 * reading prices the text as well as the turn.
 *
 * `answered` decides which calls get an answer - a run killed inside a call is a real shape (its session ends on the
 * question), and it is the one case where the two status counts must disagree rather than be reconciled.
 */
function sessionFile({ steps, stepMs = 2000, answered = () => true }) {
  const entries = [{ type: "session", timestamp: iso(START) }];
  const at = (index) => START + (index + 1) * stepMs;
  steps.forEach((step, index) => {
    if (step.prompt !== false) entries.push(playerTask(at(index) - 500, TASK_TEXT));
    entries.push(assistantTurn(step.timestamp ?? at(index), step.calls, step.text));
    for (const call of step.calls) {
      if (call.answer === undefined || !answered(index, call)) continue;
      const text = typeof call.answer === "string" ? call.answer : JSON.stringify(call.answer);
      entries.push(answer(at(index) + 400, call, text));
    }
  });
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function writeRun({
  root,
  session,
  withResult,
  record = RECORD,
  multiday = null,
  timeline = null,
  programOutcomes = null,
}) {
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "launch.json"), JSON.stringify({ schema: "gamebuddy-live-run-launch/v1" }));
  if (withResult === true)
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        state: "blocked",
        toolTiming: { record },
        ...(multiday === null ? {} : { multiday }),
        ...(programOutcomes === null ? {} : { programOutcomes }),
      }),
    );
  if (timeline !== null)
    writeFileSync(join(runDir, "timeline.jsonl"), `${timeline.map((row) => JSON.stringify(row)).join("\n")}\n`);
  if (session !== null) {
    const path = join(runDir, ...SESSION_RELATIVE);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, session);
  }
  return runDir;
}

function verdictProcess(runDir, { cwd = REPO, extraArgs = [] } = {}) {
  const appData = join(runDir, "..", "appdata");
  mkdirSync(appData, { recursive: true });
  return spawnSync(process.execPath, [VERDICT, runDir, ...extraArgs], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, APPDATA: appData },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runVerdict(runDir, options = {}) {
  const result = verdictProcess(runDir, options);
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
      assert.equal(
        bucketTurns(block, "housekeeping"),
        1,
        "a stop_action turn priced the run's bookkeeping, not a residual bucket",
      );
      assert.doesNotMatch(
        block,
        /^ {4}other\b/mu,
        "there is no residual bucket: every turn lands in one that names what it did",
      );
      assert.match(block, /accounting\s+6 bucket turns = 6 prompt turns/u);
      assert.equal(bucketTurns(block, "speech_only"), 0, "every turn here called something");
      assert.match(block, /assistant_messages\s+6 \(1\.0 per prompt turn\)/u);
      assert.match(block, /model_seconds_per_completed_action\s+6\.0s \/ 4 actions = 1\.5s per action/u);
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

/**
 * THE INSERTED-NODE READING, AGAINST THE WORLD THE FIX EXISTS FOR.
 *
 * The population is the node ids the COMPILER reported, so the fixture carries them exactly as `body-program-script.ts`
 * publishes them, and the outcome is joined from the run's own bundle. A node the author never wrote that settled as a
 * failure fails the verdict by name; a run whose plans inserted nothing is `blocked` rather than green.
 */
test("an inserted node that settled as a failure is named and fails the verdict", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({
        steps: [
          {
            calls: [
              planCall("i1", 3, "talk_to_npc", ["auto_dismiss_02"]),
              statusCall("si1", "plan_i1", [
                ["n01", "succeeded", "talk_to_npc"],
                ["auto_dismiss_02", "failed", "dismiss_modal"],
                ["n03", "succeeded", "chop_tree"],
              ]),
            ],
          },
        ],
      }),
      programOutcomes: [
        {
          programId: "plan_i1",
          nodeOutcomes: [
            { nodeId: "n01", actionId: "talk_to_npc", state: "succeeded" },
            {
              nodeId: "auto_dismiss_02",
              actionId: "dismiss_modal",
              state: "failed",
              reasonCode: "no_modal_present",
            },
            { nodeId: "n03", actionId: "chop_tree", state: "succeeded" },
          ],
        },
      ],
    }),
    (runDir) => {
      const result = verdictProcess(runDir);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /inserted_nodes\s+1 node\(s\) the compiler wrote across 1 plan\(s\), 1 not succeeded/u);
      assert.match(
        output,
        /inserted_node_failed:auto_dismiss_02:dismiss_modal:no_modal_present - the compiler wrote this node to give the body back/u,
      );
      assert.equal(result.status, 1, "an inserted node that failed is the defect this reading exists for");
    },
  ));

test("a run whose plans inserted nothing reports the inserted-node gate as blocked, not green", () =>
  withFixture(
    () => ({ withResult: true, session: sessionFile({ steps: [{ calls: [planCall("n1", 1, "cut_weeds")] }] }) }),
    (runDir) => {
      const result = verdictProcess(runDir);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(
        output,
        /inserted_nodes\s+blocked: this run's plans inserted nothing, so the gate examined 0 inserted node\(s\) - not green, nothing to check/u,
      );
      assert.doesNotMatch(output, /inserted_node_failed/u);
      assert.notEqual(result.status, 1, "nothing to check is blocked, not red");
    },
  ));

test("an inserted node whose outcome was never recorded is unmeasured, not zero", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({ steps: [{ calls: [planCall("u1", 2, "talk_to_npc", ["auto_dismiss_02"])] }] }),
    }),
    (runDir) => {
      const result = verdictProcess(runDir);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /1 with no recorded outcome \(unmeasured, not zero\)/u);
      assert.doesNotMatch(output, /inserted_node_failed/u);
    },
  ));

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
      assert.match(block, /dispatches\s+1 /u);
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

// THE CROSSINGS NUMBER. The loop counted the nights it watched and the artifact published that count as the nights the
// run lived; these fixtures are the shapes that difference takes, and the evidence that answers it.
const sleepReceipt = (atMs, requestId) => ({
  type: "execution_receipt",
  atMs,
  reasonCode: "day_advanced",
  requestId,
  evidence: { detail: "state=passed;reason=day_advanced;entered_via=native_sleep_prompt;day_before=4;day_after=5" },
});
const dayStartedFact = (day) => ({
  type: "world_fact",
  worldFactKind: "day_started",
  worldFactPayload: { eventId: `day_started_day_${String(day)}` },
});
const watchedNight = (day) => ({
  day,
  terminal: { state: "succeeded", reasonCode: "day_advanced" },
  after: { dayOfMonth: 5 },
  menus: [],
});
const twoTurns = () => sessionFile({ steps: [{ calls: [observeCall("c1")] }, { calls: [] }] });

test("a night crossed after the watcher stopped is counted, named post_watch beside all four numbers", () =>
  withFixture(
    () => ({
      withResult: true,
      session: twoTurns(),
      multiday: {
        crossings: 2,
        dayRecords: [watchedNight(1), watchedNight(2)],
        assessment: { daysCrossed: 2, passOutNights: 0, unobservedNights: 0 },
      },
      timeline: [
        sleepReceipt(1794310882971, "r1"),
        sleepReceipt(1794311627708, "r2"),
        sleepReceipt(1794312231618, "r3"),
        dayStartedFact(5),
        dayStartedFact(6),
        dayStartedFact(7),
      ],
    }),
    (runDir) => {
      const output = runVerdict(runDir);
      assert.match(output, /nights\s+crossings 3 by the run's own evidence: 2 watched, 1 post_watch/u);
      assert.match(output, /sleep_receipts\s+3\s+<- timeline\.jsonl/u);
      assert.match(output, /day_started_facts\s+3\s+<- timeline\.jsonl/u);
      assert.match(output, /day_records\s+2\s+<- result\.json multiday\.dayRecords/u);
      assert.match(output, /recorded\s+2\s+<- result\.json multiday\.crossings/u);
      assert.match(output, /observed\s+watch, watch, post_watch/u);
      // THE DISAGREEMENT NAMES THE CLAIM, NOT THE EVIDENCE. The three nights are agreed by the receipts and the calendar
      // (3 = 3, printed above); what falls short is the loop's own watch and the number this artifact published, which is
      // the round44 defect - so those are the two sources named, and a run whose evidence also disagreed would name
      // every readable source instead (the fixture below).
      assert.match(output, /DISAGREEMENT\s+crossings_disagree:day_records=2:recorded=2/u);
      assert.match(output, /4 night mechanism\s+PASS\s+crossed=3 \(evidence: 2 watched, 1 post_watch\)/u);
      assert.doesNotMatch(output, /crossings 2 by the run's own evidence/u, "the watched count is not the crossings");
    },
  ));

test("evidence sources that disagree are printed with all their numbers rather than reconciled into one", () =>
  withFixture(
    () => ({
      withResult: true,
      session: twoTurns(),
      multiday: {
        crossings: 2,
        dayRecords: [watchedNight(1), watchedNight(2)],
        assessment: { daysCrossed: 2, passOutNights: 0, unobservedNights: 0 },
      },
      timeline: [
        sleepReceipt(1, "r1"),
        sleepReceipt(2, "r2"),
        sleepReceipt(3, "r3"),
        dayStartedFact(5),
        dayStartedFact(6),
      ],
    }),
    (runDir) => {
      const output = runVerdict(runDir);
      assert.match(output, /nights\s+crossings not_decided/u);
      assert.match(output, /DISAGREEMENT\s+crossings_disagree:sleep_receipts=3:day_started_facts=2/u);
      assert.match(output, /4 night mechanism\s+PASS\s+crossed=not_decided/u);
      assert.doesNotMatch(output, /crossings 3 by the run's own evidence/u, "two evidence sources, no single number");
    },
  ));

test("a tool-less turn is speech_only, a plan turn is a dispatch, and no residual bucket holds either", () => {
  const steps = [];
  for (let index = 0; index < 20; index += 1) steps.push({ calls: [] });
  for (let index = 0; index < 20; index += 1) steps.push({ calls: [planCall(`p${index}`, 1, "cut_weeds")] });
  withFixture(
    () => ({ withResult: true, session: sessionFile({ steps }) }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.equal(bucketTurns(block, "speech_only"), 20);
      assert.equal(bucketTurns(block, "dispatches"), 20);
      assert.doesNotMatch(block, /^ {4}other\b/mu, "the 45 % bucket that described nothing is gone");
      assert.match(block, /accounting\s+40 bucket turns = 40 prompt turns/u);
      assert.match(block, /of the \S+ wall, nothing unaccounted/u);
      assert.match(block, /speech_only\s+20 of 40 prompt turns made no tool call: \S+ \(\d+\.\d% of the wall\)/u);
      assert.match(block, /median turn \d+\.\ds, median text 2 chars/u);
      assert.match(block, /speech_only_messages 20 messages · \S+ - the same turns read by message/u);
      assert.match(block, /against 0\.0s in 0 poll turn\(s\)/u);
    },
  );
});

// THE UNIT. A bucket is a prompt turn, so a turn that spoke, dispatched and then spoke again is ONE dispatch turn - and
// the messages it took are counted on the message line, not as three turns.
test("three assistant messages in one prompt turn are ONE dispatch turn, and the message line counts three", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({
        steps: [
          { calls: [], text: "先看一眼。" },
          { calls: [planCall("c1", 2, "cut_weeds")], prompt: false },
          { calls: [], prompt: false, text: "排好了，两格都交给你。" },
        ],
      }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.equal(bucketTurns(block, "dispatches"), 1, "two text messages do not make a second turn");
      assert.equal(bucketTurns(block, "speech_only"), 0);
      assert.match(block, /prompt_turns\s+1 - one turn per delivered user message/u);
      assert.match(block, /assistant_messages\s+3 \(3\.0 per prompt turn\)/u);
      assert.match(block, /^ {4}dispatches +1 +3\.0s/mu, "the turn's seconds are its three messages' seconds");
      assert.match(block, /accounting\s+1 bucket turns = 1 prompt turns/u);
      assert.match(block, /accounting_messages\s+3\.0s of assistant time over 3 messages/u);
    },
  ));

test("two text-only messages in one prompt turn are ONE speech_only turn, and the message line counts two", () =>
  withFixture(
    () => ({
      withResult: true,
      session: sessionFile({
        steps: [
          { calls: [], text: "嗯。" },
          { calls: [], prompt: false, text: "想想。" },
        ],
      }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.equal(bucketTurns(block, "speech_only"), 1);
      assert.match(block, /^ {4}speech_only +1 +2\.0s/mu);
      assert.match(block, /speech_only\s+1 of 1 prompt turns made no tool call/u);
      // 5 characters across two messages: the reading prices the turn's own text, so a short turn is visible as short.
      assert.match(block, /median text 5 chars, largest 5 chars/u);
      assert.match(block, /speech_only_messages 2 messages · 2\.0s/u);
    },
  ));

test("seconds that reach no bucket fail the verdict loudly, naming how many", () => {
  const steps = [
    { calls: [observeCall("c1")] },
    { calls: [observeCall("c2")], timestamp: "not-a-date" },
    { calls: [observeCall("c3")] },
  ];
  withFixture(
    () => ({ withResult: true, session: sessionFile({ steps }) }),
    (runDir) => {
      const result = verdictProcess(runDir);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, `an unbalanced accounting must exit non-zero:\n${output}`);
      assert.match(output, /accounting\s+.*MISSING \d+\.\ds in no bucket/u);
      assert.match(output, /ACCOUNTING FAILURE\s+\d+\.\ds of the \d+\.\ds wall reaches no bucket/u);
      assert.match(output, /the buckets do not add up, so no share here can be read/u);
    },
  );
});

// THE WAKE ACCOUNT, as the verdict must read it.
//
// The wall clock of a live run is 94% model time because the harness wakes her per programme rather than per objective.
// Two of the three readings are arithmetic on what the verdict already measures (prompt turns and the objectives they
// served, the buckets' seconds against the wall); the third - what was suppressed, and why - exists nowhere but in the
// runner's own account, so a run that did not publish it must say so by field name instead of printing a zero.
const WAKE_STEPS = [
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
  { calls: [stopCall("c5")] },
  { calls: [observeCall("c6")] },
];

test("the verdict prices the wakes: how many per objective, and the model's share of the wall", () =>
  withFixture(
    () => ({
      withResult: true,
      multiday: {
        wakes: {
          total: 6,
          continuationPromptsIssued: 2,
          continuationPromptsSuppressed: 3,
          suppressedByReason: { body_still_working: 2, objective_met: 1 },
          byReason: { day_start: 1, continuation: 2, stall_wake: 0, day_end_offer: 1, player_input: 0 },
        },
      },
      session: sessionFile({ steps: WAKE_STEPS }),
    }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      // Six prompt turns serving two objectives: the number the round44 baseline is stated in.
      assert.match(block, /wakes_per_objective\s+3\.0 = 6 prompt turns \/ 2 objectives/u);
      // The model's own seconds against the measured wall, not against the buckets' own sum.
      assert.match(block, /wall_ms_in_model\s+[1-9]\d?\.\d% = 6\.0s model \/ \d+\.\ds wall/u);
      assert.match(block, /continuation_prompts_issued\s+2 of 6 prompt turns/u);
      assert.match(block, /day_start 1, continuation 2, stall_wake 0, day_end_offer 1, player_input 0/u);
      assert.match(block, /continuation_prompts_suppressed\s+3: body_still_working 2, objective_met 1/u);
    },
  ));

test("a run that published no wake account says so by field name, never as a zero", () =>
  withFixture(
    () => ({ withResult: true, session: sessionFile({ steps: WAKE_STEPS }) }),
    (runDir) => {
      const block = efficiencyBlock(runVerdict(runDir));
      assert.match(block, /wakes_per_objective\s+3\.0 = 6 prompt turns \/ 2 objectives/u);
      assert.match(
        block,
        /continuation_prompts_issued\s+not_measured \(result\.json multiday\.wakes was not published by this run\)/u,
        "an absent account is not an account of zero suppressions",
      );
    },
  ));
