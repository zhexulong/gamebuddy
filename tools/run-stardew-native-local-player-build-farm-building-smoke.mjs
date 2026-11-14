// Stardew-local build_farm_building smoke: production native client, bounded scope, revision-bound requests, exact
// receipt identity, terminal wait, the stale re-send and owned teardown all come from the shared template
// (`tools/lib/native-local-runner-scaffold.mjs`). Action-specific logic - which published site, what the receipt must
// have observed, and what "the world did not move" means for a site that now holds a building - stays in this runner.
//
// The receipt is not the proof. Five things are observed directly, and the first is the one
// that makes the action worth having:
//
//   1. the site comes from the Mod's own `farmBuildingTargets` projection (`kind ===
//      "build_site"`), never from this runner — the request names the tile and the opaque id
//      discovery published for it;
//   2. the world CHANGED: the same projection now publishes a `built` entry on exactly that
//      tile carrying the requested building type and the id the receipt names. A `built`
//      surface that is absent is `not_checked`, never a pass;
//   3. the commission's SITE left discovery — a tile that now holds the building is not a
//      place a building can go, so the published candidate must be gone;
//   4. the receipt's own postcondition agrees with the world: money dropped by exactly the
//      declared cost, each declared material left the inventory, and the construction days
//      equal the building data's own `BuildDays`;
//   5. RESUBMITTING THE SAME TARGET is refused by name and moves nothing. The tile now holds
//      the building, so a second success there would be a second structure (or a silent
//      no-op reported as success); the run fails rather than passing on a green receipt.
//
// The runner never chooses the site or the building type: both come from the projection.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "build_farm_building";
/** The action's own success word (`ExecuteBuildFarmBuilding`: the structure is placed and commissioned). */
const SUCCESS_CODE = "farm_building_built";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_build_farm_building_v1`). */
const FIXTURE_SCENARIO = "native_build_farm_building_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["farmBuildingTargets"] },

  /** The commission site the fixture established, as discovery publishes it. */
  prepare: ({ snapshot }) => ({ snapshot, plan: { target: chooseBuildSite(snapshot) } }),

  describePlan: ({ target }) => ({
    target: target.targetId,
    tile: `${target.x},${target.y}`,
    buildingType: target.buildingType,
    buildCost: target.buildCost,
    buildDays: target.buildDays,
  }),

  request: ({ target }) => ({
    args: { buildingType: target.buildingType, x: target.x, y: target.y, expectedTargetId: target.targetId },
  }),

  /**
   * The negative case, declared to the template: the tile the build consumed is not a place a building can go any
   * more, so the same target must be refused and the world it left behind must be the world the build left behind.
   */
  negative: {
    args: ({ target }) => ({
      buildingType: target.buildingType,
      x: target.x,
      y: target.y,
      expectedTargetId: target.targetId,
    }),
    refusedCodes: ["build_farm_building_site_blocked"],
    unchanged: ({ before, after }) => {
      const sitesBefore = buildSites(before)
        .map((entry) => entry.targetId)
        .join(",");
      const sitesAfter = buildSites(after)
        .map((entry) => entry.targetId)
        .join(",");
      if (sitesBefore !== sitesAfter) return `sites:${sitesBefore}->${sitesAfter}`;
      const builtBefore = (builtBuildings(before) ?? []).map((entry) => entry.buildingId).join(",");
      const builtAfter = (builtBuildings(after) ?? []).map((entry) => entry.buildingId).join(",");
      return builtBefore === builtAfter ? null : `built:${builtBefore}->${builtAfter}`;
    },
  },

  async assertPostcondition({ evidence, plan, after }) {
    const { target } = plan;
    const checks = assertBuildFarmBuildingPostconditions({
      target,
      evidence,
      sitesAfter: buildSites(after),
      builtAfter: builtBuildings(after),
    });
    const failures = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failures.length > 0)
      throw new Error(
        `build_farm_building live contract failed: ${failures.join(",")};checks=${JSON.stringify(checks)}`,
      );
    return { checks, target: target.targetId, buildingType: target.buildingType, evidence };
  },
});

export const runBuildFarmBuildingSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport:
 * the published projection before and after, and the receipt's evidence.
 *
 * `buildingPresentAtTile` is `not_checked` — not `true` — when the observation surface does not
 * carry the built entries at all, because "I could not look" and "the structure is not there"
 * must never read the same, and the caller treats `not_checked` as a failure.
 */
export function assertBuildFarmBuildingPostconditions({ target, evidence, sitesAfter, builtAfter }) {
  const observable = Array.isArray(builtAfter);
  const built = observable
    ? builtAfter.find((entry) => entry?.kind === "built" && entry.x === target.x && entry.y === target.y)
    : null;
  return {
    // The published fact changed: a tile that now holds the building is not a build site.
    siteNoLongerAdvertised: !sitesAfter.some((entry) => entry?.targetId === target.targetId),
    // The structure exists on the named tile, re-read from the world.
    buildingPresentAtTile: observable ? built != null && built.buildingType === target.buildingType : "not_checked",
    // And it is the very structure the receipt named.
    receiptNamesTheBuilding: observable
      ? built != null &&
        typeof evidence.building_id === "string" &&
        evidence.building_id.length > 0 &&
        built.buildingId === evidence.building_id
      : "not_checked",
    // Money and materials are part of the world change, so the debit is asserted, not assumed.
    moneyCharged:
      evidence.build_cost === String(target.buildCost) &&
      Number.isSafeInteger(Number(evidence.money_before)) &&
      Number.isSafeInteger(Number(evidence.money_after)) &&
      Number(evidence.money_after) === Number(evidence.money_before) - Number(evidence.build_cost),
    materialsConsumed:
      Number.isSafeInteger(Number(evidence.materials_before)) &&
      Number.isSafeInteger(Number(evidence.materials_after)) &&
      Number.isSafeInteger(Number(evidence.materials_required)) &&
      Number(evidence.materials_after) === Number(evidence.materials_before) - Number(evidence.materials_required),
    // Construction TIME is the building data's own BuildDays (0 for a magical build).
    constructionDaysMatch:
      evidence.build_days === String(target.buildDays) &&
      evidence.days_of_construction_left === String(target.buildDays),
  };
}

/** The commission site the fixture established, as discovery publishes it. */
function chooseBuildSite(snapshot) {
  const candidates = buildSites(snapshot);
  if (candidates.length === 0)
    throw new Error(`no farm-building site is advertised: ${JSON.stringify(snapshot?.farmBuildingTargets)}`);
  return candidates[0];
}

function buildSites(snapshot) {
  const targets = snapshot?.farmBuildingTargets;
  return Array.isArray(targets) ? targets.filter((entry) => entry?.kind === "build_site") : [];
}

/** The buildings the world now reports, or null when the surface does not carry them at all. */
function builtBuildings(snapshot) {
  const targets = snapshot?.farmBuildingTargets;
  return Array.isArray(targets) ? targets.filter((entry) => entry?.kind === "built") : null;
}
