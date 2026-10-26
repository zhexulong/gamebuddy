import assert from "node:assert/strict";
import test from "node:test";

import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { Snapshot } from "./protocol.js";

/**
 * W5: the observation payload is the largest per-turn cost the Host hands the model. Measured on the
 * 2026-10-26 multi-day run (26 calls, 643,712 bytes, mean 24,758): two families carried bytes no
 * dispatch decision can consume, and both are bounded here.
 *
 * Everything a dispatched action needs to be issued - target ids, tiles, tool slots, inventory,
 * clock and calendar - must survive the bound unchanged. An EMPTY family stays present, because a
 * plan script loops `for (const row of snapshot.<family>)` and an elided key throws in the compiler.
 */

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

/** A snapshot whose bounded families are populated the way the live Mod publishes them. */
const snapshot: Snapshot = {
  revision: 412,
  location: "Farm",
  tile: { x: 64, y: 15 },
  stamina: 270,
  health: 100,
  exhausted: false,
  actionable: true,
  capabilities: ["plant_seed", "craft_item", "cook_recipe", "talk_to_npc"],
  catalogRevision: 9,
  enabledActionIds: ["plant_seed", "craft_item", "cook_recipe", "talk_to_npc"],
  presentationLocale: "zh-CN",
  weather: "sunny",
  timeOfDay: 1400,
  dayOfMonth: 12,
  seasonIndex: 2,
  year: 2,
  currentTool: "(T)Hoe",
  currentToolSlot: 1,
  inventorySlots: 36,
  // Dispatch-bearing: the plan copies slot/x/y/expectedTargetId verbatim.
  seedTargets: [
    { targetId: "seed_aaa", slot: 5, x: 58, y: 19, qualifiedItemId: "(O)474", displayName: "花椰菜种子" },
    { targetId: "seed_bbb", slot: 5, x: 59, y: 18, qualifiedItemId: "(O)474", displayName: "花椰菜种子" },
  ],
  toolSlots: [{ slot: 1, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }],
  // Bounded: villagers elsewhere whose coordinates no action can reach, plus one in this location.
  villagerWhereabouts: [
    { npcName: "Marlon", displayName: "马龙", location: "AdventureGuild", x: 5, y: 11, inCurrentLocation: false },
    { npcName: "Jas", displayName: "贾斯", location: "AnimalShop", x: 4, y: 6, inCurrentLocation: false },
    { npcName: "Abigail", displayName: "阿比盖尔", location: "Farm", x: 70, y: 20, inCurrentLocation: true },
  ],
  // Bounded: learned recipes that cannot be crafted from this inventory.
  craftingRecipeTargets: [
    { targetId: "Campfire", displayName: "篝火", ingredientsAvailable: false },
    { targetId: "Chest", displayName: "宝箱", ingredientsAvailable: false },
    { targetId: "Wood_Fence", displayName: "木栅栏", ingredientsAvailable: true },
  ],
  cookingRecipeTargets: [{ targetId: "Fried_Egg", displayName: "煎蛋", ingredientsAvailable: false }],
};

interface Observation {
  /** The JSON the model receives. */
  readonly published: Readonly<Record<string, unknown>>;
  /** The bound's operator accounting, which the provider never sends. */
  readonly budget: Readonly<{
    elidedVillagerCoordinates: number;
    withheldUnavailableRecipes: number;
    bytesRemoved: number;
  }>;
}

function connectionFor(candidate: Snapshot): StardewBridgeConnection {
  return {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["plant_seed"],
      catalogRegistrations: [],
      catalogRevision: 9,
      enabledActionIds: ["plant_seed"],
      snapshot: candidate,
      latestReceipt: null,
      latestReasonCode: null,
    },
  };
}

async function observe(candidate: Snapshot): Promise<Observation> {
  const tool = createStardewObservationTools(connectionFor(candidate)).find(
    (entry) => entry.name === "stardew_observe",
  );
  if (tool === undefined) throw new Error("stardew_observe_tool_missing");
  const result = await tool.execute("t", {}, new AbortController().signal, () => {}, {} as never);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const budget = (result.details as { observationBudget?: unknown }).observationBudget;
  if (budget === undefined || typeof budget !== "object" || budget === null)
    throw new Error("observation_budget_missing_from_details");
  return {
    published: JSON.parse(text) as Readonly<Record<string, unknown>>,
    budget: budget as Observation["budget"],
  };
}

test("an observation drops the coordinates of villagers that are not in the actor's location", async () => {
  const { published } = await observe(snapshot);
  const whereabouts = published.villagerWhereabouts as readonly Readonly<Record<string, unknown>>[];

  // The roster fact survives: the model can still tell a villager is elsewhere, and where.
  assert.equal(whereabouts.length, 3, "every villager stays listed");
  const marlon = whereabouts.find((row) => row.npcName === "Marlon");
  assert.ok(marlon !== undefined, "an off-location villager must still be named");
  assert.equal(marlon.location, "AdventureGuild");
  assert.equal(marlon.inCurrentLocation, false);
  // And the fact no action could use is gone.
  assert.equal("x" in marlon, false, "an off-location tile is unreachable and must not be published");
  assert.equal("y" in marlon, false);

  // Positive control: the villager standing here keeps the tile an action is dispatched at.
  const abigail = whereabouts.find((row) => row.npcName === "Abigail");
  assert.ok(abigail !== undefined);
  assert.equal(abigail.x, 70);
  assert.equal(abigail.y, 20);
});

