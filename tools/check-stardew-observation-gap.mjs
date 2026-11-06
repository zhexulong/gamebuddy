#!/usr/bin/env node
/**
 * The observation-gap report, ARMED: `stardew-action-inventory-reconciliation.mjs --fail-on-ungranted`.
 *
 * WHY. The reconciliation analyzer prints six observation sections - engine collections, tile channels,
 * addressability, postcondition mutations, publication gating, consumption - and appends them to its artifact under
 * `observationGaps`. The flag that turns an unregistered gap into a failure is `--fail-on-ungranted`, and on 2026-11-05
 * a grep for it found three hits, all inside that one file: the flag was written and never passed. The default CLI
 * semantics are "writing the artifact is success", because existing consumers depend on that, so nothing in the tree
 * could have gone red on a gap. This gate is the arming, and nothing else: it runs the analyzer's own CLI over the
 * three-step chain that produces its inputs and lets the analyzer make the verdict.
 *
 * THE CHAIN, all three steps the analyzer project's own entry points, into a temp directory under the OS temp root:
 *   stardew-action-candidates.mjs        --source-root <decompiled> --action-register <register> --out <candidates>
 *   stardew-remaining-actions-report.mjs --candidates <candidates> --catalog <catalog> --out <remaining>
 *   stardew-action-inventory-reconciliation.mjs --source-root ... --remaining <remaining> --fail-on-ungranted
 * The method-layer tiers exist only in the remaining report, which is why the chain is three steps rather than one; the
 * analyzer refuses a candidates artifact in the `--remaining` slot by name (`input_is_candidates_artifact_not_remaining_report`).
 *
 * INPUTS this checkout may not have. The decompiled tree under `ref/external/StardewValleyDecompiled` is gitignored, and
 * so is nothing else here: the register and the capability catalog are committed. Without the tree there is nothing to
 * recompute, so the gate prints `observation_gap_skipped: needs ref/external/...` and exits 0. That marker is the
 * convention `tools/check-ci-coverage.mjs` counts as `not_measured` and `tools/prelive.mjs` reports as UNAVAILABLE:
 * an unavailable measurement is not a pass, and this gate must never read as one.
 *
 * A run that exits 0 without printing the analyzer's `observation gaps:` summary line is a FAILURE, not a pass: the
 * artifact path prints only a JSON one-liner, and a chain that skipped the measurement is exactly the defect this file
 * exists for.
 *
 *   node tools/check-stardew-observation-gap.mjs      # the verdict; exit 1 on an ungranted gap
 *
 * red-proof: inject  with `--fail-on-ungranted` removed from the reconciliation step, the falsifier failed on
 *   "the chain arms --fail-on-ungranted on the reconciliation step, which is the whole point"
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANALYSIS = "integrations/stardew/action-development/src/analysis";
export const DECOMPILED_ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley";
export const ACTION_REGISTER =
  "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json";
export const CAPABILITY_CATALOG = "design/gameplay-capability-catalog.json";

/** Everything the chain reads. Named once, so the skip message and the run name the same paths. */
export const REQUIRED_INPUTS = Object.freeze([DECOMPILED_ROOT, ACTION_REGISTER, CAPABILITY_CATALOG]);

/** What the analyzer prints when it measured: its own summary line, from `writeObservationSummary`. */
const SUMMARY_MARKER = /^observation gaps: \d+ engine collections$/mu;

export function missingInputs({ exists = (path) => existsSync(resolve(ROOT, path)) } = {}) {
  return REQUIRED_INPUTS.filter((path) => !exists(path));
}

/**
 * The three steps, as data. Each is the analyzer project's own CLI with the arguments its `Usage` block documents, so
 * this gate cannot drift from what those tools accept without the tool itself going red.
 */
export function chainSteps({ candidates, remaining }) {
  return [
    {
      name: "candidates",
      args: [
        `${ANALYSIS}/stardew-action-candidates.mjs`,
        "--source-root",
        DECOMPILED_ROOT,
        "--action-register",
        ACTION_REGISTER,
        "--out",
        candidates,
      ],
    },
    {
      name: "remaining",
      args: [
        `${ANALYSIS}/stardew-remaining-actions-report.mjs`,
        "--candidates",
        candidates,
        "--catalog",
        CAPABILITY_CATALOG,
        "--out",
        remaining,
      ],
    },
    {
      name: "observation_gap",
      args: [
        `${ANALYSIS}/stardew-action-inventory-reconciliation.mjs`,
        "--source-root",
        DECOMPILED_ROOT,
        "--action-register",
        ACTION_REGISTER,
        "--remaining",
        remaining,
        "--catalog",
        CAPABILITY_CATALOG,
        "--out",
        // A file, not stdout: the artifact is megabytes and the verdict is one line.
        join(dirname(remaining), "reconciliation.json"),
        "--fail-on-ungranted",
      ],
    },
  ];
}

/**
 * Run the chain and decide. `skipped` carries the reason a checkout cannot measure; `failed` names the step that
 * stopped it and prints that step's own stderr, so the cause is the first thing a reader sees.
 */
export function runObservationGap({
  exists = (path) => existsSync(resolve(ROOT, path)),
  run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  makeTempDir = () => mkdtempSync(join(tmpdir(), "gamebuddy-observation-gap-")),
  removeTempDir = (dir) => rmSync(dir, { recursive: true, force: true }),
  write = (text) => process.stdout.write(text),
} = {}) {
  const missing = missingInputs({ exists });
  if (missing.length > 0) return { status: "skipped", missing, steps: [] };
  const directory = makeTempDir();
  const steps = [];
  let summary = "";
  try {
    for (const step of chainSteps({
      candidates: join(directory, "candidates.json"),
      remaining: join(directory, "remaining.json"),
    })) {
      const startedAt = Date.now();
      const outcome = run(step.args);
      const stdout = outcome.stdout ?? "";
      const stderr = outcome.stderr ?? "";
      const exitCode = typeof outcome.status === "number" ? outcome.status : 1;
      steps.push({ name: step.name, ms: Date.now() - startedAt, exitCode });
      if (exitCode !== 0)
        return { status: "failed", steps, failedStep: step.name, exitCode, cause: firstLines(`${stderr}${stdout}`) };
      if (step.name === "observation_gap") summary = stderr;
    }
    if (!SUMMARY_MARKER.test(summary))
      return {
        status: "failed",
        steps,
        failedStep: "observation_gap",
        exitCode: 0,
        cause: "the analyzer exited 0 without printing its observation summary, so nothing was measured",
      };
    return { status: "measured", steps, summary };
  } finally {
    removeTempDir(directory);
  }
}

function firstLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 12)
    .join("\n");
}

function main() {
  const result = runObservationGap();
  if (result.status === "skipped") {
    // Exit 0 with a marker: an unavailable measurement is not a failure, and it is not a pass either.
    process.stdout.write(`observation_gap_skipped: needs ${result.missing.join(", ")}\n`);
    return;
  }
  if (typeof result.summary === "string") process.stdout.write(result.summary);
  for (const step of result.steps)
    process.stdout.write(`observation_gap step ${step.name} exit=${step.exitCode} ${step.ms}ms\n`);
  if (result.status === "failed") {
    process.stderr.write(
      `observation_gap_failed: step ${result.failedStep} exit=${result.exitCode}\n${result.cause}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("observation_gap: green\n");
}

if (import.meta.main) main();
