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
import { join } from "node:path";
import { test } from "node:test";
import { cdpPortLockDir } from "./cdp-port-lock.mjs";
import { runPaths } from "./config.mjs";
import {
  describeLeftovers,
  describeTeardown,
  inspectRunLeftovers,
  registerRunProcess,
  registeredRunProcesses,
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

test("an unreadable process table is not reported as 'nothing remained'", () => {
  const leftovers = inspectRunLeftovers({ paths: runPaths({ outRoot: "x", stageRoot: "" }), run: { cdpPort: 9498 } });
  assert.equal(leftovers.status, "unverifiable", "an empty query is not a machine running nothing");
  assert.match(describeLeftovers(leftovers, { cdpPort: 9498 }), /^LEFTOVERS: unverifiable:process_table_unavailable/u);
});
