// The runner log has to be found by what it SAYS, and read once per identity its producer gave it.
//
// Two properties, both measured on real logs (2026-11-19): `round78` was stopped mid-run, so its log is the only record
// it has - and `round77`'s log holds 469 execution identities in 240 683 lines, of which 2 submissions are re-submits
// of a program already submitted. A reading that counted lines instead of identities would report a neighbour's run, or
// the same execution twice.
//
// Every fixture is fabricated here on purpose: nothing is read from `.live-runs` or from `tools/_*-live-runner.log`.
//
// red-proof: history  this module did not exist before this change; `locateRunnerLog` returns null for a log whose first
//                    instant does not match the run's launch receipt, so pointing these tests at `round78`'s log while
//                    naming `round77`'s launch instant finds nothing and the reading says why.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  actionExecutions,
  actionStates,
  attemptedActions,
  describeRunnerLog,
  locateRunnerLog,
  programmeNodes,
  readRunnerLog,
  succeededActions,
} from "./live-runner-log.mjs";

const receipt = (executionId, actionId, state, extra = {}) =>
  JSON.stringify({
    type: "execution_receipt",
    atMs: 1000,
    executionId,
    requestId: `req-${executionId}`,
    reasonCode: state,
    evidence: { detail: "chore=itemTargets;tile=1,2" },
    worldFactPayload: {
      actionId,
      executionId,
      state,
      reasonCode: state,
      evidence: { detail: "chore=itemTargets;tile=1,2" },
      origin: { kind: "programme", programId: "plan_1", nodeId: executionId === "exec-2" ? "n02" : "n01" },
    },
    ...extra,
  });

const fact = (executionId, actionId, state, extra) => `BRIDGE_FACT ${receipt(executionId, actionId, state, extra)}`;

/** One run's log: two real executions, one of them written twice, one submission re-sent, and one line no parser reads. */
function writeLog(directory, name, lines) {
  const path = join(directory, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

const LOG_LINES = [
  'LAUNCH_PHASE {"phase":"launcher_start","elapsedMs":1,"atMs":1000}',
  fact("exec-1", "move_to_tile", "succeeded"),
  fact("exec-1", "move_to_tile", "succeeded"),
  fact("exec-2", "break_rock", "rejected"),
  'BRIDGE_FACT {"type":"semantic_event","atMs":1001,"reasonCode":"warped","worldFactPayload":{"kind":"snapshot_changed"}}',
  'AGENT_PROGRAM_SUBMIT {"programId":"plan_1","code":"accepted","nodes":2}',
  'AGENT_PROGRAM_SUBMIT {"programId":"plan_1","code":"accepted","nodes":2}',
  'AGENT_PROGRAM_SUBMIT {"programId":"plan_2","code":"accepted","nodes":1}',
  "BRIDGE_FACT {not json at all",
  "GAME_TURN_ACCOUNT traces 3 {receipt:accepted: 0}",
];

test("receipts are keyed on the execution id, and the population says what that collapsed", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    const log = readRunnerLog(writeLog(directory, "a-live-runner.log", LOG_LINES));
    assert.match(
      describeRunnerLog(log),
      /2 execution_receipt identities from 3 receipt lines \(1 collapsed\)/u,
      "a re-written receipt is one execution, not two",
    );
    assert.match(describeRunnerLog(log), /2 programme identities from 3 submissions \(1 re-submitted\)/u);
    assert.match(describeRunnerLog(log), /1 other facts \(not executions\)/u);
    assert.match(
      describeRunnerLog(log),
      /1 unreadable line\(s\): 9/u,
      "a line no parser reads is counted, never skipped",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the same detail in two positions is read once, and the count of it is printed", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    const log = readRunnerLog(writeLog(directory, "a-live-runner.log", LOG_LINES));
    assert.match(
      describeRunnerLog(log),
      /2 execution_receipt identities/u,
      "reading evidence.detail and worldFactPayload.evidence.detail would have counted each execution twice",
    );
    assert.equal(log.receipts[0].detail, "chore=itemTargets;tile=1,2");
    assert.equal(
      log.counts.detailInBoth,
      log.counts.receiptLines,
      "every fixture receipt line carries the detail in both places, which is the shape a token count doubles",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actions, states and programme nodes come from the identities, never from the lines", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    const log = readRunnerLog(writeLog(directory, "a-live-runner.log", LOG_LINES));
    assert.deepEqual(attemptedActions(log), ["break_rock", "move_to_tile"]);
    assert.deepEqual(succeededActions(log), ["move_to_tile"]);
    assert.deepEqual(
      [...actionStates(log)],
      [
        ["succeeded", 1],
        ["rejected", 1],
      ],
    );
    const executions = actionExecutions(log);
    assert.equal(executions.unnamed, 0);
    // `n01` is the node id of every programme's first node, so a reading keyed on it alone keeps one row per programme.
    assert.deepEqual([...programmeNodes(log).nodeIdOnly], ["n01", "n02"]);
    assert.equal(programmeNodes(log).identities.size, log.counts.receipts);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a log is this run's by its own first instant, never by being the newest file", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    writeLog(directory, "_multiday_routine-round1-live-runner.log", ['LAUNCH_PHASE {"atMs":5000}']);
    const mine = writeLog(directory, "_multiday_routine-round2-live-runner.log", ['LAUNCH_PHASE {"atMs":90000}']);
    const found = locateRunnerLog({ logDir: directory, startedAtMs: 90_900 });
    assert.equal(found.path, mine);
    assert.match(found.how, /its first line carries 90000 ms, 900 ms from this run's launch receipt/u);
    // The neighbour's run is 85 s away, which is further than the launcher can drift: nothing is returned rather than a
    // reading of the wrong run.
    const missing = locateRunnerLog({ logDir: directory, startedAtMs: 90_000 + 600_000 });
    assert.equal(missing.path, null);
    assert.match(missing.why, /no -live-runner\.log under/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two logs matching one instant are refused rather than resolved by a coin toss", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    writeLog(directory, "_multiday_routine-round1-live-runner.log", ['LAUNCH_PHASE {"atMs":1000}']);
    writeLog(directory, "_multiday_routine-round2-live-runner.log", ['LAUNCH_PHASE {"atMs":1500}']);
    const found = locateRunnerLog({ logDir: directory, startedAtMs: 1200 });
    assert.equal(found.path, null);
    assert.match(found.why, /^ambiguous: /u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run with no launch instant, a captured log, and a named log are three different answers", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  try {
    const runDir = join(directory, "run");
    const captured = join(runDir, "live-runner.log");
    const named = writeLog(directory, "named-live-runner.log", LOG_LINES);
    // No launch instant: nothing binds this directory to any log, and saying so is the reading.
    const unbound = locateRunnerLog({ runDir: null, logDir: directory, startedAtMs: null });
    assert.equal(unbound.path, null);
    assert.match(unbound.why, /no start instant/u);
    // The capture's own copy wins over any search, because the run directory names it.
    mkdirSync(runDir, { recursive: true });
    writeLog(runDir, "live-runner.log", LOG_LINES);
    assert.equal(locateRunnerLog({ runDir }).path, captured);
    assert.equal(locateRunnerLog({ logPath: named }).path, named);
    assert.match(locateRunnerLog({ logPath: join(directory, "absent.log") }).why, /does not exist/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
