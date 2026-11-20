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
//   the waits' rules    a scripted page decides what a wait is allowed to accept, including the
//                       loading state whose 0 looks final (`waitForPanel`) and every state the installation
//                       panel publishes ONLY while it is working (`waitForPanelSettled`).
//   the reads' guards   every driver that reads the opening editor asks for it to load first, and every
//                       driver that drives the installation panel asks for its settled state first. Both
//                       populations are read from the capture directory rather than listed here.
//
// red-proof: inject  deleting the wait in m-opening-picker.cjs -> the guard below names that file;
//                    scripting the page to stay on the product's loading line with 0 rows ->
//                    waitForPanel answers the 3 rows that arrive, never the loading state's 0;
//                    scripting the page to sit in `retrying` -> waitForPanelSettled never answers it, and
//                    fails naming the states it read (frontend--r13's driver T asserted on exactly that
//                    state, which is why the wait exists).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT, waitForPanel, waitForPanelSettled } from "./common.cjs";
import { INSTALLATION_DISCOVERY_STATES } from "./installation-panel.cjs";

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
    // Inside the driver's own body, so a helper above it that polls the editor on purpose (driver M's save wait
    // reads it once per tick) does not answer for the driver's first read of the editor.
    const body = source.slice(source.indexOf("(async () => {"));
    const wait = body.indexOf("await waitForPanel(page,");
    const read = body.indexOf("page.evaluate(openingEditorFacts)");
    assert.ok(
      wait >= 0,
      `${file} reads the opening editor without waitForPanel: a sleep cannot tell a loading editor from an empty one`,
    );
    assert.ok(wait < read, `${file} reads the opening editor before waiting for it to load`);
  }
});

/*
 * The installation panel's state machine, held against the product.
 *
 * The panel publishes one typed state as its `data-state` (`StardewInstallationDiscovery.tsx:304`), and a driver
 * that reads it - or that presses a control and reads what the press produced - has to know which members mean
 * "still working". That split is the kit's `INSTALLATION_DISCOVERY_STATES`, and the population is the union the
 * product declares: a state added there must be classified here by name, never quietly left out of the drivers'
 * set.
 */
const PRODUCT_STATE_UNION = (() => {
  const source = readFileSync(join(REPO_ROOT, "dialogue-web", "src", "game-presentation.ts"), "utf8");
  const declaration = /export type InstallationDiscoveryState =([\s\S]*?);/u.exec(source);
  if (declaration === null) return null;
  return [...declaration[1].matchAll(/"([a-z0-9_-]+)"/gu)].map((match) => match[1]);
})();

test("the panel's own vocabulary covers the product's union, in its own declaration order", () => {
  assert.ok(PRODUCT_STATE_UNION !== null, "InstallationDiscoveryState is no longer declared in game-presentation.ts");
  assert.ok(
    PRODUCT_STATE_UNION.length >= 10,
    `the union parsed to ${PRODUCT_STATE_UNION.length} member(s), which is a reading of nothing: the declaration changed shape`,
  );
  assert.deepEqual(
    [...INSTALLATION_DISCOVERY_STATES.all],
    PRODUCT_STATE_UNION,
    "INSTALLATION_DISCOVERY_STATES.all must be the union itself; a state the product adds fails here by name",
  );
});

test("every member of the panel's state is either a working state or a settled answer, and nothing else", () => {
  const working = new Set(INSTALLATION_DISCOVERY_STATES.working);
  const settled = new Set(INSTALLATION_DISCOVERY_STATES.settled);
  for (const state of INSTALLATION_DISCOVERY_STATES.all) {
    assert.ok(
      working.has(state) !== settled.has(state),
      `${state} is ${working.has(state) ? "working AND settled" : "neither working nor settled"}: classify it in installation-panel.cjs`,
    );
  }
  for (const state of [...working, ...settled])
    assert.ok(
      INSTALLATION_DISCOVERY_STATES.all.includes(state),
      `${state} is classified in installation-panel.cjs but not a member of InstallationDiscoveryState`,
    );
});

test("the working states are the ones the panel's own component names", () => {
  const source = readFileSync(
    join(REPO_ROOT, "dialogue-web", "src", "components", "StardewInstallationDiscovery.tsx"),
    "utf8",
  );
  for (const state of INSTALLATION_DISCOVERY_STATES.working)
    assert.ok(
      source.includes(`"${state}"`),
      `${state} is classified as a working state, but the component never names it: the classification has drifted`,
    );
});

