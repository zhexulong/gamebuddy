import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { auditLooseAssertions } from "./check-loose-assertions.mjs";

// red-proof: inject  a module-level `expect(...)` in a real spec-shaped tree -> `assertion_runs_at_import`
//                    naming that file:line, while the helper assertions in the same tree stay green
//                    ("an assertion at module level runs at import" below). Also injected: an `expect(...)`
//                    in a helper no test calls (`assertion_in_an_unreached_function`), one at the top of a
//                    `describe` body and one in a helper only module code calls (both
//                    `assertion_runs_at_import`), a `node:assert` call read through the spec's own import,
//                    a spec the grammar cannot parse (`journey_not_parsed`), and a corpus with no assertion
//                    at all (exit 2, `examined 0`, never a pass).

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-loose-assertions.mjs");
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

/** One synthetic checkout holding `dialogue-web/tests` and the specs the case asks for. */
function makeTree(specs) {
  const root = mkdtempSync(join(tmpdir(), "loose-assertions-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(specs)) {
    const full = join(root, "dialogue-web", "tests", name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

const codes = (reading) => reading.findings.map((finding) => `${finding.code}:${finding.file.split("/").at(-1)}`);

/** Every assertion carries exactly one verdict, so the report's counts and its population cannot disagree. */
function assertEveryAssertionClassified(reading) {
  assert.equal(
    reading.assertions.length,
    reading.examined,
    `${reading.assertions.length} assertions carry a verdict but the report says examined=${reading.examined}`,
  );
  const counts = reading.assertions.length;
  const classified = reading.assertions.filter(
    (assertion) =>
      assertion.verdict === "in_a_test" ||
      assertion.verdict === "in_a_reachable_helper" ||
      assertion.verdict === "runs_at_import" ||
      assertion.verdict === "unreached",
  ).length;
  assert.equal(classified, counts, `${counts - classified} assertion(s) carry no verdict`);
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("an assertion at module level runs at import", async () => {
  const root = makeTree({
    "module-level.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      "const FIXTURES = 2;",
      'expect(FIXTURES, "an injected module-level assertion").toBeGreaterThan(0);',
      "",
      "async function openSurface(page) {",
      '  await expect(page.locator("#surface")).toBeVisible();',
      "}",
      "",
      'test("a journey", async ({ page }) => {',
      "  await openSurface(page);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(codes(reading), ["assertion_runs_at_import:module-level.spec.ts"]);
  // The other assertion in the same file is inside a helper the test calls, so it stays green and is
  // named as such rather than folded into the finding.
  const helper = reading.assertions.find((assertion) => assertion.verdict === "in_a_reachable_helper");
  assert.equal(helper?.line, 7);
  assertEveryAssertionClassified(reading);
});

test("an assertion in a function no test reaches", async () => {
  const root = makeTree({
    "dead-helper.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      "async function openSurface(page) {",
      '  await expect(page.locator("#surface")).toBeVisible();',
      "}",
      "",
      "async function neverMounted(page) {",
      '  expect(await page.locator("#ghost").count(), "a claim nothing grades").toBe(0);',
      "}",
      "",
      'test("a journey", async ({ page }) => {',
      "  await openSurface(page);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(codes(reading), ["assertion_in_an_unreached_function:dead-helper.spec.ts"]);
  assert.equal(reading.findings[0].line, 8);
  assert.match(reading.findings[0].detail, /`neverMounted` is never called/u);
  assertEveryAssertionClassified(reading);
});

test("an assertion in a helper a test calls is attributed to that test", async () => {
  const root = makeTree({
    "called-helper.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      "async function openSurface(page) {",
      '  await expect(page.locator("#surface")).toBeVisible();',
      "}",
      "",
      'test("a journey", async ({ page }) => {',
      "  await openSurface(page);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.assertions[0].verdict, "in_a_reachable_helper");
});

test("a callback a helper hands to the page is reached, because a live call delivers it a body", async () => {
  const root = makeTree({
    "route-callback.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      "async function stubRoutes(page) {",
      '  await page.route("**/api/tavern/v1/draft", async (route) => {',
      '    expect(route.request().method(), "the draft is written with a PUT").toBe("PUT");',
      '    return await route.fulfill({ status: 200, body: "{}" });',
      "  });",
      "}",
      "",
      'test("a journey", async ({ page }) => {',
      "  await stubRoutes(page);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.assertions[0].verdict, "in_a_reachable_helper");
});

test("an assertion in a describe body has no test name either", async () => {
  const root = makeTree({
    "describe-body.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      'test.describe("a group", () => {',
      '  expect(1, "an injected assertion at the top of a describe body").toBe(1);',
      "",
      '  test("a journey", async () => {',
      "    expect(2).toBe(2);",
      "  });",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(codes(reading), ["assertion_runs_at_import:describe-body.spec.ts"]);
  assert.equal(reading.findings[0].line, 4);
  assert.match(reading.findings[0].detail, /while Playwright collects the file/u);
  // The nested test's own assertion is inside a test, so the group is not the whole story.
  assert.equal(reading.assertions.filter((assertion) => assertion.verdict === "in_a_test").length, 1);
  assertEveryAssertionClassified(reading);
});

test("a helper only module-level code calls runs before any test, not inside one", async () => {
  const root = makeTree({
    "import-time-helper.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      "function fixturesAreUsable(records) {",
      '  expect(records.length, "the fixtures really carry a record").toBeGreaterThan(0);',
      "}",
      "",
      "const RECORDS = [{ id: 1 }];",
      "fixturesAreUsable(RECORDS);",
      "",
      'test("a journey", async () => {',
      "  expect(RECORDS.length).toBe(1);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(codes(reading), ["assertion_runs_at_import:import-time-helper.spec.ts"]);
  assert.equal(reading.findings[0].line, 4);
  assert.match(reading.findings[0].detail, /`fixturesAreUsable` is called from module-level code/u);
});

test("a node:assert call is read through the spec's own import, in both scopes", async () => {
  const root = makeTree({
    "node-assert.spec.ts": [
      'import assert from "node:assert/strict";',
      'import { test } from "@playwright/test";',
      "",
      'assert.deepEqual([1], [1], "an injected module-level node assertion");',
      "",
      'test("a journey", () => {',
      "  assert.equal(1, 1);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  // Both are assertions; only the module-level one is a finding, and the test's own is attributed to it.
  assert.equal(reading.examined, 2);
  assert.deepEqual(codes(reading), ["assertion_runs_at_import:node-assert.spec.ts"]);
  assert.equal(reading.findings[0].line, 4);
});

test("a spec the grammar cannot parse is named rather than skipped", async () => {
  const root = makeTree({
    "unparseable.spec.ts": [
      'import { test } from "@playwright/test";',
      "",
      'test("a journey", () => {',
      "  const = ;",
      "});",
      "",
    ].join("\n"),
    "healthy.spec.ts": [
      'import { expect, test } from "@playwright/test";',
      "",
      'test("a journey", () => {',
      "  expect(1).toBe(1);",
      "});",
      "",
    ].join("\n"),
  });
  const reading = await auditLooseAssertions({ root });
  assert.deepEqual(codes(reading), ["journey_not_parsed:unparseable.spec.ts"]);
  assert.equal(reading.parsed, 1, "the healthy spec is still read");
});

test("a corpus with no assertion is blocked, never green", () => {
  const root = makeTree({
    "empty.spec.ts": ['import { test } from "@playwright/test";', "", 'test("a journey", () => {});', ""].join("\n"),
  });
  const { status, stdout, stderr } = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  assert.equal(status, 2, `expected the blocked exit, got ${status}: ${stderr}`);
  assert.match(stdout, /^blocked: /mu);
  assert.match(stdout, /"status":"blocked"/u);
  assert.match(stdout, /"examined":0/u);
  assert.match(stderr, /loose_assertion_gate_blocked:no_assertion_examined: examined 0 assertions/u);
});

test("a corpus with no journey is blocked too, rather than reading clean over nothing", () => {
  const root = makeTree({});
  const { status, stdout, stderr } = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  assert.equal(status, 2, `expected the blocked exit, got ${status}: ${stderr}`);
  assert.match(stderr, /examined 0 assertions/u);
});

test("the commit's own journeys are attributed end to end, and the report is the reading it prints", async () => {
  const reading = await auditLooseAssertions({ root: REPOSITORY_ROOT });
  // A corpus this large is never empty, so a green reading here is a measurement rather than a silence.
  assert.ok(reading.specs > 0, "no journey was found under dialogue-web/tests");
  assert.ok(reading.examined > 0, "no assertion was read in any journey");
  assert.deepEqual(reading.findings, []);
  assertEveryAssertionClassified(reading);

  const printed = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  const report = printed.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith('{"gate":"loose_assertions/v1"'));
  assert.ok(report, "the gate printed no self-verification report");
  const parsed = JSON.parse(report);
  assert.equal(parsed.examined, reading.examined, "the report and the reading state two populations");
  assert.equal(parsed.status, "passed");
});
