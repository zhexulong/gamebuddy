import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditAssertionSubstance, evaluate, EXISTENCE_MATCHERS } from "./check-assertion-substance.mjs";

const GATE = fileURLToPath(new URL("./check-assertion-substance.mjs", import.meta.url));

// red-proof: inject  a journey added to a synthetic tree whose only assertion is `toBeVisible()` on a
//            control -> `journey_asserts_only_existence` names it, while the same journey with one
//            `toHaveText` beside it is green ("a journey whose only assertion is visibility is named"
//            and its control below). Also injected: a journey with no assertion at all
//            (`journey_asserts_nothing`), the `toHaveCount(1)` shape the defect is named after, and a
//            journey recorded in the baseline that asserts something now (`baseline_entry_stale`).

const roots = [];

function makeTree(specs) {
  const root = mkdtempSync(join(tmpdir(), "assertion-substance-"));
  roots.push(root);
  for (const [name, source] of Object.entries(specs)) {
    const full = join(root, "dialogue-web", "tests", name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  return root;
}

const journey = (body, { imports = "" } = {}) =>
  [
    `import { expect, test } from "./frontend-coverage";`,
    ...(imports === "" ? [] : [imports]),
    "",
    `test("a journey", async ({ page }) => {`,
    body,
    "});",
    "",
  ].join("\n");

const NODE_ASSERT = 'import assert from "node:assert/strict";';

const codes = (findings) => findings.map((finding) => finding.code);
const reading = (specs) => auditAssertionSubstance({ root: makeTree(specs) });

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a journey whose only assertion is visibility is named", () => {
  const measured = reading({
    "existence.spec.ts": journey('  await expect(page.getByTestId("game-endgame-open")).toBeVisible();'),
  });
  const { findings } = evaluate({ reading: measured, baseline: { entries: [] } });
  assert.deepEqual(codes(findings), ["journey_asserts_only_existence"]);
  assert.match(findings[0].detail, /every assertion is about existence \(toBeVisible\)/u);
  assert.deepEqual(measured.findings[0].matchers, ["toBeVisible"]);
});

test("the same journey with one content assertion beside it is green", () => {
  const measured = reading({
    "existence.spec.ts": journey(
      [
        '  await expect(page.getByTestId("game-endgame-open")).toBeVisible();',
        '  await expect(page.getByTestId("game-endgame-open")).toHaveText("End the game");',
      ].join("\n"),
    ),
  });
  assert.deepEqual(measured.findings, []);
  assert.deepEqual(evaluate({ reading: measured, baseline: { entries: [] } }).findings, []);
});

test("the count shape the defect is named after is the same finding", () => {
  const measured = reading({
    "count.spec.ts": journey('  await expect(page.getByTestId("chat-message-copy")).toHaveCount(1);'),
  });
  assert.deepEqual(
    measured.findings.map((entry) => [entry.verdict, entry.matchers]),
    [["existence_only", ["toHaveCount"]]],
  );
});

test("a chain that breaks the line after `expect` is read, not skipped", () => {
  const measured = reading({
    "multiline.spec.ts": journey(
      [
        "  await expect",
        '    .soft(page.getByTestId("game-endgame-open"), "the control is offered")',
        "    .toBeVisible();",
      ].join("\n"),
    ),
  });
  assert.equal(measured.tests[0].assertions, 1);
  assert.deepEqual(
    measured.findings.map((entry) => [entry.verdict, entry.matchers]),
    [["existence_only", ["toBeVisible"]]],
  );
});

test("a poll chain written one call per line carries its matcher", () => {
  const measured = reading({
    "poll.spec.ts": journey(["  await expect", "    .poll(async () => 1)", "    .toBe(1);"].join("\n")),
  });
  assert.equal(measured.tests[0].assertions, 1);
  assert.deepEqual(measured.tests[0].matchers, ["toBe"]);
  assert.deepEqual(measured.findings, []);
});

test("a node assertion is an assertion: `assert.deepEqual` beside a visibility check is substantive", () => {
  const measured = reading({
    "judged.spec.ts": journey(
      ["  assert.deepEqual(violations, []);", '  await expect(page.getByTestId("a")).toBeVisible();'].join("\n"),
      { imports: NODE_ASSERT },
    ),
  });
  assert.equal(measured.tests[0].assertions, 2);
  assert.deepEqual(measured.tests[0].matchers, ["deepEqual", "toBeVisible"]);
  assert.deepEqual(measured.findings, []);
});

