import assert from "node:assert/strict";
import test from "node:test";

import { assertBuildFarmBuildingPostconditions } from "./run-stardew-native-local-player-build-farm-building-smoke.mjs";

/**
 * The build_farm_building live judgement, tested DIRECTLY.
 *
 * The judgement is pure and exported, so it is exercised here with no transport at all, which is
 * also what makes these cases meaningful: each one is a way the LIVE run could lie. One case per
 * way, plus the surface-absent case, which must report `not_checked` rather than a pass.
 */

const TARGET = {
  targetId: "build_site_0123456789abcdef",
  kind: "build_site",
  location: "Farm",
  x: 40,
  y: 20,
  buildingType: "Coop",
  buildCost: 6000,
  buildDays: 3,
};

const EVIDENCE = {
  target: TARGET.targetId,
  location: "Farm",
  tile: "40,20",
  building_type: "Coop",
  building_id: "3f2504e04f8911d39a0c0305e82c3301",
  money_before: "12000",
  money_after: "6000",
  build_cost: "6000",
  materials_before: "10",
  materials_after: "0",
  materials_required: "10",
  build_days: "3",
  days_of_construction_left: "3",
  magical: "false",
  tile_building_after: "Coop",
  native_placement: "true",
};

const BUILT = {
  targetId: "built_3f2504e04f8911d39a0c0305e82c3301",
  kind: "built",
  location: "Farm",
  x: 40,
  y: 20,
  buildingType: "Coop",
  buildingId: "3f2504e04f8911d39a0c0305e82c3301",
  daysOfConstructionLeft: 3,
};

const sitesAfter = () => [];
const builtAfter = (overrides = {}) => [{ ...BUILT, ...overrides }];

test("the honest happy path passes every check", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.deepEqual(checks, {
    siteNoLongerAdvertised: true,
    buildingPresentAtTile: true,
    receiptNamesTheBuilding: true,
    moneyCharged: true,
    materialsConsumed: true,
    constructionDaysMatch: true,
  });
});

test("a site still advertised after the build fails: the published fact must change", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    sitesAfter: [{ ...TARGET }],
    builtAfter: builtAfter(),
  });
  assert.equal(checks.siteNoLongerAdvertised, false);
});

test("no built entry on the named tile fails: the structure must be in the world", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter({ x: 41 }),
  });
  assert.equal(checks.buildingPresentAtTile, false);
});

test("a built entry of a DIFFERENT type on that tile fails", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter({ buildingType: "Barn" }),
  });
  assert.equal(checks.buildingPresentAtTile, false);
});

test("a receipt naming a DIFFERENT structure than the world shows fails", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, building_id: "00000000000000000000000000000000" },
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.equal(checks.receiptNamesTheBuilding, false);
});

test("a receipt claiming a build that did not charge fails", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, money_after: "12000" },
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.equal(checks.moneyCharged, false);
});

test("a receipt whose cost is not the published type's cost fails", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, build_cost: "0", money_after: "12000" },
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.equal(checks.moneyCharged, false);
});

test("materials that were not consumed fail", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, materials_after: "10" },
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.equal(checks.materialsConsumed, false);
});

test("construction days that are not the building data's own BuildDays fail", () => {
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, days_of_construction_left: "0" },
    sitesAfter: sitesAfter(),
    builtAfter: builtAfter(),
  });
  assert.equal(checks.constructionDaysMatch, false);
});

test("an observation surface with no built entries reports not_checked, NEVER a pass", () => {
  // The distinction this test exists for: "I could not look" must not read as "the structure is
  // not there" - and the runner treats `not_checked` as a failure, so a surface that cannot show
  // the built entries cannot silently bless a run.
  const checks = assertBuildFarmBuildingPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    sitesAfter: sitesAfter(),
    builtAfter: null,
  });
  assert.equal(checks.buildingPresentAtTile, "not_checked");
  assert.equal(checks.receiptNamesTheBuilding, "not_checked");
  assert.equal(
    Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").length,
    2,
    "the run must fail, on exactly these two checks",
  );
});
