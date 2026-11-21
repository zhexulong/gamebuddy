// The interaction-value gate has to be able to go red, and its red has to name which clause failed.
//
// Every fixture here is fabricated on purpose: the gate's input is a run directory plus a session record, so a
// synthetic pair states exactly one property per test - three step reports and no remark about the player, an obstacle
// answered with a plan, a session that cannot be bound to the run at all - without a live game in the loop. The counts
// asserted are the gate's whole claim, so each test pastes them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessInteractionValue,
  classifySpokenLine,
  formatInteractionValueTable,
  PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES,
  SCHEMA,
} from "./interaction-value-gate.mjs";

const RUN_START = Date.parse("2026-11-04T10:00:00.000Z");
const at = (minutes) => RUN_START + Math.round(minutes * 60_000);
const iso = (minutes) => new Date(at(minutes)).toISOString();
const RUN_NAME = "2026-11-04T10-00-00-000Z-interaction-value";

const clauseFor = (report, id) => report.clauses.find((entry) => entry.id === id);

function assistant(text, minute) {
  return {
    type: "message",
    id: `assistant-${minute}`,
    timestamp: iso(minute),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function toolOnlyAssistant(minute) {
  return {
    type: "message",
    id: `assistant-tool-${minute}`,
    timestamp: iso(minute),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${minute}`, name: "stardew_observe", arguments: {} }],
    },
  };
}

function toolResult(minute) {
  return {
    type: "message",
    id: `tool-result-${minute}`,
    timestamp: iso(minute),
    message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
  };
}

function playerLine(text, minute) {
  const batch = {
    kind: "gamebuddy_fact_batch",
    batchId: `batch-${minute}`,
    disposition: "steer",
    triggerEventIds: [],
    playerInputs: [{ source: "player_text", inputId: `input-${minute}`, text }],
    worldFacts: [],
    events: [],
  };
  return {
    type: "message",
    id: `user-${minute}`,
    timestamp: iso(minute),
    message: { role: "user", content: [{ type: "text", text: JSON.stringify(batch) }] },
  };
}

const receipt = (minute, state, reasonCode) => ({
  type: "execution_receipt",
  atMs: at(minute),
  reasonCode,
  worldFactPayload: { state, reasonCode },
});
const milestone = (minute, gameTime) => ({
  type: "world_fact",
  atMs: at(minute),
  worldFactKind: "time_milestone",
  worldFactPayload: { kind: "time_milestone", gameTime },
});
const lifecycle = (minute) => ({ type: "lifecycle", atMs: at(minute), reasonCode: "session_ready" });

// The retired classifier, kept here as the red case the structural rule replaces: a care collocation or a fixed day
// phrase. Every line in the tests below was spoken to the player and none of them contains one of its alternatives.
const RETIRED_PLAYER_OR_DAY =
  /你(?:累|困|饿|冷|热|还好|没事|昨晚|睡得|先歇|去歇|歇会|歇歇|辛苦)|咱(?:俩|们)|我们|早点(?:睡|歇)|天(?:亮|黑)了|晚安|早上好|这日子|今天(?:累|辛|真|就)|明天(?:再|还|见)/u;

/** The directory shape the runtime writes its session records into. */
function sessionsDir(runDir) {
  return join(runDir, "runtime-root", "contexts", "hash", "surface-sessions", "game-1", "sessions");
}

/**
 * One session record at the path shape the product writes: `<utc>_<sessionId>.jsonl`, where the stamp is the moment the
 * runtime opened that session - the fact the gate filters its population by.
 */
function writeSessionFile(runDir, stampMs, rows) {
  const directory = sessionsDir(runDir);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date(stampMs).toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const path = join(directory, `${stamp}_01a1a61a-f518-76e4-8b96-37d7f118b88c.jsonl`);
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return path;
}

/** A run directory in the product's captured shape, with the one session record its own first row names. */
function writeRun(t, { timeline, session }) {
  const root = mkdtempSync(join(tmpdir(), "gb-interaction-value-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, RUN_NAME);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "timeline.jsonl"), timeline.map((row) => `${JSON.stringify(row)}\n`).join(""));
  writeSessionFile(runDir, Date.parse(String(session[0].timestamp)), session);
  return runDir;
}

/** An unwritten run directory, for the tests that place several session records themselves. */
function writeRunShell(t, timeline) {
  const root = mkdtempSync(join(tmpdir(), "gb-interaction-value-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, RUN_NAME);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "timeline.jsonl"), timeline.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return runDir;
}

const header = (minute) => ({ type: "session", version: 3, id: "session", timestamp: iso(minute), cwd: "/run" });

test("three bare step reports and no remark about the player fail clauses 4 and 1", (t) => {
  const runDir = writeRun(t, {
    timeline: [
      lifecycle(0),
      receipt(2, "accepted", "accepted"),
      milestone(3, "0600"),
      receipt(12, "accepted", "accepted"),
      milestone(29, "0730"),
    ],
    session: [
      header(0),
      assistant("草浇完了，石头也敲完了。", 5),
      assistant("我把门修好了。", 10),
      assistant("种子种完了，水也浇好了。", 15),
      toolResult(16),
    ],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(report.schema, SCHEMA);
  assert.equal(report.verdict, "failed");
  const stepReports = clauseFor(report, "no_step_reports");
  assert.equal(stepReports.state, "fail");
  assert.equal(stepReports.observed.stepReports, 3);
  assert.equal(stepReports.observed.lines, 3);
  assert.deepEqual(
    stepReports.evidence.map((entry) => entry.text),
    ["草浇完了，石头也敲完了。", "我把门修好了。", "种子种完了，水也浇好了。"],
    "every step report is quoted with its classification, not just counted",
  );
  const remark = clauseFor(report, "player_or_day_rate");
  assert.equal(remark.state, "fail");
  assert.deepEqual(
    { spoken: remark.observed.spoken, counted: remark.observed.counted, dropped: remark.observed.dropped },
    { spoken: 3, counted: 0, dropped: 3 },
    "a run whose every bubble is a step report counts nothing, and the three it dropped are accounted for",
  );
  assert.deepEqual(remark.observed.droppedByRegister, { step_report: 3, obstacle: 0, choice: 0, other: 0 });
  assert.equal(remark.observed.droppedReason, "neither_speaks_to_the_player_nor_locates_the_day");
  assert.equal(remark.reason, "fewer_player_or_day_remarks_than_one_per_five_minutes");
  assert.equal(remark.observed.rateWindowMinutes, 29, "the denominator is the run's own window, not the speech span");
  assert.equal(report.measurements.register.counts.step_report, 3);
  assert.equal(report.measurements.spokenLines.count, 3);
  assert.equal(report.measurements.spokenLines.wallMinutes, 10);
  assert.ok(
    report.measurements.spokenLines.gameSpanMinutes > 0,
    `the game clock advanced over the spoken window: ${String(report.measurements.spokenLines.gameSpanMinutes)}`,
  );
  assert.equal(report.establishment.bound, true);
});

test("one obstacle answered with a next plan passes that clause, quoting both halves", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), milestone(20, "0730")],
    session: [header(0), assistant("石头太多，搬不动。", 3), assistant("我先去把北边的草清了。", 4), toolResult(5)],
  });

  const report = assessInteractionValue({ runDir });
  const clause = clauseFor(report, "obstacle_with_plan");

  assert.equal(clause.state, "pass");
  assert.equal(clause.observed.pairs, 1);
  assert.equal(clause.observed.obstacles, 1);
  assert.equal(clause.evidence.length, 1);
  assert.equal(clause.evidence[0].obstacle.text, "石头太多，搬不动。");
  assert.equal(clause.evidence[0].plan.text, "我先去把北边的草清了。");
  assert.equal(report.measurements.register.counts.obstacle, 1);
  assert.equal(report.measurements.register.counts.other, 1, "the plan line is not an obstacle line");
});

test("a setback in the world that was never narrated fails the obstacle clause instead of passing it", (t) => {
  const runDir = writeRun(t, {
    timeline: [
      lifecycle(0),
      receipt(2, "rejected", "no_native_path"),
      receipt(3, "blocked", "destination_unreachable"),
    ],
    session: [header(0), assistant("我把门修好了。", 2), toolResult(3)],
  });

  const report = assessInteractionValue({ runDir });
  const clause = clauseFor(report, "obstacle_with_plan");

  assert.equal(clause.state, "fail");
  assert.equal(clause.reason, "setback_happened_and_was_never_narrated");
  assert.equal(clause.observed.refusalsInTimeline, 2);
  assert.equal(report.measurements.timeline.refusals, 2);
});

test("a session that cannot be bound to the run is not_established, never a pass", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600")],
    // A record from the previous day: the shape of the mixing defect this tool exists to prevent.
    session: [header(-24 * 60), assistant("我把门修好了。", -24 * 60 + 2)],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(report.verdict, "not_established");
  assert.notEqual(report.verdict, "passed");
  assert.equal(report.establishment.bound, false);
  assert.equal(report.establishment.reason, "no_session_inside_run_window");
  assert.equal(report.establishment.candidates.length, 1);
  assert.equal(report.establishment.candidates[0].reason, "outside_run_window");
  assert.equal(report.measurements.sessionBinding.excludedOutsideWindow, 1);
  assert.equal(report.measurements.spokenLines.count, 0);
  assert.ok(
    report.clauses.every((entry) => entry.state === "not_exercised"),
    "an unbound run exercises nothing, and every clause says why",
  );
  assert.ok(report.clauses.every((entry) => entry.reason === "session_not_bound:no_session_inside_run_window"));
});

test("an explicit session path whose messages are outside the run window is refused", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0)],
    session: [header(3 * 24 * 60), assistant("我把门修好了。", 3 * 24 * 60 + 1)],
  });

  const report = assessInteractionValue({
    runDir,
    sessionPath: join(
      sessionsDir(runDir),
      `${iso(3 * 24 * 60)
        .replaceAll(":", "-")
        .replaceAll(".", "-")}_01a1a61a-f518-76e4-8b96-37d7f118b88c.jsonl`,
    ),
  });

  assert.equal(report.verdict, "not_established");
  assert.equal(report.establishment.reason, "chosen_session_outside_window");
});

// The population rule, on the shape that broke it: a captured runtime root carries the profile's whole history, and the
// record of the run that finished six minutes earlier - whose last message lands inside this run's five-minute slack -
// is the exact file that made every real run report `session_binding_ambiguous`. A record from before the run is not an
// ambiguity to resolve, it is not a candidate at all.
test("a run directory full of earlier sessions binds the one stamped inside the run's window", (t) => {
  const runDir = writeRunShell(t, [lifecycle(0), milestone(0, "0600"), milestone(20, "0730")]);
  const previousDays = [
    writeSessionFile(runDir, Date.parse("2026-10-31T13:11:26.300Z"), [
      header(-4 * 24 * 60),
      assistant("旧会话里的话。", -4 * 24 * 60 + 1),
    ]),
    writeSessionFile(runDir, Date.parse("2026-11-03T06:34:03.725Z"), [
      header(-1 * 24 * 60),
      assistant("旧会话里的话。", -1 * 24 * 60 + 1),
    ]),
    // The previous run's own session: opened six minutes before this one started, and its last message still falls inside
    // the five-minute message slack - so the old overlap rule called it this run's session too.
    writeSessionFile(runDir, at(-6), [header(-6), assistant("旧会话里的话。", -1), toolResult(-0.5)]),
  ];
  const inside = writeSessionFile(runDir, at(1), [header(1), assistant("你昨晚睡得还好吗？", 2), toolResult(3)]);

  const report = assessInteractionValue({ runDir });

  assert.equal(report.establishment.bound, true);
  assert.equal(report.establishment.path, inside);
  assert.ok(!previousDays.includes(report.establishment.path));
  assert.equal(
    report.measurements.sessionBinding.excludedOutsideWindow,
    3,
    "three files are outside the window and each one is counted",
  );
  assert.equal(report.measurements.sessionBinding.considered, 1);
  assert.deepEqual(report.measurements.sessionBinding.superseded, []);
  assert.deepEqual(report.measurements.sessionBinding.runWindow, [at(0), at(20)]);
  assert.deepEqual(
    report.measurements.lines.map((line) => line.text),
    ["你昨晚睡得还好吗？"],
    "the numbers are the inside session's, not the history's",
  );
});

test("two sessions inside the window bind the later one and publish the earlier as superseded", (t) => {
  const runDir = writeRunShell(t, [lifecycle(0), milestone(0, "0600"), milestone(20, "0730")]);
  const earlier = writeSessionFile(runDir, at(1), [header(1), assistant("第一次说的话。", 2), toolResult(3)]);
  const later = writeSessionFile(runDir, at(5), [header(5), assistant("第二次说的话。", 6), toolResult(7)]);

  const report = assessInteractionValue({ runDir });

  assert.equal(report.establishment.bound, true);
  assert.equal(report.establishment.path, later);
  assert.equal(report.measurements.sessionBinding.considered, 2);
  assert.equal(report.measurements.sessionBinding.excludedOutsideWindow, 0);
  assert.deepEqual(report.measurements.sessionBinding.superseded, [{ path: earlier, fileStampedAtMs: at(1) }]);
  assert.deepEqual(
    report.measurements.lines.map((line) => line.text),
    ["第二次说的话。"],
  );
});

test("no session stamped inside the run window is not_established and the CLI exits 2", (t) => {
  const runDir = writeRunShell(t, [lifecycle(0), milestone(0, "0600"), milestone(20, "0730")]);
  writeSessionFile(runDir, Date.parse("2026-11-03T06:34:03.725Z"), [
    header(-1 * 24 * 60),
    assistant("旧会话里的话。", -1 * 24 * 60 + 1),
  ]);

  const report = assessInteractionValue({ runDir });

  assert.equal(report.verdict, "not_established");
  assert.equal(report.establishment.reason, "no_session_inside_run_window");
  assert.equal(report.measurements.sessionBinding.chosen, null);
  assert.equal(report.measurements.sessionBinding.excludedOutsideWindow, 1);
  assert.equal(report.measurements.spokenLines.count, 0);

  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./interaction-value-gate.mjs", import.meta.url)), "--run", runDir],
    {
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 2, "an unestablishable gate cannot share the success code");
  assert.match(cli.stdout, /session=unbound:no_session_inside_run_window/u);
  assert.match(cli.stdout, /1 file\(s\), 1 excluded outside window/u);
});

test("a chosen file whose messages fall outside the window is refused by name, not measured", (t) => {
  const runDir = writeRunShell(t, [lifecycle(0), milestone(0, "0600"), milestone(20, "0730")]);
  // The name says the session was opened with this run; its conversation is forty minutes older, so it belongs to some
  // other run and measuring it would publish that run's numbers.
  const chosen = writeSessionFile(runDir, at(1), [header(-40), assistant("我把门修好了。", -40), toolResult(-39)]);

  const report = assessInteractionValue({ runDir });

  assert.equal(report.verdict, "not_established");
  assert.equal(report.establishment.reason, "chosen_session_outside_window");
  assert.equal(report.measurements.sessionBinding.chosen, chosen);
  assert.equal(report.measurements.spokenLines.count, 0, "nothing was measured from the refused file");
  assert.ok(report.clauses.every((entry) => entry.reason === "session_not_bound:chosen_session_outside_window"));
  assert.match(
    formatInteractionValueTable(report),
    new RegExp(basename(chosen).replaceAll(".", "\\."), "u"),
    "the refusal names the file it refused",
  );
});

test("not_exercised is not a pass: a run that never heard the player fails the gate", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), milestone(9, "0700")],
    session: [header(0), assistant("我先去把北边的草清了。", 3), toolResult(4)],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(clauseFor(report, "player_agency").state, "not_exercised");
  assert.equal(clauseFor(report, "player_agency").reason, "no_player_input_found");
  assert.equal(clauseFor(report, "obstacle_with_plan").state, "not_exercised");
  assert.equal(clauseFor(report, "obstacle_with_plan").reason, "no_setback_in_this_run");
  assert.equal(report.verdict, "failed", "two unexercised clauses must not add up to a pass");
  assert.equal(clauseFor(report, "no_step_reports").state, "pass");
  assert.ok(
    report.clauses.some((entry) => entry.state === "not_exercised") && report.verdict !== "passed",
    "a passing clause beside unexercised ones is still not a pass for the gate",
  );
});

test("a companion that never spoke is failed, and its silent clause is not a vacuous pass", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), receipt(6, "succeeded", "weeds_cut")],
    session: [header(0), toolOnlyAssistant(1), toolResult(2), toolOnlyAssistant(5), toolResult(6)],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(report.measurements.spokenLines.count, 0);
  assert.equal(clauseFor(report, "player_or_day_rate").state, "fail");
  assert.equal(clauseFor(report, "player_or_day_rate").reason, "no_spoken_lines");
  assert.equal(clauseFor(report, "no_step_reports").state, "not_exercised");
  assert.equal(clauseFor(report, "no_step_reports").reason, "no_spoken_lines");
  assert.equal(report.verdict, "failed");
});

test("a run that does the four things the gate asks for passes", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), receipt(2, "succeeded", "weeds_cut"), milestone(4, "0630")],
    session: [
      header(0),
      playerLine("东头那点草你先弄一下", 1),
      assistant("石头太多，搬不动。", 2),
      assistant("我先去把北边的草清了。", 2.5),
      assistant("你昨晚睡得还好吗？", 3),
      toolResult(3.5),
    ],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(report.measurements.playerAgency.inputs.length, 1);
  assert.equal(report.measurements.playerAgency.inputs[0].state, "consequence_observed");
  assert.equal(report.measurements.playerAgency.inputs[0].kinds.action_attempted, 1);
  assert.equal(clauseFor(report, "player_agency").state, "pass");
  assert.equal(clauseFor(report, "obstacle_with_plan").state, "pass");
  assert.equal(clauseFor(report, "no_step_reports").state, "pass");
  assert.equal(clauseFor(report, "player_or_day_rate").state, "pass");
  assert.equal(report.measurements.register.counts.player_or_day, 1);
  assert.equal(report.verdict, "passed");
  assert.match(formatInteractionValueTable(report), /verdict=PASSED/u);
});

test("a player input with nothing after it is no_consequence, and the clause fails", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), milestone(5, "0630")],
    session: [header(0), playerLine("把东头收拾一下", 1), toolResult(4), assistant("嗯。", 4.5)],
  });

  const report = assessInteractionValue({ runDir });
  const input = report.measurements.playerAgency.inputs[0];

  assert.equal(input.state, "no_consequence");
  assert.deepEqual(input.kinds, { plan_submitted: 0, action_attempted: 0, refused: 0, spoken_to: 0 });
  assert.equal(report.measurements.playerAgency.withConsequence, 0);
  assert.equal(clauseFor(report, "player_agency").state, "fail");
  assert.equal(clauseFor(report, "player_agency").reason, "every_player_input_went_unanswered");
});

test("a submitted plan counts as a consequence of the player's line", (t) => {
  const planCall = {
    type: "message",
    id: "assistant-plan",
    timestamp: iso(2),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-plan", name: "stardew_submit_action_program", arguments: {} }],
    },
  };
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), milestone(5, "0630")],
    session: [header(0), playerLine("把东头收拾一下", 1), planCall, toolResult(3)],
  });

  const report = assessInteractionValue({ runDir });
  const input = report.measurements.playerAgency.inputs[0];

  assert.equal(input.kinds.plan_submitted, 1);
  assert.equal(input.evidence[0].detail, "stardew_submit_action_program");
  assert.equal(input.state, "consequence_observed");
});

test("the longest silence is measured on both clocks and says what the world did during it", (t) => {
  const runDir = writeRun(t, {
    timeline: [
      lifecycle(0),
      milestone(0, "0600"),
      receipt(4, "succeeded", "weeds_cut"),
      receipt(6, "succeeded", "crop_watered"),
      receipt(6.5, "succeeded", "seed_planted"),
      milestone(20, "0800"),
    ],
    session: [header(0), assistant("我把门修好了。", 2), assistant("种子种完了。", 18), toolResult(19)],
  });

  const report = assessInteractionValue({ runDir });
  const silence = report.measurements.longestSilence;

  assert.equal(silence.longest.wallMs, 16 * 60_000);
  assert.equal(silence.longest.fromText, "我把门修好了。");
  assert.equal(silence.longest.toText, "种子种完了。");
  assert.equal(silence.longest.world.total, 3, "three receipts landed while the companion said nothing");
  assert.deepEqual(silence.longest.world.byType, { execution_receipt: 3 });
  assert.ok(silence.longest.gameMinutes > 0, "the silence is also expressed in game time");
  assert.equal(silence.headMs, 2 * 60_000);
  assert.equal(silence.tailMs, 2 * 60_000, "the last line to the run's end is silence the player sat through too");
});

test("the game clock accumulates across a day rollover instead of going backwards", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "2600"), milestone(10, "0600")],
    session: [header(0), assistant("我把门修好了。", 0), assistant("种子种完了。", 10), toolResult(10)],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(
    report.measurements.spokenLines.gameSpanMinutes,
    240,
    "26:00 to 06:00 the next morning is four game hours, not minus twenty",
  );
});

test("the register classifier stays narrow: a report with an obstacle in it is not a step report", () => {
  assert.equal(classifySpokenLine("草浇完了，石头也敲完了。").register, "step_report");
  assert.equal(classifySpokenLine("我把草清了。").register, "step_report");
  assert.equal(
    classifySpokenLine("§43§ 我把草清了。").register,
    "step_report",
    "Magic Context's self-tag is not speech",
  );
  assert.equal(classifySpokenLine("草浇完了，不过石头太多搬不动。").register, "obstacle");
  assert.equal(
    classifySpokenLine("我把草清了，你去浇水吧。").register,
    "player_or_day",
    "a second person makes it a conversation, and a conversation is one of the two things this clause counts",
  );
  assert.equal(classifySpokenLine("要不要先把草清了？").register, "choice");
  assert.equal(classifySpokenLine("你昨晚睡得还好吗？").register, "player_or_day");
  // Both halves from the 2026-11-04 multiday run's own transcript. `干净了` is a satisfied observation, and matching it
  // as an action report (干 of 干净 + 了) is the false verdict this rule's adjacency requirement exists to prevent.
  assert.equal(classifySpokenLine("扫完这几丛，这一片终于干净了。").register, "other");
  // The boundary, stated: a completed action followed by the next one, addressing nobody and taking no stance, is the
  // "done, now watering" shape the gate counts.
  assert.equal(classifySpokenLine("浇完水我去取那三封信。").register, "step_report");
  assert.equal(
    classifySpokenLine("今天天气不错。").register,
    "other",
    "a closed vocabulary misses lines; it never guesses",
  );
});

// The rule is structural: a line addresses the player, or it locates the day. Neither asks for a collocation, which is
// why every line here - all five spoken in the 2026-11-05 multiday run - counts without one.
test("a second person or a day reference makes a line player_or_day, and neither is a phrase bag", () => {
  const spokeToThePlayer = [
    "你去镇上把事办妥，矿里别硬往深处钻",
    "天已经擦黑了，我把门口这几棵杂草和石头收拾了",
    "你要是还在矿里，别贪深，梯子顺着找就行",
    "你那边要是被困住，记得别硬撑",
    "十点了。我先不躺下，你要是摸黑回来，屋里好歹有个活人",
  ];
  for (const text of spokeToThePlayer) {
    const { register, matched } = classifySpokenLine(text);
    assert.equal(
      register,
      "player_or_day",
      `${text} speaks to the player or names the time of day, matched ${matched}`,
    );
    assert.ok(
      matched !== null && text.includes(matched),
      `the matched evidence is the pronoun or the day word it found, got ${String(matched)}`,
    );
  }

  // The smallest evidence, and which of the two asked it: an address can also name the day ("十点了…你要是"), and the
  // pronoun is the fact recorded then, because the sub-count must say whether the run talked to the player at all.
  assert.equal(classifySpokenLine("你去镇上把事办妥").matched, "你");
  assert.equal(classifySpokenLine("你去镇上把事办妥").basis, "addressed_to_player");
  assert.equal(classifySpokenLine("天已经擦黑了，石头也收拾了").matched, "擦黑");
  assert.equal(classifySpokenLine("天已经擦黑了，石头也收拾了").basis, "day_only");
  assert.equal(classifySpokenLine("十点了。你要是摸黑回来，屋里有个活人").basis, "addressed_to_player");

  // The companion's own chores are not remarks about the player, and neither of these addresses anyone.
  for (const text of ["三颗花椰菜都熟了，我先摘了", "石头也清完了，我先进屋"]) {
    const register = classifySpokenLine(text).register;
    assert.notEqual(register, "player_or_day", `${text} reports the companion's work, not the player`);
    assert.ok(["step_report", "other"].includes(register), `${text} is a report or unrecognised, got ${register}`);
  }

  assert.equal(classifySpokenLine("要不要我先把水浇了").register, "choice", "a decision handed over stays a choice");
  // 你们 is a plural and 几点 asks a question rather than reading a clock: neither is an address to the player.
  assert.equal(classifySpokenLine("你们这儿几点开门").basis, null);
  assert.equal(classifySpokenLine("你们这儿几点开门").register, "other");

  // A day word inside a clause that is itself a finished action does not turn a chore into a remark about the day.
  assert.equal(classifySpokenLine("擦黑前我把草清了，石头还堆在那儿").register, "other");
  assert.equal(classifySpokenLine("擦黑前我把草清了，石头还堆在那儿").basis, null);
  assert.equal(classifySpokenLine("擦黑前我把草清了，石头还堆在那儿").playerOrDay, null);
});

// One line can answer two questions at once, and before this rule only one answer survived: the register's winner.
// MEASURED `round88` (2026-11-21): the clause counted 3 of the run's 34 spoken lines, because six remarks about the
// night or the afternoon had been claimed by the obstacle and choice rules first, and two of them named a light the
// vocabulary did not hold (`天黑` was left out while the register WAS the population, on the grounds that it is an
// obstacle word).
test("a line that is both a setback and a remark about the night answers both clauses", () => {
  const nightfall = "这身子卡在原地看着不动，等着缓过来。天都黑透了，我得赶紧回农场。";
  assert.equal(classifySpokenLine(nightfall).register, "obstacle", "it is still a setback for the clause that asks");
  assert.deepEqual(
    classifySpokenLine(nightfall).playerOrDay,
    { basis: "day_only", matched: "黑透" },
    "and it is still a remark about the hour for the clause that asks that",
  );
  for (const text of [
    "天都黑下来了，这条回农场的路真够长。",
    "西南角落还剩一丛草，前面压着石头够不着，先不管它。天擦黑了，我收工回屋。",
    "这身体就这么僵在河边，天倒是彻底黑透了。我再晾它一会儿。",
  ]) {
    assert.equal(classifySpokenLine(text).playerOrDay?.basis, "day_only", `${text} names the state of the light`);
  }

  // A decision handed over is still a choice, and the afternoon it names is still a remark about the day.
  const choice = "两棵花椰菜苗浇透了，壶里还剩三十八格水。下午还剩一大截，我上河边再甩两竿，还是留在农场清那片杂草？";
  assert.equal(classifySpokenLine(choice).register, "choice");
  assert.equal(classifySpokenLine(choice).playerOrDay?.basis, "day_only");

  // The address outranks the day for the SUB-count, which exists to say whether she talked to the player at all.
  assert.equal(classifySpokenLine("十点了。你要是摸黑回来，屋里有个活人").playerOrDay?.basis, "addressed_to_player");
});

// `round88`'s own lines, verbatim and in order, with the minute each one was spoken: the run's own bundle
// (`.live-runs/game-ladder/2026-11-21T17-48-27-810Z-multiday_routine`) recorded 34 assistant text parts over 16 turns,
// 11 of which reached the player as bubbles, and the gate published `3 remarks in 24.38 min` - `failed`. The three the
// old rule found are real remarks; the six it missed are too, and this is the whole population they were measured from.
const ROUND88_SPEECH = [
  [0.68, "门口三棵花椰菜都熟了，我先收了，再把剩下两包种子点进去。"],
  [0.84, "三棵花椰菜都进包了，剩下的种子我正往地里点。"],
  [0.975, "收到，钓条鱼回来是吧。我先去北边那片水塘蹲着甩两竿。"],
  [1.102, "水边那丛草挡着站脚的地方，我先拿镰刀刮了再下竿。"],
  [1.645, "这片塘边水线和站脚的地方对不上，我往南边那片水塘去试试。"],
  [2.108, "南边这塘水面够宽，站脚的地方也齐，我到边上就下竿。"],
  [2.225, "北边那塘边站不住脚，我绕过来换南边这片水面，这就到岸边了。"],
  [2.365, "这塘四周全是挡死的地块，站不到水边。我上后山那片湖去，那儿岸边踏实。"],
  [2.499, "北边那个出口正中间压着一丛草，我先刮掉再往山上走。"],
  [3.005, "山口正堵着一丛大灌木，推不动。我从隧道那边绕上去。"],
  [3.185, "隧道那头也堵死了。算了，我回农场把南塘哪几格能站人摸清，别再瞎撞。"],
  [3.402, "农场这两片水面全都下不去竿，我往南边森林那条河去碰碰。"],
  [4.536, "两条小嘴鲈鱼进包了，这条任务算盘上了。再甩两竿就回农场，别光顾着钓忘了浇那两棵苗。"],
  [4.901, "三条鲈鱼够了，我收竿回农场，顺路把那两棵苗浇上。"],
  [5.567, "鱼竿收了，三条鲈鱼搁包里。我到门口那两棵苗边上了，先把水浇上。"],
  [6.023, "两棵花椰菜苗浇透了，壶里还剩三十八格水。下午还剩一大截，我上河边再甩两竿，还是留在农场清那片杂草？"],
  [8.033, "包里那两颗混合种子点下去了，一颗防风草一颗土豆，水也浇了。"],
  [9.547, "西南角落还剩一丛草，前面压着石头够不着，先不管它。天擦黑了，我收工回屋。"],
  [11.485, "睡到第六天清早了，出货箱结进五百三十五块。我出门先把那几棵苗浇上。"],
  [11.797, "熔炉要二十块铜加二十五块石头，我包里铜才五块，得先出去敲一批。我先出门把苗浇了。"],
  [12.117, "农场这几块石头我挨个敲了，能出几块铜算几块，凑够二十就做熔炉。"],
  [12.73, "农场石头全敲完，铜一块没多，倒敲出五颗钻石。铜还得去矿洞里找，我上后山看看路通不通。"],
  [13.13, "山口那丛大灌木把整条道堵死了。我从南边公交站绕镇子那边上去，看能不能通到矿洞口。"],
  [13.3, "山口、隧道、公交站三条路全堵死了。矿洞今天去不成，我先回农场，砍树攒点木头，宝箱也是个好帮手。"],
  [13.882, "树都倒了，地上木材撒了一地，我先捡干净。"],
  [15.485, "熔炉那二十块铜实在凑不出来，我先做了个宝箱档房子南边，石头全塞进去了，顺手。你镇上那边办得怎么样了？"],
  [16.706, "两棵苗都浇透了。手上这点体力也懒得再干重活，我歇一会儿。"],
  [19.598, "竿甩下去了，水面有动静，我盯着浮标等咬钩。"],
  [20.652, "浮标瞪了半天没鱼咬，收竿了。天擦黑，我回农场。"],
  [20.761, "天都黑下来了，这条回农场的路真够长。"],
  [22.315, "这身子卡在原地看着不动，等着缓过来。天都黑透了，我得赶紧回农场。"],
  [22.418, "我这儿还杵在原地不动，怎么催都不挪。等它缓过劲我再往回走。"],
  [23.565, "这身子就这么僵在河边，天倒是彻底黑透了。我再晾它一会儿。"],
  [24.552, "我这人卡在河边死活不动，催几遍都跟钉住一样。天都黑透了，再这么耗下去，真怕捱过一点半被哈维抬回去扣钱。"],
];

/** The nine of `round88`'s lines that speak of the player or the day, verbatim: the population, not a ratio. */
const ROUND88_COUNTED = [
  "两棵花椰菜苗浇透了，壶里还剩三十八格水。下午还剩一大截，我上河边再甩两竿，还是留在农场清那片杂草？",
  "西南角落还剩一丛草，前面压着石头够不着，先不管它。天擦黑了，我收工回屋。",
  "睡到第六天清早了，出货箱结进五百三十五块。我出门先把那几棵苗浇上。",
  "熔炉那二十块铜实在凑不出来，我先做了个宝箱档房子南边，石头全塞进去了，顺手。你镇上那边办得怎么样了？",
  "浮标瞪了半天没鱼咬，收竿了。天擦黑，我回农场。",
  "天都黑下来了，这条回农场的路真够长。",
  "这身子卡在原地看着不动，等着缓过来。天都黑透了，我得赶紧回农场。",
  "这身子就这么僵在河边，天倒是彻底黑透了。我再晾它一会儿。",
  "我这人卡在河边死活不动，催几遍都跟钉住一样。天都黑透了，再这么耗下去，真怕捱过一点半被哈维抬回去扣钱。",
];

test("round88's own 34 lines: 9 speak of the player or the day, and the two populations are printed side by side", (t) => {
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "1200"), milestone(24, "1410"), receipt(21, "succeeded", "fish_caught")],
    session: [
      header(0),
      playerLine("你去钓条鱼回来吧", 0.9),
      ...ROUND88_SPEECH.map(([minutes, text]) => assistant(text, minutes)),
      toolResult(24.6),
    ],
  });

  const report = assessInteractionValue({ runDir });
  const clause = clauseFor(report, "player_or_day_rate");
  const population = report.measurements.ratePopulation;

  assert.equal(report.measurements.spokenLines.count, 34, "the run said 34 lines, and every one is in the population");
  assert.deepEqual(
    {
      spoken: population.spoken,
      counted: population.counted,
      dropped: population.dropped,
      droppedByRegister: population.droppedByRegister,
      addressedToPlayer: population.addressedToPlayer,
      dayOnly: population.dayOnly,
    },
    {
      spoken: 34,
      counted: 9,
      dropped: 25,
      droppedByRegister: { step_report: 0, obstacle: 4, choice: 0, other: 21 },
      addressedToPlayer: 1,
      dayOnly: 8,
    },
    "3 of 34 was the old rule's answer to a different question; the nine here are the population it was asking about",
  );
  assert.deepEqual(
    report.measurements.lines.filter((line) => line.playerOrDay !== null).map((line) => line.text),
    ROUND88_COUNTED,
    "the counted population, line by line, so the next reader can argue with the nine instead of a ratio",
  );

  assert.equal(
    clause.state,
    "pass",
    "9 remarks in 24 minutes is 1.86 per five minutes, and the old reading called it 0.62",
  );
  assert.equal(clause.reason, null);
  assert.equal(clause.observed.perFiveMinutes, 1.88);
  assert.equal(clause.observed.rateWindowMinutes, 24);
  assert.deepEqual(
    clause.evidence.map((entry) => entry.text),
    ROUND88_COUNTED.slice(0, 5),
    "the clause quotes the population it counted, not only the three the register had claimed",
  );

  const table = formatInteractionValueTable(report);
  assert.match(
    table,
    /player_or_day_rate +pass +9 of 34 spoken line\(s\) about the player or the day in 24 min \(need 1 per 5\) · dropped 25 \{obstacle: 4, other: 21\}/u,
    "the two populations are printed side by side, with what each dropped line was",
  );
  assert.match(
    table,
    /remarks 9 of 34 spoken line\(s\) about the player or the day \| 1 addressed to the player \| 8 day only/u,
  );
});

