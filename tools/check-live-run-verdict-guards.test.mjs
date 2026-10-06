import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findAbsencePassBranches } from "./check-live-run-verdict-guards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(here, "check-live-run-verdict-guards.mjs");

async function withFixture(source, run) {
  const root = await mkdtemp(join(tmpdir(), "verdict-guard-"));
  try {
    await mkdir(join(root, "game"), { recursive: true });
    await writeFile(join(root, "game", "runner.mjs"), source, "utf8");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the guard catches the exact shape that let the ladder pass without a persona", async () => {
  // The pre-fix code, verbatim in shape: a disposable root has no expectation, so
  // the gate passed without observing anything (measured 2026-10-06, a58a4386).
  const preFix = [
    "const personaWorldBook = await readAssembledContextEvidence(paths);",
    "const contentGate = personaWorldBook.contentGate ?? null;",
    "const contentPassed =",
    "  contentGate === null || contentGate.profileRead !== true",
    "    ? true",
    "    : contentGate.personaPresent;",
    "",
  ].join("\n");
  await withFixture(preFix, async (root) => {
    const findings = findAbsencePassBranches({ root });
    assert.equal(findings.length, 1, "the unfixed branch must be reported");
    assert.equal(findings[0].line, 5);
    assert.match(findings[0].snippet, /\?\s*true/);
    // And the CLI must fail, not merely print.
    const result = spawnSync(process.execPath, [CHECKER, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1, "the checker must exit non-zero on a real finding");
    assert.match(result.stdout, /absence-as-pass branch/);
  });
});

test("a verdict-vocabulary form and a named exception are both accepted", async () => {
  const fixed = [
    'import { isPass, judgeExpectation } from "../core/evidence-verdict.mjs";',
    "const contentVerdict = judgeExpectation({ expectation: expectedProfile, observed: contentGate?.profileRead === true, ok: contentGate?.personaPresent === true });",
    "const contentPassed = isPass(contentVerdict);",
    "// absence-as-pass: only the active ladder rung is judged, see LADDER guards below",
    "const ladderOnePassed = LADDER === \"1\" ? walkReceipt !== undefined : true;",
    "",
  ].join("\n");
  await withFixture(fixed, async (root) => {
    assert.deepEqual(findAbsencePassBranches({ root }), []);
    const result = spawnSync(process.execPath, [CHECKER, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, "the checker must pass a documented exception");
  });
});

test("the marker requires a reason - a bare marker is not an exception", async () => {
  const bare = [
    "// absence-as-pass:",
    "const contentPassed = expectation === null ? true : observed;",
    "",
  ].join("\n");
  await withFixture(bare, async (root) => {
    assert.equal(findAbsencePassBranches({ root }).length, 1, "a reasonless marker must not exempt the branch");
  });
});

test("the repository itself has no undocumented absence-as-pass branch", () => {
  const findings = findAbsencePassBranches({ root: join(here, "live-run") });
  assert.deepEqual(
    findings,
    [],
    `fix with evidence-verdict.mjs or declare the exception: ${findings.map((f) => `${f.file}:${f.line}`).join(", ")}`,
  );
});