test("a node assertion that claims only presence is the same finding as `toBeVisible`", () => {
  const measured = reading({
    "presence.spec.ts": journey('  assert.ok(await page.getByTestId("a").isVisible(), "it is offered");', {
      imports: NODE_ASSERT,
    }),
  });
  const { findings } = evaluate({ reading: measured, baseline: { entries: [] } });
  assert.deepEqual(codes(findings), ["journey_asserts_only_existence"]);
  assert.deepEqual(measured.findings[0].matchers, ["ok"]);
});

test("a node assertion counts by the name its import binds, and no other bare call counts", () => {
  const destructured = reading({
    "named.spec.ts": journey(["  deepEqual(violations, []);", "  recorded(1);"].join("\n"), {
      imports: 'import { deepEqual } from "node:assert/strict";',
    }),
  });
  assert.equal(destructured.tests[0].assertions, 1);
  assert.deepEqual(destructured.tests[0].matchers, ["deepEqual"]);

  const unimported = reading({
    "assumed.spec.ts": journey('  assert.ok(await page.getByTestId("a").isVisible());'),
  });
  assert.equal(unimported.tests[0].assertions, 0);
  assert.deepEqual(
    unimported.findings.map((entry) => entry.verdict),
    ["asserts_nothing"],
  );
});

test("a journey that asserts nothing at all is named separately", () => {
  const measured = reading({ "silent.spec.ts": journey('  await page.getByTestId("chat-surface").click();') });
  assert.deepEqual(
    measured.findings.map((entry) => entry.verdict),
    ["asserts_nothing"],
  );
  const { findings } = evaluate({ reading: measured, baseline: { entries: [] } });
  assert.deepEqual(codes(findings), ["journey_asserts_nothing"]);
});

test("state, geometry, value and request assertions are all substantive, not existence", () => {
  const substantive = [
    'await expect(page.getByTestId("a")).toBeDisabled();',
    'await expect(page.getByTestId("a")).toBeInViewport();',
    'await expect(page.getByTestId("a")).toHaveAttribute("data-tone", "danger");',
    "expect(route.request().postDataJSON()).toEqual({ confirm: true });",
    'expect(page.getByTestId("a")).toHaveText("Keep playing");',
    'expect(page.getByTestId("a")).toBeFocused();',
    'expect(page.getByTestId("a")).toBeNull();',
    'expect(page.getByTestId("a")).toBeTruthy();',
    "expect(measured.strip.box.height).toBeLessThanOrEqual(100);",
  ];
  for (const assertion of substantive) {
    const measured = reading({ "one.spec.ts": journey(`  ${assertion}`) });
    assert.deepEqual(measured.findings, [], assertion);
  }
  assert.deepEqual(
    EXISTENCE_MATCHERS.filter((matcher) =>
      /^toBeDisabled|toBeInViewport|toHaveAttribute|toEqual|toHaveText/u.test(matcher),
    ),
    [],
  );
});

test("a recorded journey is held, and an entry that asserts something now is stale", () => {
  const measured = reading({
    "existence.spec.ts": journey('  await expect(page.getByTestId("game-endgame-open")).toBeVisible();'),
    "count.spec.ts": journey('  await expect(page.getByTestId("chat-message-copy")).toHaveCount(1);'),
  });
  const held = evaluate({
    reading: measured,
    baseline: {
      entries: [
        { file: "dialogue-web/tests/existence.spec.ts", title: "a journey" },
        { file: "dialogue-web/tests/count.spec.ts", title: "a journey" },
      ],
    },
  });
  assert.deepEqual(held.findings, []);
  assert.equal(held.held, 2);

  const stale = evaluate({
    reading: measured,
    baseline: { entries: [{ file: "dialogue-web/tests/count.spec.ts", title: "a journey" }] },
  });
  assert.deepEqual(codes(stale.findings), ["journey_asserts_only_existence"]);
  assert.equal(stale.held, 1);
});

test("no journey at all is a reading that says so, not a clean run", () => {
  const measured = reading({});
  assert.equal(measured.tests.length, 0);
  assert.match(measured.unassessed[0], /^unassessed: dialogue-web\/tests - no mounted journey found/u);
});

// The CLI is the layer CI runs, and a tree that yields no test must refuse there: `--update` over it would write an
// empty baseline over the recorded debt.
test("the CLI refuses a tree whose journeys yield no test, instead of reporting a clean run", () => {
  const root = makeTree({});
  assert.throws(
    () =>
      execFileSync(process.execPath, [GATE, "--root", root], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.equal(error.status, 2, String(error.stdout) + String(error.stderr));
      assert.match(String(error.stderr), /assertion_substance_blocked:no_test_examined: examined 0 test/u);
      return true;
    },
  );
});