test("an observation publishes only currently craftable recipes and counts the rest", async () => {
  const { published } = await observe(snapshot);
  const crafting = published.craftingRecipeTargets as readonly Readonly<{ targetId: string }>[];
  const cooking = published.cookingRecipeTargets as readonly Readonly<{ targetId: string }>[];

  // A recipe whose ingredients are absent has exactly one decision attached - craft it now - and that
  // decision cannot be taken. Its row goes; the fact that it exists does not.
  assert.deepEqual(
    crafting.map((row) => row.targetId),
    ["Wood_Fence"],
  );
  assert.deepEqual(cooking, []);

  // The count is disclosed in the payload, so "not in the list" cannot be misread as "not learned".
  const disclosed = published.observationBudget as Readonly<{ withheldUnavailableRecipes: number }>;
  assert.equal(disclosed.withheldUnavailableRecipes, 3, "2 crafting + 1 cooking, counted in one place");
});

test("an observation keeps every fact an action is dispatched with", async () => {
  const { published } = await observe(snapshot);

  // Identity and geometry of the targets themselves.
  const seeds = published.seedTargets as readonly Readonly<Record<string, unknown>>[];
  assert.equal(seeds.length, 2);
  assert.deepEqual(
    seeds.map((row) => [row.targetId, row.slot, row.x, row.y]),
    [
      ["seed_aaa", 5, 58, 19],
      ["seed_bbb", 5, 59, 18],
    ],
  );

  // The actor's own place, tools and pack.
  assert.deepEqual(published.tile, { x: 64, y: 15 });
  assert.equal(published.location, "Farm");
  assert.equal(published.currentTool, "(T)Hoe");
  assert.equal(published.currentToolSlot, 1);
  assert.equal(published.inventorySlots, 36);
  assert.equal((published.toolSlots as readonly unknown[]).length, 1);

  // The clock and calendar.
  assert.equal(published.timeOfDay, 1400);
  assert.equal(published.dayOfMonth, 12);
  assert.equal(published.seasonIndex, 2);
  assert.equal(published.year, 2);

  // The revision an action's preconditions are bound to.
  assert.equal(published.revision, 412);
});

test("an empty target family stays present so a plan loop over it still runs", async () => {
  const { published } = await observe({ ...snapshot, weedTargets: [], machineTargets: [] });

  // A plan script writes `for (const weed of snapshot.weedTargets)`. An elided key is a TypeError in
  // the compiler, so an empty family is published as an empty array, never dropped.
  assert.deepEqual(published.weedTargets, []);
  assert.deepEqual(published.machineTargets, []);
});

test("the bound reports the NET bytes the model stops receiving", async () => {
  const { published, budget } = await observe(snapshot);

  // The disclosure block itself costs payload bytes. A gross figure would overstate the saving by
  // exactly the size of the block that carries it - the same class of error as a ledger that counts
  // inserts but not deletes.
  assert.equal(
    budget.bytesRemoved,
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") - Buffer.byteLength(JSON.stringify(published), "utf8"),
    "the reported saving must equal the measured payload difference",
  );
  assert.ok(budget.bytesRemoved > 0, "on a real-shaped payload the bound must be a net saving");
  assert.equal(budget.elidedVillagerCoordinates, 2);
  assert.equal(budget.withheldUnavailableRecipes, 3);
});

test("an observation with nothing to bound is published unchanged and disclosed as no cost", async () => {
  const clean: Snapshot = {
    ...snapshot,
    villagerWhereabouts: [
      { npcName: "Abigail", displayName: "阿比盖尔", location: "Farm", x: 70, y: 20, inCurrentLocation: true },
    ],
    craftingRecipeTargets: [{ targetId: "Wood_Fence", displayName: "木栅栏", ingredientsAvailable: true }],
    cookingRecipeTargets: [],
  };
  const { published, budget } = await observe(clean);

  // No disclosure block: a block that says "nothing was withheld" is pure cost on every clean
  // observation, and there is nothing for it to disclose.
  assert.equal("observationBudget" in published, false);
  assert.deepEqual(published.villagerWhereabouts, clean.villagerWhereabouts);
  assert.deepEqual(published.craftingRecipeTargets, clean.craftingRecipeTargets);
  assert.equal(budget.bytesRemoved, 0);
  assert.equal(budget.elidedVillagerCoordinates, 0);
  assert.equal(budget.withheldUnavailableRecipes, 0);
});
