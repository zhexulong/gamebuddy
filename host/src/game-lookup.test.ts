import assert from "node:assert/strict";
import test from "node:test";
import type { AffordanceAction } from "./game-lookup.js";
import {
  LOOKUP_SUBJECTS,
  lookUp,
  MAX_AFFORDANCE_COUNTERS,
  MAX_AFFORDANCE_GROUPS,
  MAX_LOOKUP_ROWS,
  noSnapshot,
} from "./game-lookup.js";
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

/**
 * AFFORDANCES: the derived subject, at the module boundary.
 *
 * The surface is passed in rather than reached for, so these cases can hand it families the live Mod does not publish yet -
 * which is the only way to prove the grouping comes from the surface rather than from a table that happens to match
 * today's surface.
 */
const AFFORDANCE_SURFACE: readonly AffordanceAction[] = Object.freeze([
  { actionId: "cut_weeds", targetFamily: "weedTargets" },
  { actionId: "break_rock", targetFamily: "rockSourceTargets" },
  { actionId: "machine_inspect", targetFamily: "machineTargets" },
  { actionId: "machine_load", targetFamily: "machineTargets" },
  { actionId: "machine_collect_output", targetFamily: "machineTargets" },
  { actionId: "pet_farm_animal", targetFamily: "farmAnimalPetTargets" },
]);

function farmWith(targets: Readonly<Record<string, unknown>>): Snapshot {
  return { ...base, ...targets, tile: { x: 40, y: 10 } };
}

/** `shop_purchase`'s own declaration: the one surface entry a shop question needs. */
const SHOP_SURFACE: readonly AffordanceAction[] = Object.freeze([
  { actionId: "shop_purchase", targetFamily: "shopTargets" },
]);

/**
 * The nine counters a shop room publishes, in the shape the Mod sends them - including the two facts the answer has to
 * carry: the counter's own tile (`ownerTileX`/`ownerTileY`) and what the menu charges for one unit.
 *
 * The actor stands on (40,10), so the third counter is the nearest one and the first two tie with it; the id breaks that tie.
 */
function shopCounters(): readonly Readonly<Record<string, unknown>>[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
    targetId: `shop_${String(index).padStart(16, "0")}`,
    shopId: index === 2 ? "SeedShop" : `Shop${String(index)}`,
    ownerName: index === 2 ? "Pierre" : "Robin",
    location: "SeedShop",
    // The counter's own tile: the third counter is one step from the actor on (40,10), and the rest recede by id.
    ownerTileX: index === 2 ? 40 : 42 + index,
    ownerTileY: 11,
    ownerInReach: index === 2,
    stockCount: 3,
    stockItemIds: ["(O)472", "(O)378"],
    stockPrices: [
      { qualifiedItemId: "(O)472", price: 40 },
      { qualifiedItemId: "(O)378", price: 75 },
    ],
  }));
}

function groupsOf(answer: ReturnType<typeof lookUp>): readonly Record<string, any>[] {
  assert.ok("answer" in answer, `affordances must answer, got ${JSON.stringify(answer)}`);
  return answer.answer.groups as readonly Record<string, any>[];
}

test("affordances groups the families that have a target in view, with count, action and nearest target", () => {
  const answer = lookUp(
    farmWith({
      weedTargets: [0, 1, 2].map((index) => ({ targetId: `weed_${String(index)}`, x: 40 + index, y: 9, health: 1 })),
      rockSourceTargets: [
        {
          targetId: "rock_0",
          location: "Farm",
          x: 44,
          y: 9,
          qualifiedItemId: "(O)32",
          health: 1,
          displayName: "Stone",
        },
      ],
      machineTargets: [
        {
          targetId: "machine_0",
          displayName: "Furnace",
          x: 43,
          y: 12,
          qualifiedItemId: "(BC)13",
          readyForHarvest: false,
          minutesUntilReady: 30,
        },
      ],
      farmAnimalPetTargets: [{ targetId: "farm_animal_0", x: 46, y: 8, animalType: "White Chicken", friendship: 40 }],
    }),
    "affordances",
    "",
    AFFORDANCE_SURFACE,
  );
  const groups = groupsOf(answer);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["weed", "farmAnimalPet", "machine", "rockSource"],
    "count desc, then kind name - the order a caller can rely on",
  );
  assert.deepEqual(groups[0], {
    kind: "weed",
    family: "weedTargets",
    count: 3,
    action: "cut_weeds",
    actions: ["cut_weeds"],
    nearest: { targetId: "weed_0", x: 40, y: 9, tiles: 1 },
  });
  assert.deepEqual(groups.find((group) => group.family === "machineTargets")?.actions, [
    "machine_inspect",
    "machine_load",
    "machine_collect_output",
  ]);
  assert.ok("answer" in answer);
  assert.equal(answer.answer.omitted, 0);
  assert.equal(answer.answer.actionable, true);
});

