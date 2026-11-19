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

const SCORECARD = join(import.meta.dirname, "airp-scorecard.mjs");
const START = Date.parse("2026-11-19T04:46:54.000Z");
const iso = (ms) => new Date(ms).toISOString();
const RECORD = join("runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", "session-1.jsonl");

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
