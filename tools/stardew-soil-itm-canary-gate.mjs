#!/usr/bin/env node
/**
 * The entry point for `test:stardew-soil-itm-canary`.
 *
 * The five cases read their witnesses out of a decompiled Stardew tree that a checkout does not carry, so they skip
 * there - and `node --test` exits 0 when every case skips, which is the same green as a suite that measured. The runner
 * also collapses the suite's own status to 1, so the blocked verdict cannot be published from inside the file: this
 * runner decides before the suite starts and reports exit 2 itself.
 *
 * `--allow-absent-decompile-root` runs the suite anyway, where its five cases skip with the named reason. That is the
 * caller's decision and it has to be made explicitly; the default is the blocked verdict.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  missingSoilItmWitnesses,
  SOIL_ITM_DECOMPILE_ROOT_RELATIVE_PATH,
  SOIL_ITM_NOT_MEASURED,
} from "./lib/stardew-soil-itm-canary.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_PATH = path.join(REPOSITORY_ROOT, "tools", "stardew-soil-itm-canary.test.mjs");

/** The explicit opt-out: run the five skips, on purpose, and say so in the output. */
export const ALLOW_ABSENT_ROOT_FLAG = "--allow-absent-decompile-root";

/** The environment the suite reads to register its cases as skips instead of refusing to run. */
export const ALLOW_ABSENT_ROOT_ENV = "GAMEBUDDY_SOIL_ITM_CANARY_ALLOW_ABSENT_ROOT";

/**
 * Run the suite, or report the absent witness root.
 *
 * The marker names the absolute root that was looked for and the witnesses missing under it, because "the suite
 * skipped" says nothing about which tree to stage.
 */
export function planSoilItmCanaryRun({ repositoryRoot, argv = [], exists = existsSync }) {
  const root = path.join(repositoryRoot, SOIL_ITM_DECOMPILE_ROOT_RELATIVE_PATH);
  const missing = missingSoilItmWitnesses({ root, exists });
  if (missing.length === 0) return { status: "run", root, missing, allowed: false };
  if (argv.includes(ALLOW_ABSENT_ROOT_FLAG)) return { status: "run", root, missing, allowed: true };
  return { status: "not_measured", root, missing, marker: `${SOIL_ITM_NOT_MEASURED}:decompile_root_absent:${root}` };
}

function describeNotMeasured(plan) {
  return [
    plan.marker,
    `  ${plan.missing.length} witness(es) absent: ${plan.missing.join(", ")}`,
    `  stage the decompiled tree (tools/README.md: "Trace-first Interaction Transition Model (ITM) canary"), or pass ` +
      `${ALLOW_ABSENT_ROOT_FLAG} to run the five skips deliberately`,
  ];
}

function main() {
  const plan = planSoilItmCanaryRun({ repositoryRoot: REPOSITORY_ROOT, argv: process.argv.slice(2) });
  if (plan.status === "not_measured") {
    for (const line of describeNotMeasured(plan)) process.stdout.write(`${line}\n`);
    process.exitCode = 2;
    return;
  }
  if (plan.allowed)
    process.stdout.write(
      `${SOIL_ITM_NOT_MEASURED}:decompile_root_absent_allowed:${plan.root} - ${plan.missing.length} witness(es) ` +
        `absent; the five cases will skip\n`,
    );
  const suite = spawnSync(process.execPath, ["--test", SUITE_PATH], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(plan.allowed ? { [ALLOW_ABSENT_ROOT_ENV]: "1" } : {}) },
  });
  process.exitCode = typeof suite.status === "number" ? suite.status : 1;
}

if (import.meta.main) main();
