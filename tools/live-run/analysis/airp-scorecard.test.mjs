// The scorecard has to read the fields the artifact PUBLISHES, key a node by its whole identity, and measure a span from
// the artifact of its own name. Measured 2026-11-19 (`round77`): it printed `task checklist progress not_measured` beside a
// `result.taskPurposes` carrying three judged tasks, attributed the run's first mistake to `sleep` (a node id `n01` taken
// from whichever program was submitted last), and read `noWakeForMs: 712856` as "how long she was not woken" on a run
// whose session never had two turn openings more than 175,201 ms apart.
//
// Every fixture is fabricated on purpose, so one property is stated per test and nothing is read from `.live-runs`.
//
// red-proof: history  check out tools/live-run/analysis/airp-scorecard.mjs before this change and run this suite: the
//                    checklist reads `not_measured:bundle carries no task-purpose verdict`, the attribution prints
//                    `node n01 (sleep)` for a node that ran `navigate_to_destination`, and the gate line is absent, so the
//                    span test finds no `a_reported_span_is_the_span_its_name_claims` line at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTaskPrompts } from "./action-breadth.mjs";

const SCORECARD = join(import.meta.dirname, "airp-scorecard.mjs");
const START = Date.parse("2026-11-19T04:46:54.000Z");
const iso = (ms) => new Date(ms).toISOString();
const RECORD = join("runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", "session-1.jsonl");

/** A day's note, in the words the runner puts in the player's mouth: read from that table, never spelt again. */
const NOTE_ZH = (task) =>
  `我今天去镇上办事，你把这活儿干一下：${readTaskPrompts().zh[task].trim()}怎么安排你自己定，天黑累了就回屋睡，不用等我。`;

/** A session record whose user messages are the turn openings at `openings`, with her replies between them. */
function writeSession(runDir, openings) {
  const path = join(runDir, RECORD);
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, timestamp: iso(openings[0] ?? START) })];
  openings.forEach((at, index) => {
    lines.push(
      JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: `turn ${index}` } }),
    );
    lines.push(
      JSON.stringify({ type: "message", timestamp: iso(at + 500), message: { role: "assistant", content: [] } }),
    );
  });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return "session-1.jsonl";
}

/** One fabricated bundle, read by the real script: the only way to assert what it PRINTS. */
function scorecard(result, openings = null) {
  const runDir = mkdtempSync(join(tmpdir(), "airp-scorecard-"));
  try {
    const body = { ...result };
    if (openings !== null) body.toolTiming = { record: writeSession(runDir, openings) };
    writeFileSync(join(runDir, "result.json"), JSON.stringify(body), "utf8");
    const run = spawnSync(process.execPath, [SCORECARD, runDir], { encoding: "utf8" });
    return { out: `${run.stdout}${run.stderr}`, status: run.status };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

const line = (out, label) => out.split("\n").find((entry) => entry.startsWith(label)) ?? "";

const START_MS = Date.parse("2026-11-19T10:30:34.853Z");
const receiptLine = (executionId, actionId, state, nodeId = "n01") =>
  `BRIDGE_FACT ${JSON.stringify({
    type: "execution_receipt",
    atMs: START_MS + 1000,
    executionId,
    requestId: `request-${executionId}`,
    reasonCode: state,
    worldFactPayload: {
      actionId,
      executionId,
      state,
      reasonCode: state,
      origin: { kind: "programme", programId: "plan_1", nodeId },
    },
  })}`;

/**
 * A run that has not ended: no `result.json`, a launch receipt, and the log it has been writing all along.
 *
 * This is `round78`'s shape - stopped eleven minutes in - which the scorecard used to answer with
 * `not_measured:no_bundle`.
 */
function scorecardMidRun({ logLines = null, notes = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "airp-midrun-"));
  try {
    const runDir = join(root, "run");
    const logs = join(root, "logs");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(runDir, "launch.json"),
      JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", startedAtMs: START_MS }),
      "utf8",
    );
    if (notes !== null) {
      const path = join(runDir, RECORD);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        path,
        `${notes
          .map((note, turn) =>
            JSON.stringify({
              type: "message",
              timestamp: iso(START_MS + 1000 + turn * 3000),
              message: { role: "user", content: [{ type: "text", text: note }] },
            }),
          )
          .join("\n")}\n`,
        "utf8",
      );
    }
    writeFileSync(
      join(logs, "_multiday_routine-round99-live-runner.log"),
      `${(
        logLines ?? [
          `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START_MS + 1654}}`,
          receiptLine("exec-1", "move_to_tile", "succeeded"),
          receiptLine("exec-2", "move_to_tile", "succeeded"),
          receiptLine("exec-3", "navigate_to_destination", "rejected"),
          receiptLine("exec-4", "break_rock", "succeeded", "n02"),
          'AGENT_PROGRAM_SUBMIT {"programId":"plan_1","code":"accepted","nodes":2}',
        ]
      ).join("\n")}\n`,
      "utf8",
    );
    const run = spawnSync(process.execPath, [SCORECARD, runDir, "--log-dir", logs], { encoding: "utf8" });
    return { out: `${run.stdout}${run.stderr}`, status: run.status };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a run that has not ended is scored from its log, and every reading says which file it read", () => {
  const { out, status } = scorecardMidRun();
  assert.match(line(out, "source"), /^source\s+live-runner\.log - its first line carries/u);
  assert.match(
    line(out, "partial"),
    /^partial\s+this run has not ended, so every reading below is what it had done/mu,
    "a reading taken before the bundle exists must never be read as a verdict on the run",
  );
  assert.match(line(out, "verdict"), /^verdict {28}not_measured:this run has published no result\.json/u);
  assert.match(
    line(out, "node identity"),
    /^node identity\s+2 submitted nodes · 2 \(programId, nodeId\) receipt identities · 2 nodeId-only keys/u,
  );
  assert.match(
    line(out, "first mistake"),
    /^first mistake\s+receipt#2 plan_1 node n01 \(navigate_to_destination\) rejected/u,
    "the first mistake is attributed to the action the receipt itself names, not to a node id shared by every programme",
  );
  assert.match(line(out, "breadth"), /^breadth\s+3 attempted of not_measured \(no snapshot census\) addressable/u);
  // A metric the run directory cannot answer is a stated absence, never a zero: no session record reached this directory.
  assert.match(line(out, "tool use"), /^tool use\s+not_measured:no session record in this run directory/u);
  assert.match(
    out,
    /^a_reading_names_the_source_it_read readings examined \d+ · from-result 0 · from-log [1-9]\d* · unmeasured 0$/mu,
    "nothing read from the log is printed without saying it came from the log",
  );
  assert.equal(status, 0, "a partial reading is not a failure; a reading with no source would be");
});

