// THE RECORD THAT MAKES `bridge_disconnected` ATTRIBUTABLE.
//
// Measured 2026-11-22 (`round90`, 8 minutes, `blocked / bridge_disconnected`): `process-reclamation.json` held ONE row -
// the game, `closeOutcome: "killed"`, `exit: {code: null, signal: null}` - while the Mod's log ended with
// `ai_player_control_pipe_reader_ended:EndOfStreamException` and the pipe's client (the Host, inside the runner
// process) had plainly gone first. The record named the consequence because the game was the only process it had a row
// for. The rows below are REAL children: the red case is a host child that exits 1 before the game does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  childReading,
  childRow,
  childrenRecord,
  firstToLeave,
  firstToLeaveLine,
  mergeChildren,
  openChildRoster,
  readChildRecord,
  writeChildRecord,
} from "./child-roster.mjs";

/** Spawn a real child, and hand back its pid plus the one promise that resolves when its own handle reports the exit. */
function startChild({ source }) {
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore", windowsHide: true });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, atMs: Date.now() })));
  return { child, closed };
}

test("the host child leaving with code 1 before the game reads first_to_leave=host:code=1", async () => {
  const roster = openChildRoster();
  const host = startChild({ source: "process.exit(1);" });
  roster.started({ role: "host", pid: host.child.pid, startedAtMs: Date.now() });
  const hostExit = await host.closed;
  roster.ended({ pid: host.child.pid, ...hostExit });

  // The game outlives the host by construction, which is the shape round90 ended in.
  const game = startChild({ source: "setTimeout(() => {}, 30_000);" });
  roster.started({ role: "game", pid: game.child.pid, startedAtMs: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  game.child.kill();
  roster.ended({ pid: game.child.pid, ...(await game.closed) });

  const record = childrenRecord(roster.rows());
  assert.deepEqual(
    record.children.map((child) => child.role),
    ["host", "game"],
    "one row per process this run started, in spawn order",
  );
  const hostRow = childRow(record, "host");
  assert.equal(hostRow.pid, host.child.pid);
  assert.ok(Number.isFinite(hostRow.startedAtMs), "a row says when its child started");
  assert.equal(hostRow.exit.code, 1, "the host's own exit code, from the handle that owned it");
  assert.equal(hostRow.exit.signal, null);
  assert.ok(Number.isFinite(hostRow.exit.atMs), "and the instant it left, which is what orders the rows");
  assert.equal(hostRow.survivedTeardown, false, "zero survivors is measured per child, not inferred from the record");

  const gameRow = childRow(record, "game");
  assert.equal(gameRow.pid, game.child.pid, "the game has a row of its own, not the host's");

  assert.equal(record.firstToLeave, "host:code=1", "the ordering is the diagnosis");
  assert.equal(firstToLeaveLine(record.firstToLeave), "first_to_leave=host:code=1");
});

test("a child that left without an exit code reads unknown, never zero", () => {
  const roster = openChildRoster();
  roster.started({ role: "game", pid: 4242, startedAtMs: 1_000 });
  const record = roster.record({ isAlive: () => false });

  const row = childRow(record, "game");
  assert.deepEqual(row.exit, { code: null, signal: null, atMs: null }, "an exit nobody observed is null, not 0");
  assert.equal(childReading(row), "game:unknown");
  assert.equal(record.firstToLeave, null, "no observed instant, so nothing can be ordered");
  assert.equal(firstToLeaveLine(record.firstToLeave), "first_to_leave=unobserved");
  assert.notEqual(firstToLeaveLine(record.firstToLeave), "first_to_leave=game:code=0");
});

test("the ordering comes from the exit instants, not from the order the rows were written", () => {
  const rows = [
    { role: "game", pid: 3, startedAtMs: 0, exit: { code: 1, signal: null, atMs: 300 }, survivedTeardown: false },
    { role: "host", pid: 2, startedAtMs: 10, exit: { code: 7, signal: null, atMs: 200 }, survivedTeardown: false },
    { role: "orchestrator", pid: 1, startedAtMs: 20, exit: { code: 0, signal: null, atMs: 400 }, survivedTeardown: false },
  ];
  assert.equal(firstToLeave(rows), "host:code=7");
  assert.equal(firstToLeave([...rows].reverse()), "host:code=7", "a reader cannot reorder the run by reordering the rows");
  // Two children leaving on the same instant: the one that STARTED first is the one that left first.
  assert.equal(
    firstToLeave([
      { role: "game", pid: 9, startedAtMs: 0, exit: { code: 0, signal: null, atMs: 5 } },
      { role: "host", pid: 8, startedAtMs: 1, exit: { code: 0, signal: null, atMs: 5 } },
    ]),
    "game:code=0",
  );
  // A signal is an ending, and it is not a code: nothing here may collapse into `code:0`.
  assert.equal(
    firstToLeave([{ role: "host", pid: 1, startedAtMs: 0, exit: { code: null, signal: "SIGTERM", atMs: 1 } }]),
    "host:signal=SIGTERM",
  );
});

test("a child still alive when the record is written survived the teardown", async () => {
  const roster = openChildRoster();
  const alive = startChild({ source: "setInterval(() => {}, 1_000);" });
  roster.started({ role: "ai-player", pid: alive.child.pid, startedAtMs: Date.now() });
  try {
    const record = childrenRecord(roster.rows());
    assert.equal(childRow(record, "ai-player").survivedTeardown, true);
    assert.equal(record.firstToLeave, null, "a child that never left cannot be first to leave");
  } finally {
    alive.child.kill();
    await alive.closed;
  }
});

test("a row needs a spawn, a role from the run's own vocabulary, and a real pid", () => {
  const roster = openChildRoster();
  assert.throws(() => roster.started({ role: "sidekick", pid: 1 }), /child_role_unknown:sidekick/u);
  assert.throws(() => roster.started({ role: "game", pid: 0 }), /child_pid_invalid:0/u);
  assert.throws(() => roster.ended({ pid: 99, code: 0 }), /child_exit_without_a_start:99/u);
  roster.started({ role: "game", pid: 4321, startedAtMs: 1 });
  assert.throws(() => roster.started({ role: "game", pid: 4321, startedAtMs: 2 }), /child_already_started:4321/u);
  // The FIRST ending is the ending: a second report for one pid cannot rewrite how it left.
  roster.ended({ pid: 4321, code: 1, atMs: 10 });
  roster.ended({ pid: 4321, code: 0, atMs: 11 });
  assert.equal(childRow(childrenRecord(roster.rows()), "game").exit.code, 1);
});

test("the record on disk keeps every row a previous writer measured, and re-derives the ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "child-roster-"));
  const path = join(dir, "process-reclamation.json");
  try {
    // The orchestrator: the two children IT spawned.
    writeChildRecord({
      path,
      fields: { closeOutcome: "killed", windowMode: "hidden" },
      children: [
        { role: "game", pid: 11, startedAtMs: 100, exit: { code: null, signal: null, atMs: null }, survivedTeardown: false },
        { role: "host", pid: 12, startedAtMs: 110, exit: { code: 0, signal: null, atMs: 200 }, survivedTeardown: false },
      ],
    });
    const prior = readChildRecord({ path });
    assert.equal(prior.firstToLeave, "host:code=0");

    // The launcher: its own child, merged into what the orchestrator measured.
    const merged = mergeChildren(prior.children, [
      { role: "orchestrator", pid: 13, startedAtMs: 90, exit: { code: 0, signal: null, atMs: 300 }, survivedTeardown: false },
    ]);
    const record = writeChildRecord({ path, children: merged, fields: { closeOutcome: prior.closeOutcome } });

    assert.deepEqual(
      record.children.map((child) => `${child.role}:${child.pid}`),
      ["game:11", "host:12", "orchestrator:13"],
    );
    assert.equal(record.firstToLeave, "host:code=0", "the first child to leave, not the last writer's own child");
    assert.equal(record.closeOutcome, "killed", "the fields a previous writer measured are not dropped");
    const reread = readChildRecord({ path });
    assert.equal(reread.firstToLeave, "host:code=0", "what a reader gets is what was derived");
    assert.equal(reread.children[0].exit.code, null, "the game's unobserved exit is not written as 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second writer may fill in an exit the first never observed, and nothing else", () => {
  const existing = [
    { role: "game", pid: 11, startedAtMs: 100, exit: { code: null, signal: null, atMs: null }, survivedTeardown: false },
  ];
  const filled = mergeChildren(existing, [
    { role: "game", pid: 11, startedAtMs: 999, exit: { code: 3, signal: null, atMs: 400 }, survivedTeardown: true },
  ]);
  assert.deepEqual(filled, [
    {
      role: "game",
      pid: 11,
      startedAtMs: 100,
      exit: { code: 3, signal: null, atMs: 400 },
      survivedTeardown: false,
    },
  ]);
  // An exit that IS observed is not overwritten by a later opinion.
  const kept = mergeChildren(filled, [
    { role: "game", pid: 11, startedAtMs: 100, exit: { code: 0, signal: null, atMs: 500 }, survivedTeardown: false },
  ]);
  assert.equal(kept[0].exit.code, 3);
});
