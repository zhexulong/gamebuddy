// THE RUN'S ENDING, AND THE INSTRUMENT THAT MUST OUTLIVE THE RUN.
//
// WHY these tests exist (measured 2026-11-17): eight of the ten most recent ladder runs wrote no `result.json`, and round67's
// run directory held `launch.json` and nothing else - a Host died at a turn boundary, the game kept ticking for ten minutes,
// and the launcher that had spawned it survived another 641.4 s and wrote nothing about it. A dead run and a clean run then
// reach every downstream gate as the same absence, because every gate's input is `result.json`.
//
// The property held here is not "a file exists". It is two: the process that SURVIVES writes how the run ended, for every
// ending; and a launch receipt with no closure is a BLOCKED reading that names the run, so the absence is countable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RUN_PROGRESS_FILE, openRunProgress } from "./run-progress.mjs";
import {
  auditRunClosures,
  closeRunClosure,
  endingOf,
  openRunClosure,
  readRunClosure,
  renderClosureAudit,
  RUN_CLOSURE_FILE,
  RUN_LAUNCH_FILE,
  writeLaunchReceipt,
} from "./run-closure.mjs";

const NOW = Date.parse("2026-11-17T19:09:31.414Z");
const RUN = "2026-11-17T19-09-31-413Z-multiday_routine";
const PROGRESS_URL = new URL("./run-progress.mjs", import.meta.url).href;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "run-closure-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** round67's run directory, verbatim: a launch receipt written by the process that then said nothing more. */
function round67Shape(root) {
  const dir = join(root, "game-ladder", RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, RUN_LAUNCH_FILE),
    `${JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", kind: "game-ladder", label: "multiday_routine", startedAtMs: NOW, pid: 13860 })}\n`,
    "utf8",
  );
  return dir;
}

/** A child that attaches to the record the way the runner does, reaches one turn, then dies without unwinding. */
function childThatDiesInsideATurn(dir, { open = true } = {}) {
  const script = open
    ? `
      const { openRunProgress } = await import(${JSON.stringify(PROGRESS_URL)});
      const progress = openRunProgress({ dir: ${JSON.stringify(dir)} });
      progress.record({ event: "turn_started", turn: 7 });
      progress.record({ event: "presented", index: 0 });
      process.kill(process.pid, "SIGKILL");
      `
    : `process.kill(process.pid, "SIGKILL");`;
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000 });
}

test("a run that died leaves a record: the launch receipt's owner outlives the child and writes the ending", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "game-ladder", RUN);
  const closure = openRunClosure({ dir, kind: "game-ladder", label: "multiday_routine", startedAtMs: NOW });
  const receipt = readRunClosure({ dir });
  assert.equal(receipt, null, "nothing has ended yet, so nothing claims it has");

  const child = childThatDiesInsideATurn(dir);
  assert.notEqual(child.status, 0, "the child must really die without unwinding");
  const written = closure.close({ childPid: child.pid, exitCode: null, result: "absent" });

  assert.equal(written.state, "died", "a child killed inside a turn did not finish its own unwind");
  assert.equal(written.reasonCode, "runner_exit_unreported", "the ending names that no exit was ever reported");
  assert.equal(written.result, "absent", "no bundle was written, and the record says which absence this is");
  assert.equal(
    written.progress.lines,
    4,
    "the survivor's open line, the child's attach and two entries survived the kill",
  );
  assert.equal(written.progress.lastTurn, 7, "the last turn the run reached is in the record, not in a terminal log");
  assert.equal(written.progress.lastEvent, "presented");
  assert.deepEqual(
    written.progress.openedBy,
    [process.pid, child.pid],
    "the file was armed by the survivor and then attached to by the child - in that order",
  );
});

