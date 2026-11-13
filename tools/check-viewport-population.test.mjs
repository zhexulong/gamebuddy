/**
 * The falsifier for `tools/check-viewport-population.mjs`: every reading the gate claims, driven through the real gate
 * over a throwaway workspace instead of a second implementation of the reader.
 *
 * The sizes are the REAL `dialogue-web/tests/viewport-policy.ts`, copied in, so a fixture cannot pass by declaring a
 * population the product does not; only the specs and the config are written here, one per shape the gate judges.
 *
 * red-proof: inject  `spelled-locally.spec.ts` measuring 1440x900, 1024x768 and 400x800 by hand ->
 *   `viewport_cells_incomplete` naming the file and `missing=1280x800,1280x720,900x700,816x767,480x900` and exit 1
 *   (the "a fourth cell is declared" reading below grows that list by the new cell)
 * red-proof: inject  a ninth cell added to `VIEWPORT_SIZES` in the fixture policy ->
 *   the spec that iterates `VIEWPORT_SIZES` stays green (it owes nothing new: it iterates the declaration) and the
 *   hand-written spec's `missing=` list gains the new cell, which is the size it now owes
 * red-proof: inject  a project `use` with no `viewport`, and one with a literal in its place ->
 *   `viewport_default_undeclared`; with a hand-written `{ width: 1280, height: 720 }` -> the same finding, because a
 *   literal is a second spelling
 * red-proof: inject  an exemption whose cell set no site evaluates -> `exemption_expired`
 * red-proof: inject  a tests root holding no spec at all -> `status: "blocked"`, because a reading over zero specs
 *   is not a pass
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkViewportPopulation } from "./check-viewport-population.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_POLICY = readFileSync(join(ROOT, "dialogue-web", "tests", "viewport-policy.ts"), "utf8");

/** A throwaway workspace: the real policy, the specs this case needs, and a config. */
function workspace({ policy = REAL_POLICY, specs = {}, config = CONFIG_WITH_DEFAULT } = {}) {
  const root = mkdtempSync(join(tmpdir(), "viewport-population-"));
  const web = join(root, "dialogue-web");
  mkdirSync(join(web, "tests"), { recursive: true });
  writeFileSync(join(web, "tests", "viewport-policy.ts"), policy);
  writeFileSync(join(web, "playwright.config.ts"), config);
  for (const [name, text] of Object.entries(specs)) writeFileSync(join(web, "tests", name), text);
  return { root, web, read: (options) => checkViewportPopulation({ webRoot: web, exemptions: [], ...options }) };
}

const CONFIG_WITH_DEFAULT = `import { DEFAULT_VIEWPORT } from "./tests/viewport-policy";
export default { projects: [{ name: "chromium", use: { viewport: DEFAULT_VIEWPORT } }] };
`;

const ITERATES_THE_MATRIX = `import { test } from "@playwright/test";
import { VIEWPORT_SIZES } from "./viewport-policy";
test("a spec that measures the matrix", async ({ page }) => {
  for (const viewport of VIEWPORT_SIZES) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.innerWidth);
  }
});
`;

const ITERATES_THE_PAIR = `import { test } from "@playwright/test";
import { LAYOUT_PAIR } from "./viewport-policy";
test("a copy journey that varies the two layouts", async ({ page }) => {
  for (const viewport of LAYOUT_PAIR) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }
});
`;

/**
 * Three declared sizes written by hand, and the two ends left out: the shape the gate exists to catch - a journey that
 * samples the middle of the population and neither the desktop nor the phone.
 */
const SPELLED_LOCALLY = `import { test } from "@playwright/test";
test("a spec that spells three of the sizes itself", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 900, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
  }
});
`;

const ONE_CELL = `import { test } from "@playwright/test";
test("a spec that pins the phone layout", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
});
`;

const codes = (verdict) => verdict.findings.map((entry) => entry.code);
const detailOf = (verdict, code) => verdict.findings.find((entry) => entry.code === code)?.detail ?? "";

test("the declared matrix, the pair and a pinned cell are all covered, so the gate passes and says what it read", () => {
  const space = workspace({
    specs: { "matrix.spec.ts": ITERATES_THE_MATRIX, "pair.spec.ts": ITERATES_THE_PAIR, "cell.spec.ts": ONE_CELL },
  });
  try {
    const verdict = space.read();
    assert.deepEqual(codes(verdict), []);
    assert.equal(verdict.status, "passed");
    assert.equal(verdict.examinedFiles, 3);
    assert.equal(verdict.examinedSites, 3);
    assert.equal(verdict.varyingSites, 2);
    assert.equal(verdict.policy.matrix.length > 2, true, "the real policy declares more than two cells");
    assert.equal(verdict.inherited.declared, true);
  } finally {
    rmSync(space.root, { recursive: true, force: true });
  }
});

