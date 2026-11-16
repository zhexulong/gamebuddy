import assert from "node:assert/strict";
import test from "node:test";
import { runSweepScytheSmoke } from "./run-stardew-native-local-player-sweep-scythe-smoke.mjs";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "sweep_scythe"];
const ACTOR = { x: 10, y: 8 };
/** The stance `chooseStance` must reach for: the only cardinal neighbour of the nearest weed, one tile away. */
const STANCE = { x: 10, y: 9 };
const NAMED = { x: 10, y: 10, targetId: "weed_0123456789abcdef", health: 2 };
const FENCEPOST = { x: 11, y: 11, targetId: "weed_fedcba9876543210", health: 2 };

function validConfig() {
  return {
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: ["sweep_scythe"],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_cut_weeds_v1",
    },
  };
}

/**
 * The evidence a passing swing writes.
 *
 * Every field is the Mod's own (`ToolActionEvidence.SweepScythe`); the numbers here are a CANE the test leans on, and the
 * runner is expected to disagree with whichever one the case under test corrupts.
 */
function sweepEvidence(overrides = {}) {
  const fields = {
    location: "Farm",
    target: `${NAMED.x},${NAMED.y}`,
    before_occupant: "weed",
    after_occupant: "weed",
    named_moved: "true",
    // Facing DOWN: 13 tiles measured by the engine's own rectangles, so the window is 11-15.
    arc_tiles: "13",
    arc_sweepable: "2",
    arc_clear: "6",
    changed: `${NAMED.x}:${NAMED.y}:weed|${FENCEPOST.x}:${FENCEPOST.y}:weed`,
    tiles_changed: "2",
    tool_selected: "scythe",
    slot: "1",
    tool_before: "axe",
    slot_before: "0",
    stamina_before: "270",
    stamina_after: "270",
    stamina_delta: "0",
    expected_stamina_cost: "0",
    tool_restored: "axe",
    ...overrides,
  };
  return {
    detail: Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(";"),
  };
}

function baseSnapshot(overrides = {}) {
  return {
    revision: 1,
    location: "Farm",
    tile: { ...ACTOR },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    warps: [],
    weedTargets: [
      { targetId: NAMED.targetId, location: "Farm", x: NAMED.x, y: NAMED.y, health: NAMED.health },
      { targetId: FENCEPOST.targetId, location: "Farm", x: FENCEPOST.x, y: FENCEPOST.y, health: FENCEPOST.health },
    ],
    grassTargets: [],
    cropTargets: [],
    scytheCropTargets: [],
    toolSlots: [{ slot: 1, category: "scythe", label: "(W)47" }],
    currentToolSlot: 0,
    ...overrides,
  };
}

/**
 * A fake Mod: it answers `move_to_tile` by putting the body on the requested tile, and `sweep_scythe` with the evidence
 * and the world the case under test names.
 */