test("a kind the surface does not declare is absent even when the snapshot carries its family", () => {
  // The snapshot has weeds; the surface says nothing consumes them. Reporting them would be inventing an action, and the
  // answer is what can be done rather than what exists.
  const answer = lookUp(
    farmWith({ weedTargets: [{ targetId: "weed_0", x: 40, y: 9, health: 1 }] }),
    "affordances",
    "",
    [{ actionId: "break_rock", targetFamily: "rockSourceTargets" }],
  );
  assert.deepEqual(groupsOf(answer), []);
  assert.ok("answer" in answer);
  // The one family the surface declares (`rockSourceTargets`) is not in this snapshot at all, so the answer names that
  // instead of claiming the world holds no rock.
  assert.deepEqual(answer.answer.notMeasured, ["rockSourceTargets"]);
  assert.match(String(answer.answer.nothing_actionable_here), /nothing here was measured/u);
});

test("a new family arrives with a name, with no edit to the module", () => {
  // The naming is derived from the wire's own shape, so a family the Mod adds later cannot arrive unnamed. It is also the
  // falsifier for "the kinds are a list": `meadowTargets` is in no list anywhere.
  const answer = lookUp(farmWith({ meadowTargets: [{ targetId: "meadow_0", x: 41, y: 10 }] }), "affordances", "", [
    { actionId: "scythe_meadow", targetFamily: "meadowTargets" },
  ]);
  assert.deepEqual(
    groupsOf(answer).map((group) => [group.kind, group.action]),
    [["meadow", "scythe_meadow"]],
  );
});

test("the nearest row is the closest by Chebyshev distance, then by id, and (0,0) is a real tile", () => {
  const answer = lookUp(
    farmWith({
      // (0,0) is the top-left tile of every farm: a row there must be located, not read as "no coordinates".
      weedTargets: [
        { targetId: "weed_far", x: 0, y: 0, health: 1 },
        { targetId: "weed_near_b", x: 39, y: 11, health: 1 },
        { targetId: "weed_near_a", x: 41, y: 9, health: 1 },
      ],
    }),
    "affordances",
    "",
    AFFORDANCE_SURFACE,
  );
  const weeds = groupsOf(answer)[0];
  // Both are one step away on the diagonal; the tie is broken by id so two runs answer the same bytes.
  assert.equal(weeds?.nearest.targetId, "weed_near_a");
  assert.equal(weeds?.nearest.tiles, 1);
  const onlyOrigin = lookUp(
    farmWith({ weedTargets: [{ targetId: "weed_origin", x: 0, y: 0, health: 1 }] }),
    "affordances",
    "",
    AFFORDANCE_SURFACE,
  );
  assert.deepEqual(groupsOf(onlyOrigin)[0]?.nearest, { targetId: "weed_origin", x: 0, y: 0, tiles: 40 });
});

test("a family whose rows carry no tile still reports its count, with the distance it does not know said out loud", () => {
  const answer = lookUp(
    farmWith({
      cookingRecipeTargets: [{ targetId: "recipe_0" }],
      weedTargets: [{ targetId: "weed_0", x: 40, y: 9, health: 1 }],
    }),
    "affordances",
    "",
    [...AFFORDANCE_SURFACE, { actionId: "cook_recipe", targetFamily: "cookingRecipeTargets" }],
  );
  const recipe = groupsOf(answer).find((group) => group.family === "cookingRecipeTargets");
  assert.equal(recipe?.count, 1);
  assert.deepEqual(recipe?.nearest, { targetId: "recipe_0", x: null, y: null, tiles: null });
});

/**
 * A SHOP ANSWER MUST NAME THE COUNTER, NOT THE SHOP.
 *
 * Measured `round90`: `shopTargets` published nine counters, the group answered `{kind:"shop", count:9, nearest:{…}}` with
 * `x`/`y`/`tiles` all null, and the two `shop_purchase` calls that followed passed `SeedShop` - the `shopId` the row carries
 * beside every counter - and were refused `shop_target_is_a_shop_id_not_a_counter`. The refusal was right; the answer that
 * invited the name was the defect, and it also hid the `stockPrices` the wire had just gained.
 */
