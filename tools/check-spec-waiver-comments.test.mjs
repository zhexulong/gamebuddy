import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { auditSpecWaivers, classifyComment, commentBlocksOf } from "./lib/spec-waiver-comments.mjs";

// red-proof: history  the four real waiver comments as they stood at `be55c772^` and `930a031e^` -> each is
//            `waiver_undocumented` at the line its fix commit deleted it from (CASES below). Also injected: a
//            declaration whose product literal is gone, whose file is gone, and one with no expiry clause.

const roots = [];

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "spec-waiver-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  return root;
}

const journey = (body) =>
  [
    'import { expect, test } from "./frontend-coverage";',
    "",
    `test("a journey", async ({ page }) => {`,
    body,
    "});",
    "",
  ].join("\n");

const drawer = "dialogue-web/src/components/ContextDrawer.tsx";

const withDrawer = (body, drawerSource = "const trigger = <button disabled={busy} />;\n") => ({
  "dialogue-web/tests/one.spec.ts": journey(body),
  [drawer]: drawerSource,
});

const codes = (findings) => findings.map((finding) => finding.code);
const reading = (files) => auditSpecWaivers({ root: makeTree(files) });

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * The four, exactly as they stood. Each quote is the comment the fix commit deleted, and the line is
 * the line it stood on: `930a031e` removed the three drawer ones, `be55c772` the disclosure's.
 */
const CASES = [
  [
    "dialogue-web/tests/composed-profile-bootstrap.spec.ts",
    '  expect(await disclosure.evaluate((node) => node.querySelector("pre") === null)).toBe(true);',
    [
      "  // Closed, the dump's own DOM is not mounted at all: a collapsed disclosure that",
      "  // keeps a few hundred lines of JSON in the document is still a node the layout",
      "  // walks and an assistive technology can reach.",
    ].join("\n"),
  ],
  [
    "dialogue-web/tests/drawer-focus-trap.spec.ts",
    '  await drawer.locator(".drawer-header h2").click();',
    [
      "  // The picker is still out of the tab order after the re-render, and the drawer's cycle",
      "  // is still the three controls a player can reach. Focus is brought back inside the way a",
      "  // player would - by pointing at the drawer - because the upload's own busy state drops",
      "  // it to `<body>` (measured: `focusout` from the trigger with `disabled === true`); that",
      "  // drop is the avatar section's busy-state behaviour, not this trap, and it is reported",
      "  // rather than changed here.",
    ].join("\n"),
  ],
  [
    "dialogue-web/tests/model-profile-freshness.spec.ts",
    '  await page.getByTestId("chat-model-drawer").getByRole("button", { name: "Close" }).click();',
    [
      "  // It closes through its own affordance. The close button is used rather than",
      "  // Escape: the Save button is disabled while saving, which drops focus to <body>,",
      "  // so Escape would have no drawer to reach - a real affordance question, but not",
      "  // the freshness this journey measures.",
    ].join("\n"),
  ],
  [
    "dialogue-web/tests/sending-and-composer.spec.ts",
    '  await popout.getByRole("button", { name: "Close", exact: true }).click();',
    [
      "  // The drawer's own close control, not Escape: the Save that just ran disabled itself and dropped",
      "  // focus to <body>, so this asserts the surface's close affordance rather than a keyboard accident.",
    ].join("\n"),
  ],
];

for (const [file, step, comment] of CASES) {
  test(`the waiver ${file.split("/").at(-1)} carried is named, with the step it excused`, () => {
    const measured = reading({ [file]: journey([comment, step].join("\n")) });
    assert.deepEqual(codes(measured.findings), ["waiver_undocumented"], file);
    assert.equal(measured.findings[0].file, file);
    assert.equal(measured.findings[0].line, 4, "the finding points at the comment, not at the test");
    assert.match(measured.findings[0].claim, /body|<body>|not mounted/u);
  });
}

test("the two halves of a multi-line waiver are one comment, which is the only way either half reads as a waiver", () => {
  const blocks = commentBlocksOf(
    journey(["  // used rather than Escape", "  // drops focus to <body>.", "  step();"].join("\n")),
  );
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /used rather than Escape drops focus to <body>/u);
  assert.equal(classifyComment(blocks[0].text).isWaiver, true);
  assert.equal(classifyComment("used rather than Escape").isWaiver, false, "a deviation alone is not a waiver");
  assert.equal(classifyComment("drops focus to <body>").isWaiver, false, "a denial alone is not a waiver");
});

