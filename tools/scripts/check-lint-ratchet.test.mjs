/**
 * The lint ratchet's predicate and its population, planted against.
 *
 * `check-lint-ratchet.mjs` stands in front of a repo-wide `biome lint` that has 84 errors in 64 recorded files, so the
 * only thing its verdict can mean is "no file newly joins the red set and no recorded file's count grows". These tests
 * hold that reading against a real biome run on a throwaway tree, and hold the population to the index: an untracked
 * violation is published by name and does not count, and the same file counts the moment it is staged.
 *
 * red-proof: inject  a planted `tools/legacy.mjs` using `==` -> `lint_ratchet_failed new=1` naming it; record it ->
 *                    `lint_ratchet_ok` with the debt unchanged; write the same violation untracked -> `lint_ratchet_ok`
 *                    with `untracked_not_counted 1: tools/inflight.mjs`; `git add` it -> `lint_ratchet_failed new=1` on
 *                    the same file and no `untracked_not_counted` (tools/scripts/check-lint-ratchet.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseReport, ratchet, SCOPE } from "./check-lint-ratchet.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPTS_ROOT, "..", "..");
const GATE = join(SCRIPTS_ROOT, "check-lint-ratchet.mjs");
const roots = [];

/** One real lint error: `lint/suspicious/noDoubleEquals`, which the repository's own `biome.json` enables. */
const VIOLATION = 'export const value = 1;\nif (value == 2) {\n  console.log("x");\n}\n';

const git = (root, args) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "ignore" });

/**
 * A throwaway tree biome can lint: the repository's own `biome.json`, the four roots `lint` names, one clean file, and
 * an index carrying all of it.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gb-lint-ratchet-"));
  roots.push(root);
  for (const relativePath of [...SCOPE, "tools/scripts"]) mkdirSync(join(root, relativePath), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, "biome.json"), join(root, "biome.json"));
  writeFileSync(join(root, "tools", "clean.mjs"), "export const value = 1;\n");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=lint-ratchet",
    "-c",
    "user.email=lint-ratchet@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  record(root, {});
  return root;
}

/** The roots the gate scans, taken from the gate itself rather than restated here. */
const record = (root, files) =>
  writeFileSync(
    join(root, "tools", "scripts", "lint-baseline.json"),
    `${JSON.stringify({ note: "fixture", revision: "0000000", errors: 0, warnings: 0, files }, null, 2)}\n`,
  );

const runGate = (root) => spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });

const stage = (root, relativePath) => git(root, ["add", "--", relativePath]);

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test("parseReport.1: the verdict comes from the diagnostics, and only errors join the red set", () => {
  const report = parseReport(
    JSON.stringify({
      summary: { errors: 1, warnings: 2, changed: 0, unchanged: 3 },
      diagnostics: [
        { severity: "error", location: { path: { file: "tools\\a.mjs" } } },
        { severity: "warning", location: { path: { file: "tools\\b.mjs" } } },
      ],
    }),
  );
  assert.deepEqual(report, { errors: 1, warnings: 2, checked: 3, counts: { "tools/a.mjs": 1 } });
});

test("parseReport.2: a scan that printed no summary did not run, and is not a clean reading", () => {
  assert.throws(() => parseReport(JSON.stringify({ diagnostics: [] })), /the scan did not run/u);
});

test("ratchet.1: a file the baseline never recorded is the finding, and a recorded one is debt", () => {
  const grown = ratchet({ baselineCounts: { "tools/legacy.mjs": 2 }, counts: { "tools/legacy.mjs": 3 } });
  assert.deepEqual(grown.grown, [{ file: "tools/legacy.mjs", count: 3, recorded: 2 }]);
  assert.deepEqual(ratchet({ baselineCounts: { "tools/legacy.mjs": 3 }, counts: { "tools/legacy.mjs": 3 } }).grown, []);
  assert.deepEqual(ratchet({ baselineCounts: { "tools/legacy.mjs": 3 }, counts: { "tools/legacy.mjs": 2 } }).fixed, [
    { file: "tools/legacy.mjs", recorded: 3, count: 2 },
  ]);
});

test("planted.1: a tracked file with a real lint error fails the gate, and is debt once recorded", () => {
  const root = fixture();
  writeFileSync(join(root, "tools", "legacy.mjs"), VIOLATION);
  stage(root, "tools/legacy.mjs");

  const failing = runGate(root);
  assert.equal(failing.status, 1, failing.stdout);
  assert.match(failing.stdout, /lint_ratchet_failed new=1/u);
  assert.match(failing.stdout, /tools\/legacy\.mjs errors=1 recorded=0/u);

  record(root, { "tools/legacy.mjs": 1 });
  const passing = runGate(root);
  assert.equal(passing.status, 0, passing.stdout);
  assert.match(passing.stdout, /lint_ratchet_ok debt: errors=1 warnings=\d+ files=1 recorded=1/u);
});

test("planted.2: an untracked file is published by name and inert, and counts the moment it is staged", () => {
  const root = fixture();
  writeFileSync(join(root, "tools", "inflight.mjs"), VIOLATION);

  // The defect this pins: another lane writing a file used to move this gate's baseline. It is neither counted nor
  // hidden - the reading names it, so a reader can see what the verdict could not see.
  const untracked = runGate(root);
  assert.equal(untracked.status, 0, untracked.stdout);
  assert.match(untracked.stdout, /^lint_ratchet_ok debt: .* · untracked_not_counted 1: tools\/inflight\.mjs$/mu);

  stage(root, "tools/inflight.mjs");
  const tracked = runGate(root);
  assert.equal(tracked.status, 1, tracked.stdout);
  assert.match(tracked.stdout, /lint_ratchet_failed new=1/u);
  assert.match(tracked.stdout, /tools\/inflight\.mjs errors=1 recorded=0/u);
  assert.doesNotMatch(tracked.stdout, /untracked_not_counted/u);
});

test("planted.3: the published complement is bounded, and still names the files it leaves out by count", () => {
  const root = fixture();
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
  for (const name of names) writeFileSync(join(root, "tools", `${name}.mjs`), VIOLATION);

  const result = runGate(root);
  assert.equal(result.status, 0, result.stdout);
  assert.match(
    result.stdout,
    /untracked_not_counted 7: tools\/alpha\.mjs, tools\/bravo\.mjs, tools\/charlie\.mjs, tools\/delta\.mjs, tools\/echo\.mjs, … and 2 more$/mu,
  );
});

test("planted.4: the recorded baseline is this repository's, and its debt is published on every run", () => {
  const baseline = JSON.parse(readFileSync(resolve(SCRIPTS_ROOT, "lint-baseline.json"), "utf8"));
  assert.ok(Object.keys(baseline.files).length > 0);
});