test("every driver that drives the installation panel waits for its settled state", () => {
  const captureDirectory = join(REPO_ROOT, "tools", "live-run", "frontend", "capture");
  const drivers = readdirSync(captureDirectory)
    .filter((file) => file.endsWith(".cjs"))
    .filter((file) =>
      readFileSync(join(captureDirectory, file), "utf8").includes('require("./installation-panel.cjs")'),
    );
  assert.ok(
    drivers.length >= 2,
    `only ${drivers.length} driver(s) import the installation panel's vocabulary, so this guard has no premise`,
  );
  for (const file of drivers) {
    const source = readFileSync(join(captureDirectory, file), "utf8");
    assert.match(
      source,
      /waitForPanelSettled\(/u,
      `${file} drives the installation panel without waitForPanelSettled: a fixed delay cannot tell "still working" from "the answer"`,
    );
    assert.match(
      source,
      /settledStates: INSTALLATION_[A-Z_]+_STATES/u,
      `${file} passes hand-written states to waitForPanelSettled instead of the panel's own vocabulary`,
    );
  }
});

/*
 * The settled-state wait, held without a browser.
 *
 * The scripted page answers in the shape `waitForPanelSettled`'s in-page function returns, so what is pinned here
 * is the RULE - which readings are an answer and which are not - and not the selector semantics, which belong to
 * the browser and are what a live run exercises.
 */
const INSTALLATION_PANEL = {
  name: "installation",
  panel: ".game-installation-panel",
  settledStates: INSTALLATION_DISCOVERY_STATES.settled,
};

function scriptedStates(states) {
  const asked = [];
  return {
    asked,
    async evaluate(_pageFunction, argument) {
      const index = asked.length;
      asked.push(argument);
      const state = states[index] ?? states[states.length - 1];
      return state === null ? { panel: false, state: null } : { panel: true, state };
    },
    async waitForTimeout(_ms) {},
  };
}

test("a settled state that holds across two reads is accepted, with what the wait read on the way", async () => {
  const page = scriptedStates(["loading", "candidates", "candidates"]);
  const reading = await waitForPanelSettled(page, INSTALLATION_PANEL);
  assert.equal(reading.state, "candidates");
  assert.deepEqual(reading.observed, ["loading", "candidates"], "the wait reports every state it read, in order");
  assert.equal(page.asked.length, 3);
  assert.equal(page.asked[0], ".game-installation-panel");
});

test("the panel's working states are never read as the answer", async () => {
  // `frontend--r13`: the Host had answered `resolved` with one candidate, and the panel still read `retrying` -
  // which draws the candidate rows it already has, so the read LOOKED like the answer.
  const page = scriptedStates(["retrying", "retrying", "retrying", "candidates", "candidates"]);
  const reading = await waitForPanelSettled(page, INSTALLATION_PANEL);
  assert.equal(reading.state, "candidates", "the answer is the state the panel settles in, not the one it works in");
  assert.deepEqual(reading.observed, ["retrying", "candidates"]);
});

test("a panel that never leaves its working states fails by name, quoting what it read", async () => {
  const page = scriptedStates(["loading", "retrying"]);
  await assert.rejects(waitForPanelSettled(page, { ...INSTALLATION_PANEL, timeoutMs: 40, settleMs: 5 }), (error) => {
    assert.match(error.message, /panel_never_settled:installation/u);
    assert.match(error.message, /\.game-installation-panel/u, "the failure names the panel it waited for");
    assert.match(error.message, /it reported \["loading","retrying"\]/u, "and every state it read on the way");
    assert.match(error.message, /"candidates"/u, "and the answers it would have accepted");
    return true;
  });
});

test("a panel that is not in the DOM at all says so instead of reporting a state", async () => {
  const page = scriptedStates([null]);
  await assert.rejects(waitForPanelSettled(page, { ...INSTALLATION_PANEL, timeoutMs: 30, settleMs: 5 }), (error) => {
    assert.match(error.message, /no element matched \.game-installation-panel/u);
    return true;
  });
});

test("a settled state the caller did not accept is not an answer either", async () => {
  // The 取消 case: the panel keeps the state it had while the request is outstanding, so a caller that has just
  // pressed a control passes the answers that control can reach - and the state from before the press is not one.
  const page = scriptedStates(["candidates"]);
  await assert.rejects(
    waitForPanelSettled(page, {
      ...INSTALLATION_PANEL,
      settledStates: ["cancelled", "error"],
      timeoutMs: 40,
      settleMs: 5,
    }),
    (error) => {
      assert.match(error.message, /it reported \["candidates"\]/u);
      return true;
    },
  );
});

test("a wait without the states it accepts is refused before it reads anything", async () => {
  const page = scriptedStates(["candidates"]);
  await assert.rejects(
    waitForPanelSettled(page, { ...INSTALLATION_PANEL, settledStates: [] }),
    /requires_the_states_it_accepts/u,
  );
  assert.equal(page.asked.length, 0);
});
