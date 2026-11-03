// The wait every driver that reads an async panel depends on, held without a browser.
//
// The defect this exists for was measured on the `frontend-e` run, on a contended machine: driver M
// slept a fixed 1600ms after `activateSurface(page, "角色")`, read the opening editor while its card
// read was still in flight, and took `variantCount: 0` for "her opening set is already down to one".
// Zero rows with no buttons is also exactly what the product's own loading state renders, so the
// reading looked like a product fact rather than like an absence - `rows discarded: 0`, then
// `saving the one-opening set: no_button:保存开场白`, then a 30s click timeout in the next switch.
// (The sibling `frontend-e/m-opening-picker.txt` on an idle machine passed 20/20 with the same code.)
//
// Two properties are held here, because they answer different questions:
//
//   the wait's rules   a scripted page decides what the wait is allowed to accept, including the
//                      loading state whose 0 looks final.
//   the read's guard   every driver that reads the opening editor asks for it to load first, and
//                      the population is the capture directory rather than a list written here.
//
// red-proof: inject  deleting the wait in m-opening-picker.cjs -> the guard below names that file;
//                    scripting the page to stay on the product's loading line with 0 rows ->
//                    waitForPanel answers the 3 rows that arrive, never the loading state's 0
//                    (tools/live-run/frontend/capture/wait-for-panel.test.mjs)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT, waitForPanel } from "./common.cjs";

/**
 * A page whose answers are scripted, so the wait's rules can be held without a browser.
 *
 * `answers(index)` returns one reading in the shape the in-page function returns. The fake counts
 * polls and records the argument each one asked for, because "wait for the panel's data" is a claim
 * about WHAT is asked and HOW MANY times - which a fake can pin exactly, while the selector semantics
 * itself belong to the browser and are what a live run exercises.
 */
function scriptedPage(answers) {
  const asked = [];
  return {
    asked,
    async evaluate(_pageFunction, argument) {
      const index = asked.length;
      asked.push(argument);
      return answers(index);
    },
    async waitForTimeout(_ms) {},
  };
}

const OPENING_EDITOR = { name: "opening-editor", panel: "[data-opening-editor]", item: ".opening-variant-row" };

test("a loaded panel whose item count holds across two reads is accepted, with the count it holds", async () => {
  const page = scriptedPage(() => ({ panel: true, loading: 0, count: 3 }));
  const reading = await waitForPanel(page, OPENING_EDITOR);
  assert.equal(reading.count, 3);
  assert.equal(reading.loading, 0);
  assert.equal(page.asked.length, 2, "one read cannot show a count is stable");
  assert.deepEqual(page.asked[0], { panelSelector: "[data-opening-editor]", itemSelector: ".opening-variant-row" });
});

test("the product's own loading line is never read as a panel that holds nothing", async () => {
  // The measured shape: the section is mounted, its loading line is showing, it holds no rows - and
  // the card read then lands with three.
  const page = scriptedPage((index) =>
    index < 3 ? { panel: true, loading: 1, count: 0 } : { panel: true, loading: 0, count: 3 },
  );
  const reading = await waitForPanel(page, OPENING_EDITOR);
  assert.equal(reading.count, 3, "the loading state's 0 is not a reading of her opening set");
  assert.equal(reading.loading, 0);
  assert.equal(page.asked.length, 5, "three loading reads, then the two that agree");
});

test("a count that is still changing is not read half-drawn", async () => {
  const page = scriptedPage((index) => ({ panel: true, loading: 0, count: index === 0 ? 0 : 3 }));
  const reading = await waitForPanel(page, OPENING_EDITOR);
  assert.equal(reading.count, 3);
  assert.equal(page.asked.length, 3);
});

test("a loaded panel that really holds nothing is a reading, not a wait that never ends", async () => {
  const page = scriptedPage(() => ({ panel: true, loading: 0, count: 0 }));
  const reading = await waitForPanel(page, OPENING_EDITOR);
  assert.equal(reading.count, 0, "an empty panel after its loading line cleared is the panel's answer");
});

test("a panel read without an item selector is accepted as soon as it is loaded", async () => {
  const page = scriptedPage(() => ({ panel: true, loading: 0, count: null }));
  const reading = await waitForPanel(page, { name: "game-surface", panel: '[data-testid="game-surface"]' });
  assert.equal(reading.panel, true);
  assert.equal(page.asked.length, 1);
});

test("a panel that never mounts fails by name, quoting the selector and the last reading", async () => {
  const page = scriptedPage(() => ({ panel: false, loading: 0, count: null }));
  await assert.rejects(waitForPanel(page, { ...OPENING_EDITOR, timeoutMs: 40, settleMs: 5 }), (error) => {
    assert.match(error.message, /panel_never_settled:opening-editor/u);
    assert.match(error.message, /\[data-opening-editor\]/u, "the failure names the panel it waited for");
    assert.match(error.message, /\.opening-variant-row/u, "and the rows it waited for");
    assert.match(error.message, /panel=false loading=0 count=null/u, "and what the page last said");
    return true;
  });
});

test("every driver that reads the opening editor asks for it to load before reading it", () => {
  const captureDirectory = join(REPO_ROOT, "tools", "live-run", "frontend", "capture");
  const readers = readdirSync(captureDirectory)
    .filter((file) => file.endsWith(".cjs"))
    .filter((file) => readFileSync(join(captureDirectory, file), "utf8").includes("openingEditorFacts"));
  assert.ok(readers.length > 0, "no driver reads the opening editor any more, so this guard has no premise");
  for (const file of readers) {
    const source = readFileSync(join(captureDirectory, file), "utf8");
    const wait = source.indexOf("await waitForPanel(page,");
    const read = source.indexOf("page.evaluate(openingEditorFacts)");
    assert.ok(
      wait >= 0,
      `${file} reads the opening editor without waitForPanel: a sleep cannot tell a loading editor from an empty one`,
    );
    assert.ok(wait < read, `${file} reads the opening editor before waiting for it to load`);
  }
});