test("a shop answer names every counter it counts, with the tile to walk to and what each sells", () => {
  const answer = lookUp(farmWith({ shopTargets: shopCounters() }), "affordances", "", SHOP_SURFACE);
  const shop = groupsOf(answer)[0];
  assert.equal(shop?.kind, "shop");
  assert.equal(shop?.count, 9, "the count is the rows the wire published");
  // The counter's own tile: published as `ownerTileX`/`ownerTileY`, and the walk to it is a walk a caller can make.
  assert.deepEqual(shop?.nearest, { targetId: "shop_0000000000000002", x: 40, y: 11, tiles: 1 });
  const counters = shop?.counters as readonly Record<string, any>[];
  assert.equal(counters.length, MAX_AFFORDANCE_COUNTERS, "the counters are bounded, nearest first");
  assert.equal(counters[0]?.targetId, shop?.nearest.targetId, "the nearest counter is the one `nearest` reports");
  assert.deepEqual({ x: counters[0]?.x, y: counters[0]?.y, tiles: counters[0]?.tiles }, { x: 40, y: 11, tiles: 1 });
  // Every counter is the id the action resolves. The shop id is a name beside it and is never what a caller passes.
  for (const counter of counters)
    assert.match(
      String(counter.targetId),
      /^shop_[0-9a-f]{16}$/u,
      "a counter id is the `shop_<16 hex>` the wire mints",
    );
  assert.deepEqual(
    counters.map((counter) => counter.shopId),
    ["SeedShop", "Shop0", "Shop1"],
    "the shop id is carried so a caller can tell WHICH counter it is, nearest first",
  );
  assert.equal(counters[0]?.ownerName, "Pierre");
  assert.equal(counters[0]?.ownerInReach, true, "whether the body can trade without walking is the row's own fact");
  // The price reaches the answer, joined to its item by id: this is the family `stockPrices` was added for.
  assert.deepEqual(counters[0]?.sells, [
    { qualifiedItemId: "(O)472", price: 40 },
    { qualifiedItemId: "(O)378", price: 75 },
  ]);
  assert.equal(
    counters[0]?.stockCount,
    3,
    "the menu's whole size is read, so a bounded `sells` is not read as the stock",
  );
  assert.equal(shop?.countersOmitted, 9 - MAX_AFFORDANCE_COUNTERS, "the counters the bound dropped are counted");
});

test("a counter that published no price for an item says so instead of printing free", () => {
  const [counter] = shopCounters();
  const answer = lookUp(
    farmWith({ shopTargets: [{ ...counter, stockPrices: [{ qualifiedItemId: "(O)472", price: 40 }] }] }),
    "affordances",
    "",
    SHOP_SURFACE,
  );
  const sells = (groupsOf(answer)[0]?.counters as readonly Record<string, any>[])[0]?.sells;
  assert.deepEqual(sells, [
    { qualifiedItemId: "(O)472", price: 40 },
    { qualifiedItemId: "(O)378", price: null },
  ]);
  // A price the counter does not name is dropped rather than attached to the id beside it: the join is by id, not by
  // position.
  const unstocked = lookUp(
    farmWith({ shopTargets: [{ ...counter, stockPrices: [{ qualifiedItemId: "(O)999", price: 7 }] }] }),
    "affordances",
    "",
    SHOP_SURFACE,
  );
  assert.deepEqual(
    (groupsOf(unstocked)[0]?.counters as readonly Record<string, any>[])[0]?.sells.map(
      (row: { price: unknown }) => row.price,
    ),
    [null, null],
  );
});

/**
 * THE SECOND ZERO: a family the surface declares and the snapshot does not carry is NOT MEASURED.
 *
 * The answer used to say nothing about the family at all, and the sentence it left behind - "no target of any published
 * action is in this snapshot" - claims the world holds none, which is a fact nobody measured. A caller has to be able to
 * tell "no shop counter here" from "the counters were never published, go and observe".
 */
test("a family the snapshot does not publish is named as not measured, never as a count of zero", () => {
  const answer = lookUp(base, "affordances", "", SHOP_SURFACE);
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, any>;
  assert.deepEqual(body.groups, [], "a family that was not published has no group, and no count of 0");
  assert.deepEqual(body.notMeasured, ["shopTargets"]);
  assert.equal(body.notMeasuredOmitted, 0);
  assert.match(
    String(body.nothing_actionable_here),
    /was measured|observe/u,
    "the empty answer must not claim the world holds no shop counter",
  );
});

