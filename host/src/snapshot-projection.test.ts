import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  projectMovementContext,
  projectFarmingContext,
  projectInventoryContext,
  projectGameSnapshotContext,
  MAX_GAME_SNAPSHOT_PROJECTION_BYTES,
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
        exhausted: fc.boolean(),
        health: fc.integer({ min: 0, max: 100 }),
        actionable: fc.boolean(),
        capabilities: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        catalogRevision: fc.constant(1),
        enabledActionIds: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        presentationLocale: fc.constant("en-US"),
        weather: fc.constant("sunny"),
        timeOfDay: fc.constant(600),
        dayOfMonth: fc.constant(1),
        seasonIndex: fc.constant(0),
        year: fc.constant(1),
        inventorySlots: fc.option(fc.integer({ min: 12, max: 36 }), { nil: undefined }),
        soilTiles: fc.option(
          fc.array(fc.record({ x: fc.integer({ min: 0, max: 200 }), y: fc.integer({ min: 0, max: 200 }) }), {
            minLength: 0,
            maxLength: 5,
          }),
          { nil: undefined },
        ),
        toolSlots: fc.option(
          fc.array(
            fc.record({ slot: fc.integer({ min: 0, max: 36 }), label: fc.string({ minLength: 1, maxLength: 20 }) }),
            { minLength: 0, maxLength: 5 },
          ),
          { nil: undefined },
        ),
        warps: fc.option(
          fc.array(
            fc.record({
              sourceX: fc.integer({ min: 0, max: 200 }),
              sourceY: fc.integer({ min: 0, max: 200 }),
              targetLocation: fc.string({ minLength: 1, maxLength: 20 }),
              targetX: fc.integer({ min: 0, max: 200 }),
              targetY: fc.integer({ min: 0, max: 200 }),
            }),
            { minLength: 0, maxLength: 3 },
          ),
          { nil: undefined },
        ),
        doorTargets: fc.option(
          fc.array(
            fc.record({
              sourceX: fc.integer({ min: 0, max: 200 }),
              sourceY: fc.integer({ min: 0, max: 200 }),
              targetLocation: fc.string({ minLength: 1, maxLength: 20 }),
              targetX: fc.integer({ min: 0, max: 200 }),
              targetY: fc.integer({ min: 0, max: 200 }),
            }),
            { minLength: 0, maxLength: 3 },
          ),
          { nil: undefined },
        ),
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
        assert.equal(farmProj1.exhausted, snapshot.exhausted === true);
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
    exhausted: true,
    health: 100,
    actionable: true,
    capabilities: ["till_soil", "water_crop"],
    catalogRevision: 1,
    enabledActionIds: ["till_soil", "water_crop"],
    presentationLocale: "en-US",
    weather: "sunny",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    soilTiles: [
      { x: 5, y: 10 },
      { x: 5, y: 11 },
    ],
    toolSlots: [
      { slot: 0, label: "Axe" },
      { slot: 1, label: "Hoe" },
    ],
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
  assert.equal(farming.exhausted, true);
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
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities: ["move_to_tile", "inspect_self"],
    catalogRevision: 99,
    enabledActionIds: ["move_to_tile"],
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
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
    warps: Array.from({ length: 200 }, () => ({
      sourceX: 1,
      sourceY: 1,
      targetLocation: "Town",
      targetX: 2,
      targetY: 2,
    })),
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
    exhausted: false,
    health: 50,
    actionable: false,
    capabilities: [],
    catalogRevision: 1,
    enabledActionIds: [],
    presentationLocale: "en-US",
    weather: "sunny",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
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
    exhausted: false,
    health: 50,
    actionable: false,
    capabilities: [],
    catalogRevision: 1,
    enabledActionIds: [],
    presentationLocale: "en-US",
    weather: "sunny",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
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
  assert.equal(farming.exhausted, false);
  assert.equal(farming.soilTilesCount, 0);
  assert.equal(farming.canTill, false);
  assert.equal(farming.canWater, false);

  const inventory = projectInventoryContext(minimalSnapshot);
  assert.equal(inventory.revision, 1);
  assert.equal(inventory.inventorySlots, 12);
  assert.equal(inventory.toolSlotsCount, 0);
  assert.deepEqual(inventory.toolLabels, []);
});

/**
 * Weather is deliberately NOT projected here, and this test is what keeps it that way.
 *
 * The fact is already delivered every turn by the environment-facts line
 * (`formatGameEnvironmentFacts`, `runtime-core.internal.ts`), which Magic Context injects as
 * `<runtime-environment>` into that same turn's user message. The projection's own `text` and its
 * structured fields ride the SAME message (`event-pump.ts` `takeBatch` -> `payload`), so projecting
 * weather too would put one fact into the model's context twice - the duplication this repo keeps
 * paying for. The turn-facts line is the owner: it is the layer that renders the world once per
 * turn, and it is what the Game surface's world-book selection is keyed on
 * (`gameTurnWorldStateText`). A solicited `stardew_observe` still returns `weather` verbatim.
 *
 * The Mod publishes neither a festival day nor a music track on `Snapshot` (`SNAPSHOT_KEYS`,
 * `protocol.ts`), so those two are not withheld here - they do not exist on the wire to project.
 */
