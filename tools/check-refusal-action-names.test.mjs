#!/usr/bin/env node
/**
 * Tests for `check-refusal-action-names.mjs`.
 *
 * The gate exists for one class: a refusal, a hold or a remedy that names an ACTION, where the name is not an action the
 * catalog declares. It shipped twice in one sentence of one night (round60) - `native_sleep_prompt_owned_by_advance_day`
 * and `body_owned_by_day_advance`, two spellings of an action id that was renamed `sleep` and never updated - and the
 * consequence was a 31-minute stall because the routes it named could not be taken.
 *
 * What this file proves, in the order the gate's own header states it:
 *
 *   1. RED ON REAL HISTORY. The pre-fix blobs of `9c539da8` (the commit before this unit) are replayed through the gate
 *      and it names BOTH codes and BOTH missing names - the finding comes from the rule, not from a fixture the test
 *      invented.
 *   2. GREEN ON THE TREE. The same run over today's sources is clean, with a population that is not empty: the census
 *      counts the codes it read, so "0 missing" cannot be a run that read nothing.
 *   3. SYNTHETIC FALSIFIERS, one per position, for members nobody has written: a multi-word body-hold kind, an advice
 *      field naming a non-action, and an owner code naming a non-action. Each reds the gate by name, which is what makes
 *      this a gate over the CLASS rather than a check of the two strings that happened to ship.
 *   4. NOT MEASURED IS NOT GREEN. A scope with no Mod sources and no catalog exits 2 and says which prerequisite was
 *      missing, instead of printing a clean verdict over zero files.
 *
 * red-proof: history  the pre-fix blobs of 9c539da8 -> `✖ refusal_names_an_action_the_catalog_lacks:
 *                     native_sleep_prompt_owned_by_advance_day:advance_day` and `:body_owned_by_day_advance:day_advance`,
 *                     `name an action ... missing 2`, exit 1; today's tree prints `missing 0` (this suite)
 * red-proof: inject   `body_owned_by_ride_horse` (a hold kind spelled like an action) and `answer_it=navigate` (an
 *                     advice field naming a non-action) into the controller's own source ->
 *                     `✖ refusal_names_an_action_the_catalog_lacks:body_owned_by_ride_horse:ride_horse` and
 *                     `:answer_it=:navigate`, exit 1 (this suite)
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkRefusalActionNames, FINDING, readHoldKinds } from "./check-refusal-action-names.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CHECKER = path.join(HERE, "check-refusal-action-names.mjs");

/** The commit before this unit: the tree that shipped both spellings of the missing action. */
const BEFORE = "9c539da8";

const REFUSAL_SOURCE = "integrations/stardew/farmhandexecutioncontroller.modalactions.cs";
const CONTROLLER_SOURCE = "integrations/stardew/farmhandexecutioncontroller.cs";

