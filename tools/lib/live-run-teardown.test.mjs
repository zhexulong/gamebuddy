// The killed run's teardown: an external stop must cost the run its own verdict and nothing of the run's surroundings.
//
// Measured 2026-11-06 at 19:37:14: a launcher ended by an external timeout left its fixture transaction unreleased and its
// run directory holding `launch.json` alone, because nothing trapped the signal. These are the falsifiers for the two
// halves that fix it: the trap (first signal owns the unwind, second exits immediately) and the teardown steps it runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installLiveRunInterrupt,
  installRunExitHook,
  killedReasonCode,
  launcherReclamationSteps,
  missingReclamationSteps,
  RECLAMATION_STATES,
  reclamationRecord,
  reclamationStep,
  restoreFixtureTransaction,
  SIGNAL_EXIT_CODES,
  stampReclamation,
  writeKilledRunRecord,
} from "./live-run-teardown.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const withTrap = async (options, drive) => {
  const trap = installLiveRunInterrupt({ log: () => {}, ...options });
  try {
    await drive(trap);
  } finally {
    trap.dispose();
  }
};

test("the first signal owns the unwind, and the process exits with that signal's own code", async () => {
  const interrupted = [];
  const exits = [];
  await withTrap(
    {
      onInterrupt: async (signal) => {
        interrupted.push(signal);
      },
      exit: (code) => exits.push(code),
    },
    async (trap) => {
      process.emit("SIGINT");
      await flush();
      assert.deepEqual(interrupted, ["SIGINT"], "the unwind runs once, named by the signal that caused it");
      assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT], "a killed run is not exit 0");
      // SIGTERM is the same trap: a soft POSIX-style timeout must take this path, not the killed-by-nobody one.
      trap.dispose();
      const second = installLiveRunInterrupt({
        log: () => {},
        onInterrupt: async (signal) => interrupted.push(signal),
        exit: (code) => exits.push(code),
      });
      process.emit("SIGTERM");
      await flush();
      second.dispose();
      assert.deepEqual(interrupted, ["SIGINT", "SIGTERM"]);
      assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT, SIGNAL_EXIT_CODES.SIGTERM]);
      assert.ok(SIGNAL_EXIT_CODES.SIGTERM !== SIGNAL_EXIT_CODES.SIGINT, "the two signals stay distinguishable");
    },
  );
});

test("a second signal exits at once instead of starting a second unwind", async () => {
  const interrupted = [];
  const exits = [];
  let release = null;
  const stuck = new Promise((resolve) => {
    release = resolve;
  });
  await withTrap(
    {
      onInterrupt: (signal) => {
        interrupted.push(signal);
        // The first unwind is stuck on a bridge that is already gone - which is exactly when a second signal arrives.
        return stuck;
      },
      exit: (code) => exits.push(code),
    },
    async () => {
      process.emit("SIGINT");
      await flush();
      assert.deepEqual(interrupted, ["SIGINT"]);
      process.emit("SIGINT");
      assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT], "the second signal does not wait for the first unwind");
      assert.deepEqual(interrupted, ["SIGINT"], "and does not start a teardown of its own");
      release();
      await flush();
      assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT], "the eventual settle cannot exit twice");
    },
  );
});

test("a teardown that throws still exits like a killed run, never like a survivor", async () => {
  const exits = [];
  await withTrap(
    {
      onInterrupt: async () => {
        throw new Error("fixture_restore_refused");
      },
      exit: (code) => exits.push(code),
    },
    async () => {
      process.emit("SIGTERM");
      await flush();
      assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGTERM]);
    },
  );
});

test("a disposed trap leaves no listener behind", async () => {
  const interrupted = [];
  const trap = installLiveRunInterrupt({ log: () => {}, onInterrupt: async (signal) => interrupted.push(signal) });
  trap.dispose();
  process.emit("SIGINT");
  await flush();
  assert.deepEqual(interrupted, []);
});

