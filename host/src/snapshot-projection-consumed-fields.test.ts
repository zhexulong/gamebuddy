import assert from "node:assert/strict";
import test from "node:test";

import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { Snapshot } from "./protocol.js";
import { projectGameSnapshotContext, type GameSnapshotContextProjection } from "./snapshot-projection.js";

/**
 * L2 consumer evidence for `card-l2-consumer-evidence.md` — now closed by
 * Track A (projection renders the fields the LLM consults).
 *
 * The Mod publishes macro time (`timeOfDay`/`dayOfMonth`/`seasonIndex`/`year`,
 * `integrations/stardew/farmhandexecutioncontroller.cs:1408-1411`) and pet
 * stillness (`petTargets[].stationary`, native `PetBehavior.WalkInDirection`,
 * `:1607-1612`). `host/src/protocol.ts` requires and bounds them, the bridge
 * admits them into `state.snapshot`, and — since Track A —
 * `projectGameSnapshotContext` renders them into the bounded per-turn context
 * (`snapshot-projection.ts` `clock` / `pets` + `text`).
 *
 * These tests pin the rendered projection: the fields must actually reach the
 * per-turn context (not just the raw `stardew_observe` dump), stay bounded,
 * and keep the projection's other situational facts intact.
 */

const sampledAtMs = 1_700_000_000_000;
const nowMs = sampledAtMs + 250;

const baseSnapshot: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 80,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: ["pet_animal", "water_crop"],
  catalogRevision: 3,
  enabledActionIds: ["pet_animal"],
  presentationLocale: "en-US",
  weather: "sunny",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
};

function project(snapshot: Snapshot): GameSnapshotContextProjection {
  return projectGameSnapshotContext(snapshot, sampledAtMs, nowMs);
}

test("bounded companion projection renders snapshot time and calendar fields", () => {
  const early = project({
    ...baseSnapshot,
    timeOfDay: 0,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
  });
  const lateNightLastDay = project({
    ...baseSnapshot,
    timeOfDay: 2350,
    dayOfMonth: 28,
    seasonIndex: 3,
    year: 4,
  });
  if (!early.available) throw new Error("projection_unavailable");
  if (!lateNightLastDay.available) throw new Error("projection_unavailable");

  // The clock fields are rendered, not ignored.
  assert.notDeepEqual(lateNightLastDay.clock, early.clock);
  assert.equal(early.clock.timeOfDay, 0);
  assert.equal(early.clock.seasonIndex, 0);
  assert.equal(lateNightLastDay.clock.timeOfDay, 2350);
  assert.equal(lateNightLastDay.clock.dayOfMonth, 28);
  assert.equal(lateNightLastDay.clock.seasonIndex, 3);
  assert.equal(lateNightLastDay.clock.year, 4);
  // Rendered into the bounded text too: late night shows a wall clock.
  assert.match(lateNightLastDay.text, /23:50/);
  assert.match(lateNightLastDay.text, /Winter/);
  assert.match(early.text, /00:00/);
  assert.match(early.text, /Spring/);

  // Positive control: situational fields still project distinctly.
  const moved = project({
    ...baseSnapshot,
    location: "FarmHouse",
    tile: { x: 9, y: 8 },
  });
  if (!moved.available) throw new Error("projection_unavailable");
  assert.notDeepEqual(moved, early);
  assert.equal(moved.movement.location, "FarmHouse");
  assert.deepEqual(moved.movement.tile, { x: 9, y: 8 });
});

test("bounded companion projection renders pet targets and their stationary flag", () => {
  const noPets = project(baseSnapshot);
  const withPets = project({
    ...baseSnapshot,
    petTargets: [
      {
        targetId: "pet_deadbeef",
        x: 10,
        y: 12,
        petType: "Dog",
        friendship: 500,
        pettedToday: false,
        stationary: false,
      },
      {
        targetId: "pet_feedface",
        x: 11,
        y: 12,
        petType: "Cat",
        friendship: 900,
        pettedToday: false,
        stationary: true,
      },
    ],
  });
  if (!noPets.available) throw new Error("projection_unavailable");
  if (!withPets.available) throw new Error("projection_unavailable");

  // Pets are rendered, not ignored.
  assert.notDeepEqual(withPets.pets, noPets.pets);
  assert.equal(withPets.pets.length, 2);
  const [dog, cat] = withPets.pets;
  assert.ok(dog !== undefined && cat !== undefined, "projection_pets_missing");
  assert.equal(dog.stationary, false);
  assert.equal(cat.stationary, true);
  assert.equal(cat.petType, "Cat");
  assert.match(withPets.text, /Cat\(stationary\)/);
  assert.match(withPets.text, /Dog\(moving\)/);
  // With no pets in range the projection says so rather than omitting the line.
  assert.match(noPets.text, /Pets: none within range/);

  // Positive control on the same target-array mechanism: soilTiles is a
  // snapshot target array that this projection does count.
  const soil = project({ ...baseSnapshot, soilTiles: [{ x: 5, y: 10 }] });
  if (!soil.available) throw new Error("projection_unavailable");
  assert.notDeepEqual(soil.farming, noPets.farming);
  assert.equal(soil.farming.soilTilesCount, 1);
  assert.equal(soil.farming.stamina, baseSnapshot.stamina);
  assert.deepEqual(soil.pets, noPets.pets);
});