test("a declared waiver whose product code is still there is held, not reported", () => {
  const measured = reading(
    withDrawer(
      [
        "  // spec-waiver: closes with its Close button rather than Escape, because a Save that disabled",
        "  // itself parks focus on <body>, so Escape has no drawer to reach.",
        `  // expires when: ${drawer} no longer contains \`disabled={busy}\``,
        '  await page.getByRole("button", { name: "Close" }).click();',
      ].join("\n"),
    ),
  );
  assert.deepEqual(measured.findings, []);
  assert.equal(measured.waivers.length, 1);
  assert.equal(measured.waivers[0].literal, "disabled={busy}");
  assert.equal(measured.waivers[0].verdict, "held");
});

test("a waiver whose product code is gone has expired, and says so by the literal that went", () => {
  const measured = reading(
    withDrawer(
      [
        "  // spec-waiver: closes with its Close button rather than Escape, because a Save that disabled",
        "  // itself parks focus on <body>.",
        `  // expires when: ${drawer} no longer contains \`disabled={busy}\``,
        '  await page.getByRole("button", { name: "Close" }).click();',
      ].join("\n"),
      "const trigger = <button />; // the busy state no longer disables the control it sits on\n",
    ),
  );
  assert.deepEqual(codes(measured.findings), ["waiver_expired"]);
  assert.match(measured.findings[0].detail, /no longer contains `disabled=\{busy\}`/u);
  assert.equal(measured.waivers.length, 0);
});

test("a waiver whose file is gone is unmeasurable, not expired: a rename is not a fix", () => {
  const measured = reading(
    withDrawer(
      [
        "  // spec-waiver: closes with its Close button rather than Escape, because a Save that disabled",
        "  // itself parks focus on <body>.",
        "  // expires when: dialogue-web/src/components/Gone.tsx no longer contains `disabled={busy}`",
        '  await page.getByRole("button", { name: "Close" }).click();',
      ].join("\n"),
    ),
  );
  assert.deepEqual(codes(measured.findings), ["waiver_expiry_unmeasurable"]);
  assert.match(measured.findings[0].detail, /Gone\.tsx does not exist/u);
});

test("a declaration with no expiry clause is a waiver that will never end, and is reported", () => {
  const measured = reading(
    withDrawer(
      [
        "  // spec-waiver: closes with its Close button rather than Escape, because a Save that",
        "  // disabled itself parks focus on <body>. It is fine here.",
        '  await page.getByRole("button", { name: "Close" }).click();',
      ].join("\n"),
    ),
  );
  assert.deepEqual(codes(measured.findings), ["waiver_without_expiry"]);
});

test("a comment that names an alternative without claiming a capability is missing stays out of the population", () => {
  const measured = reading({
    "dialogue-web/tests/one.spec.ts": journey(
      [
        "  // The rule is asserted against the words the player can act on rather than against the tag a",
        "  // control happens to be, because a read affordance is not an activation affordance.",
        '  await expect(page.getByRole("button")).toHaveText("Switch");',
      ].join("\n"),
    ),
  });
  assert.deepEqual(measured.findings, []);
  assert.equal(measured.examined, 1, "the two lines are one paragraph, and it is not a waiver");
});

test("a journey's own JSDoc is not read: it is where the assertion is justified, not where a step is excused", () => {
  const source = [
    "/**",
    " * NOTE, deliberately not changed here: the trigger is `disabled={busy}` and disabling the",
    " * focused control drops focus to `<body>`, so this is reported rather than changed here.",
    " */",
    'test("a journey", async ({ page }) => {',
    "  step();",
    "});",
    "",
  ].join("\n");
  const measured = reading({ "dialogue-web/tests/one.spec.ts": source });
  assert.deepEqual(measured.findings, []);
  assert.equal(measured.examined, 0, "a doc block is not a step comment");
});

test("a tree with no spec directory is unassessed, and a tree of journeys with no prose is blocked", () => {
  const empty = auditSpecWaivers({ root: makeTree({ "README.md": "nothing here\n" }) });
  assert.equal(empty.files, 0);
  assert.match(empty.unassessed[0], /^unassessed: dialogue-web\/tests - no spec directory/u);

  const silent = reading({ "dialogue-web/tests/one.spec.ts": journey("  step();") });
  assert.equal(silent.files, 1);
  assert.equal(silent.examined, 0, "the caller reads this as blocked: files > 0 and examined === 0");
});

test("the population is counted, so a run that recognised nothing is visible", () => {
  const measured = reading(withDrawer('  await page.keyboard.press("Escape");'));
  assert.equal(measured.files, 1);
  assert.equal(measured.examined, 0, "no comment at all in this journey");
  const talked = reading(withDrawer(["  // The drawer answers Escape from anywhere.", "  step();"].join("\n")));
  assert.equal(talked.examined, 1, "one step comment examined");
  assert.deepEqual(talked.findings, []);
});