test("a spec that spells a partial list is named with the declared sizes it is missing", () => {
  const space = workspace({ specs: { "spelled-locally.spec.ts": SPELLED_LOCALLY } });
  try {
    const verdict = space.read();
    assert.equal(verdict.status, "failed");
    assert.deepEqual(codes(verdict), ["viewport_cells_incomplete"]);
    const detail = detailOf(verdict, "viewport_cells_incomplete");
    assert.match(detail, /spelled-locally\.spec\.ts:8/u, "the finding names the file and the site");
    assert.match(detail, /measures 1024x768,1440x900,900x700/u, "it names the cells the site does evaluate");
    for (const cell of ["1280x800", "1280x720", "816x767", "480x900", "400x800"])
      assert.match(detail, new RegExp(cell, "u"));
    assert.doesNotMatch(detail.split("missing=")[1] ?? "", /1024x768/u, "a cell it does measure is not owed back");
  } finally {
    rmSync(space.root, { recursive: true, force: true });
  }
});

test("declaring a new cell makes the hand-written spec owe it and leaves the iterating spec green", () => {
  const before = workspace({
    specs: { "spelled-locally.spec.ts": SPELLED_LOCALLY, "matrix.spec.ts": ITERATES_THE_MATRIX },
  });
  let beforeDetail = "";
  try {
    beforeDetail = detailOf(before.read(), "viewport_cells_incomplete");
  } finally {
    rmSync(before.root, { recursive: true, force: true });
  }

  const policy = REAL_POLICY.replace(
    "  PHONE,\n];",
    '  PHONE,\n  { name: "red-proof", width: 1200, height: 640, reason: "" },\n];',
  );
  assert.notEqual(policy, REAL_POLICY, "the fixture declares the extra cell");
  const after = workspace({
    policy,
    specs: { "spelled-locally.spec.ts": SPELLED_LOCALLY, "matrix.spec.ts": ITERATES_THE_MATRIX },
  });
  try {
    const verdict = after.read();
    assert.deepEqual(codes(verdict), ["viewport_cells_incomplete"], "only the hand-written spec owes anything");
    assert.match(verdict.findings[0].detail, /spelled-locally\.spec\.ts/u);
    const afterDetail = detailOf(verdict, "viewport_cells_incomplete");
    assert.doesNotMatch(beforeDetail, /1200x640/u);
    assert.match(afterDetail, /1200x640/u, "the newly declared cell is named as owed");
    assert.match(afterDetail, /missing=.*1200x640/u);
    assert.equal(
      verdict.rows.filter((row) => row.verdict === "matrix").length,
      1,
      "the spec that iterates VIEWPORT_SIZES measures the new cell without an edit",
    );
  } finally {
    rmSync(after.root, { recursive: true, force: true });
  }
});

test("a config that leaves the inherited cell to the device, or spells it, is reported", () => {
  const bare = workspace({
    specs: { "cell.spec.ts": ONE_CELL },
    config: `export default { projects: [{ name: "chromium", use: {} }] };\n`,
  });
  const spelled = workspace({
    specs: { "cell.spec.ts": ONE_CELL },
    config: `import { DEFAULT_VIEWPORT } from "./tests/viewport-policy";\nexport default { projects: [{ name: "chromium", use: { viewport: { width: 1280, height: 720 } } }] };\n`,
  });
  try {
    assert.deepEqual(codes(bare.read()), ["viewport_default_undeclared"]);
    assert.match(detailOf(bare.read(), "viewport_default_undeclared"), /names no `viewport`/u);
    assert.deepEqual(codes(spelled.read()), ["viewport_default_undeclared"]);
    assert.match(
      detailOf(spelled.read(), "viewport_default_undeclared"),
      /instead of the policy's `DEFAULT_VIEWPORT`/u,
    );
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
    rmSync(spelled.root, { recursive: true, force: true });
  }
});

test("an exemption that matches no site is expired, and one that matches is counted", () => {
  const space = workspace({ specs: { "spelled-locally.spec.ts": SPELLED_LOCALLY } });
  try {
    const stale = space.read({
      exemptions: [{ file: "dialogue-web/tests/spelled-locally.spec.ts", cells: ["1x1", "2x2"], reason: "nothing" }],
    });
    assert.deepEqual(codes(stale).sort(), ["exemption_expired", "viewport_cells_incomplete"]);

    const stated = space.read({
      exemptions: [
        {
          file: "dialogue-web/tests/spelled-locally.spec.ts",
          cells: ["1024x768", "1440x900", "900x700"],
          reason: "a stated reason for this exact set",
        },
      ],
    });
    assert.deepEqual(codes(stated), []);
    assert.equal(stated.exemptSites, 1);
  } finally {
    rmSync(space.root, { recursive: true, force: true });
  }
});

test("a reading over no spec is blocked, not passed", () => {
  const space = workspace({ specs: {} });
  try {
    const verdict = space.read();
    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.examinedSites, 0);
  } finally {
    rmSync(space.root, { recursive: true, force: true });
  }
});
