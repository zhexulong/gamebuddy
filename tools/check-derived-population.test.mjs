import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditDerivedPopulation, byFile } from "./check-derived-population.mjs";
import { describeMemberDiff, memberDiff } from "./lib/member-diff.mjs";

// red-proof: inject  `assert.equal(list.length, 15)` into a test file -> `literal_population_assertion:
//            <file>:2:15 - use list.length or assert.deepEqual(...)` (see "a frozen count beside a derived
//            population is named with the file, the line and the literal" below).
//
// Also injected, each seen red once (this file): a literal on the left of the assertion, a bare
// `list.length === 15`, two derived sides reported as a literal, every file in a directory treated as a
// test, an unsorted member diff, an empty population treated as a pass, and a raw-text sweep in place of
// the syntax tree - which names the defect inside a comment and a string.
//
// PROVENANCE - the four instances that named this class, all measured on 2026-11-05:
//
//   `expected 28 to equal 15`  a test froze "15 registered seams that all nine predicates reject"; the
//                              authority held 28, and the failure could not say which thirteen arrived.
//   `13 -> 15`                 a frozen key table grew by two keys; the assertion compared lengths.
//   `66 of 68`                 a legal growth became 67 of 69, and the message quoted a numerator whose
//                              denominator it could not name.
//   `advance_day -> sleep`     an action was renamed and the assertion still spelled the old name, so the
//                              report was a count mismatch about a set nobody could see.
//
// The last one is exactly what `describeMemberDiff` prints, and the third test below pins that output.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-derived-population.mjs");

