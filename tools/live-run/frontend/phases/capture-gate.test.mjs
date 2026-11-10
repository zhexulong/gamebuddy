/*
 * red-proof: inject  with the `executed.length === 0` guard removed, this suite fails on
 *
 *   "a stage whose drivers are all already done is a failure, not a green run"
 *     expected 4, received 0 — the exact shape of the 2026-11-05 run that reported
 *     `DONE-CAPTURE failed=0 of 20 (skipped=0)` above 115 screenshots dated two days earlier.
 *
 * The population is the roster the phase runs (`drivers.mjs`), imported rather than copied, so a driver
 * added tomorrow is covered without editing this file. Every driver is marked done, which is what makes the
 * phase reach its own decision without spawning a browser: nothing is executed, and the question is
 * only whether that is reported as success.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KIT_ROOT, defaultStageFor, runPaths, saveRunConfig } from "../lib/config.mjs";
import { DRIVERS } from "./drivers.mjs";

const PHASE = join(KIT_ROOT, "phases", "capture.mjs");
/** The roster itself, imported: the same list the phase runs and the report reconciles. */
const DRIVER_OUTPUTS = DRIVERS.map((driver) => driver.out);

async function fabricateStage() {
  const outRoot = join(await mkdtemp(join(tmpdir(), "frontend-capture-gate-")), "out");
  const run = { outRoot, stageRoot: defaultStageFor(outRoot) };
  const paths = runPaths(run);
  saveRunConfig(paths, run);
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.launchStateFile, JSON.stringify({ kind: "mounted", mounted: true, port: 1, cdpPort: 1 }), "utf8");
  return { outRoot, paths };
}

function runPhase(paths, extra = []) {
  return spawnSync(process.execPath, [PHASE, paths.runConfigFile, ...extra], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("the driver population is read from the phase, not written here", () => {
  assert.ok(
    DRIVER_OUTPUTS.length >= 19,
    `expected the phase's DRIVERS table to name its outputs, found ${DRIVER_OUTPUTS.length}`,
  );
});

test("a stage whose drivers are all already done is a failure, not a green run", async () => {
  const { outRoot, paths } = await fabricateStage();
  try {
    mkdirSync(join(paths.stateDir, "capture-done"), { recursive: true });
    for (const output of DRIVER_OUTPUTS) {
      writeFileSync(join(paths.stateDir, "capture-done", `${output}.driver-done`), "{}", "utf8");
    }

    const result = runPhase(paths);

    assert.equal(
      result.status,
      4,
      `expected exit 4 (nothing verified), got ${result.status}: ${(result.stdout ?? "").slice(-400)}`,
    );
    assert.match(result.stdout ?? "", /capture_ran_nothing/u);
    assert.match(result.stdout ?? "", /ran=0 /u);
    assert.doesNotMatch(
      result.stdout ?? "",
      /skipped=0 /u,
      "a driver skipped by a done marker must not be counted as not-selected",
    );
  } finally {
    await rm(join(outRoot, ".."), { recursive: true, force: true });
  }
});

test("a --driver= that matches nothing is also a failure, and says so in its own words", async () => {
  const { outRoot, paths } = await fabricateStage();
  try {
    const result = runPhase(paths, ["--driver=no-such-driver"]);

    assert.equal(result.status, 4, `expected exit 4, got ${result.status}`);
    assert.match(result.stdout ?? "", /capture_selected_nothing/u);
  } finally {
    await rm(join(outRoot, ".."), { recursive: true, force: true });
  }
});
