import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditStubSubjectCollisions } from "./check-stub-subject-collision.mjs";

// red-proof: self-check  a spec whose title names the resource it stubs is listed, while the same stub
//            under a title naming something else is not ("a title that names the resource it stubs is
//            listed" and its control below). The report is also seen to read the three shapes that made
//            a first reading wrong: routes stubbed through an imported helper, a route named by a
//            constant, and a route name this report cannot resolve (which is `unassessed`, never
//            "stubs nothing"). A spec that mounts a probe page is named as one, not as a spec that
//            stubs nothing.

const roots = [];
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "check-stub-subject-collision.mjs");

function makeTree(specs) {
  const root = mkdtempSync(join(tmpdir(), "stub-subject-"));
  roots.push(root);
  for (const [name, source] of Object.entries(specs)) {
    const full = join(root, "dialogue-web", "tests", name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  return root;
}

const journey = (title, body) =>
  [
    'import { expect, test } from "./frontend-coverage";',
    "",
    `test("${title}", async ({ page }) => {`,
    body,
    "});",
    "",
  ].join("\n");

const stub = (pattern) =>
  `  await page.route("${pattern}", (route) => route.fulfill({ status: 200, body: "{}" }));`;

const codes = (reading) => reading.collisions.map((collision) => `${collision.file}:${collision.subject}`);
const reading = (specs) => auditStubSubjectCollisions({ root: makeTree(specs) });

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a title that names the resource it stubs is listed", () => {
  const measured = reading({
    "settings.spec.ts": journey("the connection sentence says who configured it", stub("**/api/tavern/settings/connection")),
  });
  assert.deepEqual(codes(measured), ["dialogue-web/tests/settings.spec.ts:connection"]);
  assert.equal(measured.decidesNothing.length, 0);
});

test("the same stub under a title naming something else is not a collision", () => {
  const measured = reading({
    "settings.spec.ts": journey("the panel renders one row per field", stub("**/api/tavern/settings/connection")),
  });
  assert.deepEqual(measured.collisions, []);
});

test("a word that sits mid-path in the spec's own routes names a family, not a subject", () => {
  const measured = reading({
    "game.spec.ts": journey("the game surface shows the farm", stub("**/api/composed-reference-game/v1/game/state")),
  });
  assert.deepEqual(measured.collisions, []);
});

test("routes stubbed by an imported helper belong to the spec that imports it", () => {
  const measured = reading({
    "helpers.ts": [
      "export async function mount(page) {",
      '  await page.route("**/api/tavern/settings/connection", (route) => route.fulfill({ status: 200 }));',
      "}",
      "",
    ].join("\n"),
    "settings.spec.ts": [
      'import { expect, test } from "./frontend-coverage";',
      'import { mount } from "./helpers";',
      "",
      'test("the connection sentence", async ({ page }) => {',
      "  await mount(page);",
      "});",
      "",
    ].join("\n"),
  });
  assert.deepEqual(codes(measured), ["dialogue-web/tests/settings.spec.ts:connection"]);
  assert.deepEqual(measured.decidesNothing, []);
});

test("a route named by a constant is resolved, and one that resolves to nothing is unassessed", () => {
  const resolved = reading({
    "settings.spec.ts": [
      'import { expect, test } from "./frontend-coverage";',
      'const CONNECTION_ROUTE = "**/api/tavern/settings/connection";',
      "",
      'test("the connection sentence", async ({ page }) => {',
      "  await page.route(CONNECTION_ROUTE, (route) => route.fulfill({ status: 200 }));",
      "});",
      "",
    ].join("\n"),
  });
  assert.deepEqual(codes(resolved), ["dialogue-web/tests/settings.spec.ts:connection"]);

  const unreadable = reading({
    "settings.spec.ts": [
      'import { expect, test } from "./frontend-coverage";',
      "async function stub(page, pattern) {",
      "  await page.route(pattern, (route) => route.fulfill({ status: 200 }));",
      "}",
      "",
      'test("the connection sentence", async ({ page }) => {',
      "  await stub(page, request);",
      "});",
      "",
    ].join("\n"),
  });
  assert.deepEqual(unreadable.collisions, []);
  assert.deepEqual(unreadable.decidesNothing, []);
  assert.deepEqual(unreadable.unresolved, [{ file: "dialogue-web/tests/settings.spec.ts", names: ["pattern"] }]);
});

test("a spec that stubs nothing decides nothing, and one that mounts a probe page is named as such", () => {
  const measured = reading({
    "silent.spec.ts": journey("the dot is green", '  await expect(page.getByTestId("dot")).toBeVisible();'),
    "probe.spec.ts": [
      'import { expect, test } from "./frontend-coverage";',
      "",
      'test("the delete control", async ({ page }) => {',
      '  await page.goto("/tests/chat-surface-probe.html");',
      "});",
      "",
    ].join("\n"),
  });
  assert.deepEqual(measured.decidesNothing, ["dialogue-web/tests/silent.spec.ts"]);
  assert.deepEqual(measured.probeMounted, ["dialogue-web/tests/probe.spec.ts"]);
});

test("the report is not a gate: it exits 0 with a collision on the list", () => {
  const root = makeTree({
    "settings.spec.ts": journey("the connection sentence says who configured it", stub("**/api/tavern/settings/connection")),
  });
  const result = spawnSync(process.execPath, [CLI, "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stub_subject_collision specs=1 .*collisions=1/u);
  assert.match(result.stdout, /collision:dialogue-web\/tests\/settings\.spec\.ts:\d+ stubs a route naming "connection"/u);
});
