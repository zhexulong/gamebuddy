import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CATALOG,
  DECOMPILED_ROOT,
  REQUIRED_INPUTS,
  chainSteps,
  missingInputs,
  runObservationGap,
} from "./check-stardew-observation-gap.mjs";

/**
 * Falsifiers for the arming of `--fail-on-ungranted`. The claim this file protects is narrow: the observation-gap
 * report is run with the flag that makes an unregistered gap exit 1, and a run that could not measure says so instead
 * of passing. Every case below is one way that claim could be false.
 *
 * The real tree is not measured here - that costs ~21 s and the ladder's L0b rung is where it runs. What is asserted
 * here is the wiring, which is the part that was missing: three grep hits for the flag, all inside the analyzer.
 *
 * red-proof: inject  with `--fail-on-ungranted` removed from the reconciliation step, this suite failed on
 *   "the chain arms --fail-on-ungranted on the reconciliation step, which is the whole point"
 * red-proof: with the failure excerpt cut back to the first 12 lines (the shape before 2026-11-08), this suite failed
 *   on "a failing cause names the findings that failed it" - the run printed "3 undeclared" and cut the two
 *   `mutation_not_observable` lines that were the verdict.
 */

const SUMMARY = [
  "observation gaps: 122 engine collections",
  "  A collections       20 read, 102 never read",
  "  green: every engine collection, tile channel, action target and handler mutation is published or recorded",
  "",
].join("\n");

const okRun = (args, { stdout = "", stderr = "" } = {}) => ({ status: 0, stdout, stderr });

test("the chain arms --fail-on-ungranted on the reconciliation step, which is the whole point", () => {
  const steps = chainSteps({ candidates: "C:/tmp/candidates.json", remaining: "C:/tmp/remaining.json" });
  assert.deepEqual(
    steps.map((step) => step.name),
    ["candidates", "remaining", "observation_gap"],
  );
  const last = steps.at(-1).args;
  assert.ok(last.includes("--fail-on-ungranted"), "the reconciliation step must pass the flag");
  assert.ok(last.includes("--remaining"), "the method-layer tiers only exist in the remaining report");
  assert.ok(last.includes(DECOMPILED_ROOT), "the decompiled tree is the source of every section");
  assert.ok(last.includes(CAPABILITY_CATALOG), "the catalog is a required input of the analyzer's CLI");
  assert.ok(steps[0].args.includes("--action-register"), "the candidates step needs the native seam register");
});

test("the three named inputs are the ones the skip message names", () => {
  assert.deepEqual(
    [...REQUIRED_INPUTS],
    [
      DECOMPILED_ROOT,
      "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
      CAPABILITY_CATALOG,
    ],
  );
  assert.deepEqual(missingInputs({ exists: () => true }), []);
  assert.deepEqual(missingInputs({ exists: (path) => path === CAPABILITY_CATALOG }), [
    DECOMPILED_ROOT,
    REQUIRED_INPUTS[1],
  ]);
});

test("without the decompiled tree the gate SKIPS with a named reason and runs no step at all", () => {
  let ran = false;
  const result = runObservationGap({
    exists: () => false,
    run: () => {
      ran = true;
      return okRun([]);
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(ran, false, "an unmeasurable tree must not start a 16 s analysis");
  assert.ok(result.missing.includes(DECOMPILED_ROOT));
});

test("a failing step stops the chain, names the step, and leaves the cause in the gate's own words", () => {
  const removed = [];
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: (dir) => removed.push(dir),
    run: (args) =>
      args.some((arg) => arg.includes("stardew-remaining-actions-report.mjs"))
        ? { status: 1, stdout: "", stderr: "remaining_report_invalid:missing_tiers\n" }
        : okRun(args),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "remaining");
  assert.match(result.cause, /remaining_report_invalid:missing_tiers/u);
  assert.deepEqual(removed, ["C:/tmp/observation-gap"], "the temp directory is removed on the failing path too");
});

test("a chain that exits 0 without the analyzer's observation summary is a FAILURE, not a pass", () => {
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      okRun(args, {
        stdout: args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs"))
          ? '{"state":"written"}\n'
          : "",
      }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "observation_gap");
  assert.match(result.cause, /without printing its observation summary/u);
});

test("a failing cause names the findings that failed it, even when they print after the section lines", () => {
  // The analyzer prints one line per section and then the findings that failed the run, so a head-only excerpt of a
  // failing run reported the section counts and cut the verdict - the reader got "3 undeclared" and no member.
  const stderr = [
    "observation gaps: 122 engine collections",
    ...Array.from({ length: 20 }, (_, index) => `  ${index} section   1 measured, 2 kept`),
    "  mutation_not_observable:collect_crab_pot_output:CurrentToolIndex: collect_crab_pot_output assigns `player.CurrentToolIndex`",
    "  mutation_not_observable:talk_to_npc:CurrentToolIndex: talk_to_npc assigns `Game1.player.CurrentToolIndex`",
    "  2 ungranted observation gap(s)",
    "",
  ].join("\n");
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs"))
        ? { status: 1, stdout: "", stderr }
        : okRun(args),
  });
  assert.equal(result.status, "failed");
  assert.match(result.cause, /observation gaps: 122 engine collections/u, "the head of the run is still shown");
  assert.match(result.cause, /mutation_not_observable:talk_to_npc:CurrentToolIndex/u, "the verdict names its members");
  assert.match(result.cause, /2 ungranted observation gap\(s\)/u);
  assert.match(result.cause, /line\(s\) omitted/u, "the elision is stated rather than silent");
});

test("a measured run carries the summary the analyzer printed, and every step's exit code", () => {
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      okRun(args, {
        stderr: args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs")) ? SUMMARY : "",
      }),
  });
  assert.equal(result.status, "measured");
  assert.match(result.summary, /^observation gaps: 122 engine collections/mu);
  assert.deepEqual(
    result.steps.map((step) => [step.name, step.exitCode]),
    [
      ["candidates", 0],
      ["remaining", 0],
      ["observation_gap", 0],
    ],
  );
});