test("the restore a killed run runs is the same command the ordinary path runs", () => {
  // The killed half exists because the ordinary teardown never ran. What it must NOT do is invent a second command: the
  // lock is released by this exact invocation, so the assertion is the argv, not a paraphrase of it.
  const argv = [];
  restoreFixtureTransaction({
    run: (args) => argv.push(args),
    fixtureRoot: "D:/fixtures",
    modsPath: "D:/fixtures/mods",
    releaseDir: "E:/repo/integrations/stardew/bin/Release/net6.0",
    backupName: "native-local-play-session-fixture-backup",
    evidenceDir: "E:/repo/tools",
  });
  assert.deepEqual(argv, [
    [
      "tools/restore-stardew-native-local-player-fixture.mjs",
      "--root",
      "D:/fixtures",
      "--mods-path",
      "D:/fixtures/mods",
      "--release-dir",
      "E:/repo/integrations/stardew/bin/Release/net6.0",
      "--backup-name",
      "native-local-play-session-fixture-backup",
      "--evidence-dir",
      "E:/repo/tools",
    ],
  ]);
});

test("the killed record is written once, and never over a bundle the runner published", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-killed-record-"));
  try {
    const resultPath = join(dir, "multiday_routine.result.json");
    const record = { state: "killed", reasonCode: killedReasonCode("SIGINT"), scenario: "multiday_routine" };
    assert.equal(
      writeKilledRunRecord({ resultPath, record }),
      true,
      "no bundle means the launcher's record is the run",
    );
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), record);
    // The runner's own account wins: a second record for one run is how two artifacts come to disagree about it.
    const runnerBundle = { state: "killed", reasonCode: killedReasonCode("SIGINT"), dayRecords: [{ day: 1 }] };
    writeFileSync(resultPath, JSON.stringify(runnerBundle), "utf8");
    assert.equal(
      writeKilledRunRecord({ resultPath, record: { ...record, evidence: "launcher" } }),
      false,
      "the launcher must not overwrite the runner's bundle",
    );
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), runnerBundle);
    assert.ok(existsSync(resultPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the killed reason code names the signal and is one spelling for both halves", () => {
  // The runner's bundle carries this code and the launcher's fallback record carries it too; two hand-written copies is
  // how they would drift into two vocabularies.
  assert.equal(killedReasonCode("SIGTERM"), "run_killed_by_signal:SIGTERM");
  assert.equal(killedReasonCode("SIGINT"), "run_killed_by_signal:SIGINT");
});

// ── The reclamation account: what the unwind DID, in the artifact an auditor reads ────────────────────────────────
//
// MEASURED 2026-11-09 (`round40`): the run reaped its game, released its fixture transaction and flushed its runtime
// trace, and its bundle published `reclamation: {state: "unobserved", exitReason: null, steps: [], reflection:
// "completed"}` - a completed reflection over zero steps. The audit could not read a teardown account at all, so these
// are the falsifiers for the account itself: every step named with its own outcome, and a state that FOLLOWS them.

const OK_STEPS = [
  { step: "runtime_close", ok: true },
  { step: "binding_close", ok: true },
  { step: "bridge_detach", ok: true },
  { step: "process_reap", ok: true, detail: "game_exit:code:0", pids: [4321] },
  { step: "fixture_restore", ok: true },
];

