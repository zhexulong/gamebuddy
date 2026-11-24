// The two container-deposit lanes: a scenario id that EXISTS, a Given that is armed on its own, and a route the
// coverage gate can see.
//
// WHY THIS FILE LIVES HERE. The registry it holds is `tools/lib/stardew-native-local-player-fixture.mjs`, whose two
// tables answer the whole chain a run starts from: `--action` -> the enabled capability set (`fixtureActions`) -> the
// `NativeLocalPlayerFixture.FixtureScenario` the fixture writes (`fixtureScenario`) -> the world a
// `NativeLocalFixtureScenarioRow` builds. Nothing tied a lane to the Mod row it names, so a scenario that no `--action`
// reaches - or one naming a row the Mod would refuse - was invisible until a run armed it: this lane was exactly that
// shape, with `put_item_in_fish_tank` and `place_item_on_pedestal` registered, their Givens implemented in
// `ModEntry.Fixtures.PlacedDepositTargets.cs`, and no lane that armed either.
//
// The three facts are asserted together because any one alone is satisfiable by a world that cannot be run: a lane key
// with the wrong scenario, a scenario the Mod's table has no row for, and a scenario whose action has no route on the
// coverage gate's population.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveStardewActionGateRoute } from "../../lib/stardew-action-gate-route.mjs";
import { fixtureActions, fixtureScenario } from "../../lib/stardew-native-local-player-fixture.mjs";
import {
  CATALOG_PATH,
  checkLiveRunnerCoverage,
  gateArtifactsInIndex,
} from "../../../gates/stardew/check-stardew-live-runner-coverage.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The two lanes this file holds, each with the ONE scenario its Given builds. */
const CONTAINER_DEPOSIT_LANES = Object.freeze({
  put_item_in_fish_tank: "native_put_item_in_fish_tank_v1",
  place_item_on_pedestal: "native_place_item_on_pedestal_v1",
});

/**
 * Every `native_*_vN` scenario the Mod's fixture code declares as a ROW, as `name -> <file>:<line>`.
 *
 * `ModEntry` is a partial class, so the table is spread over every `ModEntry.Fixtures*.cs`: the population is a
 * directory scan and the row shape is read from the declaration, never from a list here.
 */
function declaredModScenarioRows() {
  const modRoot = resolve(ROOT, "integrations", "stardew");
  const rows = new Map();
  for (const file of readdirSync(modRoot).filter((name) => /^ModEntry\.Fixtures.*\.cs$/u.test(name))) {
    const source = readFileSync(resolve(modRoot, file), "utf8");
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/NativeLocalFixtureScenarioRow\.\w+\("(native_[a-z0-9_]+_v\d+)"/gu))
        if (!rows.has(match[1])) rows.set(match[1], `integrations/stardew/${file}:${index + 1}`);
    });
  }
  return rows;
}

const MOD_SCENARIO_ROWS = declaredModScenarioRows();

test("every container-deposit lane arms its own Given and nothing else", () => {
  assert.ok(MOD_SCENARIO_ROWS.size > 0, "the Mod's fixture scenario table was not read, so nothing below is measured");
  const wrong = [];
  for (const [lane, scenario] of Object.entries(CONTAINER_DEPOSIT_LANES)) {
    const actions = fixtureActions(lane);
    if (actions.length !== 1 || actions[0] !== lane)
      wrong.push(`${lane}: the lane grants [${actions.join(",")}], so a run of it would do more than the one action`);
    const armed = fixtureScenario(actions, lane);
    if (armed !== scenario) wrong.push(`${lane}: arms ${armed || '""'}, not ${scenario}`);
    if (!MOD_SCENARIO_ROWS.has(armed))
      wrong.push(
        `${lane}: arms ${armed}, which no NativeLocalFixtureScenarioRow declares under integrations/stardew/ModEntry.Fixtures*.cs`,
      );
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("neither container-deposit world is reachable from another lane", () => {
  // A scenario that a SECOND lane also selects would make the `--action` that armed it ambiguous: the run would build a
  // world for an action it is not testing, and the lane's own Given would never arm. Every lane key is tried.
  const lanes = readFileSync(resolve(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs"), "utf8");
  const declared = [...lanes.matchAll(/if \(action === "([a-z0-9_]+)"\) return \[([^\]]*)\];/gu)].map((match) => ({
    lane: match[1],
    actions: [...match[2].matchAll(/"([a-z0-9_]+)"/gu)].map((id) => id[1]),
  }));
  assert.ok(declared.length > 100, `expected the fixture's lane table, got ${declared.length} lane(s)`);
  const collisions = [];
  for (const [lane, scenario] of Object.entries(CONTAINER_DEPOSIT_LANES)) {
    for (const candidate of declared) {
      if (candidate.lane === lane) continue;
      let armed = null;
      try {
        armed = fixtureScenario(candidate.actions, candidate.lane);
      } catch {
        continue;
      }
      if (armed === scenario) collisions.push(`${candidate.lane} also arms ${scenario}`);
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `a container-deposit world is reachable from another lane:\n${collisions.join("\n")}`,
  );
});

test("the coverage gate's population sees both container-deposit actions as routed", () => {
  const catalogSource = readFileSync(resolve(ROOT, CATALOG_PATH), "utf8");
  const artifacts = gateArtifactsInIndex({ root: ROOT });
  const report = checkLiveRunnerCoverage({ catalogSource, artifacts });
  if (report.blocked !== null) assert.fail(`not_measured:${report.blocked}`);
  // The reading is not vacuous: the population IS the Mod catalog, and it was read in full.
  assert.ok(report.examined > 90, `the catalog population read ${report.examined} action(s)`);
  const unrouted = report.unrouted.map((entry) => `${entry.actionId} (${entry.finding})`);
  for (const lane of Object.keys(CONTAINER_DEPOSIT_LANES)) {
    const route = resolveStardewActionGateRoute(lane);
    assert.equal(route.problem, null, `${lane}: ${route.problem?.code} ${route.problem?.detail ?? ""}`.trim());
    assert.equal(route.route, "runner", `${lane}: the live gate must be a runner route, got ${String(route.route)}`);
    assert.ok(
      !report.unrouted.some((entry) => entry.actionId === lane),
      `${lane} is still reported without a live gate: ${unrouted.join(", ")} (untracked gate artifacts the index does ` +
        `not carry yet: ${artifacts.untracked.join(", ") || "none"})`,
    );
  }
});