// The measurement that failed the 2026-11-05 multiday run - `1 remarks in 14.64 min` - was this classifier's, not the
// companion's: it spoke to the player ten times and the bag recognised one. Both counts are asserted from the same run.
test("a run that talks to the player at ordinary moments clears the rate clause the retired bag failed", (t) => {
  const spoken = [
    "你去镇上把事办妥，矿里别硬往深处钻",
    "天已经擦黑了，我把门口这几棵杂草和石头收拾了",
    "你要是还在矿里，别贪深，梯子顺着找就行",
    "你那边要是被困住，记得别硬撑",
    "十点了。我先不躺下，你要是摸黑回来，屋里好歹有个活人",
  ];
  const minutes = [2, 6, 10, 15, 22];
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "1200"), milestone(25, "2600")],
    session: [header(0), ...spoken.map((text, index) => assistant(text, minutes[index])), toolResult(23)],
  });

  const report = assessInteractionValue({ runDir });
  const clause = clauseFor(report, "player_or_day_rate");

  assert.equal(clause.state, "pass");
  assert.equal(clause.observed.counted, 5);
  assert.equal(clause.observed.rateWindowMinutes, 25, "the denominator is still the run's window, unchanged");
  assert.equal(clause.observed.perFiveMinutes, 1);
  assert.deepEqual(
    {
      counted: report.measurements.ratePopulation.counted,
      addressedToPlayer: report.measurements.ratePopulation.addressedToPlayer,
      dayOnly: report.measurements.ratePopulation.dayOnly,
      dropped: report.measurements.ratePopulation.dropped,
    },
    { counted: 5, addressedToPlayer: 4, dayOnly: 1, dropped: 0 },
    "the sub-count separates a companion that talks to you from one that narrates the clock",
  );
  assert.deepEqual(
    clause.evidence.map((entry) => entry.text),
    spoken,
  );
  assert.match(formatInteractionValueTable(report), /4 addressed to the player \| 1 day only/u);

  // The same run under the rule this replaces: zero remarks, and the clause it failed.
  const retiredRemarks = spoken.filter((text) => RETIRED_PLAYER_OR_DAY.test(text)).length;
  assert.equal(retiredRemarks, 0, "the retired phrase bag recognised none of the five lines");
  assert.equal(retiredRemarks, clause.observed.counted - 5, "every remark counted here is one it missed");
  assert.ok(
    retiredRemarks * PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES < clause.observed.rateWindowMinutes,
    "so the retired rule failed this clause on this run (0 * 5 < 25) while the structural rule passes it (5 * 5 >= 25)",
  );
});