function createFakeClient({ evidence = {}, before = {}, after = {} } = {}) {
  const receipts = [];
  let sequence = 0;
  const client = {
    state: {
      catalogRegistrations: publishedActionRegistrations(),
      snapshot: baseSnapshot(before),
      latestReceipt: null,
    },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      assert.equal(request.idempotencyKey, `${request.requestId}_idem`);
      sequence += 1;
      const current = client.state.snapshot;
      assert.equal(request.expectedRevision, current.revision);
      const accepted = {
        requestId: request.requestId,
        executionId: `sweep-scythe-execution-${sequence}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: current.revision,
      };
      if (request.action === "move_to_tile") {
        client.state.snapshot = { ...current, revision: current.revision + 1, tile: { ...request.args } };
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "target_reached",
          revision: client.state.snapshot.revision,
        });
        return accepted;
      }
      if (request.action === "sweep_scythe") {
        assert.deepEqual(request.args, { x: NAMED.x, y: NAMED.y });
        client.state.snapshot = { ...current, revision: current.revision + 1, ...after };
        const terminal = {
          ...accepted,
          state: "succeeded",
          reasonCode: "scythe_sweep_cut",
          revision: client.state.snapshot.revision,
          evidence: sweepEvidence(evidence),
        };
        client.state.latestReceipt = terminal;
        receipts.push(terminal);
        return accepted;
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts };
}

/** The world after a clean swing: the named weed thinned, the second weed thinned, nothing else touched. */
function cleanWorldAfter() {
  return {
    weedTargets: [
      { targetId: NAMED.targetId, location: "Farm", x: NAMED.x, y: NAMED.y, health: 1 },
      { targetId: FENCEPOST.targetId, location: "Farm", x: FENCEPOST.x, y: FENCEPOST.y, health: 1 },
    ],
  };
}

test("sweep-scythe runner proves the named tile moved and reports the engine's arc for the stance", async () => {
  const { client, receipts } = createFakeClient({ after: cleanWorldAfter() });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "scythe_sweep_cut");
  assert.deepEqual(result.named, { x: NAMED.x, y: NAMED.y, targetId: NAMED.targetId, health: NAMED.health });
  assert.deepEqual(result.actor, STANCE);
  assert.equal(result.facing, "down");
  assert.deepEqual(result.arc, {
    tiles: 13,
    sweepable: 2,
    clear: 6,
    facing: "down",
    measured: 13,
    facingWindow: { min: 11, max: 15 },
    declaredBand: { min: 10, max: 16 },
  });
  assert.deepEqual(
    result.changed.map((tile) => `${tile.x},${tile.y}:${tile.kind}`),
    [`${NAMED.x},${NAMED.y}:weed`, `${FENCEPOST.x},${FENCEPOST.y}:weed`],
  );
  // Nothing destructive stood in the arc, so the destructive arm is NOT MEASURED rather than pretended.
  assert.equal(result.destructiveArm, "not_measured:sweep_scythe:no_destructive_object_in_the_arc");
  assert.deepEqual(result.cropGuard, { cropsMoved: 0, declaredKinds: ["weed"] });
  assert.deepEqual(result.lostBehindTheArc, []);
});

test("sweep-scythe runner refuses an arc wider than the engine's own band for that stance", async () => {
  // 20 tiles is outside the declared 10-16 band: a receipt claiming it measured a swing on a different target version.
  const { client, receipts } = createFakeClient({ evidence: { arc_tiles: "20" }, after: cleanWorldAfter() });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_arc_outside_declared_band:down:20:10-16");
});

test("sweep-scythe runner ties the arc to the FACING the stance implies", async () => {
  // 16 is legal in the declared band but four wider than the engine's 13 for a downward stance: the arc did not come
  // from this stance's rectangles, whatever band it claims to sit in.
  const { client, receipts } = createFakeClient({ evidence: { arc_tiles: "16" }, after: cleanWorldAfter() });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_arc_disagrees_with_engine:down:16:11-15");
});

test("sweep-scythe runner refuses a swing that cut a crop", async () => {
  const { client, receipts } = createFakeClient({
    evidence: { changed: `${NAMED.x}:${NAMED.y}:weed|9:9:crop`, tiles_changed: "2" },
    after: cleanWorldAfter(),
  });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_arc_took_a_crop:9,9");
});

test("sweep-scythe runner catches a destructive object the receipt never reported", async () => {
  // THE SILENT CASE. A tuft stands one tile behind the stance, the swing takes it, and the receipt's own `changed` list
  // does not name it - so every count in the receipt is still consistent and only the world says what happened.
  const tuft = { targetId: "grass_0123456789abcdef", location: "Farm", x: 9, y: 9, grassType: 1, numberOfWeeds: 4 };
  const { client, receipts } = createFakeClient({
    before: { grassTargets: [tuft] },
    after: { ...cleanWorldAfter(), grassTargets: [] },
  });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_destructive_object_lost_behind_the_arc:9,9:grass");
});

test("sweep-scythe runner accepts a tuft the receipt DID report as the work it is", async () => {
  // The same tuft, this time named by `changed`: the catalogue declares grass as what this swing is for, so the swing is
  // honest - and the arm is MEASURED rather than not_measured.
  const tuft = { targetId: "grass_0123456789abcdef", location: "Farm", x: 9, y: 9, grassType: 1, numberOfWeeds: 4 };
  const { client, receipts } = createFakeClient({
    before: { grassTargets: [tuft] },
    evidence: { changed: `${NAMED.x}:${NAMED.y}:weed|9:9:grass`, tiles_changed: "2" },
    after: { ...cleanWorldAfter(), grassTargets: [] },
  });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.destructiveArm, "measured");
  assert.deepEqual(result.cropGuard.declaredKinds, ["grass", "weed"]);
});

test("sweep-scythe runner refuses a stance with a crop in the arc instead of swinging into it", async () => {
  const crop = {
    targetId: "crop_0123456789abcdef",
    location: "Farm",
    x: 9,
    y: 9,
    cropId: "483",
    qualifiedHarvestItemId: "(O)271",
    displayName: "Wheat",
    readyForHarvest: false,
  };
  const { client, receipts } = createFakeClient({ before: { cropTargets: [crop] } });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_no_stance_clear_of_crops:8");
});

test("sweep-scythe runner refuses a receipt whose named tile did not move", async () => {
  const { client, receipts } = createFakeClient({ after: { weedTargets: baseSnapshot().weedTargets } });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, `sweep_scythe_named_tile_unmoved:${NAMED.x},${NAMED.y}`);
});

test("sweep-scythe runner refuses a `tiles_changed` that disagrees with its own list", async () => {
  const { client, receipts } = createFakeClient({ evidence: { tiles_changed: "3" }, after: cleanWorldAfter() });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_changed_count_mismatch:3:2");
});

test("sweep-scythe runner refuses a change list that does not name the tile the world says moved", async () => {
  const { client, receipts } = createFakeClient({
    evidence: { changed: `${FENCEPOST.x}:${FENCEPOST.y}:weed`, tiles_changed: "1" },
    after: cleanWorldAfter(),
  });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, `sweep_scythe_receipt_disagrees_with_world:${FENCEPOST.x}:${FENCEPOST.y}:weed`);
});

test("sweep-scythe runner refuses a swing that cost stamina a scythe does not cost", async () => {
  const { client, receipts } = createFakeClient({ evidence: { stamina_delta: "-1" }, after: cleanWorldAfter() });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_stamina_disagrees:-1:0");
});

test("sweep-scythe runner refuses arc counters that do not partition the arc", async () => {
  const { client, receipts } = createFakeClient({
    evidence: { arc_tiles: "13", arc_sweepable: "9", arc_clear: "8" },
    after: cleanWorldAfter(),
  });
  const result = await runSweepScytheSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "sweep_scythe_arc_counts_incoherent:13:9:8");
});
