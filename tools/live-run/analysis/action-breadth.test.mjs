// Breadth has to be readable BEFORE the run ends, and each number has to say which file it came from.
//
// Measured 2026-11-19: `round78` was stopped eleven minutes in, so `result.json` never existed - and this tool printed
// `action_breadth_result_unreadable` while its runner log held all 74 executions and ten action families. The audit had to
// count them by hand from the log. That is the defect these fixtures pin: the log is a source, the readings are marked
// partial, the identities are counted beside the lines, and the two sources are reported side by side instead of summed.
//
// red-proof: history  point these tests at the previous `action-breadth.mjs`: the log-only fixture exits 2 with
//                    `action_breadth_result_unreadable`, no `action_breadth_source` line exists, and there is no
//                    `a_reading_names_the_source_it_read` line at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { productivityGate, readTaskPrompts, settlementGate } from "./action-breadth.mjs";

const BREADTH = join(import.meta.dirname, "action-breadth.mjs");
const START = Date.parse("2026-11-19T10:30:34.853Z");
// The task's own sentence, read from the table that composes a day's note: a fixture that spelled it again would agree
// with itself rather than with the run.
const NOTE_ZH = (task) =>
  `我今天去镇上办事，你把这活儿干一下：${readTaskPrompts().zh[task].trim()}怎么安排你自己定，天黑累了就回屋睡，不用等我。`;

const receiptLine = (executionId, actionId, state, atMs = START + 1000) =>
  `BRIDGE_FACT ${JSON.stringify({
    type: "execution_receipt",
    atMs,
    executionId,
    requestId: `request-${executionId}`,
    reasonCode: state,
    evidence: { detail: "chore=itemTargets;tile=1,2" },
    worldFactPayload: {
      actionId,
      executionId,
      state,
      reasonCode: state,
      evidence: { detail: "chore=itemTargets;tile=1,2" },
      origin: { kind: "programme", programId: "plan_1", nodeId: "n01" },
    },
  })}`;

const LOG = [
  `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START + 1654}}`,
  receiptLine("exec-1", "move_to_tile", "succeeded"),
  receiptLine("exec-1", "move_to_tile", "succeeded"),
  receiptLine("exec-2", "break_rock", "succeeded"),
  receiptLine("exec-3", "navigate_to_destination", "rejected"),
  'AGENT_PROGRAM_SUBMIT {"programId":"plan_1","code":"accepted","nodes":3}',
];

// The shape `round79` printed as six successes: one action, six executions, four of them refusals. `exec-1` is written
// twice for the reason the log writes one receipt's detail in two places, so the identity population must stay six.
const MIXED_LOG = [
  `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START + 1654}}`,
  receiptLine("m-1", "move_placed_furniture", "succeeded"),
  receiptLine("m-1", "move_placed_furniture", "succeeded"),
  receiptLine("m-2", "move_placed_furniture", "succeeded"),
  receiptLine("m-3", "move_placed_furniture", "rejected"),
  receiptLine("m-4", "move_placed_furniture", "rejected"),
  receiptLine("m-5", "move_placed_furniture", "rejected"),
  receiptLine("m-6", "move_placed_furniture", "rejected"),
  receiptLine("n-1", "navigate_to_destination", "uncertain"),
];

/** One run directory, its launch receipt, and the log directory this run's log was written into. */
function fixture({ result = null, logLines = LOG, sessions = [] }) {
  const root = mkdtempSync(join(tmpdir(), "action-breadth-"));
  const runDir = join(root, "run");
  const logs = join(root, "logs");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    join(runDir, "launch.json"),
    JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", label: "multiday_routine", startedAtMs: START }),
    "utf8",
  );
  if (result !== null) writeFileSync(join(runDir, "result.json"), JSON.stringify(result), "utf8");
  if (logLines !== null)
    writeFileSync(join(logs, "_multiday_routine-round99-live-runner.log"), `${logLines.join("\n")}\n`);
  for (const [index, notes] of sessions.entries()) {
    const path = join(
      runDir,
      "runtime-root",
      "contexts",
      "ctx-1",
      "surface-sessions",
      "game-1",
      "sessions",
      `session-${String(index + 1)}.jsonl`,
    );
    mkdirSync(join(path, ".."), { recursive: true });
    const lines = notes.map((note, turn) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(START + 1000 + turn * 3000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: note }] },
      }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  }
  return { root, runDir, logs };
}

