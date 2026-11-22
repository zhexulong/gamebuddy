// The run's own record, written as it happens.
//
// WHY these tests exist (measured 2026-11-17, round66/67): three consecutive multi-day rounds left a run directory
// holding `launch.json` and nothing else, because every record the harness has was written at its END. Round67's Host
// died between 278.98 s and 288.08 s with the game still writing ten minutes later, and no artifact said where the run
// had got to. The property these hold is not "the file exists" - it is that a line is ON DISK at the moment the thing it
// describes happened, so a process that dies mid-await leaves the last thing it reached.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRunProgress, RUN_PROGRESS_FILE, readNewestRunProgress, readRunProgressFile } from "./run-progress.mjs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "run-progress-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an entry is on disk when the call that describes it returns, not at close", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const progress = openRunProgress({ dir: area.dir, startedAtMs: 1_000 });
  assert.equal(progress.record({ event: "turn_started", turn: 3 }), true);

  // Read through a SECOND handle, with the run's own descriptor still open and the process still running: this is the
  // reading the audit needed on a run that never reached its close.
  const text = readFileSync(progress.path, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 2, "the open writes its own attribution line, then the entry");
  assert.equal(JSON.parse(lines[0]).event, "run_opened");
  assert.deepEqual(
    { ...JSON.parse(lines[1]), atMs: undefined },
    { event: "turn_started", turn: 3, atMs: undefined },
    "the entry is the entry, with the moment it was appended",
  );
  assert.equal(typeof JSON.parse(lines[1]).atMs, "number");
  progress.close();
});

test("a process killed mid-run leaves the last entry it reached", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "run").split("\\").join("/");
  // A REAL child that records two entries and then kills itself without unwinding: no close, no finally, no exit
  // handler - the shape a crashed or externally killed runner leaves. The FALSIFIER is the sibling case below, which
  // buffers the entries and writes them at exit: that process leaves the same empty directory this one must not.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const { openRunProgress } = await import(${JSON.stringify(new URL("./run-progress.mjs", import.meta.url).href)});
      const progress = openRunProgress({ dir: ${JSON.stringify(dir)} });
      progress.record({ event: "turn_started", turn: 1 });
      progress.record({ event: "presented", index: 0 });
      process.kill(process.pid, "SIGKILL");
      `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.notEqual(child.status, 0, "the child must really die without unwinding");
  const lines = readFileSync(join(dir, RUN_PROGRESS_FILE), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((entry) => entry.event),
    ["run_opened", "turn_started", "presented"],
    "both entries survived the kill, in order",
  );
});

test("the falsifier: entries buffered until exit are lost by the same kill", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const dir = join(area.dir, "run").split("\\").join("/");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      const buffered = [];
      buffered.push({ event: "turn_started", turn: 1 });
      buffered.push({ event: "presented", index: 0 });
      process.kill(process.pid, "SIGKILL");
      writeFileSync(join(${JSON.stringify(dir)}, ${JSON.stringify(RUN_PROGRESS_FILE)}), buffered.map((e) => JSON.stringify(e)).join("\\n"));
      `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.notEqual(child.status, 0);
  assert.equal(
    existsSync(join(dir, RUN_PROGRESS_FILE)),
    false,
    "a run that keeps its record in memory until it exits leaves nothing - which is what round66 and round67 left",
  );
});

test("the newest run's record is chosen by when it was written, not by its name", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  const root = join(area.dir, "game-ladder");
  const older = join(root, "2026-11-17T23-23-04-000Z-multiday_routine");
  const newer = join(root, "2026-11-17T21-00-00-000Z-multiday_routine");
  const first = openRunProgress({ dir: older });
  first.record({ event: "turn_started", turn: 1 });
  first.close();
  const second = openRunProgress({ dir: newer });
  second.record({ event: "turn_started", turn: 9 });
  second.close();
  // The names disagree with the clock on purpose: a directory whose name sorts last was written first.
  utimesSync(join(older, RUN_PROGRESS_FILE), new Date(1_000_000), new Date(1_000_000));
  utimesSync(join(newer, RUN_PROGRESS_FILE), new Date(2_000_000), new Date(2_000_000));

  const reading = readNewestRunProgress({ root });
  assert.equal(reading.last.turn, 9, "the entry read is the one from the run that just happened");
  assert.equal(reading.lines, 2);
});

test("each presented piece is counted in the window of the turn that was open when it landed", (t) => {
  // The reading `round87b` needed: its day-3 turn recorded no lines while nineteen bubbles landed after that turn's own
  // `turn_started`. The record is the witness - one line per commit, in order - so the count has to come from it.
  const area = tempDir();
  t.after(() => area.remove());
  const progress = openRunProgress({ dir: area.dir });
  progress.record({ event: "presented", index: 0 });
  progress.record({ event: "turn_started", turn: 0, reason: "day_start" });
  progress.record({ event: "presented", index: 1 });
  progress.record({ event: "presented", index: 2 });
  progress.record({ event: "turn_started", turn: 1, reason: "day_start" });
  progress.record({ event: "presented", index: 3 });
  progress.close();

  const record = readRunProgressFile({ dir: area.dir });
  assert.equal(record.presented, 4, "every committed piece is on the record");
  assert.equal(record.presentedBeforeFirstTurn, 1, "the launch bubble belongs to no turn of this record, and says so");
  assert.deepEqual(
    record.presentedByTurn.map((window) => [window.turn, window.presented]),
    [
      [0, 2],
      [1, 1],
    ],
    "a piece falls in the window of the last turn_started before it",
  );

  // A record with no turns at all still counts its pieces: "no turn" is not "nothing was presented".
  const empty = openRunProgress({ dir: join(area.dir, "no-turns") });
  empty.record({ event: "presented", index: 0 });
  empty.close();
  const noTurns = readRunProgressFile({ dir: join(area.dir, "no-turns") });
  assert.equal(noTurns.presented, 1);
  assert.deepEqual(noTurns.presentedByTurn, []);
  assert.equal(noTurns.presentedBeforeFirstTurn, 1);
});

test("a root with no record answers null, never an empty record", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  assert.equal(readNewestRunProgress({ root: join(area.dir, "nothing-here") }), null);
  writeFileSync(join(area.dir, "notes.txt"), "not a record", "utf8");
  assert.equal(readNewestRunProgress({ root: area.dir }), null);
});

test("a record that cannot be opened refuses instead of throwing, and names no path it did not write", (t) => {
  const area = tempDir();
  t.after(() => area.remove());
  // A FILE where the run directory should be: `mkdirSync` fails, and this module's contract is that a diagnostic write
  // never ends the run it describes.
  const blocker = join(area.dir, "blocked");
  writeFileSync(blocker, "not a directory", "utf8");
  const progress = openRunProgress({ dir: blocker });
  assert.equal(progress.record({ event: "turn_started", turn: 1 }), false);
  assert.equal(existsSync(join(blocker, RUN_PROGRESS_FILE)), false);
});
