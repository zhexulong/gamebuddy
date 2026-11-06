// The killed run's teardown: an external stop must cost the run its own verdict and nothing of the run's surroundings.
//
// Measured 2026-11-06 at 19:37:14: a launcher ended by an external timeout left its fixture transaction unreleased and its
// run directory holding `launch.json` alone, because nothing trapped the signal. These are the falsifiers for the two
// halves that fix it: the trap (first signal owns the unwind, second exits immediately) and the teardown steps it runs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installLiveRunInterrupt,
  killedReasonCode,
  restoreFixtureTransaction,
  SIGNAL_EXIT_CODES,
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
