import assert from "node:assert/strict";
import test from "node:test";

import {
  DECLARATION_NAME,
  declaredWindows,
  judge,
  perActionSelectors,
  publishedKinds,
  publishedWindows,
} from "./check-deadline-ceiling-declaration.mjs";
import { parseJavaScript } from "../../tools/lib/javascript-ast.mjs";

/**
 * The falsifiers for `check-deadline-ceiling-declaration.mjs`, driven through the gate's OWN reading.
 *
 * <p>
 * The gate's real population is a checkout: 305 Host sources parsed, one artifact read. That is the right population for
 * the verdict and the wrong one for a falsifier - a test that edits the tree to make a gate red is a test that cannot run
 * beside another lane. So the reading is exported as functions over (tree, action ids) and these cases drive it with
 * in-memory sources: the shape that shipped, the shape that replaced it, and the ways a declaration can stop covering an
 * action.
 * </p>
 *
 * <p>
 * Each case asserts the FINDING and the reason, not a count alone: a classifier that reported every node it saw would
 * satisfy `fromNameList > 0` and be useless. The `other per-action values` case is the one that keeps the rule narrow -
 * `local-stardew-bridge.ts` chooses a STRING from an action id (a scene kind), which is not a deadline and must not be
 * reported as one.
 * </p>
 *
 * red-proof: inject  the classifier widened to call every per-action selector a window (`numericValue = () => true`) ->
 *                   `a selector that chooses a STRING is not a deadline ceiling, and is counted apart` fails
 *                   (`8 passed, 1 failed`, measured 2026-11-16).
 * red-proof: inject  the classifier narrowed to call none of them one (`numericValue = () => false`) ->
 *                   `the shape that shipped is a numeric selector over action ids, and the gate calls it a name list`
 *                   and `the site counts add up, so no part of the population escapes a bucket` fail
 *                   (`7 passed, 2 failed`, measured 2026-11-16).
 */

const ACTION_IDS = new Set(["move_to_tile", "travel", "navigate_to_destination", "sleep"]);

/** The shape that shipped: a ceiling chosen by comparing two action ids. */
const NAME_LIST_SOURCE = `
const CEILING = 600_000;
export function deadlineCeiling(action: string): number {
  const ceiling = action === "navigate_to_destination" || action === "sleep" ? 600_000 : 60_000;
  return ceiling;
}
`;

/** The shape that replaced it: one declaration, read by action. */
const DECLARATION_SOURCE = `
export const ${DECLARATION_NAME}: Readonly<Record<string, number>> = Object.freeze({
  move_to_tile: 60_000,
  travel: 60_000,
  navigate_to_destination: 600_000,
  sleep: 600_000,
});
export function deadlineCeiling(action: string): number | null {
  return declaredDeadlineWindow(${DECLARATION_NAME}, action);
}
`;

/** A per-action value that is NOT a number: the label chooser that already lives in `local-stardew-bridge.ts`. */
const STRING_SELECTOR_SOURCE = `
export function sceneKind(actionId: string): string {
  return actionId === "observe_scene" ? "world_perception" : "world_navigation";
}
`;

const WINDOWS_ARTIFACT = {
  schema: "gamebuddy-action-deadline-windows/v1",
  catalogRevision: 1,
  windows: [
    { actionId: "move_to_tile", admittedMs: 60_000 },
    { actionId: "travel", admittedMs: 60_000 },
    { actionId: "navigate_to_destination", admittedMs: 600_000 },
    { actionId: "sleep", admittedMs: 600_000 },
    { actionId: "observe_scene", admittedMs: 60_000 },
  ],
};

const SURFACE = {
  actions: [
    { actionId: "move_to_tile", kind: "execution" },
    { actionId: "travel", kind: "execution" },
    { actionId: "navigate_to_destination", kind: "execution" },
    { actionId: "sleep", kind: "execution" },
    { actionId: "observe_scene", kind: "read_only" },
  ],
};

async function selectorsOf(source, actionIds = new Set([...ACTION_IDS, "observe_scene"])) {
  const tree = await parseJavaScript(source, "case.ts");
  return perActionSelectors(tree, actionIds);
}

async function declaredOf(source = DECLARATION_SOURCE) {
  return declaredWindows(await parseJavaScript(source, "case.ts"));
}

/** The gate's verdict over the fixture artifact, one declaration and the selectors found in one source. */
function verdictOf({ selectors = [], declaration, sources = 1 }) {
  return judge({
    actionIds: publishedWindows(WINDOWS_ARTIFACT),
    declaration,
    selectors,
    sources,
    kinds: publishedKinds(SURFACE),
  });
}

test("the shape that shipped is a numeric selector over action ids, and the gate calls it a name list", async () => {
  const selectors = await selectorsOf(NAME_LIST_SOURCE);
  assert.deepEqual(
    selectors.map((selector) => [...selector.ids].sort()),
    [["navigate_to_destination", "sleep"]],
    "the ternary must be read, and both actions it chooses between are named",
  );
  assert.equal(selectors[0]?.yieldsWindow, true, "it chooses 600_000 / 60_000, so it is a deadline ceiling by name");

  const verdict = verdictOf({
    declaration: await declaredOf(),
    selectors: selectors.map((selector) => ({ ...selector, site: "host/src/protocol.ts" })),
  });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(
    verdict.findings.filter((finding) => finding.startsWith("deadline_ceiling_is_a_name_list:")),
    [
      `deadline_ceiling_is_a_name_list:host/src/protocol.ts:${selectors[0]?.row}:action === "navigate_to_destination" || action === "sleep" ? 600_000 : 60_000`,
    ],
  );
  assert.equal(verdict.sites.fromNameList, 1);
});

