import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { catalogDefaultLifecycle, checkPromotionPlaces } from "./check-stardew-promotion-parity.mjs";
import { PROMOTION_PATHS } from "./promote-stardew-action.mjs";
import { parseKnownFixtureScenarios } from "./prelive.mjs";

/**
 * Falsifiers for "a promotion has one path".
 *
 * `tools/promote-stardew-action.mjs` moves an action through four places in one pass: the Mod catalog's
 * lifecycle, the published gate table, the experimental runner map and the fixture scenario. Nothing could
 * see a hand edit that moved two of them, so an action could sit at `live_verified` with its runner still in
 * the experimental map (or with no gate row at all) and every other gate stayed green.
 *
 * Every case below injects the half-promotion into the REAL catalog and gate-descriptor sources - the
 * parsers are the promotion tool's own, imported here rather than restated, so a case that cannot apply its
 * mutation fails loudly instead of asserting against an unchanged tree.
 *
 * red-proof: inject  deleting use_mine_ladder's published gate row -> `promotion_places_disagree:use_mine_ladder:`
 *   `catalog=live_verified;gate=absent` (tools/check-stardew-promotion-parity.test.mjs)
 */

const root = resolve(import.meta.dirname, "..");
const catalogSource = await readFile(resolve(root, PROMOTION_PATHS.modCatalog), "utf8");
const gateDescriptorSource = await readFile(resolve(root, PROMOTION_PATHS.gateDescriptors), "utf8");
const knownScenarios = parseKnownFixtureScenarios(
  await readFile(resolve(root, "integrations/stardew/ModConfig.cs"), "utf8"),
);

/** The fixture's own answer, injected so a case can state what the library does or does not model. */
const noFixture = () => ({ modelled: false, scenario: null });

function check({ catalog = catalogSource, gates = gateDescriptorSource, fixtureScenarioFor = noFixture } = {}) {
  return checkPromotionPlaces({
    catalogSource: catalog,
    gateDescriptorSource: gates,
    knownScenarios,
    fixtureScenarioFor,
  });
}

/** Replace exactly one occurrence, and fail the case if the anchor no longer exists. */
function replaceOnce(source, search, replacement) {
  const at = source.indexOf(search);
  assert.ok(at >= 0, `the mutation anchor must still exist: ${search.slice(0, 80)}`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

const USE_MINE_LADDER_ROW = `  gate(
    "use_mine_ladder",
    1,
    "run-stardew-native-local-player-use-mine-ladder-smoke.mjs",
    "mine_left",
    "native_mine_use_ladder_exit_v1",
  ),
`;

test("the real tree's four places agree for every catalog action", () => {
  const report = check();
  assert.deepEqual(report.findings, [], JSON.stringify(report.findings, null, 2));
  assert.ok(report.checked > 90, `the population is the catalog, measured ${report.checked}`);
  assert.equal(report.checked, report.total, "every catalog registration is compared, none skipped");
});

test("a live_verified action with no gate row names the catalog's rung and the missing place", () => {
  const gates = replaceOnce(gateDescriptorSource, USE_MINE_LADDER_ROW, "");
  assert.deepEqual(check({ gates }).findings, [
    "promotion_places_disagree:use_mine_ladder:catalog=live_verified;gate=absent",
  ]);
});

test("the half-promotion - catalog promoted, runner still in the experimental map - is named", () => {
  const experimentalEntry = `  hold_absorption: "run-stardew-native-local-player-hold-absorption-smoke.mjs",\n`;
  const gates = replaceOnce(
    gateDescriptorSource,
    experimentalEntry,
    `${experimentalEntry}  use_mine_ladder: "run-stardew-native-local-player-use-mine-ladder-smoke.mjs",\n`,
  );
  assert.deepEqual(check({ gates }).findings, [
    "promotion_places_disagree:use_mine_ladder:catalog=live_verified;experimental=present:run-stardew-native-local-player-use-mine-ladder-smoke.mjs",
  ]);
});

test("a gate row whose fixture scenario disagrees with the fixture library is named on both sides", () => {
  const gates = replaceOnce(
    gateDescriptorSource,
    USE_MINE_LADDER_ROW,
    USE_MINE_LADDER_ROW.replace('    "native_mine_use_ladder_exit_v1",\n', ""),
  );
  const report = check({
    gates,
    fixtureScenarioFor: (actionId) =>
      actionId === "use_mine_ladder"
        ? { modelled: true, scenario: "native_mine_use_ladder_exit_v1" }
        : { modelled: false, scenario: null },
  });
  assert.deepEqual(report.findings, [
    "promotion_places_disagree:use_mine_ladder:catalog=live_verified;fixture=none;fixture_library=native_mine_use_ladder_exit_v1",
  ]);
});

test("a gate row naming a scenario the Mod does not declare is named, even when the library cannot model it", () => {
  const gates = replaceOnce(
    gateDescriptorSource,
    USE_MINE_LADDER_ROW,
    USE_MINE_LADDER_ROW.replace("native_mine_use_ladder_exit_v1", "native_invented_world_v9"),
  );
  assert.deepEqual(check({ gates }).findings, [
    "promotion_places_disagree:use_mine_ladder:catalog=live_verified;fixture=native_invented_world_v9",
  ]);
});

test("an experimental action that already carries a gate row is named", () => {
  // rotate_furniture is experimental today, so promoting the catalog alone (the row and the runner map
  // untouched) is the half-write a hand edit leaves behind.
  const catalog = catalogSource.replace(
    /(E\("rotate_furniture"[\s\S]*?FarmhandActionLifecycle\.)Experimental/u,
    "$1LiveVerified",
  );
  assert.notEqual(catalog, catalogSource, "the mutation must actually apply");
  const report = check({ catalog });
  // Both halves of the half-write are named: no gate row appeared, and the runner never left the map.
  assert.deepEqual(report.findings, [
    "promotion_places_disagree:rotate_furniture:catalog=live_verified;gate=absent;experimental=present:run-stardew-native-local-player-rotate-furniture-smoke.mjs",
  ]);
});

test("an unreadable catalog default lifecycle is a finding, never a guessed rung", () => {
  assert.equal(catalogDefaultLifecycle(catalogSource), "published");
  const catalog = replaceOnce(
    catalogSource,
    "FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published",
    "FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Unstated",
  );
  assert.equal(catalogDefaultLifecycle(catalog), null);
  const report = check({ catalog });
  assert.ok(report.findings.includes("catalog_default_lifecycle_unreadable"), JSON.stringify(report.findings));
});

test("an empty population is blocked by name instead of passing", () => {
  const report = check({ catalog: "public static class Empty { }", gates: "" });
  assert.ok(report.findings.includes("promotion_parity_population_empty"), JSON.stringify(report.findings));
});
