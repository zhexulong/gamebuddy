import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  projectMovementContext,
  projectFarmingContext,
  projectInventoryContext,
  projectGameSnapshotContext,
  MAX_GAME_SNAPSHOT_PROJECTION_BYTES,
  type MovementContextProjection,
  type FarmingContextProjection,
  type InventoryContextProjection,
} from "./snapshot-projection.js";
import type { Snapshot } from "./protocol.js";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    const val = (value as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return Object.freeze(value);
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(deepClone) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    clone[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return clone as T;
}

test("Projection Purity Invariant: project(S) == project(S) and does not mutate source Snapshot across optional field variations", () => {
  fc.assert(
    fc.property(
      fc.record({
        revision: fc.integer({ min: 0, max: 100000 }),
        location: fc.string({ minLength: 1, maxLength: 20 }),
        tile: fc.record({ x: fc.integer({ min: 0, max: 200 }), y: fc.integer({ min: 0, max: 200 }) }),
        stamina: fc.integer({ min: 0, max: 500 }),
        health: fc.integer({ min: 0, max: 100 }),
        actionable: fc.boolean(),
        capabilities: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        catalogRevision: fc.constant(1),
        enabledActionIds: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        presentationLocale: fc.constant("en-US"),
        inventorySlots: fc.option(fc.integer({ min: 12, max: 36 }), { nil: undefined }),
        soilTiles: fc.option(fc.array(fc.record({ x: fc.integer({ min: 0, max: 200 }), y: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 5 }), { nil: undefined }),
        toolSlots: fc.option(fc.array(fc.record({ slot: fc.integer({ min: 0, max: 36 }), label: fc.string({ minLength: 1, maxLength: 20 }) }), { minLength: 0, maxLength: 5 }), { nil: undefined }),
        warps: fc.option(fc.array(fc.record({ sourceX: fc.integer({ min: 0, max: 200 }), sourceY: fc.integer({ min: 0, max: 200 }), targetLocation: fc.string({ minLength: 1, maxLength: 20 }), targetX: fc.integer({ min: 0, max: 200 }), targetY: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 3 }), { nil: undefined }),
        doorTargets: fc.option(fc.array(fc.record({ sourceX: fc.integer({ min: 0, max: 200 }), sourceY: fc.integer({ min: 0, max: 200 }), targetLocation: fc.string({ minLength: 1, maxLength: 20 }), targetX: fc.integer({ min: 0, max: 200 }), targetY: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 3 }), { nil: undefined }),
      }),
      (generated) => {
        const snapshot = generated as unknown as Snapshot;
        const baselineClone = deepClone(snapshot);
        const frozen = deepFreeze(deepClone(snapshot));

        const proj1 = projectMovementContext(frozen);
        const proj2 = projectMovementContext(frozen);

        assert.deepEqual(proj1, proj2);
        assert.deepEqual(frozen, baselineClone);

        const invProj1 = projectInventoryContext(frozen);
        const invProj2 = projectInventoryContext(frozen);
        assert.deepEqual(invProj1, invProj2);
        assert.equal(invProj1.inventorySlots, snapshot.inventorySlots ?? 12);
        assert.equal(invProj1.toolSlotsCount, snapshot.toolSlots?.length ?? 0);
        assert.deepEqual(frozen, baselineClone);

        const farmProj1 = projectFarmingContext(frozen);
        const farmProj2 = projectFarmingContext(frozen);
        assert.deepEqual(farmProj1, farmProj2);
        assert.equal(farmProj1.soilTilesCount, snapshot.soilTiles?.length ?? 0);
        assert.equal(farmProj1.stamina, snapshot.stamina);
        assert.deepEqual(frozen, baselineClone);
      },
    ),
    { numRuns: 100 },
  );
});

test("projectFarmingContext and projectInventoryContext extract structured facts without memory bloat", () => {
  const snapshot: Snapshot = {
    revision: 10,
    location: "Farm",
    tile: { x: 5, y: 10 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: ["till_soil", "water_crop"],
    catalogRevision: 1,
    enabledActionIds: ["till_soil", "water_crop"],
    presentationLocale: "en-US",
    soilTiles: [{ x: 5, y: 10 }, { x: 5, y: 11 }],
    toolSlots: [{ slot: 0, label: "Axe" }, { slot: 1, label: "Hoe" }],
    inventorySlots: 24,
  };

  const movement = projectMovementContext(snapshot);
  assert.equal(movement.revision, 10);
  assert.equal(movement.location, "Farm");
  assert.deepEqual(movement.tile, { x: 5, y: 10 });
  assert.equal(movement.actionable, true);
  assert.equal(movement.warpsCount, 0);
  assert.equal(movement.doorsCount, 0);
  assert.ok(Object.isFrozen(movement));
  assert.ok(Object.isFrozen(movement.tile));

  const farming = projectFarmingContext(snapshot);
  assert.equal(farming.revision, 10);
  assert.equal(farming.location, "Farm");
  assert.equal(farming.soilTilesCount, 2);
  assert.equal(farming.stamina, 270);
  assert.equal(farming.canTill, true);
  assert.equal(farming.canWater, true);
  assert.ok(Object.isFrozen(farming));

  const inventory = projectInventoryContext(snapshot);
  assert.equal(inventory.revision, 10);
  assert.equal(inventory.inventorySlots, 24);
  assert.equal(inventory.toolSlotsCount, 2);
  assert.deepEqual(inventory.toolLabels, ["Axe", "Hoe"]);
  assert.ok(Object.isFrozen(inventory));
  assert.ok(Object.isFrozen(inventory.toolLabels));
});

test("Game snapshot projection is bounded, deterministic, frozen, and excludes authority-shaped fields", () => {
  const snapshot = {
    revision: 42,
    location: "Farm",
    tile: { x: 5, y: 10 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: ["move_to_tile", "inspect_self"],
    catalogRevision: 99,
    enabledActionIds: ["move_to_tile"],
    presentationLocale: "en-US",
    currentTool: "Axe",
    inventorySlots: 24,
    activeExecution: {
      executionId: "execution_secret",
      requestId: "request_secret",
      action: "move_to_tile",
      state: "running",
      reasonCode: "secret",
      evidence: { bearer: "secret" },
    },
    toolSlots: Array.from({ length: 200 }, (_, slot) => ({ slot, label: `Tool ${slot}` })),
    warps: Array.from({ length: 200 }, () => ({ sourceX: 1, sourceY: 1, targetLocation: "Town", targetX: 2, targetY: 2 })),
  } as unknown as Snapshot;
  const first = projectGameSnapshotContext(snapshot, 10_000, 10_120);
  const second = projectGameSnapshotContext(snapshot, 10_000, 10_120);
  assert.deepEqual(first, second);
  assert.equal(first.available, true);
  if (!first.available) return;
  assert.equal(first.snapshotRevision, 42);
  assert.equal(first.sampledAgeMs, 120);
  assert.equal(first.movement.warpsCount, 200);
  assert.equal(first.inventory.toolLabels.length, 12);
  assert.equal(first.inventory.toolLabels[0], "Tool 0");
  assert.equal(first.text.includes("execution_secret"), false);
  assert.equal(first.text.includes("move_to_tile"), false);
  assert.equal(first.text.includes("request_secret"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= MAX_GAME_SNAPSHOT_PROJECTION_BYTES);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.movement));
  assert.ok(Object.isFrozen(first.inventory.toolLabels));
});

test("Game snapshot projection reports unavailable and bounds snapshot age", () => {
  assert.deepEqual(projectGameSnapshotContext(undefined, 1, 2), {
    schema: "gamebuddy-game-snapshot-projection/v1",
    available: false,
    reasonCode: "unavailable",
    text: "[Game Snapshot Unavailable]",
  });
  assert.deepEqual(projectGameSnapshotContext(null, 1, 2), {
    schema: "gamebuddy-game-snapshot-projection/v1",
    available: false,
    reasonCode: "unavailable",
    text: "[Game Snapshot Unavailable]",
  });
  const minimalSnapshot: Snapshot = {
    revision: 1,
    location: "Town",
    tile: { x: 0, y: 0 },
    stamina: 100,
    health: 50,
    actionable: false,
    capabilities: [],
    catalogRevision: 1,
    enabledActionIds: [],
    presentationLocale: "en-US",
  };
  const projection = projectGameSnapshotContext(minimalSnapshot, 0, Number.MAX_SAFE_INTEGER);
  assert.equal(projection.available, true);
  if (projection.available) assert.equal(projection.sampledAgeMs, 86_400_000);
});

test("Projections handle completely empty or missing optional fields cleanly", () => {
  const minimalSnapshot: Snapshot = {
    revision: 1,
    location: "Town",
    tile: { x: 0, y: 0 },
    stamina: 100,
    health: 50,
    actionable: false,
    capabilities: [],
    catalogRevision: 1,
    enabledActionIds: [],
    presentationLocale: "en-US",
  };

  const movement = projectMovementContext(minimalSnapshot);
  assert.equal(movement.revision, 1);
  assert.equal(movement.location, "Town");
  assert.equal(movement.warpsCount, 0);
  assert.equal(movement.doorsCount, 0);

  const farming = projectFarmingContext(minimalSnapshot);
  assert.equal(farming.revision, 1);
  assert.equal(farming.location, "Town");
  assert.equal(farming.stamina, 100);
  assert.equal(farming.soilTilesCount, 0);
  assert.equal(farming.canTill, false);
  assert.equal(farming.canWater, false);

  const inventory = projectInventoryContext(minimalSnapshot);
  assert.equal(inventory.revision, 1);
  assert.equal(inventory.inventorySlots, 12);
  assert.equal(inventory.toolSlotsCount, 0);
  assert.deepEqual(inventory.toolLabels, []);
});