/** A throwaway tree written at the real relative paths, so the scope rules are the product's own. */
async function withFixtureRoot(specs, run) {
  const root = mkdtempSync(join(tmpdir(), "derived-population-"));
  try {
    for (const [relativePath, contents] of Object.entries(specs)) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One host test file whose body is the shape under test, so the line number is known. */
const hostTest = (body) => [`test("x", () => {`, `  ${body}`, `});`, ""].join("\n");

const reading = (specs) => withFixtureRoot(specs, (root) => auditDerivedPopulation({ root }));

const messages = (violations) => violations.map((violation) => violation.message);

test("a frozen count beside a derived population is named with the file, the line and the literal", async () => {
  const { examined, violations } = await reading({
    "host/src/seams.test.ts": hostTest("assert.equal(list.length, 15);"),
  });
  assert.equal(examined, 1);
  assert.deepEqual(messages(violations), [
    "literal_population_assertion:host/src/seams.test.ts:2:15 — use list.length or " +
      "assert.deepEqual(new Set(actual), new Set(AUTHORITY))",
  ]);
  assert.equal(violations[0].code, "literal_population_assertion");
  assert.equal(violations[0].line, 2);
  assert.equal(violations[0].literal, "15");
  assert.equal(violations[0].authority, "list");
  assert.match(violations[0].hint, /describeMemberDiff\("list", actual, AUTHORITY\)/u);
});

test("two derived sides are an authority comparison, not a frozen count", async () => {
  const { violations } = await reading({
    "host/src/seams.test.ts": hostTest(
      [
        "assert.equal(list.length, AUTHORITY.length);",
        "assert.strictEqual(snapshot.seams.length, registeredSeams.length);",
      ].join("\n  "),
    ),
  });
  assert.deepEqual(violations, []);
});

test("the literal on the left of the assertion is the same violation", async () => {
  const { violations } = await reading({
    "host/src/keys.test.ts": hostTest("assert.strictEqual(13, FROZEN_KEYS.length);"),
  });
  assert.deepEqual(messages(violations), [
    "literal_population_assertion:host/src/keys.test.ts:2:13 — use FROZEN_KEYS.length or " +
      "assert.deepEqual(new Set(actual), new Set(AUTHORITY))",
  ]);
});

test("a bare length comparison is the same violation, and extra assertion arguments do not hide it", async () => {
  const { violations } = await reading({
    "host/src/seams.test.ts": [
      `test("x", () => {`,
      `  if (list.length === 15) return;`,
      `  assert.equal(list.length, 15, "the seam table");`,
      `});`,
      "",
    ].join("\n"),
  });
  assert.deepEqual(
    violations.map((violation) => [violation.line, violation.operator, violation.literal]),
    [
      [2, "===", "15"],
      [3, "equal", "15"],
    ],
  );
});

test("the defect spelled in a comment or a string is prose, not code", async () => {
  const { examined, violations } = await reading({
    "host/src/seams.test.ts": [
      `// was assert.equal(list.length, 15) until the table grew`,
      `test("x", () => {`,
      '  const spelled = "assert.equal(list.length, 15)";',
      "  assert.equal(spelled.length, 30);",
      "});",
      "",
    ].join("\n"),
  });
  assert.equal(examined, 1);
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [4],
  );
});

test("production files and test support are outside the population", async () => {
  const { examined, violations } = await reading({
    "host/src/seams.ts": "export const seams = (): number => list.length === 15 ? 1 : 0;\n",
    "host/src/seams.test-support.ts": "export const bad = (): boolean => list.length === 15;\n",
    "host/src/seams.test.ts": hostTest("assert.equal(list.length, AUTHORITY.length);"),
    "integrations/stardew/action-development/fixtures/gone.test.mjs": "assert.equal(list.length, 15);\n",
    "integrations/stardew/action-development/tests/seams.test.mjs": "assert.equal(list.length, 15);\n",
  });
  assert.equal(examined, 2);
  assert.deepEqual(messages(violations), [
    "literal_population_assertion:integrations/stardew/action-development/tests/seams.test.mjs:1:15 — " +
      "use list.length or assert.deepEqual(new Set(actual), new Set(AUTHORITY))",
  ]);
});

test("the primitive names the members that arrived and the ones that went missing", () => {
  assert.deepEqual(memberDiff([1, 2], [2, 3]), { added: ["1"], missing: ["3"] });
  assert.deepEqual(describeMemberDiff("", [1, 2], [2, 3]), "+ newly added: [1]\n- missing: [3]");
  // The fourth instance: a rename reports the new name and the old one, not "expected 1, got 1".
  assert.deepEqual(
    describeMemberDiff("", ["advance_day"], ["sleep"]),
    "+ newly added: [advance_day]\n- missing: [sleep]",
  );
  // Sorted by code unit and labelled, with no empty side printed.
  assert.equal(describeMemberDiff("", ["b", "a"], []), "+ newly added: [a, b]");
  assert.equal(describeMemberDiff("registered seams", ["a", "b"], []), "registered seams\n+ newly added: [a, b]");
  assert.equal(describeMemberDiff("registered seams", ["a"], ["a"]), "");
  assert.deepEqual(memberDiff(["a", "a"], []), { added: ["a"], missing: [] });
});

test("a tree with no test file at all is blocked, not passed", () => {
  const root = mkdtempSync(join(tmpdir(), "derived-population-empty-"));
  try {
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /derived_population examined 0 violations 0 unread 0 status blocked/u);
    assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).status, "blocked");
    assert.match(result.stderr, /no test file was examined, so nothing can be judged/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI prints examined N and names the violation it found", async () => {
  await withFixtureRoot(
    {
      "host/src/seams.test.ts": hostTest("assert.equal(list.length, 15);"),
      "dialogue-web/tests/seams.spec.ts": 'test("y", () => {\n  expect(list.length).toBe(2);\n});\n',
    },
    (root) => {
      const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /derived_population examined 2 violations 1 unread 0 status failed/u);
      assert.match(result.stdout, /host\/src\/seams\.test\.ts: 1$/mu);
      assert.match(result.stderr, /literal_population_assertion:host\/src\/seams\.test\.ts:2:15/u);
      const reading = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.deepEqual(Object.keys(reading), ["gate", "examined", "violations", "unparsed", "status"]);
      assert.equal(reading.gate, "derived-population");
      assert.equal(reading.examined, 2);
    },
  );
});

test("the per-file counts are what a lane receives", () => {
  assert.deepEqual(
    byFile([
      { file: "a.test.ts", line: 2 },
      { file: "b.test.ts", line: 3 },
      { file: "a.test.ts", line: 9 },
    ]),
    [
      ["a.test.ts", 2],
      ["b.test.ts", 1],
    ],
  );
});