test("the declaration that replaced it is read as a table, and yields no name list", async () => {
  const declaration = await declaredOf();
  assert.deepEqual(
    [...declaration.windows],
    [
      ["move_to_tile", 60_000],
      ["travel", 60_000],
      ["navigate_to_destination", 600_000],
      ["sleep", 600_000],
    ],
  );
  assert.deepEqual(declaration.problems, []);

  const selectors = await selectorsOf(DECLARATION_SOURCE);
  assert.deepEqual(selectors, [], "a lookup is not a selector: nothing in it compares an action id to a literal");
  const verdict = verdictOf({ declaration });
  assert.equal(verdict.status, "passed", verdict.findings.join("\n"));
  assert.equal(verdict.sites.examined, 4);
  assert.equal(verdict.sites.fromDeclaration, 4);
  assert.equal(verdict.windows.readOnly, 1, "observe_scene is published read_only, so it needs no dispatch window");
});

test("a selector that chooses a STRING is not a deadline ceiling, and is counted apart", async () => {
  const selectors = await selectorsOf(STRING_SELECTOR_SOURCE);
  assert.deepEqual(
    selectors.map((selector) => [...selector.ids].sort()),
    [["observe_scene"]],
    "the string chooser is read as one selector, naming the action it chooses a label for",
  );
  assert.equal(selectors[0]?.yieldsWindow, false);
  const verdict = verdictOf({ declaration: await declaredOf(), selectors });
  assert.equal(verdict.status, "passed", "a label chooser must not be reported as a deadline ceiling");
  assert.equal(verdict.sites.fromNameList, 0);
});

test("falsifier: a published action the declaration does not cover is named, never silently capped", async () => {
  const declaration = await declaredOf();
  declaration.windows.delete("travel");
  const verdict = verdictOf({ declaration });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.findings, [
    "deadline_window_not_declared:travel:the Mod publishes a window and the Host declares none",
  ]);
  assert.equal(verdict.windows.undeclared, 1);
  assert.equal(
    verdict.windows.declared + verdict.windows.readOnly + verdict.windows.undeclared,
    verdict.windows.examined,
  );
});

test("falsifier: an action declared here and not published by the Mod is named", async () => {
  const declaration = await declaredOf();
  declaration.windows.set("sell_item", 60_000);
  const verdict = verdictOf({ declaration });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.findings, [
    "deadline_window_not_published:sell_item:declared here, not published by the Mod",
  ]);
  assert.equal(
    verdict.sites.fromDeclaration,
    5,
    "the extra entry is still a declared site, and it is the one that fails",
  );
});

test("falsifier: a declared window that disagrees with the Mod's number names both values", async () => {
  const declaration = await declaredOf();
  declaration.windows.set("travel", 300_000);
  const verdict = verdictOf({ declaration });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.findings, ["deadline_window_disagrees:travel:the Mod declares 60000 ms, the Host 300000"]);
});

test("falsifier: a declaration value that is not a number is a malformed entry, not a smaller population", async () => {
  const declaration = await declaredOf(`
export const ${DECLARATION_NAME} = Object.freeze({
  move_to_tile: 60_000,
  travel: ordinaryWindow(),
});
`);
  assert.equal(declaration.windows.size, 1);
  assert.deepEqual(declaration.problems, [
    "travel: the declared value is not a whole number of milliseconds (ordinaryWindow())",
  ]);
  const verdict = verdictOf({ declaration });
  assert.equal(verdict.status, "failed");
  assert.ok(
    verdict.findings.includes(
      "deadline_window_malformed:travel: the declared value is not a whole number of milliseconds (ordinaryWindow())",
    ),
  );
});

test("blocked: a declaration that is not there, an artifact with no window, and a run over no source", async () => {
  await assert.rejects(
    () => declaredOf("export const OTHER = Object.freeze({ move_to_tile: 60_000 });"),
    (error) => error.code === "deadline_declaration_not_found",
  );
  await assert.rejects(
    () =>
      declaredOf("export const EXECUTION_REQUEST_DEADLINE_WINDOWS_NOTE = 1;\nexport const OTHER = Object.freeze({});"),
    (error) => error.code === "deadline_declaration_not_found",
    "a different identifier that merely starts with the name is not the declaration",
  );
  assert.throws(
    () => publishedWindows({ schema: "gamebuddy-action-deadline-windows/v1", windows: [] }),
    (error) => error.code === "deadline_windows_population_empty",
  );
  assert.throws(
    () => publishedWindows({ schema: "something-else/v1", windows: [{ actionId: "travel", admittedMs: 1 }] }),
    (error) => error.code === "deadline_windows_schema_unexpected",
  );
  const verdict = verdictOf({ declaration: await declaredOf(), sources: 0 });
  assert.equal(verdict.status, "blocked", "a run that parsed no source is blocked, never green");
  assert.equal(verdict.blockedReading, "no Host production source was parsed");
});

test("the site counts add up, so no part of the population escapes a bucket", async () => {
  const declaration = await declaredOf();
  const selectors = (await selectorsOf(NAME_LIST_SOURCE)).map((selector) => ({
    ...selector,
    site: "host/src/protocol.ts",
  }));
  const verdict = verdictOf({ declaration, selectors });
  assert.equal(verdict.sites.examined, verdict.sites.fromDeclaration + verdict.sites.fromNameList);
  assert.equal(verdict.windows.examined, 5);
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.sites.fromNameList, 1);
});