test("a finished unwind names every step it performed, and the state follows the steps", () => {
  const clean = reclamationRecord({ steps: OK_STEPS.map(reclamationStep), exitReason: "game_exit:code:0" });
  assert.equal(clean.state, "clean");
  assert.equal(clean.reflection, "completed");
  assert.equal(clean.exitReason, "game_exit:code:0");
  assert.equal(clean.steps.length, 5);
  assert.deepEqual(clean.steps[3], {
    step: "process_reap",
    state: "ok",
    detail: "game_exit:code:0",
    pids: [4321],
  });

  // One step that did not finish is the run's ending, and the failing step is the one that names it.
  const failed = reclamationRecord({
    steps: [...OK_STEPS.slice(0, 4), { step: "fixture_restore", ok: false, detail: "restore refused" }].map(
      reclamationStep,
    ),
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.reflection, "failed");
  assert.equal(failed.steps.find((entry) => entry.state === "failed").step, "fixture_restore");

  // An unwind nobody measured says so, and says it with the vocabulary the contract already has.
  const unobserved = reclamationRecord({ steps: [] });
  assert.equal(unobserved.state, "unobserved");
  assert.equal(unobserved.reflection, "skipped");
  assert.deepEqual(unobserved.steps, []);
  assert.ok(RECLAMATION_STATES.includes(unobserved.state));
});

test("the account is stamped into the artifacts that already exist, and never invents one that does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-reclamation-"));
  try {
    const resultPath = join(dir, "multiday_routine.result.json");
    const manifestPath = join(dir, "manifest.json");
    const absentPath = join(dir, "nobody-wrote-this.json");
    writeFileSync(resultPath, JSON.stringify({ state: "blocked", reasonCode: "multiday_routine_blocked" }), "utf8");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, reclamation: { state: "unobserved", exitReason: null, steps: [] } }),
      "utf8",
    );

    const stamped = stampReclamation({
      paths: [resultPath, manifestPath, absentPath],
      steps: OK_STEPS.map(reclamationStep),
      exitReason: "game_exit:code:0",
    });
    assert.deepEqual(stamped.written, [resultPath, manifestPath], "only what exists is written");
    assert.equal(existsSync(absentPath), false, "a run that published no artifact is not given one");
    assert.equal(JSON.parse(readFileSync(resultPath, "utf8")).reclamation.state, "clean");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.reclamation.steps.length, 5);
    assert.equal(manifest.reclamation.exitReason, "game_exit:code:0");
    assert.equal(manifest.schemaVersion, 1, "the rest of the artifact is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the account is extended by the process that measured the next step, and stays one record", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-reclamation-extend-"));
  try {
    const resultPath = join(dir, "multiday_routine.result.json");
    // The runner has already published its own artifact: the stamp fills the account in it, never creates one.
    writeFileSync(resultPath, JSON.stringify({ state: "blocked", reasonCode: "multiday_routine_blocked" }), "utf8");
    // The runner measures its own unwind first: what it owes is closed over BEFORE the game has been reaped.
    stampReclamation({
      paths: [resultPath],
      steps: [
        { step: "runtime_close", ok: true },
        { step: "binding_close", ok: true },
        { step: "bridge_detach", ok: true },
      ].map(reclamationStep),
    });
    // …and the launcher, which owns the game and the fixture, adds what only it can see.
    const extended = stampReclamation({
      paths: [resultPath],
      steps: [
        { step: "process_reap", ok: true, pids: [4321] },
        { step: "fixture_restore", ok: true },
      ].map(reclamationStep),
      exitReason: "game_exit:code:0",
    });
    assert.deepEqual(
      extended.record.steps.map((entry) => entry.step),
      ["runtime_close", "binding_close", "bridge_detach", "process_reap", "fixture_restore"],
      "one record, extended in the order the unwind performed it",
    );
    assert.equal(extended.record.state, "clean");
    assert.deepEqual(
      JSON.parse(readFileSync(resultPath, "utf8")).reclamation.steps.map((entry) => entry.step),
      extended.record.steps.map((entry) => entry.step),
      "the persisted account carries the same steps, in the same order, as the record it was stamped from",
    );
    // The gate: the steps a finished run owes that this account never measured, named one by one.
    assert.deepEqual(missingReclamationSteps(extended.record), []);
    assert.deepEqual(
      missingReclamationSteps(reclamationRecord({ steps: [reclamationStep({ step: "runtime_close", ok: true })] })),
      ["binding_close", "bridge_detach", "process_reap", "fixture_restore"],
    );
    assert.deepEqual(missingReclamationSteps(null), [
      "runtime_close",
      "binding_close",
      "bridge_detach",
      "process_reap",
      "fixture_restore",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The launcher's half of the same account: the game tree it owns to reap and the fixture transaction it holds. Measured
// 2026-11-09 (`round40`): both were clean and neither was written down. The game is a ROW in the run's children record,
// beside the host's - measured 2026-11-22 (`round90`), where the record held this one process and nothing said who left
// first.
const CHILD_RECORD = {
  children: [
    {
      role: "game",
      pid: 4321,
      startedAtMs: 1_000,
      exit: { code: 0, signal: null, atMs: 9_000 },
      survivedTeardown: false,
    },
    {
      role: "host",
      pid: 5321,
      startedAtMs: 1_100,
      exit: { code: 1, signal: null, atMs: 8_000 },
      survivedTeardown: false,
    },
  ],
  firstToLeave: "host:code=1",
  closeOutcome: "killed",
  survivors: [],
};

test("the launcher's steps say what it reaped and by which pid, and what it restored", () => {
  const clean = launcherReclamationSteps({
    record: CHILD_RECORD,
    survivors: [],
    fixtureRestore: { ok: true, error: null },
  });
  assert.deepEqual(
    clean.map((entry) => `${entry.step}:${entry.state}`),
    ["process_reap:ok", "fixture_restore:ok"],
  );
  assert.deepEqual(clean[0].pids, [4321], "the exact process this run launched, by its own pid");
  assert.equal(clean[0].detail, "game:code=0", "how the game ended is its own row, in the one spelling");

  // A survivor is a failed step that NAMES the process still alive - never a pid filed under what was reaped.
  const survivor = launcherReclamationSteps({
    record: CHILD_RECORD,
    survivors: [999],
    fixtureRestore: { ok: true, error: null },
  });
  assert.equal(survivor[0].state, "failed");
  assert.equal(survivor[0].detail, "game:code=0:survivors:999");
  assert.deepEqual(survivor[0].pids, [4321]);

  // A restore that refused is the failure, with its own message, and it outranks nothing: both facts are published.
  const notRestored = launcherReclamationSteps({
    record: null,
    survivors: [],
    fixtureRestore: { ok: false, error: "native_local_fixture_restore_failed" },
  });
  assert.equal(notRestored[0].detail, "game:unobserved", "a game no record holds is named, not assumed ended");
  assert.equal(notRestored[1].state, "failed");
  assert.equal(notRestored[1].detail, "native_local_fixture_restore_failed");
  assert.equal(reclamationRecord({ steps: notRestored }).state, "failed");

  // A row whose handle never reported an exit is `unknown`, and never `code=0`.
  const unobservedExit = launcherReclamationSteps({
    record: { children: [{ role: "game", pid: 4321, startedAtMs: 1_000, exit: { code: null, signal: null, atMs: null } }] },
    survivors: [],
    fixtureRestore: { ok: true, error: null },
  });
  assert.equal(unobservedExit[0].detail, "game:unknown");

  // The ordering travels beside the steps, so the account a round reader opens says who left first.
  assert.equal(
    reclamationRecord({ steps: clean, firstToLeave: CHILD_RECORD.firstToLeave }).firstToLeave,
    "host:code=1",
  );
  assert.equal(reclamationRecord({ steps: clean }).firstToLeave, null, "unobserved is null, not a fabricated order");
});

// THE ENDING, FOR THE EXITS NO `finally` REACHES.
//
// Measured 2026-11-17: a Host died at a turn boundary, its launcher survived another 641.4 s with nothing left to do, and
// no artifact said the run had ended - the run directory held `launch.json` and nothing else. The launcher's ordinary tail
// cannot cover a throw, a `process.exit` inside a helper, or a rejected top-level await, so the shared module owns an exit
// hook for all three. The child below THROWS: the falsifier is a launcher-shaped process whose only ending record would
// have been a `finally` at the bottom of its own file, and that file's tail never runs.
test("a process that throws still writes its ending: the exit hook is the last writer", () => {
  const area = mkdtempSync(join(tmpdir(), "run-exit-hook-"));
  const marker = join(area, "ending.json");
  try {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const { installRunExitHook } = await import(${JSON.stringify(new URL("./live-run-teardown.mjs", import.meta.url).href)});
        import { writeFileSync } from "node:fs";
        installRunExitHook({ onExit: () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ state: "died" })), log: () => {} });
        throw new Error("the run died where no finally can reach");

        `,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.notEqual(child.status, 0, "the child must really fail");
    assert.match(child.stderr, /no finally can reach/u, "the failure is the throw, not the hook");
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { state: "died" });
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test("an ending that cannot be written does not change how the process leaves", () => {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const { installRunExitHook } = await import(${JSON.stringify(new URL("./live-run-teardown.mjs", import.meta.url).href)});
      const said = [];
      installRunExitHook({ onExit: () => { throw new Error("disk gone"); }, log: (line) => said.push(line) });
      process.exitCode = 7;
      process.on("exit", () => { if (said.length !== 1) process.exitCode = 99; });
      `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 7, "a diagnostic write may never become the process's verdict");
});

test("the exit hook needs a handler, and dispose leaves no listener behind", () => {
  assert.throws(() => installRunExitHook({}), /run_exit_hook_needs_a_handler/u);
  const before = process.listenerCount("exit");
  const hook = installRunExitHook({ onExit: () => {}, log: () => {} });
  assert.equal(process.listenerCount("exit"), before + 1);
  hook.dispose();
  assert.equal(process.listenerCount("exit"), before);
});
