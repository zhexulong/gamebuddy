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
    // Two lines, and both are load-bearing: the absence TEST (line 4) and the absence VALUE (line 5). The
    // disjunction rule was added after a real `x === null || x.passed` survived the two earlier rules.
    assert.deepEqual(
      findings.map((finding) => ({ line: finding.line, kind: finding.kind })),
      [
        { line: 4, kind: "absence_by_disjunction" },
        { line: 5, kind: "absence_default_true" },
      ],
      "both halves of the judgement must be reported",
    );
    assert.match(findings[1].snippet, /\?\s*true/);
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
  const findings = findAbsencePassBranches({ root: join(here, "..", "tools") });
  assert.deepEqual(
    findings,
    [],
    `fix with evidence-verdict.mjs or declare the exception: ${findings.map((f) => `${f.file}:${f.line}`).join(", ")}`,
  );
});

test("the mirror spelling `A ? B : true` is caught, and an object field named true is not", async () => {
  // The first version of this guard only matched `? true`, so it missed
  // `worldBookPassed = gate.expected === true ? gate.assembled === true : true` -
  // the canonical absence-as-pass form, which then stayed in the tree while the
  // guard reported zero findings (measured 2026-10-06). Both spellings must be
  // caught, and an object FIELD named `true` must not become a false positive.
  const mirror = "const worldBookPassed = worldBookGate.expected === true ? worldBookGate.assembled === true : true;\n";
  await withFixture(mirror, async (root) => {
    const findings = findAbsencePassBranches({ root });
    assert.equal(findings.length, 1, "the `: true` alternate must be reported");
    assert.match(findings[0].snippet, /:\s*true/);
  });

  const named = `// absence-as-pass: the product has no world book configured at all\n${mirror}`;
  await withFixture(named, async (root) => {
    assert.deepEqual(findAbsencePassBranches({ root }), [], "a named absence is allowed");
  });

  const objectField = "const merged = { ...(assistantShell ? { assistantShell: true } : {}) };\n";
  await withFixture(objectField, async (root) => {
    assert.deepEqual(findAbsencePassBranches({ root }), [], "an object field named true is not a verdict");
  });
});

test("a camelCase pass identifier is not skipped", async () => {
  // The first version matched `\bpassed`, and camelCase has a word character before
  // `Passed` (`ladderZeroPassed`), so real absence-as-pass branches were silently
  // skipped while the guard reported zero findings - it missed exactly the two
  // defects it was written for (measured 2026-10-06, found by mutation testing this
  // guard against the tree). A guard that skips its targets is the disease.
  const camel = [
    "const worldBookPassed = worldBookGate.expected === true ? worldBookGate.assembled === true : true;",
    "",
  ].join("\n");
  await withFixture(camel, async (root) => {
    assert.equal(findAbsencePassBranches({ root }).length, 1, "camelCase `...Passed` must be examined");
  });
  const camelNoShape = "const ladderZeroPassed = computeSomethingElse();\n";
  await withFixture(camelNoShape, async (root) => {
    assert.deepEqual(findAbsencePassBranches({ root }), [], "a plain call is not an absence-as-pass branch");
  });
});


test("a pass-shaped name that is true when its observation is ABSENT is reported", async () => {
  // The third spelling: a disjunction whose absence branch makes a pass-shaped name true. Measured in the game
  // ladder: `const interactionPassed = interactionAssessment === null || interactionAssessment.passed;` — a
  // boolean that cannot tell "assessed and fine" from "nobody assessed it".
  const root = await mkdtemp(join(tmpdir(), "verdict-guard-disjunction-"));
  try {
    await writeFile(
      join(root, "gate.mjs"),
      [
        "export function decide(interactionAssessment) {",
        "  const interactionPassed = interactionAssessment === null || interactionAssessment.passed;",
        "  return interactionPassed;",
        "}",
        "",
      ].join("\n"),
    );
    const findings = findAbsencePassBranches({ root });
    assert.equal(findings.length, 1, "the disjunction form must be reported");
    assert.equal(findings[0].kind, "absence_by_disjunction");
    assert.match(findings[0].snippet, /=== null \|\|/);

    // A non-absence disjunction is ordinary logic, not this shape: the rule is about ABSENCE, not about `||`.
    await writeFile(
      join(root, "ordinary.mjs"),
      ['export function decide(state) {', '  const passed = state === "ok" || state === "done";', "  return passed;", "}"].join("\n"),
    );
    const afterOrdinary = findAbsencePassBranches({ root });
    assert.equal(afterOrdinary.length, 1, "an ordinary || must not be reported");
    assert.match(afterOrdinary[0].snippet, /interactionAssessment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
