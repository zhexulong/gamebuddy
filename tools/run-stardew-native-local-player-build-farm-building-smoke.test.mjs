import assert from "node:assert/strict";
import test from "node:test";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  assertBuildFarmBuildingPostconditions,
  runBuildFarmBuildingSmoke,
} from "./run-stardew-native-local-player-build-farm-building-smoke.mjs";

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

/**
 * THE RUNNER ITSELF, driven end to end through the shared template.
 *
 * The judgement above is pure, so it cannot see the lifecycle: whether the unarmed config is refused, whether the
 * request carries the published building type and site id, and - the half the pure function never judged - whether the
 * STALE RE-SEND is refused and moves nothing.
 */
const RUNNER_CAPABILITIES = ["cancel_active_execution", "inspect_self", "build_farm_building"];

function validConfig() {
  return {
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_build_farm_building_v1",
    },
  };
}

const SITE = { ...TARGET };

function evidenceDetail(overrides = {}) {
  const fields = { ...EVIDENCE, ...overrides };
  return {
    detail: Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(";"),
  };
}

function snapshotWith(targets, revision = 1) {
  return {
    revision,
    location: "Farm",
    tile: { x: 39, y: 20 },
    actionable: true,
    activeExecution: null,
    capabilities: RUNNER_CAPABILITIES,
    farmBuildingTargets: targets,
  };
}

/**
 * A fake Mod. The first request places the structure and moves the world to the built projection; the second is the
 * stale re-send, answered by `negative`.
 */
function createFakeClient({
  negative = { state: "rejected", reasonCode: "build_farm_building_site_blocked" },
  negativeWorld = null,
} = {}) {
  const receipts = [];
  let executions = 0;
  const client = {
    state: {
      catalogRegistrations: publishedActionRegistrations(),
      snapshot: snapshotWith([SITE]),
      latestReceipt: null,
    },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      executions += 1;
      const current = client.state.snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: `build-farm-building-execution-${executions}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: current.revision,
      };
      if (executions === 1) {
        assert.deepEqual(request.args, {
          buildingType: SITE.buildingType,
          x: SITE.x,
          y: SITE.y,
          expectedTargetId: SITE.targetId,
        });
        client.state.snapshot = snapshotWith([{ ...BUILT }], current.revision + 1);
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "farm_building_built",
          revision: client.state.snapshot.revision,
          evidence: evidenceDetail(),
        });
        return accepted;
      }
      if (negative.state === "rejected") {
        if (negativeWorld !== null) client.state.snapshot = snapshotWith(negativeWorld, current.revision + 1);
        receipts.push({ ...accepted, ...negative, revision: current.revision });
        return accepted;
      }
      client.state.snapshot = snapshotWith([{ ...BUILT }], current.revision + 1);
      receipts.push({ ...accepted, ...negative, revision: client.state.snapshot.revision });
      return accepted;
    },
  };
  return { client, receipts };
}

test("build-farm-building runner: the template refuses an unarmed fixture config before anything is sent", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runBuildFarmBuildingSmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_build_farm_building_fixture_config_invalid");
});

test("build-farm-building runner: the structure is read back from the world and the stale site is refused", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runBuildFarmBuildingSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "farm_building_built");
  assert.equal(result.target, SITE.targetId);
  assert.equal(result.buildingType, "Coop");
  assert.deepEqual(Object.values(result.checks), [true, true, true, true, true, true]);
  assert.equal(result.negative, "measured:build_farm_building_site_blocked");
});

test("build-farm-building runner: a stale re-send that SUCCEEDS fails the run", async () => {
  // THE FALSIFIER FOR THE NEGATIVE ARM: the tile now holds the building, so a second success is a second structure (or
  // a silent no-op reported as one).
  const { client, receipts } = createFakeClient({
    negative: { state: "succeeded", reasonCode: "farm_building_built" },
  });
  const result = await runBuildFarmBuildingSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "build_farm_building_negative_not_refused:succeeded/farm_building_built");
});

test("build-farm-building runner: a refusal that re-advertised the consumed site fails the run", async () => {
  const { client, receipts } = createFakeClient({ negativeWorld: [SITE, { ...BUILT }] });
  const result = await runBuildFarmBuildingSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, `build_farm_building_negative_moved_world:sites:->${SITE.targetId}`);
});