test("a published family with no row in view is measured emptiness, and is not reported as unpublished", () => {
  const answer = lookUp(farmWith({ shopTargets: [] }), "affordances", "", SHOP_SURFACE);
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, any>;
  assert.deepEqual(body.groups, [], "measured emptiness is absent rather than a group of zero");
  assert.deepEqual(body.notMeasured, [], "this frame DID publish `shopTargets`: the difference is the whole point");
  assert.match(String(body.nothing_actionable_here), /no target of any published action/u);
});

test("a family the snapshot does publish is never named as unpublished", () => {
  const answer = lookUp(
    farmWith({ weedTargets: [{ targetId: "weed_0", x: 40, y: 9, health: 1 }], shopTargets: [] }),
    "affordances",
    "",
    [...AFFORDANCE_SURFACE, { actionId: "shop_purchase", targetFamily: "shopTargets" }],
  );
  assert.ok("answer" in answer);
  const body = answer.answer as Record<string, any>;
  assert.deepEqual(
    body.notMeasured,
    ["farmAnimalPetTargets", "machineTargets", "rockSourceTargets"],
    "every declared family this snapshot does not carry, in one deterministic order - weeds and shops ARE carried",
  );
  assert.equal(body.groups[0]?.family, "weedTargets");
});

test("an empty answer names which empty it is, and the two empties are different sentences", () => {
  // Not one of the four families this surface declares is in `base` at all, so this is the NOT-MEASURED empty: a sentence
  // claiming the world holds no weed would be a claim about a world nobody looked at.
  const noTargets = lookUp(base, "affordances", "", AFFORDANCE_SURFACE);
  assert.ok("answer" in noTargets);
  assert.deepEqual(noTargets.answer.groups, []);
  assert.match(String(noTargets.answer.nothing_actionable_here), /nothing here was measured/u);
  assert.deepEqual(noTargets.answer.notMeasured, [
    "farmAnimalPetTargets",
    "machineTargets",
    "rockSourceTargets",
    "weedTargets",
  ]);
  const noSurface = lookUp(farmWith({ weedTargets: [{ targetId: "weed_0", x: 40, y: 9, health: 1 }] }), "affordances");
  assert.ok("answer" in noSurface);
  assert.deepEqual(noSurface.answer.groups, []);
  assert.match(String(noSurface.answer.nothing_actionable_here), /declares a target family/u);
});

test("the answer is capped and reports the kinds it dropped", () => {
  // Twelve families in view, each with one row; the cap is what keeps this a question rather than an observation.
  const families = [
    "weedTargets",
    "rockSourceTargets",
    "machineTargets",
    "debrisTargets",
    "itemTargets",
    "forageTargets",
    "seedTargets",
    "grassTargets",
    "harvestTargets",
    "treeChopSourceTargets",
    "treeStumpTargets",
    "treeSaplingTargets",
  ];
  const targets: Record<string, unknown> = {};
  for (const family of families) targets[family] = [{ targetId: `${family}_0`, x: 41, y: 10 }];
  const answer = lookUp(
    farmWith(targets),
    "affordances",
    "",
    families.map((family) => ({ actionId: `use_${family}`, targetFamily: family })),
  );
  const groups = groupsOf(answer);
  assert.equal(groups.length, MAX_AFFORDANCE_GROUPS);
  assert.ok("answer" in answer);
  assert.equal(answer.answer.omitted, families.length - MAX_AFFORDANCE_GROUPS);
});

test("the same snapshot and surface answer the same bytes twice", () => {
  const withTargets = farmWith({
    weedTargets: [
      { targetId: "weed_a", x: 40, y: 9, health: 1 },
      { targetId: "weed_b", x: 41, y: 9, health: 1 },
    ],
    rockSourceTargets: [
      { targetId: "rock_0", location: "Farm", x: 44, y: 9, qualifiedItemId: "(O)32", health: 1, displayName: "Stone" },
    ],
  });
  assert.equal(
    JSON.stringify(lookUp(withTargets, "affordances", "", AFFORDANCE_SURFACE)),
    JSON.stringify(lookUp(withTargets, "affordances", "", AFFORDANCE_SURFACE)),
  );
});
