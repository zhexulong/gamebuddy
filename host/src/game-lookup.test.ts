import assert from "node:assert/strict";
import test from "node:test";

import { LOOKUP_SUBJECTS, lookUp, MAX_LOOKUP_ROWS } from "./game-lookup.js";
import type { Snapshot } from "./protocol.js";

const base: Snapshot = {
  revision: 3,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 268,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 1320,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  cropTargets: [],
  wateringWhereabouts: [{ location: "Farm", needsWaterCount: 34, nearestX: 12, nearestY: 20 }],
  harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 3, nearestX: 14, nearestY: 21 }],
  chests: [
    {
      chestId: "chest_a",
      x: 8,
      y: 9,
      displayName: "Chest",
      isFridge: false,
      items: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 }],
    },
    {
      chestId: "chest_b",
      x: 9,
      y: 9,
      displayName: "Chest",
      isFridge: false,
      items: [{ slot: 0, qualifiedItemId: "(O)388", displayName: "Wood", stack: 40 }],
    },
  ],
  chestsSummary: { chestCount: 2, itemCount: 2, fullCount: 0 },
  villagerWhereabouts: [
    { npcName: "Abigail", displayName: "Abigail", location: "Town", x: 40, y: 12, inCurrentLocation: false },
  ],
};

test("the crops answer counts the whole map, and says the reach count is not a total", () => {
  const answer = lookUp(base, "crops");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, unknown>;
  assert.deepEqual(body.needsWater, [{ location: "Farm", count: 34, nearest: { x: 12, y: 20 } }]);
  assert.deepEqual(body.readyForHarvest, [{ location: "Farm", count: 3, nearest: { x: 14, y: 21 } }]);
  // The bounded family is reported beside it, under a name that cannot be read as a total.
  assert.equal(body.withinReach, 0);
  assert.equal(answer.source.family, "wateringWhereabouts");
});

test("a chest lookup finds the item and names the chest's tile", () => {
  const answer = lookUp(base, "chests", "iron");
  assert.ok("answer" in answer);
  const matches = (answer.answer as Record<string, unknown>).matches as readonly { at: { x: number; y: number } }[];
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.at, { x: 8, y: 9 });
  assert.equal((answer.answer as Record<string, unknown>).searched, 2);
});

test("a chest lookup that finds nothing still says how many were searched", () => {
  const answer = lookUp(base, "chests", "diamond");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, unknown>;
  assert.deepEqual(body.matches, []);
  assert.equal(body.searched, 2);
});

test("a fact the snapshot does not carry answers unknown and names the field", () => {
  const answer = lookUp(base, "calendar");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, Record<string, unknown>>;
  assert.equal(body.weatherNow, "sunny");
  assert.equal(body.weatherTomorrow?.missingField, "weatherTomorrow");
  assert.equal(body.festivalToday?.missingField, "festivalToday");
});

test("an absent family is unknown, naming the family, never an empty list", () => {
  const { inventoryItemFacts: _omitted, ...withoutInventory } = base;
  const noInventory = lookUp(withoutInventory, "inventory", "ore");
  assert.ok("unknown" in noInventory);
  assert.equal(noInventory.missingField, "inventoryItemFacts");
});

test("an unknown subject is refused with the list derived from the table", () => {
  const refused = lookUp(base, "rocks");
  assert.ok("refused" in refused);
  assert.deepEqual(refused.subjects, LOOKUP_SUBJECTS);
  assert.match(refused.refused, /unknown_subject:rocks/u);
});

test("a large answer is bounded and reports how many rows it dropped", () => {
  const many = Array.from({ length: MAX_LOOKUP_ROWS + 5 }, (_unused, index) => ({
    chestId: `chest_${String(index)}`,
    x: index,
    y: 9,
    displayName: "Chest",
    isFridge: false,
    items: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 1 }],
  }));
  const answer = lookUp({ ...base, chests: many }, "chests", "iron");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, unknown>;
  assert.equal((body.matches as readonly unknown[]).length, MAX_LOOKUP_ROWS);
  assert.equal(body.omitted, 5);
});
