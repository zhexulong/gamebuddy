#!/usr/bin/env node
/**
 * The falsifier for `tools/stardew-soil-itm-canary-gate.mjs`.
 *
 * The suite it runs needs a decompiled Stardew tree that a checkout does not carry, and a suite whose whole population
 * skips exits 0 - the same green as a measured run. These cases pin the runner's side of that contract: the absence is
 * a named not-measured verdict with exit 2, only an explicit flag reaches the five skips, and the present tree is not
 * intercepted.
 *
 * Measured red (inject): returning `status: "run"` when `missing.length > 0` (the shape before this runner) -> the case
 * "an absent witness root is not measured, and the marker names it" fails on `not_measured !== run`
 * (tools/stardew-soil-itm-canary-gate.test.mjs)
 * Measured red (inject): dropping the `argv.includes(ALLOW_ABSENT_ROOT_FLAG)` branch -> the case "only the explicit flag runs
 * the skips, and it says so" fails on `undefined !== run` (tools/stardew-soil-itm-canary-gate.test.mjs)
 * Measured red (self-check): the runner's own default run on a tree without `.tmp-stardew-decompile/` ->
 * `soil_itm_canary_not_measured:decompile_root_absent:<root>` and exit 2, where `node --test` over the same suite
 * printed five skips and exit 0 (this file's "the declared entry point" case)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  missingSoilItmWitnesses,
  SOIL_ITM_NOT_MEASURED,
  SOIL_ITM_WITNESS_PATHS,
} from "./lib/stardew-soil-itm-canary.mjs";
import { ALLOW_ABSENT_ROOT_FLAG, planSoilItmCanaryRun } from "./stardew-soil-itm-canary-gate.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_PATH = path.join(REPOSITORY_ROOT, "tools", "stardew-soil-itm-canary-gate.mjs");
const witnessesPresent =
  missingSoilItmWitnesses({ root: path.join(REPOSITORY_ROOT, ".tmp-stardew-decompile") }).length === 0;

test("an absent witness root is not measured, and the marker names it", () => {
  const plan = planSoilItmCanaryRun({ repositoryRoot: "/nowhere", exists: () => false });
  const root = path.join("/nowhere", ".tmp-stardew-decompile");
  assert.equal(plan.status, "not_measured");
  assert.equal(plan.marker, `${SOIL_ITM_NOT_MEASURED}:decompile_root_absent:${root}`);
  assert.deepEqual(plan.missing, [...SOIL_ITM_WITNESS_PATHS], "every absent witness is named, not just the root");
});

test("only the explicit flag runs the skips, and it says so", () => {
  const allowed = planSoilItmCanaryRun({
    repositoryRoot: "/nowhere",
    exists: () => false,
    argv: [ALLOW_ABSENT_ROOT_FLAG],
  });
  assert.equal(allowed.status, "run");
  assert.equal(allowed.allowed, true, "an absent tree the caller accepted is not silently the default");
  assert.equal(allowed.missing.length, SOIL_ITM_WITNESS_PATHS.length);
});

test("a complete witness set runs without the flag and is not blocked", () => {
  const present = planSoilItmCanaryRun({ repositoryRoot: "/nowhere", exists: () => true });
  assert.equal(present.status, "run");
  assert.equal(present.allowed, false);
  assert.deepEqual(present.missing, []);
});

test(
  "the declared entry point exits 2 naming the absent root, where the bare suite exited 0 over five skips",
  {
    skip: witnessesPresent
      ? "the decompiled tree is present here, so the absence this case drives is unreachable"
      : false,
  },
  () => {
    const run = spawnSync(process.execPath, [GATE_PATH], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.match(
      run.stdout,
      new RegExp(`^${SOIL_ITM_NOT_MEASURED}:decompile_root_absent:`, "mu"),
      "the marker names the not-measured verdict rather than a failure",
    );
    assert.ok(run.stdout.includes(".tmp-stardew-decompile"), "the marker names the root that was looked for");
  },
);