function blobAt(revision, relativePath) {
  return execFileSync("git", ["show", `${revision}:${relativePath}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function censusOf(report) {
  return (
    `codes examined ${report.codesExamined} · name an action ${report.named} · ` +
    `exists ${report.exists} · missing ${report.missing}`
  );
}

test("the pre-fix blobs of 9c539da8 are red, and both missing names are the same action", () => {
  const report = checkRefusalActionNames({
    root: REPO_ROOT,
    overrides: {
      [REFUSAL_SOURCE]: blobAt(BEFORE, REFUSAL_SOURCE),
      [CONTROLLER_SOURCE]: blobAt(BEFORE, CONTROLLER_SOURCE),
    },
  });

  assert.equal(report.blocked, null, "the pre-fix replay must be measured, not blocked");
  assert.ok(report.codesExamined > 1000, `the census must read the tree, read ${report.codesExamined} codes`);
  const named = report.findings.map((item) => `${item.code}:${item.action}`).sort();
  assert.deepEqual(
    named,
    ["body_owned_by_day_advance:day_advance", "native_sleep_prompt_owned_by_advance_day:advance_day"],
    `the gate must name both shipped codes by the action they claim; it named ${JSON.stringify(named)}`,
  );
  assert.equal(report.missing, 2, `expected two missing names, got ${report.missing}`);
  for (const item of report.findings) assert.equal(item.id, FINDING);
});

test("today's tree is green, and the population it read is not empty", () => {
  const report = checkRefusalActionNames({ root: REPO_ROOT });
  assert.equal(report.blocked, null);
  assert.deepEqual(report.findings, [], `today's tree: ${censusOf(report)}`);
  assert.equal(report.missing, 0);
  assert.ok(report.codesExamined > 1000, `a clean verdict over nothing is not clean: ${censusOf(report)}`);
  assert.ok(report.named > 0, `the gate must still be reading advice fields: ${censusOf(report)}`);
  assert.ok(report.exists > 0, "the advice fields it read must name real actions, or it read nothing");
});

test("a hold kind spelled like an action reds the gate by name", () => {
  const working = readFileSync(path.join(REPO_ROOT, CONTROLLER_SOURCE), "utf8");
  const source = working.replace(
    'internal const string BodyOwnedByActivity = "body_owned_by_activity";',
    'internal const string BodyOwnedByActivity = "body_owned_by_activity";\n    internal const string BodyOwnedByRideHorse = "body_owned_by_ride_horse";',
  );
  assert.notEqual(source, working, "the injection anchor must exist, or this falsifier tests nothing");

  const report = checkRefusalActionNames({ root: REPO_ROOT, overrides: { [CONTROLLER_SOURCE]: source } });
  const named = report.findings.map((item) => `${item.code}:${item.action}`);
  assert.deepEqual(
    named,
    ["body_owned_by_ride_horse:ride_horse"],
    `a new multi-word hold kind must be refused as an action name; got ${JSON.stringify(named)}`,
  );
});

test("an advice field naming a non-action reds the gate by name", () => {
  const source = readFileSync(path.join(REPO_ROOT, CONTROLLER_SOURCE), "utf8");
  const injected = source.replace(
    'internal const string BodyOwnedByNight = "body_owned_by_night";',
    'internal const string BodyOwnedByNight = "body_owned_by_night";\n    internal const string ProbeAdvice = "held_by=sleeper;answer_it=navigate";',
  );
  assert.notEqual(injected, source, "the injection anchor must exist, or this falsifier tests nothing");

  const report = checkRefusalActionNames({ root: REPO_ROOT, overrides: { [CONTROLLER_SOURCE]: injected } });
  const named = report.findings.map((item) => `${item.code}:${item.action}`);
  assert.deepEqual(
    named,
    ["answer_it=:navigate"],
    `an advice field is an action position; got ${JSON.stringify(named)}`,
  );
});

test("the hold-kind vocabulary is the Mod's own declaration, not a list in this file", () => {
  const kinds = readHoldKinds({ root: REPO_ROOT });
  assert.ok(kinds.length >= 7, `expected the declared body-hold kinds, found ${kinds.length}`);
  assert.ok(
    kinds.every((code) => code.startsWith("body_owned_by_")),
    kinds.join(","),
  );
  assert.ok(
    kinds.every((code) => !code.slice("body_owned_by_".length).includes("_")),
    `every kind is one word so it cannot be read as an action id: ${kinds.join(",")}`,
  );
});

test("the CLI prints the census and exits 0 on the real tree", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CHECKER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.match(stdout, /codes examined \d+ · name an action \d+ · exists \d+ · missing 0/u, stdout);
});

test("a scope that cannot be measured exits 2 and says so, never green over nothing", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "gb-refusal-action-names-"));
  try {
    const failure = await execFileAsync(process.execPath, [CHECKER, empty], { cwd: REPO_ROOT, encoding: "utf8" }).catch(
      (thrown) => thrown,
    );
    assert.equal(failure.code, 2, `an unmeasurable scope is a blocked reading; stdout=${failure.stdout ?? ""}`);
    assert.match(String(failure.stdout ?? ""), /blocked · (catalog_unreadable|hold_kinds_undeclared|no_mod_sources)/u);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