test("the checklist is read from the field the artifact publishes, and names each task's own state", () => {
  const { out } = scorecard({
    taskPurposes: [
      { day: 1, taskId: "home_upgrade", state: "achieved", reasonCode: null },
      {
        day: 2,
        taskId: "mine_ladder_to_depth",
        state: "unproven",
        reasonCode: "task_purpose_evidence_without_postcondition",
      },
      {
        day: 3,
        taskId: "furnish_and_arrange",
        state: "unproven",
        reasonCode: "task_purpose_evidence_without_postcondition",
      },
    ],
  });
  assert.match(
    line(out, "task checklist progress"),
    /3 tasks · achieved 1 · unproven 2 \(unproven:task_purpose_evidence_without_postcondition×2\)/u,
    "the run's own task verdicts must be what the checklist reports",
  );
  // A bundle that declares none says so by field name rather than printing the checklist of no run.
  assert.match(line(scorecard({}).out, "task checklist progress"), /not_measured:bundle declares no taskPurposes/u);
});

test("a node is keyed by its program AND its node id, so a failure is attributed to the action it ran", () => {
  const { out } = scorecard({
    programSubmissions: [
      { programId: "plan_1", nodes: [{ nodeId: "n01", actionId: "navigate_to_destination" }] },
      { programId: "plan_2", nodes: [{ nodeId: "n01", actionId: "sleep" }] },
    ],
    programOutcomes: [
      { programId: "plan_1", nodeOutcomes: [{ nodeId: "n01", actionId: "navigate_to_destination", state: "failed" }] },
    ],
  });
  // `n01` exists in every program: keyed on the node id alone this read `sleep`, the LAST program's action, and the run's
  // first mistake was a coin toss.
  assert.match(line(out, "first mistake"), /program#0 node n01 \(navigate_to_destination\) failed/u);
  assert.match(
    line(out, "node identity"),
    /2 submitted nodes · 2 \(programId, nodeId\) identities · 1 nodeId-only keys · duplicated 1/u,
  );
});

test("a reported span is the span its name claims, and a span that is not hers fails the reading", () => {
  const openings = [START, START + 175_201, START + 235_201];
  // The run that publishes what its turn stream holds measures what its name claims.
  const honest = scorecard({ multiday: { wakes: { noWakeForMs: 175_201, noWakeTurns: 3 } } }, openings);
  assert.match(line(honest.out, "longest stretch with no turn"), /175201 ms across 3 turn openings/u);
  assert.match(
    honest.out,
    /a_reported_span_is_the_span_its_name_claims fields examined 1 · measured-what-it-names 1 · misnamed 0/u,
  );
  assert.equal(honest.status, 0, "a span that matches its name does not fail the reading");
  // round77's shape: the day loop's own withholding published under the run's silence. 712,856 ms of "no wake" on a run
  // whose turns were never more than 175,201 ms apart.
  const misnamed = scorecard({ multiday: { wakes: { noWakeForMs: 712_856, noWakeTurns: 3 } } }, openings);
  assert.match(
    misnamed.out,
    /a_reported_span_is_the_span_its_name_claims:noWakeForMs - 712856 ms published; the longest stretch with no turn opened is 175201 ms/u,
  );
  assert.match(
    misnamed.out,
    /a_reported_span_is_the_span_its_name_claims fields examined 1 · measured-what-it-names 0 · misnamed 1/u,
  );
  assert.equal(misnamed.status, 1, "a misnamed span must not exit clean");
  // A wake-silence name this reading has no derivation for is misnamed rather than silently skipped: the population is
  // the published names, so a field added tomorrow is examined without editing the gate.
  const undeclared = scorecard({ multiday: { wakes: { noWakeForMs: 175_201, noWakeMaxMs: 5 } } }, openings);
  assert.match(undeclared.out, /noWakeMaxMs - its name claims a wake-silence span and no derivation here measures it/u);
  assert.equal(undeclared.status, 1);
  // And a bundle with no wake account is blocked by name, never green: `0 violations` out of `0 examined` is not a pass.
  const absent = scorecard({});
  assert.match(
    absent.out,
    /a_reported_span_is_the_span_its_name_claims:blocked - fields examined 0 · measured-what-it-names 0 · misnamed 0/u,
  );
});

// WHAT THE DAY ASKED FOR. Measured 2026-11-19 (`round79`): this scorecard printed her `9 attempted` and said nothing about
// the day, so a run that spent its day arranging furniture as asked read as a run that had done almost nothing - the farm
// counts were all zero because the task named none.
test("the day's task is printed beside the work, so a day spent on its own task is not read as neglect", () => {
  const { out, status } = scorecardMidRun({
    logLines: [
      `LAUNCH_PHASE {"phase":"launcher_start","atMs":${START_MS + 1654}}`,
      receiptLine("day-1", "place_owned_object", "succeeded"),
      receiptLine("day-2", "move_placed_furniture", "rejected"),
      receiptLine("day-3", "express_emote", "succeeded", "n02"),
    ],
    notes: [NOTE_ZH("furnish_and_arrange")],
  });
  assert.match(
    line(out, "day task"),
    /day 1 · day_task=furnish_and_arrange · family \{place_owned_object,move_placed_furniture,remove_placed_item,color_placed_object,dress_mannequin,set_sign_display\} · source session:session-1\.jsonl \(partial - this run published no result\.json\)/u,
    "the day comes from the run's own session record when it published no bundle, and is marked partial",
  );
  assert.match(
    line(out, "day family"),
    /day 1 · day_task=furnish_and_arrange day_family=yes · attempted 2 of 6 · succeeded 1 of 2 executions \(rejected 1\)/u,
    "was this the right work and did the work land are two numbers, printed separately",
  );
  assert.match(
    line(out, "day shape"),
    /the task names no farming_crops, resource_gathering, animals_pets action/u,
    "a farm count of zero on an indoor day is that day's shape and the reading must say so",
  );
  assert.match(line(out, "breadth"), /addressable · day_task=furnish_and_arrange$/u);
  assert.match(
    out,
    /^a_reading_of_productivity_names_the_day_it_judged rows examined 2 · day-task named 2 · family-scored 1 · unanchored 0$/mu,
    "both rows name the day; the one judged against the day's own action set is the family line",
  );
  assert.equal(status, 0);
});

test("a run with no day task in any artifact says so by name, and its rows are anchored to that absence", () => {
  const { out } = scorecardMidRun();
  assert.match(
    line(out, "day task"),
    /^day task +day_task=not_measured:no_task_purposes_and_no_session_record - no result\.json declares this run's days and no session record of it was found/u,
  );
  assert.match(line(out, "breadth"), /addressable · day_task=not_measured:\S+$/u);
  assert.match(
    out,
    /^a_reading_of_productivity_names_the_day_it_judged rows examined 1 · day-task named 0 · family-scored 0 · unanchored 0 · day-task not_measured 1$/mu,
    "a row that states which question nothing answered is not an unanchored row",
  );
});