test("every clause is decided, and only all-pass is a pass", (t) => {
  const stepReportRun = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0600"), milestone(30, "1200")],
    session: [header(0), assistant("草浇完了。", 5), assistant("门修好了。", 10), toolResult(11)],
  });
  const report = assessInteractionValue({ runDir: stepReportRun });

  assert.equal(report.clauses.length, 4);
  for (const entry of report.clauses) {
    assert.ok(
      ["pass", "fail", "not_exercised"].includes(entry.state),
      `${entry.id} must be one of the three states, got ${entry.state}`,
    );
    assert.equal(typeof entry.requirement, "string");
  }
  assert.equal(PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES, 5);
  const allPass = report.clauses.every((entry) => entry.state === "pass");
  assert.equal(report.verdict === "passed", allPass);

  const table = formatInteractionValueTable(report);
  assert.match(table, /interaction value {2}verdict=FAILED/u);
  assert.match(table, /player_or_day_rate +fail/u);
  assert.match(table, /no_step_reports +fail/u);
  assert.match(table, /register step_report=2/u);
});

test("the runner publishes the gate on the run's own result, from the run's own artifacts", () => {
  const source = readFileSync(new URL("./game/run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");

  assert.match(source, /import \{ assessInteractionValue \} from "\.\.\/interaction-value-gate\.mjs";/u);
  assert.match(source, /const interactionValue = assessInteractionValue\(\{/u);
  assert.match(source, /^\s+timelineFacts: factLog,$/mu, "the timeline is the run's own fact log");
  assert.match(
    source,
    /^\s+sessionPath: sessionSearch\.path \?\? null,$/mu,
    "the session is the one bound to this run",
  );
  assert.match(source, /^\s+interactionValue,$/mu, "the gate must reach result.json beside dialogueGates");
});

test("a clause the run never exercised makes the verdict not_established, never failed", (t) => {
  // The world refused nothing all run, so `obstacle_with_plan` has no verdict to give. Reporting that as `failed`
  // would blame the companion for an absence of evidence - the defect `424d79a6` fixed in the task criteria.
  const runDir = writeRun(t, {
    timeline: [lifecycle(0), milestone(0, "0800"), receipt(4, "succeeded", "moved")],
    session: [
      header(0),
      playerLine("我去镇上了。", 1),
      assistant("你路上小心，我把院子清一清。", 2),
      assistant("草清完了，你先去忙你的。", 9),
    ],
  });

  const report = assessInteractionValue({ runDir });

  assert.equal(report.verdict, "not_established");
  assert.deepEqual(report.unestablished, ["obstacle_with_plan"]);
  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./interaction-value-gate.mjs", import.meta.url)), "--run", runDir],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
});
