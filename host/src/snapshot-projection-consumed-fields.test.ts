import assert from "node:assert/strict";
import test from "node:test";

import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { Snapshot } from "./protocol.js";
import {
  projectGameSnapshotContext,
  type GameSnapshotContextProjection,
} from "./snapshot-projection.js";

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

test("time and pet target fields reach the Agent only as an unfiltered observation dump", async () => {
  // This is the whole of the current Host-side consumption: `stardew_observe`
  // serializes the admitted snapshot verbatim. Nothing derives a decision,
  // count, ranking, or availability from these fields. If a decision
  // consumer is added, it must be asserted here rather than inferred from
  // this pass-through.
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

  const observe = createStardewObservationTools(connection).find(
    (candidate) => candidate.name === "stardew_observe",
  );
  if (observe === undefined) throw new Error("stardew_observe_tool_missing");
  const result = await observe.execute(
    "test",
    {},
    new AbortController().signal,
    () => {},
    {} as never,
  );
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const delivered = JSON.parse(text) as Readonly<{
    timeOfDay: number;
    seasonIndex: number;
    petTargets: readonly Readonly<{ stationary: boolean }>[];
  }>;
  assert.equal(delivered.timeOfDay, 2350);
  assert.equal(delivered.seasonIndex, 3);
  assert.deepEqual(
    delivered.petTargets.map((target) => target.stationary),
    [true],
  );
});