test("the projection leaves weather to the turn-level environment line rather than rendering it twice", () => {
  const source: Snapshot = {
    revision: 31,
    location: "Farm",
    tile: { x: 64, y: 15 },
    stamina: 210,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities: ["water_crop"],
    catalogRevision: 4,
    enabledActionIds: [],
    presentationLocale: "en-US",
    timeOfDay: 900,
    dayOfMonth: 13,
    seasonIndex: 0,
    year: 2,
    weather: "rain",
  };

  const rain = projectGameSnapshotContext(source, 1_000, 1_250);
  const sunny = projectGameSnapshotContext({ ...source, weather: "sunny" }, 1_000, 1_250);
  if (!rain.available || !sunny.available) throw new Error("projection_unavailable");

  // Weather does not reach either half of this layer: not a structured field, not the text.
  assert.equal(Object.hasOwn(rain, "weather"), false);
  assert.deepEqual(rain, sunny);
  assert.doesNotMatch(rain.text, /rain|weather/i);

  // Positive control: the two projections above are equal because weather is absent, not because
  // this layer is inert. A fact it does own must still move it.
  const spent = projectGameSnapshotContext({ ...source, stamina: 12 }, 1_000, 1_250);
  if (!spent.available) throw new Error("projection_unavailable");
  assert.notDeepEqual(spent, rain);
  assert.match(spent.text, /Stamina=12/);
});

/**
 * Measured 2026-10-28 (round6): a `ShippingMenu` owned the screen for 31 minutes while the last projection the
 * model saw said `Actionable: true` at 22:30 and the game stood at 06:00. `actionable` was not wrong - the modal
 * family is admitted precisely when it is false, and `dismiss_modal` is one - but it reads as "nothing is in the
 * way", and the missing half was the one that explained why nothing else could happen.
 *
 * `actorDispositionKind`/`actorDispositionDetail` carry that half (`farmhandexecutioncontroller.cs:2401`).
 */
const modalSource: Snapshot = {
  revision: 1_019,
  location: "FarmHouse",
  tile: { x: 9, y: 9 },
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: ["dismiss_modal"],
  catalogRevision: 4,
  enabledActionIds: ["dismiss_modal"],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 5,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

test("a modal holding the screen is named in the projection, beside an actionable flag that still reads true", () => {
  const projection = projectGameSnapshotContext(
    {
      ...modalSource,
      actorDispositionKind: "modal",
      actorDispositionDetail: "ShippingMenu",
      actorDispositionActionOwned: false,
    },
    1_000,
    1_250,
  );
  if (!projection.available) throw new Error("projection_unavailable");

  // The modal the Mod named reaches the text the model reads, by its own class name.
  assert.match(projection.text, /Modal: ShippingMenu/);
  // The boolean is untouched and still correct: the modal family is admitted while it is true.
  assert.match(projection.text, /Actionable: true/);
  // And the text says plainly why nothing else can proceed, rather than leaving the flag to imply there is no obstacle.
  assert.match(projection.text, /no other action can run until it is cleared/);
  assert.match(projection.text, /game clock does not advance/);
  // The countermeasure is the mechanism that already exists, named.
  assert.match(projection.text, /dismiss_modal/);
  // The Mod's owner binary reaches the line too: this menu was pushed by the world, not by the companion's own action.
  assert.match(projection.text, /opened by the game, not by your action/);

  const own = projectGameSnapshotContext(
    {
      ...modalSource,
      actorDispositionKind: "modal",
      actorDispositionDetail: "LetterViewerMenu",
      actorDispositionActionOwned: true,
    },
    1_000,
    1_250,
  );
  if (!own.available) throw new Error("projection_unavailable");
  assert.match(own.text, /Modal: LetterViewerMenu/);
  assert.match(own.text, /opened by your own action/);
});

test("a snapshot with no modal in the way renders no modal line at all", () => {
  // Three cases, because an implementation that always prints a placeholder passes the modal case alone.
  const idle = projectGameSnapshotContext(
    { ...modalSource, actorDispositionKind: "idle", actorDispositionDetail: null },
    1_000,
    1_250,
  );
  const absent = projectGameSnapshotContext(modalSource, 1_000, 1_250);
  // The detail field carries a TRANSIENT kind while the actor is briefly busy. It is not a modal and must not be named
  // as one: `eating` is not a menu, and no modal action clears it.
  const transient = projectGameSnapshotContext(
    { ...modalSource, actorDispositionKind: "transient", actorDispositionDetail: "eating" },
    1_000,
    1_250,
  );
  // A modal disposition whose class name went unreported has nothing to name. It must render nothing rather than an
  // empty label: "Modal: " alone reads as a modal whose name was lost, and the model has no countermeasure for it.
  const unnamed = projectGameSnapshotContext(
    { ...modalSource, actorDispositionKind: "modal", actorDispositionDetail: null },
    1_000,
    1_250,
  );
  for (const projection of [idle, absent, transient, unnamed]) {
    if (!projection.available) throw new Error("projection_unavailable");
    assert.doesNotMatch(projection.text, /Modal/);
    assert.doesNotMatch(projection.text, /dismiss_modal/);
    assert.equal(projection.movement.holdingModal, null);
  }
  // Positive control: these are silent because no modal holds the actor, not because the projection is fixed text.
  const held = projectGameSnapshotContext(
    { ...modalSource, actorDispositionKind: "modal", actorDispositionDetail: "ShippingMenu" },
    1_000,
    1_250,
  );
  if (!held.available) throw new Error("projection_unavailable");
  assert.notEqual(held.text, idle.text);
  assert.equal(held.movement.holdingModal, "ShippingMenu");
});
