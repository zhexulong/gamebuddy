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

const BREADTH = join(import.meta.dirname, "action-breadth.mjs");
const START = Date.parse("2026-11-19T10:30:34.853Z");

const receiptLine = (executionId, actionId, state) =>
  `BRIDGE_FACT ${JSON.stringify({
    type: "execution_receipt",
    atMs: START + 1000,
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

/** One run directory, its launch receipt, and the log directory this run's log was written into. */
function fixture({ result = null, logLines = LOG }) {
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