function breadth(options, extraArgs = []) {
  const run = spawnSync(process.execPath, [BREADTH, ...extraArgs], { encoding: "utf8", cwd: options.root });
  return { out: `${run.stdout}${run.stderr}`, status: run.status };
}

const line = (out, label) => out.split("\n").find((entry) => entry.startsWith(label)) ?? "";

test("a run with no bundle is measured from its log, and every reading says so", () => {
  const options = fixture({});
  try {
    const { out, status } = breadth(options, [
      "--run",
      options.runDir,
      "--log-dir",
      options.logs,
      "--baseline",
      join(import.meta.dirname, "..", "..", "action-breadth-baseline.json"),
    ]);
    assert.match(line(out, "action_breadth_source:"), /^action_breadth_source: live-runner\.log/u);
    assert.match(line(out, "action_breadth_partial:"), /^action_breadth_partial: true/u);
    assert.match(
      line(out, "action_breadth_identities:"),
      /3 executions keyed on the executionId each receipt carries, out of 4 receipt lines \(1 collapsed on that identity\)/u,
      "one receipt written twice is one execution, and the four lines it was counted out of are printed beside it",
    );
    assert.match(line(out, "action_breadth: attempted"), /attempted 3 of \d+ published/u);
    assert.match(line(out, "action_breadth_verdict:"), /partial - the run has not ended/u);
    assert.match(
      out,
      /^a_reading_names_the_source_it_read readings examined \d+ · from-result 0 · from-log [1-9]\d* · unmeasured 0$/mu,
      "every reading taken from the log names the log, and none is left without a source",
    );
    assert.equal(status, 2, "a mid-run reading has no snapshot census, so it is not_measured rather than a verdict");
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("a bundle answers first, and the log is printed beside it instead of being added to it", () => {
  const options = fixture({
    result: {
      scenario: "multiday_routine",
      attemptedActionIds: ["move_to_tile", "break_rock"],
      succeededActionIds: ["move_to_tile"],
      executionTrace: { rows: 6, flat: 0 },
      programOutcomes: [],
      programSubmissions: [],
    },
  });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    assert.match(line(out, "action_breadth_source:"), /^action_breadth_source: result\.json/u);
    assert.doesNotMatch(
      out,
      /action_breadth_partial/u,
      "the bundle is the run's final account, so nothing here is partial",
    );
    assert.match(
      line(out, "action_breadth_log_vs_bundle:"),
      /result\.json names 2 actions in 6 executions, live-runner\.log 3 in 3 identities - 3 execution\(s\) the bundle counts and no receipt names/u,
    );
    assert.match(line(out, "action_breadth_log_vs_bundle:"), /two readings of one run, never summed/u);
    assert.match(
      out,
      /^a_reading_names_the_source_it_read readings examined \d+ · from-result [1-9]\d* · from-log [1-9]\d* · unmeasured 0$/mu,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("a row whose executions were refused reads as refusals, never as one success", () => {
  const options = fixture({ logLines: MIXED_LOG });
  try {
    const { out } = breadth(options, [
      "--run",
      options.runDir,
      "--log-dir",
      options.logs,
      "--baseline",
      join(import.meta.dirname, "..", "..", "action-breadth-baseline.json"),
    ]);
    assert.match(
      line(out, "action_breadth_action: move_placed_furniture"),
      /executions 6 \(6 distinct executionIds\) · succeeded 2 · rejected 4 · uncertain 0/u,
      "the row names what each of its six executions settled, counted once per executionId although the log wrote one receipt twice",
    );
    assert.match(
      line(out, "action_breadth_action: navigate_to_destination"),
      /executions 1 \(1 distinct executionIds\) · succeeded 0 · rejected 0 · uncertain 1/u,
      "uncertain is its own settlement, not a rounding of succeeded or rejected",
    );
    assert.doesNotMatch(
      out,
      /executions[= ]\d+ (?:succeeded|not_succeeded)\b/u,
      "a row marked succeeded because the action appears in a list of successes is the reading this tool must not print",
    );
    assert.match(
      line(out, "action_breadth_settlements:"),
      /^action_breadth_settlements: 7 executions \(7 distinct executionIds\) · succeeded 2 · rejected 4 · uncertain 1 · day_task=not_measured:\S+$/u,
    );
    assert.match(
      out,
      /^a_reading_of_success_names_the_settlement_it_read rows examined 2 · settled 2 · assumed 0 · not_measured 0$/mu,
      "every row names the settlement it read, so none is assumed",
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("the settlement gate reds on a row that reads as an outcome with no settlement behind it", () => {
  const gate = settlementGate([
    {
      reading: "action_breadth_action:move_placed_furniture",
      line: "action_breadth_action: move_placed_furniture family=buildings_farm_management executions=6 succeeded",
    },
    {
      reading: "action_breadth_action:navigate_to_destination",
      line: "action_breadth_action: navigate_to_destination family=world_navigation executions 10 (10 distinct executionIds) · succeeded 0 · rejected 8 · uncertain 2",
    },
  ]);
  assert.equal(gate.failed, true);
  assert.equal(gate.lines.length, 2, "one finding, then the summary");
  assert.match(
    gate.lines[0],
    /^a_reading_of_success_names_the_settlement_it_read:action_breadth_action:move_placed_furniture - this row reads as an outcome/u,
    "the failure names the row, not just a count",
  );
  assert.match(gate.lines[1], /rows examined 2 · settled 1 · assumed 1 · not_measured 0$/u);
});

test("the settlement gate refuses a population of zero instead of agreeing with itself", () => {
  const gate = settlementGate([]);
  assert.equal(gate.failed, true);
  assert.match(
    gate.lines[0],
    /^a_reading_of_success_names_the_settlement_it_read:blocked - rows examined 0 · settled 0 · assumed 0 · not_measured 0/u,
  );
});

test("a bundle with no receipts says not_measured per row rather than success", () => {
  const options = fixture({
    result: {
      scenario: "multiday_routine",
      attemptedActionIds: ["move_to_tile", "break_rock"],
      succeededActionIds: ["move_to_tile"],
      executionTrace: { rows: 6, flat: 0 },
      programOutcomes: [],
      programSubmissions: [],
    },
    logLines: null,
  });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    const row = line(out, "action_breadth_action: move_to_tile");
    assert.match(row, /settlement not_measured:no_per_execution_settlement_read/u);
    assert.doesNotMatch(row, /\bsucceeded\b/u, "a bundle publishes a list of actions, not a settlement per execution");
    assert.match(
      out,
      /^a_reading_of_success_names_the_settlement_it_read rows examined 2 · settled 0 · assumed 0 · not_measured 2$/mu,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("neither record is a refusal that names both, never a run that measured nothing", () => {
  const options = fixture({ logLines: null });
  try {
    const { out, status } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    assert.match(out, /^action_breadth_refused: no reading can be taken from this run/mu);
    assert.match(line(out, "action_breadth_bundle:"), /result\.json does not exist/u);
    assert.match(line(out, "action_breadth_log:"), /no -live-runner\.log under/u);
    assert.match(out, /^a_reading_names_the_source_it_read:blocked - readings examined 0/mu);
    assert.equal(status, 2);
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

// THE DAY'S TASK, WHICH IS WHAT A COUNT HAS TO BE READ AGAINST. Measured 2026-11-19 (`round79`): `place_owned_object 3 ·
// move_placed_furniture 6 · color_placed_object 2 · rotate_furniture 4` was read as a run that did almost nothing, because
// the audit compared it against farming, foraging, mining, social and fishing - none of which the day had asked for. The
// day's task was `furnish_and_arrange`, and these tests pin that the reading says so and keeps its two numbers apart.
const DAY_LOG = [
  `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START + 1654}}`,
  receiptLine("d-1", "place_owned_object", "succeeded", START + 3000),
  receiptLine("d-2", "move_placed_furniture", "rejected", START + 4000),
  receiptLine("d-3", "color_placed_object", "succeeded", START + 5000),
  receiptLine("d-4", "express_emote", "succeeded", START + 6000),
];

test("a run whose day asked for furnishing is judged against furnishing, not against a farm", () => {
  const options = fixture({ logLines: DAY_LOG, sessions: [[NOTE_ZH("furnish_and_arrange")]] });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    assert.match(
      line(out, "action_breadth_day:"),
      /^action_breadth_day: day 1 · day_task=furnish_and_arrange · family \{place_owned_object,move_placed_furniture,remove_placed_item,color_placed_object,dress_mannequin,set_sign_display\} · source session:session-1\.jsonl \(partial - this run published no result\.json\)/u,
      "the day's task is printed beside the work, and the source that answered is named with it",
    );
    assert.match(
      line(out, "action_breadth_day_family:"),
      /· day_task=furnish_and_arrange day_family=yes · attempted 3 of 6 · succeeded 2 of 3 executions \(rejected 1\) · not attempted remove_placed_item,dress_mannequin,set_sign_display/u,
      "coverage of the day's own work and whether it landed are two numbers, printed separately",
    );
    assert.match(
      line(out, "action_breadth_day_shape:"),
      /the task names no farming_crops, resource_gathering, animals_pets action, and this day ran 0 executions in those families - that is the day's shape, not a day of work missed/u,
      "a day that asked for no farm work and saw none is correct, and the reading says so instead of implying neglect",
    );
    assert.match(
      line(out, "action_breadth_action: place_owned_object"),
      /day_task=furnish_and_arrange day_family=yes/u,
      "an action the task names is marked as the day's work",
    );
    assert.match(
      line(out, "action_breadth_action: express_emote"),
      /day_task=furnish_and_arrange day_family=no/u,
      "an action the day did not ask for still names the day it is being read against",
    );
    assert.match(
      out,
      /^a_reading_of_productivity_names_the_day_it_judged rows examined \d+ · day-task named [1-9]\d* · family-scored [1-9]\d* · unanchored 0$/mu,
      "every row that scores an action count names the day it judged",
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("a day whose task IS farm work is judged against that farm work, with its own numbers", () => {
  const options = fixture({
    logLines: [
      `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START + 1654}}`,
      receiptLine("f-1", "till_soil", "succeeded", START + 3000),
      receiptLine("f-2", "plant_seed", "succeeded", START + 4000),
      receiptLine("f-3", "water_crop", "rejected", START + 5000),
    ],
    sessions: [[NOTE_ZH("till_and_sow")]],
  });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    assert.match(
      line(out, "action_breadth_day_family:"),
      /day 1 · day_task=till_and_sow day_family=yes · attempted 3 of 4 · succeeded 2 of 3 executions \(rejected 1\)/u,
      "the same row judges a farm day against the farm actions that day named",
    );
    assert.match(line(out, "action_breadth_action: till_soil"), /day_task=till_and_sow day_family=yes/u);
    assert.doesNotMatch(
      out,
      /action_breadth_day_shape/u,
      "a task that names farm actions gets no 'the farm count is the day's shape' note",
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("each day of a run is measured on its own executions, split at the instant its note arrived", () => {
  const options = fixture({
    logLines: [
      `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START + 1654}}`,
      receiptLine("a-1", "place_owned_object", "succeeded", START + 2000),
      receiptLine("a-2", "move_placed_furniture", "rejected", START + 3000),
      receiptLine("b-1", "machine_load", "succeeded", START + 5000),
      receiptLine("b-2", "craft_item", "rejected", START + 6000),
    ],
    // The notes arrive at +1000 and +4000, so the first two receipts are day 1's and the last two are day 2's.
    sessions: [[NOTE_ZH("furnish_and_arrange"), NOTE_ZH("run_the_machines")]],
  });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    const families = out.split("\n").filter((entry) => entry.startsWith("action_breadth_day_family:"));
    assert.equal(families.length, 2, "one line per day, each with its own numbers");
    assert.match(
      families[0],
      /day 1 · day_task=furnish_and_arrange day_family=yes · attempted 2 of 6 · succeeded 1 of 2 executions/u,
    );
    assert.match(
      families[1],
      /day 2 · day_task=run_the_machines day_family=yes · attempted 2 of 5 · succeeded 1 of 2 executions/u,
    );
    assert.match(line(out, "action_breadth_day:"), /day 1 · day_task=furnish_and_arrange/u);
    assert.match(out, /^action_breadth_day: day 2 · day_task=run_the_machines /mu);
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("a bundle's own taskPurposes is the first authority for what each day asked", () => {
  const options = fixture({
    result: {
      scenario: "multiday_routine",
      attemptedActionIds: ["till_soil", "plant_seed"],
      succeededActionIds: ["till_soil"],
      executionTrace: { rows: 2, flat: 0 },
      taskPurposes: [{ day: 1, task: "till_and_sow", state: "achieved", reasonCode: "task_purpose_achieved" }],
    },
    logLines: null,
  });
  try {
    const { out } = breadth(options, ["--run", options.runDir, "--log-dir", options.logs]);
    assert.match(
      line(out, "action_breadth_day:"),
      /^action_breadth_day: day 1 · day_task=till_and_sow · family \{till_soil,plant_seed,water_crop,fertilize_tile\} · source result\.json - the bundle's own taskPurposes$/u,
      "the run's own declaration answers before any session record, and a run that ended is not marked partial",
    );
    assert.match(
      line(out, "action_breadth_day_family:"),
      /day 1 · day_task=till_and_sow day_family=yes · attempted not_measured:no_per_action_execution_count of 4 · succeeded not_measured:no_per_execution_settlement_read/u,
      "a bundle publishes executions without a settlement per execution and without a per-action count, and the reading says which half is missing instead of printing `0 of 4`",
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("the productivity gate reds on a row that scores an action count and names no day", () => {
  const gate = productivityGate([
    "action_breadth: attempted 5 of 101 published (5.0%)",
    "action_breadth_day_family: day 1 · day_task=furnish_and_arrange day_family=yes · attempted 2 of 6 · succeeded 1 of 2 executions (rejected 1)",
  ]);
  assert.equal(gate.failed, true);
  assert.match(
    gate.lines[0],
    /^a_reading_of_productivity_names_the_day_it_judged:action_breadth:attempted - this row scores an action count and names no day it judged/u,
    "the failure names the row, not just a count",
  );
  assert.match(gate.lines[1], /rows examined 2 · day-task named 1 · family-scored 1 · unanchored 1$/u);
  // A row that names the ABSENCE of a day task is not unanchored: it states which question no artifact answered.
  const absent = productivityGate([
    "action_breadth: attempted 5 of 101 published · day_task=not_measured:no session record",
  ]);
  assert.equal(absent.failed, false);
  assert.match(
    absent.lines[0],
    /rows examined 1 · day-task named 0 · family-scored 0 · unanchored 0 · day-task not_measured 1$/u,
  );
  // And a population of zero is blocked rather than green.
  const empty = productivityGate([]);
  assert.equal(empty.failed, true);
  assert.match(empty.lines[0], /:blocked - rows examined 0 · day-task named 0 · family-scored 0 · unanchored 0/u);
});