test("the falsifier: an instrument armed inside the subject is lost when the subject dies first", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  // No survivor opened the record: the child is the only process that could have, and it dies before it does. This is
  // round67's directory after the Host went away - the child got as far as arming its own capture (which writes the launch
  // receipt) and nothing else survived it - and it is what the surviving fd exists to make impossible.
  const dir = join(area.dir, "game-ladder", RUN);
  mkdirSync(dir, { recursive: true });
  writeLaunchReceipt({ dir, kind: "game-ladder", label: "multiday_routine", startedAtMs: NOW, pid: 13860 });
  const child = childThatDiesInsideATurn(dir, { open: false });
  assert.notEqual(child.status, 0);
  assert.equal(
    existsSync(join(dir, RUN_PROGRESS_FILE)),
    false,
    "an_instrument_outlives_its_subject:run-progress.jsonl - a record whose only opener is the process it describes " +
      "leaves nothing when that process dies, which is round67's directory verbatim",
  );
  const audit = auditRunClosures({ root: join(area.dir, "game-ladder") });
  assert.equal(audit.examined, 1);
  assert.equal(audit.silent, 1, "and a reader looking for the ending finds it blocked, not absent");
});

test("a launch receipt with no closure is BLOCKED and named - round67's own directory", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = round67Shape(area.dir);
  const audit = auditRunClosures({ root: join(area.dir, "game-ladder") });
  assert.equal(audit.examined, 1);
  assert.equal(audit.silent, 1, "round67 must come out silent, not green");
  assert.equal(audit.closed, 0);
  assert.equal(audit.recordedDied, 0);
  assert.equal(audit.notMeasured, 0);
  assert.deepEqual(audit.blockedRuns, [RUN]);
  assert.match(
    audit.reading.blocked[0],
    new RegExp(`^a_run_that_died_leaves_a_record:${RUN} - `, "u"),
    "the blocked reading names the run it is about",
  );
  assert.match(
    renderClosureAudit(audit),
    /runs examined 1 · closed 0 · recorded-died 0 · bundle-only 0 · silent 1 · not measured 0/u,
  );
  // AND THE OTHER DIRECTION, on the same directory: one closure record and the same tree answers `recorded`.
  closeRunClosure({ dir, startedAtMs: NOW, facts: { childPid: 4242, exitCode: 1, result: "absent" } });
  assert.ok(existsSync(join(dir, RUN_CLOSURE_FILE)));
  const after = auditRunClosures({ root: join(area.dir, "game-ladder") });
  assert.equal(after.silent, 0);
  assert.equal(after.closed, 0, "a run that exited 1 is not closed");
  assert.equal(after.recordedDied, 1, "it is recorded-died: the ending exists and says the run ended badly");
});

test("the three zeroes are told apart and every population is named", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const root = join(area.dir, "game-ladder");
  // closed
  const clean = join(root, "2026-11-18T00-00-00-000Z-multiday_routine");
  openRunClosure({ dir: clean, kind: "game-ladder", startedAtMs: NOW }).close({
    childPid: 1,
    exitCode: 0,
    result: "fresh",
  });
  // recorded died
  const died = join(root, "2026-11-18T01-00-00-000Z-multiday_routine");
  openRunClosure({ dir: died, kind: "game-ladder", startedAtMs: NOW }).close({
    childPid: 2,
    exitCode: 3,
    result: "absent",
  });
  // silent (blocked)
  round67Shape(area.dir);
  // not measured: a directory with a result and nothing that armed it
  const unarmed = join(root, "2026-11-18T02-00-00-000Z-multiday_routine");
  mkdirSync(unarmed, { recursive: true });
  writeFileSync(join(unarmed, "result.json"), "{}", "utf8");
  // bundle-only: a run the supervisor armed, that published its own bundle, and whose closure never followed
  const bundleOnly = join(root, "2026-11-18T03-00-00-000Z-multiday_routine");
  mkdirSync(bundleOnly, { recursive: true });
  writeLaunchReceipt({ dir: bundleOnly, kind: "game-ladder", startedAtMs: NOW });
  writeFileSync(join(bundleOnly, "result.json"), "{}", "utf8");

  const audit = auditRunClosures({ root });
  assert.equal(audit.examined, 5);
  assert.equal(audit.closed, 1);
  assert.equal(audit.recordedDied, 1);
  assert.equal(audit.bundleOnly, 1);
  assert.equal(audit.silent, 1);
  assert.equal(audit.notMeasured, 1);
  assert.equal(
    renderClosureAudit(audit),
    "runs examined 5 · closed 1 · recorded-died 1 · bundle-only 1 · silent 1 · not measured 1",
    "a single count would hide the blocked run inside a total",
  );
  assert.deepEqual(audit.blockedRuns, [RUN]);
  assert.deepEqual(audit.bundleOnlyRuns, ["2026-11-18T03-00-00-000Z-multiday_routine"]);
  assert.deepEqual(audit.notMeasuredRuns, ["2026-11-18T02-00-00-000Z-multiday_routine"]);
});

