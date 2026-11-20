// The run's owner: whichever way a run leaves, the processes it started are gone.
//
// Measured 2026-11-15, five runs in one night: run 1 failed in capture and left `node …/phases/launch.mjs`
// (pid 32740) and its Edge (44088) holding CDP 9341; run 2 then spent a whole build and died as
// `phase launch failed (exit 2)`; run 4 died the same way on run 2's orphan; run 5 was green only after a
// human killed two exact PIDs. So this test starts a driver, a browser and a recorded child, fails
// nothing at all (the teardown is not conditional on a phase), and asserts the whole set is gone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cdpPortLockDir } from "./cdp-port-lock.mjs";
import { runPaths } from "./config.mjs";
import { describeGameCleanup, recordedGameProcesses, survivingGameIdentities } from "./run-game.mjs";
import {
  describeLeftovers,
  describeTeardown,
  inspectRunLeftovers,
  registeredRunProcesses,
  registerRunProcess,
  retireRunProcesses,
  teardownRun,
  writeLeftoversReading,
} from "./run-owner.mjs";

const IDLE = "setInterval(() => {}, 1000);";

/** A process that stays alive, with the arguments a real one carries in its command line. */
function spawnIdle(args) {
  return spawn(process.execPath, ["-e", IDLE, "--", ...args], { stdio: "ignore", windowsHide: true });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Windows reaps asynchronously, so "gone" is a fact to poll for rather than to assume. */
async function waitForGone(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** The same asynchronous reap applies to a directory a just-killed process was working in. */
async function removeTree(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const CDP_PORT = 9499;

test("a run's owner terminates every process it started, and asserts none remains", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-owner-"));
  const stageRoot = join(root, "run.stage");
  const paths = runPaths({ outRoot: join(root, "run"), stageRoot });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.browserProfile, { recursive: true });
  writeFileSync(paths.runConfigFile, JSON.stringify({ tag: "owner-test", cdpPort: CDP_PORT }), "utf8");
  const run = { cdpPort: CDP_PORT, tag: "owner-test" };

  // Three shapes of "started by this run": the launch driver and the browser carry the stage root in
  // their command lines (found by the sweep), the capture driver carries nothing of the kind (found by
  // the registry alone).
  const launchDriver = spawnIdle([paths.runConfigFile]);
  const browser = spawnIdle([`--user-data-dir=${paths.browserProfile}`, `--remote-debugging-port=${CDP_PORT}`]);
  const captureDriver = spawnIdle(["capture"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    registerRunProcess(paths, { pid: launchDriver.pid, role: "launch-driver" });
    registerRunProcess(paths, { pid: captureDriver.pid, role: "capture:a-surfaces" });
    // A lock whose holder is about to be force-killed: a force-killed process runs no exit hook, so the
    // release is the owner's job and not the dying process's.
    mkdirSync(cdpPortLockDir(CDP_PORT), { recursive: true });
    writeFileSync(
      `${cdpPortLockDir(CDP_PORT)}/owner.json`,
      `${JSON.stringify({ pid: launchDriver.pid, startedAtMs: Date.now() })}\n`,
      "utf8",
    );

    assert.deepEqual(
      registeredRunProcesses(paths).map((record) => record.role),
      ["launch-driver", "capture:a-surfaces"],
      "the registry names what the run was told about",
    );
    const before = inspectRunLeftovers({ paths, run });
    assert.equal(before.status, "ours_remain", "before the teardown the run's own processes are alive");
    assert.ok(before.examined > 0, `the process table was really read: examined ${before.examined}`);
    assert.match(describeLeftovers(before, run), /are still alive after cleanup/);

    const teardown = teardownRun({ paths, run, reason: "phase_failure" });
    const line = describeTeardown(teardown);
    assert.match(line, /^RUN-CLEANUP\(phase_failure\).*sweep=\d+ examined/su, line);
    assert.equal(teardown.failed.length, 0, `${line} - every kill had to succeed`);
    assert.equal(teardown.lock, "released", "the port lock of a killed holder is released by the owner");

    for (const [name, child] of [
      ["launch driver", launchDriver],
      ["browser", browser],
      ["capture driver", captureDriver],
    ]) {
      assert.ok(await waitForGone(child.pid), `${name} (pid ${child.pid}) must be gone after the teardown`);
    }
    assert.equal(existsSync(cdpPortLockDir(CDP_PORT)), false, "and the CDP lock directory is gone");

    const after = inspectRunLeftovers({ paths, run });
    assert.equal(after.status, "none", describeLeftovers(after, run));
    assert.match(describeLeftovers(after, run), /^LEFTOVERS: none \(examined \d+ processes; cdp port 9499 free\)$/u);
    writeLeftoversReading(paths, after);
    assert.equal(
      JSON.parse(readFileSync(paths.leftoversFile, "utf8")).status,
      "none",
      "the reading is written beside the run, so the fact outlives the terminal",
    );
  } finally {
    for (const child of [launchDriver, browser, captureDriver]) child.kill("SIGKILL");
    rmSync(cdpPortLockDir(CDP_PORT), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// The game the run started is its own population in the assertion: the sweep cannot see the game client (its
// command line names nothing of this run), so "nothing remained" from the sweep says nothing about it. The
// teardown ends it by the pid the run recorded, and the post-run reading says which of the two happened.
test("a run takes back the game it started, and says so when it cannot", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-game-owner-"));
  const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
  mkdirSync(paths.stateDir, { recursive: true });
  const run = { cdpPort: 9496, tag: "game-owner-test" };
  const loader = spawnIdle(["--mods-path", join(paths.stageRoot, "root", "player-host", "Mods")]);
  const client = spawnIdle(["--stardew-client"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    registerRunProcess(paths, { pid: loader.pid, role: "game-smapi" });
    registerRunProcess(paths, { pid: client.pid, role: "game-client" });

    // Before the teardown the assertion is RED: both halves are alive, and the run is told so by identity.
    const before = {
      recorded: recordedGameProcesses(paths),
      surviving: survivingGameIdentities(recordedGameProcesses(paths)),
    };
    assert.equal(before.surviving.kind, "alive");
    assert.match(describeGameCleanup(before)[0], /^RUN-GAME-CLEANUP: game_still_alive: /u);
    assert.match(describeGameCleanup(before)[0], new RegExp(`${loader.pid}\\(game-smapi\\)`, "u"));
    assert.match(describeGameCleanup(before)[0], new RegExp(`${client.pid}\\(game-client\\)`, "u"));
    assert.match(
      describeGameCleanup(before)[0],
      /\(could not terminate\) - this run started a game and did not take it back$/u,
    );
    const duringLeftovers = inspectRunLeftovers({ paths, run, game: before });
    assert.equal(duringLeftovers.status, "game_alive", describeLeftovers(duringLeftovers, run));
    assert.match(describeLeftovers(duringLeftovers, run), /this run's game is still alive after cleanup/u);

    teardownRun({ paths, run, reason: "run_complete" });
    assert.ok(await waitForGone(loader.pid), `the game loader (pid ${loader.pid}) must be gone after the teardown`);
    assert.ok(await waitForGone(client.pid), `the game client (pid ${client.pid}) must be gone after the teardown`);

    const after = {
      recorded: recordedGameProcesses(paths),
      surviving: survivingGameIdentities(recordedGameProcesses(paths)),
    };
    assert.equal(after.surviving.kind, "gone");
    assert.match(describeGameCleanup(after)[0], /^RUN-GAME-CLEANUP: game_terminated_by_run: /u);
    const leftovers = inspectRunLeftovers({ paths, run, game: after });
    assert.equal(leftovers.status, "none", describeLeftovers(leftovers, run));
    writeLeftoversReading(paths, leftovers);
    assert.equal(
      JSON.parse(readFileSync(paths.leftoversFile, "utf8")).game.surviving.kind,
      "gone",
      "the game's own answer is written beside the run, so the fact outlives the terminal",
    );
  } finally {
    for (const child of [loader, client]) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable process table is not reported as 'nothing remained'", () => {
  const leftovers = inspectRunLeftovers({ paths: runPaths({ outRoot: "x", stageRoot: "" }), run: { cdpPort: 9498 } });
  assert.equal(leftovers.status, "unverifiable", "an empty query is not a machine running nothing");
  assert.match(describeLeftovers(leftovers, { cdpPort: 9498 }), /^LEFTOVERS: unverifiable:process_table_unavailable/u);
});

// The half the unit above cannot prove: that a REAL failed phase goes through this teardown. `report` on
// an out root with no artifacts is a real failure of a real phase, and it costs no build, no browser and
// no game - so the run's own exit path is exercised without a live run.
test("a phase that fails takes the run's processes with it", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-exit-"));
  const outRoot = join(root, "shots");
  const paths = runPaths({ outRoot, stageRoot: `${outRoot}.stage` });
  mkdirSync(paths.stateDir, { recursive: true });
  // A process the run started whose command line names nothing of this run's: only the registry finds it.
  const child = spawn(process.execPath, ["-e", IDLE], { cwd: root, stdio: "ignore", windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    registerRunProcess(paths, { pid: child.pid, role: "launch-driver" });
    const command = [
      fileURLToPath(new URL("../run.mjs", import.meta.url)),
      "report",
      "--out",
      outRoot,
      "--commit",
      "HEAD",
      "--runtime",
      dirname(process.execPath),
      "--cdp-port",
      "9497",
    ];
    const result = await new Promise((resolve) => {
      const phase = spawn(process.execPath, command, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      phase.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      phase.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      phase.on("close", (code) => resolve({ code, output }));
    });

    assert.notEqual(result.code, 0, "the report phase fails on an out root with no artifacts");
    assert.match(result.output, /RUN-CLEANUP\(phase_failure\)/u, result.output.slice(-1200));
    assert.match(result.output, /killed=1 \[\d+\(launch-driver\)\]/u, "the run killed the pid it recorded");
    assert.match(result.output, /^LEFTOVERS: none \(examined \d+ processes; cdp port 9497 free\)$/mu);
    assert.ok(await waitForGone(child.pid), `the recorded process (pid ${child.pid}) must be gone after the failure`);
  } finally {
    child.kill("SIGKILL");
    // Its working directory is the root this test deletes, so the delete waits for the process itself.
    await waitForGone(child.pid);
    await removeTree(root);
  }
});

// What the reaper takes back belongs to the invocation that was hard-killed, not to the one that took it back:
// the ledger keeps the record and gains the fact that it is settled, so the next phase neither kills a dead pid
// nor reports the previous invocation's game as a game IT terminated.
test("a retired pid leaves the reading and stays in the record", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-owner-retire-"));
  try {
    const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
    mkdirSync(paths.stateDir, { recursive: true });
    registerRunProcess(paths, { pid: 41048, role: "game-smapi", startTime: "2026-11-16T16:15:23.6784170+08:00" });
    registerRunProcess(paths, { pid: 35200, role: "capture:w-game-launch" });
    assert.deepEqual(
      registeredRunProcesses(paths).map((record) => record.pid),
      [41048, 35200],
      "both are the run's until something settles them",
    );
    retireRunProcesses(paths, [
      { pid: 41048, role: "game-smapi" },
      { pid: 41048, role: "game-smapi" },
    ]);
    assert.deepEqual(
      registeredRunProcesses(paths).map((record) => record.pid),
      [35200],
      "a retired pid is no longer this run's - and one retirement per pid, however many times it is named",
    );
    const lines = readFileSync(paths.runProcessesFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.pid, line.role, line.retired === true]),
      [
        [41048, "game-smapi", false],
        [35200, "capture:w-game-launch", false],
        [41048, "game-smapi", true],
      ],
      "append-only: what the invocation started is still on the record, and the retirement is written beside it",
    );
    retireRunProcesses(paths, []);
    assert.equal(
      readFileSync(paths.runProcessesFile, "utf8").trim().split("\n").length,
      3,
      "nothing to retire writes nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A pid is not an identity. The registry row for a capture driver that has already exited still names its
// pid, and Windows hands that number to the next process - so a teardown that kills by the recorded number
// alone kills a stranger. Measured 2026-11-21 (`D:/gb-modcheck/frontend--r16`): the `n-message-edit` driver
// was registered at 00:08:28Z with `startTime:null`, exited, and a later invocation's teardown killed
// whatever held pid 36952 at 00:23 - reported as `killed=1 [36952(capture:n-message-edit)]` (rule #3715).
test("a recorded pid the machine has since recycled is reported, never killed", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-owner-recycled-"));
  const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
  mkdirSync(paths.stateDir, { recursive: true });
  const run = { cdpPort: 9495, tag: "recycled-test" };
  const stranger = spawnIdle(["capture"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    registerRunProcess(paths, {
      pid: stranger.pid,
      role: "capture:n-message-edit",
      startTime: "2026-11-21T00:08:28.1640000+08:00",
    });
    const teardown = teardownRun({ paths, run, reason: "phase_failure" });
    const line = describeTeardown(teardown);
    assert.equal(teardown.killed.length, 0, `${line} - the recorded start time is not this process's`);
    assert.deepEqual(
      teardown.unverified.map((entry) => [entry.pid, entry.role, entry.recorded]),
      [[stranger.pid, "capture:n-message-edit", "2026-11-21T00:08:28.1640000+08:00"]],
      line,
    );
    assert.equal(
      typeof teardown.unverified[0].observed,
      "string",
      `the reading names both sides, so a reader can see the two are different processes: ${line}`,
    );
    assert.notEqual(teardown.unverified[0].observed, teardown.unverified[0].recorded, line);
    assert.match(
      line,
      new RegExp(
        `unverified=1 \\[${stranger.pid}\\(capture:n-message-edit\\) recorded=2026-11-21T00:08:28\\.1640000\\+08:00 observed=\\S+\\]`,
        "u",
      ),
      line,
    );
    assert.ok(isAlive(stranger.pid), "a pid wearing a recorded number is not this run's to end");
  } finally {
    stranger.kill("SIGKILL");
    await waitForGone(stranger.pid);
    await removeTree(root);
  }
});

// The same rule for a row that could not be dated when it was written: an identity nobody recorded is not
// one the teardown may assume. The run says so by name instead of killing the number.
test("a recorded pid with no start time is reported, never killed", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-owner-undated-"));
  const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
  mkdirSync(paths.stateDir, { recursive: true });
  const run = { cdpPort: 9494, tag: "undated-test" };
  const child = spawnIdle(["capture"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(
      paths.runProcessesFile,
      `${JSON.stringify({ pid: child.pid, role: "capture:a-surfaces", startTime: null, at: "2026-11-21T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const teardown = teardownRun({ paths, run, reason: "run_complete" });
    const line = describeTeardown(teardown);
    assert.equal(teardown.killed.length, 0, line);
    assert.deepEqual(
      teardown.unverified.map((entry) => [entry.pid, entry.recorded]),
      [[child.pid, null]],
      line,
    );
    assert.match(
      line,
      new RegExp(`unverified=1 \\[${child.pid}\\(capture:a-surfaces\\) recorded=nothing observed=\\S+\\]`, "u"),
      line,
    );
    assert.ok(isAlive(child.pid), "an undated row does not license a kill");
  } finally {
    child.kill("SIGKILL");
    await waitForGone(child.pid);
    await removeTree(root);
  }
});

// The registration is where the identity is available (the pid exists when it is written, and a minute later
// it need not), so the recorder takes it rather than trusting every caller to remember.
test("a registration records the process's own start time when the caller does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-owner-identity-"));
  const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
  const child = spawnIdle(["capture"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    registerRunProcess(paths, { pid: child.pid, role: "capture:b-characters" });
    const [record] = registeredRunProcesses(paths);
    assert.equal(typeof record.startTime, "string", "pid AND start time is the identity, so both are written");
    assert.match(record.startTime, /^\d{4}-\d{2}-\d{2}T/u, record.startTime);
  } finally {
    child.kill("SIGKILL");
    await waitForGone(child.pid);
    await removeTree(root);
  }
});