test("bounded companion projection says what she is carrying, and tells 'nothing but tools' apart from 'not measured'", () => {
  // The projection kept the TOOL family only (`inventory.toolLabels`), so a companion holding forty parsnip seeds and no
  // food planned as if both answers were "nothing": the wire publishes `inventoryItemFacts` (slot, item, name, stack,
  // bounded to 36 by the Mod) and the hot context dropped it. Weather is deliberately NOT added here - the
  // `<runtime-environment>` line already renders it every turn (`runtime-core.internal.ts:composeGameEnvironmentFacts`),
  // and `snapshot-projection.test.ts` pins that this layer does not print it twice.
  const carried = project({
    ...baseSnapshot,
    toolSlots: [{ slot: 0, label: "Axe" }],
    inventoryItemFacts: [
      { slot: 0, qualifiedItemId: "(T)Axe", displayName: "Axe", stack: 1 },
      { slot: 7, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", stack: 40 },
      { slot: 9, qualifiedItemId: "(O)378", displayName: "Copper Ore", stack: 5 },
    ],
  });
  if (!carried.available) throw new Error("projection_unavailable");
  assert.equal(carried.inventory.carrying.measured, true);
  assert.deepEqual(
    carried.inventory.carrying.rows.map((row) => [row.label, row.stack]),
    [
      ["Parsnip Seeds", 40],
      ["Copper Ore", 5],
    ],
    "the tool slot is the Mod's own `toolSlots` answer and is not repeated here",
  );
  assert.match(carried.text, /Carrying: 40x Parsnip Seeds, 5x Copper Ore/u);

  // Three different worlds, three different lines: carrying nothing but tools, and never having been told.
  const toolsOnly = project({
    ...baseSnapshot,
    toolSlots: [{ slot: 0, label: "Axe" }],
    inventoryItemFacts: [{ slot: 0, qualifiedItemId: "(T)Axe", displayName: "Axe", stack: 1 }],
  });
  if (!toolsOnly.available) throw new Error("projection_unavailable");
  assert.equal(toolsOnly.inventory.carrying.measured, true);
  assert.deepEqual(toolsOnly.inventory.carrying.rows, []);
  assert.match(toolsOnly.text, /Carrying: nothing but tools/u);

  const unmeasured = project(baseSnapshot);
  if (!unmeasured.available) throw new Error("projection_unavailable");
  assert.equal(unmeasured.inventory.carrying.measured, false, "the Mod published no inventory facts at all");
  assert.match(unmeasured.text, /Carrying: not measured/u);
  assert.notEqual(toolsOnly.text, unmeasured.text, "'nothing' and 'not measured' are different answers");
});

test("the carrying list is bounded, and what the bound left out is counted rather than dropped", () => {
  const many = project({
    ...baseSnapshot,
    inventoryItemFacts: Array.from({ length: 12 }, (_, slot) => ({
      slot: slot + 1,
      qualifiedItemId: `(O)${String(slot + 1)}`,
      displayName: `Item ${String(slot + 1)}`,
      stack: slot + 1,
    })),
  });
  if (!many.available) throw new Error("projection_unavailable");
  const carrying = many.inventory.carrying;
  assert.ok(carrying.rows.length < 12, "the hot context is a bound, not an inventory dump");
  assert.equal(carrying.omitted, 12 - carrying.rows.length, "every row the bound left out is counted");
  assert.match(many.text, new RegExp(`\\(\\+${String(carrying.omitted)} more\\)`, "u"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(many), "utf8") <= 4_096,
    "a full farm inventory still fits the projection's own byte cap",
  );
});

test("time and pet target fields reach the Agent through the world block, and nothing derives a decision from them", async () => {
  // This is the whole of the Host-side consumption: `stardew_observe` states the world as the same `<world-state>`
  // block the turn carries, and the clock and the target families reach the model inside it. Nothing here derives a
  // decision, count, ranking, or availability - if a decision consumer is added, it must be asserted here rather
  // than inferred from this pass-through.
  const snapshot: Snapshot = {
    ...baseSnapshot,
    timeOfDay: 2350,
    seasonIndex: 3,
    petTargets: [
      {
        targetId: "pet_deadbeef",
        x: 10,
        y: 12,
        petType: "Dog",
        friendship: 500,
        pettedToday: false,
        stationary: true,
      },
    ],
  };
  const connection: StardewBridgeConnection = {
    scope: {
      integrationId: "stardew",
      saveId: "save_01",
      worldId: "world_01",
      playerId: "player_01",
      companionId: "companion_01",
    },
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["pet_animal"],
      catalogRegistrations: [
        {
          actionId: "pet_animal",
          familyId: "animal_care",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
        },
      ],
      catalogRevision: 3,
      enabledActionIds: ["pet_animal"],
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
    },
  };

  const observe = createStardewObservationTools(connection).find((candidate) => candidate.name === "stardew_observe");
  if (observe === undefined) throw new Error("stardew_observe_tool_missing");
  const result = await observe.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /^<world-state>$/mu, "the answer is the state block, not a dump");
  assert.match(text, /23:50/u, "the clock the Mod published is stated");
  assert.match(text, /冬季/u, "and so is the season");
  assert.match(text, /宠物 \(10,12\)/u, "and the pet target, with its tile");
  assert.equal(text.includes('{"'), false, "and a JSON envelope is not what reaches the model");
});