test("a root with no run directory is not_measured, never a green zero", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const audit = auditRunClosures({ root: join(area.dir, "nothing-here") });
  assert.equal(audit.examined, 0);
  assert.equal(audit.silent, 0);
  assert.equal(
    renderClosureAudit(audit),
    "runs examined 0 · closed 0 · recorded-died 0 · bundle-only 0 · silent 0 · not measured 0",
  );
});

test("the ending is derived from the facts, so a record cannot claim a clean exit it did not have", () => {
  assert.deepEqual(endingOf({ exitCode: 0, childPid: 10 }), { state: "closed", reasonCode: "runner_exited:0" });
  assert.deepEqual(endingOf({ exitCode: 1, childPid: 10 }), { state: "died", reasonCode: "runner_exited:1" });
  assert.deepEqual(endingOf({ signal: "SIGINT", childPid: 10 }), {
    state: "killed",
    reasonCode: "launcher_killed_by_signal:SIGINT",
  });
  assert.deepEqual(endingOf({ takenOver: true, exitCode: 0, childPid: 10 }), {
    state: "taken_over",
    reasonCode: "fixture_taken_over",
  });
  assert.deepEqual(endingOf({ exitCode: 0, childPid: null }), {
    state: "died",
    reasonCode: "launcher_ended_before_the_child_was_spawned",
  });
});

test("the closure is write-once: the first ending is the ending", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "run");
  const closure = openRunClosure({ dir, kind: "game-ladder" });
  const first = closure.close({ childPid: 11, exitCode: 4, result: "absent" });
  const second = closure.close({ childPid: 11, exitCode: 0, result: "fresh" });
  assert.equal(second.reasonCode, first.reasonCode, "a second call returns what the first wrote");
  assert.equal(second.state, "died", "an ending cannot be upgraded after the fact");
});

test("the launch receipt is written once, by the process that armed the directory", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "run");
  const first = writeLaunchReceipt({
    dir,
    kind: "game-ladder",
    label: "multiday_routine",
    startedAtMs: NOW,
    pid: 13860,
  });
  assert.equal(first.written, true);
  // The child's capture opens the same run directory and would have written its own pid here. It must not.
  const second = writeLaunchReceipt({
    dir,
    kind: "game-ladder",
    label: "multiday_routine",
    startedAtMs: NOW + 5,
    pid: 999,
  });
  assert.equal(second.written, false);
  assert.equal(second.receipt.pid, 13860, "the receipt still names the process that outlives the run");
  assert.equal(JSON.parse(readFileSync(join(dir, RUN_LAUNCH_FILE), "utf8")).startedAtMs, NOW);
});

test("the record survives a child that never writes: the survivor's own open line is on disk", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "run");
  const progress = openRunProgress({ dir, startedAtMs: NOW });
  const child = childThatDiesInsideATurn(dir, { open: false });
  assert.notEqual(child.status, 0);
  progress.close();
  const lines = readFileSync(join(dir, RUN_PROGRESS_FILE), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "run_opened");
  assert.equal(lines[0].pid, process.pid, "the only opener is the process that was still alive to write the ending");
});
