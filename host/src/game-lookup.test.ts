import assert from "node:assert/strict";
import test from "node:test";

import { LOOKUP_SUBJECTS, lookUp, MAX_LOOKUP_ROWS, noSnapshot } from "./game-lookup.js";
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
  inventoryItemFacts: [
    { slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 },
    { slot: 1, qualifiedItemId: "(O)388", displayName: "Wood", stack: 40 },
  ],
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
    {
      targetId: "npc_relationship_0123456789abcdef",
      npcName: "Abigail",
      displayName: "Abigail",
      location: "Town",
      x: 40,
      y: 12,
      inCurrentLocation: false,
    },
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

test("an inventory lookup answers from the published family and names the family it read", () => {
  const answer = lookUp(base, "inventory", "iron");
  assert.ok("answer" in answer);
  assert.equal(answer.source.family, "inventoryItemFacts");
  const rows = (answer.answer as Record<string, unknown>).rows as readonly { displayName: string }[];
  assert.deepEqual(
    rows.map((row) => row.displayName),
    ["Iron Ore"],
  );
});

test("an npc lookup answers where each villager is", () => {
  const answer = lookUp(base, "npcs", "abi");
  assert.ok("answer" in answer);
  assert.equal(answer.source.family, "villagerWhereabouts");
  const rows = (answer.answer as Record<string, unknown>).rows as readonly unknown[];
  assert.deepEqual(rows, [{ name: "Abigail", location: "Town", at: { x: 40, y: 12 } }]);
});

test("a fact the snapshot does not carry answers unknown and names the field", () => {
  const answer = lookUp(base, "calendar");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, Record<string, unknown>>;
  assert.equal(body.weatherNow, "sunny");
  assert.equal(body.weatherTomorrow?.missingField, "weatherTomorrow");
  assert.equal(body.festivalToday?.missingField, "festivalToday");
});

/**
 * THE REASON THIS MODULE EXISTS. "We did not look" and "there is nothing" are different answers, and a caller that cannot
 * tell them apart will read an absent family as an empty world. So an absent family answers `source.family: null` - the one
 * spelling of "not looked" - and it does NOT answer with an empty list, which would be a claim about the world. The
 * population is every subject whose family is optional on the wire, so a subject added later without this property shows
 * up here by name.
 */
test("a subject the snapshot does not carry answers source.family null, never an empty result", () => {
  const absent: readonly (readonly [subject: string, fields: readonly (keyof Snapshot)[], answerKey: string])[] = [
    ["inventory", ["inventoryItemFacts"], "rows"],
    ["npcs", ["villagerWhereabouts"], "rows"],
    ["chests", ["chests", "chestsSummary"], "matches"],
    ["crops", ["wateringWhereabouts", "harvestWhereabouts"], "needsWater"],
  ];
  for (const [subject, fields, answerKey] of absent) {
    const withoutFamily = { ...(base as Record<string, unknown>) };
    for (const field of fields) delete withoutFamily[field];
    const answer = lookUp(withoutFamily as Snapshot, subject, "iron");
    assert.ok("unknown" in answer, `${subject} must answer unknown when ${fields.join(" and ")} are absent`);
    assert.equal(answer.source.family, null, `${subject} must say it did not look, not that the world is empty`);
    // The source still names the snapshot it was asked about: null family is "not looked", not "no snapshot".
    assert.equal(answer.source.snapshotRevision, base.revision);
    assert.equal(
      answer.missingField,
      String(fields[0]),
      `${subject} must name the field that would have to be published`,
    );
    assert.equal(
      answerKey in answer,
      false,
      `${subject} answered with ${answerKey}: an empty list is a claim about the world, not a refusal to claim`,
    );
  }
});

test("no snapshot at all is also not-looked, and names the snapshot rather than a family", () => {
  const answer = noSnapshot("integration_not_ready");
  assert.equal(answer.source.family, null);
  assert.equal(answer.source.snapshotRevision, null);
  assert.equal(answer.missingField, "snapshot");
  assert.match(answer.unknown, /integration_not_ready/u);
});

test("an unknown subject is refused with the list derived from the table", () => {
  const refused = lookUp(base, "rocks");
  assert.ok("refused" in refused);
  assert.deepEqual(refused.subjects, LOOKUP_SUBJECTS);
  assert.match(refused.refused, /unknown_subject:rocks/u);
  assert.equal(refused.source.family, null);
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

test("an answer that dropped nothing says so with 0 rather than an absent key", () => {
  const answer = lookUp(base, "npcs");
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, unknown>;
  assert.equal(body.omitted, 0);
  assert.equal((body.rows as readonly unknown[]).length + (body.omitted as number), 1);
});
