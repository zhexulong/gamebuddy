import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_ACTION_ADAPTERS } from "./action-registry.js";
import { MAX_AFFORDANCE_GROUPS, LOOKUP_SUBJECTS } from "./game-lookup.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

const snapshot: Snapshot = {
  revision: 41,
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
  inventoryItemFacts: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 }],
  chests: [
    {
      chestId: "chest_a",
      x: 8,
      y: 9,
      displayName: "Chest",
      isFridge: false,
      items: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 }],
    },
  ],
  chestsSummary: { chestCount: 1, itemCount: 1, fullCount: 0 },
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

/**
 * A connected session holding `admitted` as its authoritative snapshot. `observe` counts fresh solicitations.
 *
 * `registrations` and `capabilities` default to the empty surface, so a test that is not about the catalogue keeps the
 * smallest session that answers.
 */
function integration(
  admitted: Snapshot | null = snapshot,
  observeCalls: { count: number } = { count: 0 },
  surface: Readonly<{ registrations?: readonly ActionRegistration[]; capabilities?: readonly string[] }> = {},
) {
  const capabilities = surface.capabilities ?? [];
  const connection: StardewBridgeConnection & { observe: () => Promise<Snapshot> } = {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: admitted !== null,
      sessionId: "session_01",
      capabilities,
      catalogRegistrations: surface.registrations ?? [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: admitted,
      latestReceipt: null,
      latestReasonCode: null,
    },
    observe: async () => {
      observeCalls.count++;
      return admitted ?? snapshot;
    },
  };
  return connection;
}

function lookupTool(connection: StardewBridgeConnection) {
  const tool = createStardewObservationTools(connection).find((candidate) => candidate.name === "stardew_look_up");
  assert.ok(tool, "stardew_look_up must be a constant mount beside stardew_observe");
  return tool;
}

async function ask(connection: StardewBridgeConnection, params: unknown) {
  const tool = lookupTool(connection);
  const result = await tool.execute("lookup_01", params, new AbortController().signal, () => {}, {} as never);
  const text = result.content[0];
  assert.ok(text !== undefined && text.type === "text", "a lookup answers in one text block");
  return { text: text.text, body: JSON.parse(text.text) as Record<string, any> };
}

/**
 * The tool is only worth its schema if the model can reach it: registered by name, with the subject closed to the table
 * this module answers from and the filter optional. The subject list is read back out of the schema, so a subject added to
 * `LOOKUP_SUBJECTS` without reaching the schema - or a schema advertising a subject the module refuses - fails here.
 */
test("stardew_look_up is registered with the subject table as its closed vocabulary", () => {
  const tool = lookupTool(integration());
  const schema = tool.parameters as {
    properties?: Record<string, { anyOf?: readonly { const?: string }[]; type?: string }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  const subjectSchema = schema.properties?.subject;
  const advertised = (subjectSchema?.anyOf ?? []).map((member) => member.const);
  assert.deepEqual(
    advertised,
    [...LOOKUP_SUBJECTS],
    "the schema must advertise exactly the subjects the module answers",
  );
  assert.deepEqual(schema.required, ["subject"]);
  assert.equal(schema.additionalProperties, false, "the arguments are closed: no argument the module does not read");
  assert.ok(schema.properties?.query !== undefined, "the filter is part of the schema, or no subject can be narrowed");
});

test("every subject answers through the tool and names the family it read", async () => {
  // A session that has read the Mod's catalogue: `affordances` groups the families that catalogue declares, so it can
  // only answer once the catalogue has been admitted, and every other subject is unaffected by it being there.
  const { registrations, capabilities } = liveSurface();
  const connection = integration({ ...snapshot, capabilities }, { count: 0 }, { registrations, capabilities });
  const filters: Record<string, unknown> = { chests: "iron", inventory: "iron", npcs: "abi" };
  for (const subject of LOOKUP_SUBJECTS) {
    const { body } = await ask(connection, { subject, ...(subject in filters ? { query: filters[subject] } : {}) });
    assert.ok(typeof body.source?.family === "string", `${subject} must name its source family`);
    assert.equal(body.source.snapshotRevision, snapshot.revision, `${subject} must name the revision it describes`);
  }
});

test("a lookup answers from the snapshot the session holds and never solicits a fresh observation", async () => {
  // `stardew_observe` is the tool that asks the Mod; this one is the question you can ask without waking the world. If it
  // ever calls `observe` itself, every lookup silently doubles the bridge traffic of an observation.
  const calls = { count: 0 };
  const { body } = await ask(integration(snapshot, calls), { subject: "crops" });
  assert.equal(calls.count, 0);
  assert.equal(body.source.family, "wateringWhereabouts");
});

test("a subject the snapshot does not carry answers source.family null through the tool", async () => {
  const { inventoryItemFacts: _dropped, ...withoutInventory } = snapshot;
  const { body } = await ask(integration(withoutInventory as Snapshot), { subject: "inventory", query: "ore" });
  assert.equal(body.source.family, null, "not looked must never be reported as an empty inventory");
  assert.equal(body.missingField, "inventoryItemFacts");
  assert.equal("rows" in body, false, "an empty list would be a claim about the world");
});

test("a session with no snapshot answers not-looked and names the reason code", async () => {
  const { body } = await ask(integration(null), { subject: "crops" });
  assert.equal(body.source.family, null);
  assert.equal(body.source.snapshotRevision, null);
  assert.equal(body.missingField, "snapshot");
});

test("a subject outside the table is refused with the derived list rather than answered", async () => {
  const { body } = await ask(integration(), { subject: "rocks" });
  assert.match(body.refused, /unknown_subject:rocks/u);
  assert.deepEqual(body.subjects, [...LOOKUP_SUBJECTS]);
  assert.equal(body.source.family, null);
});

/**
 * AFFORDANCES: WHAT CAN BE DONE HERE, NOW.
 *
 * <p>
 * Measured in a 48-minute live run: 15 of 104 published actions were attempted. Not because the companion was idle - it
 * called `stardew_plan_shape` 17 times - but because the only way to learn what was actionable was to read descriptors
 * one at a time and then compare them against the snapshot by hand. Nothing ever said "here, right now, these things can
 * be done", so 89 actions stayed invisible even when their target sat inside the 13x13 view.
 * </p>
 * <p>
 * The population of a group is DERIVED: the family is the `targetFamily` the Mod's own catalogue descriptor declares for
 * the action (the same declaration `tools/audit-stardew-discovery-channels.mjs`'s `TARGET_FIELD` verifies against the
 * wire), and the action set is `visibleActionsFromModCatalog` - the one visibility definition. This file contains no
 * list of kinds, families or actions of its own.
 * </p>
 */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));

type CatalogAction = Readonly<{
  actionId: string;
  lifecycle: "published" | "live_verified" | "experimental";
  kind: "execution" | "read_only";
  targetFamily?: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }> | string;
  effect?: "read" | "write";
  postcondition?: string | Readonly<{ name: string }>;
}>;

/** The Mod's generated catalogue: the authority for which actions exist and which family each one reads. */
const CATALOG: readonly CatalogAction[] = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
).actions;

/**
 * The same catalogue as the registrations the bridge admits: identity, lifecycle and the descriptor the Mod publishes for
 * the action, which is what `visibleActionsFromModCatalog` reads (descriptor-derived actions are admitted only when their
 * descriptor is the one the surface declares).
 */
function registrationsFromCatalog(actions: readonly CatalogAction[]): readonly ActionRegistration[] {
  return actions.map((action) =>
    Object.freeze({
      actionId: action.actionId,
      familyId: "fixture_family",
      identityVersion: 1,
      lifecycle: action.lifecycle,
      kind: "execution" as const,
      descriptor: Object.freeze({
        ...(action.argumentSchema === undefined ? {} : { argumentSchema: action.argumentSchema }),
        ...(action.outputFacts === undefined ? {} : { outputFacts: action.outputFacts }),
        ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
        ...(action.effect === undefined ? {} : { effect: action.effect }),
        ...(action.postcondition === undefined ? {} : { postcondition: action.postcondition }),
        ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily }),
      }),
    }),
  );
}

/**
 * The farm the brief measured: three weeds, a rock, a machine and a farm animal, all inside the view.
 *
 * No chest and no crop tile, so the four kinds are the whole answer and every row of it can be asserted.
 */
function fourKindsFarm(): Snapshot {
  const { chests: _chests, chestsSummary: _summary, cropTargets: _crops, ...bare } = snapshot;
  return {
    ...bare,
    location: "Farm",
    tile: { x: 40, y: 10 },
    weedTargets: [0, 1, 2].map((index) => ({
      targetId: `weed_0123456789abcde${String(index)}`,
      location: "Farm",
      x: 40 + index,
      y: 9,
      health: 1,
    })),
    rockSourceTargets: [
      {
        targetId: "rock_0123456789abcdef",
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
        targetId: "machine_0123456789abcdef",
        displayName: "Furnace",
        x: 43,
        y: 12,
        qualifiedItemId: "(BC)13",
        readyForHarvest: false,
        minutesUntilReady: 30,
      },
    ],
    farmAnimalPetTargets: [
      { targetId: "farm_animal_0123456789abcdef", x: 46, y: 8, animalType: "White Chicken", friendship: 40 },
    ],
  };
}

/** The same farm with eight more kinds of target in view, which is more than one answer has room for. */
function busyFarm(): Snapshot {
  return {
    ...fourKindsFarm(),
    harvestTargets: [
      {
        targetId: "harvest_0123456789abcdef",
        x: 41,
        y: 11,
        cropId: "24",
        qualifiedHarvestItemId: "(O)24",
        displayName: "Parsnip",
        regrowsAfterHarvest: false,
        readyForHarvest: true,
      },
    ],
    debrisTargets: [
      {
        targetId: "debris_0123456789abcdef",
        slot: 3,
        x: 45,
        y: 11,
        parentSheetIndex: 600,
        toolKind: "axe",
        requiredUpgradeLevel: 0,
        health: 2,
      },
    ],
    treeChopSourceTargets: [
      {
        targetId: "tree_0123456789abcdef",
        location: "Farm",
        x: 47,
        y: 13,
        treeType: "1",
        growthStage: 5,
        health: 1,
        stump: false,
        moss: false,
        tapped: false,
      },
    ],
    itemTargets: [
      {
        targetId: "item_0123456789abcdef",
        displayName: "Stone",
        x: 48,
        y: 12,
        qualifiedItemId: "(O)32",
        stack: 1,
      },
    ],
    forageTargets: [
      {
        targetId: "forage_0123456789abcdef",
        x: 49,
        y: 11,
        qualifiedItemId: "(O)18",
        stack: 1,
        displayName: "Daffodil",
        isForage: true,
      },
    ],
    seedTargets: [
      {
        targetId: "seed_tile_0123456789abcdef",
        slot: 2,
        x: 42,
        y: 13,
        qualifiedItemId: "(O)472",
        displayName: "Parsnip Seeds",
      },
    ],
    fertilizerTargets: [
      {
        targetId: "fertilizer_tile_0123456789abcdef",
        slot: 3,
        x: 43,
        y: 13,
        qualifiedItemId: "(O)369",
        displayName: "Basic Fertilizer",
      },
    ],
    grassTargets: [
      { targetId: "grass_0123456789abcdef", location: "Farm", x: 39, y: 8, grassType: 1, numberOfWeeds: 2 },
    ],
  };
}

/** The live capability set and registrations for every action the catalogued surface declares a target family for. */
function liveSurface(): { registrations: readonly ActionRegistration[]; capabilities: readonly string[] } {
  const registrations = registrationsFromCatalog(CATALOG);
  return { registrations, capabilities: registrations.map((entry) => entry.actionId) };
}

async function affordances(admitted: Snapshot) {
  const { registrations, capabilities } = liveSurface();
  const connection = integration({ ...admitted, capabilities }, { count: 0 }, { registrations, capabilities });
  return ask(connection, { subject: "affordances" });
}

test("affordances names the actions that have a target in view and the nearest target for each", async () => {
  const { body } = await affordances(fourKindsFarm());
  const groups = body.answer?.groups as readonly Record<string, any>[] | undefined;
  assert.ok(Array.isArray(groups), `affordances must answer groups, got ${JSON.stringify(body).slice(0, 400)}`);
  // Four kinds in view, four kinds in the answer, in the one deterministic order.
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["weed", "farmAnimalPet", "machine", "rockSource"],
  );
  const byFamily = new Map(groups.map((group) => [group.family, group]));
  // The weed family is the one with three rows, so its count is the row count, not a per-tile guess.
  const weeds = byFamily.get("weedTargets");
  assert.ok(weeds !== undefined, `the three weeds in view must produce a group: ${JSON.stringify(groups)}`);
  assert.equal(weeds.count, 3);
  assert.equal(weeds.action, "cut_weeds");
  assert.deepEqual(weeds.actions, ["cut_weeds"]);
  // (40,10) is the actor's own tile, so the first weed published is the nearest one by Chebyshev distance.
  assert.equal(weeds.nearest.targetId, "weed_0123456789abcde0");
  assert.deepEqual({ x: weeds.nearest.x, y: weeds.nearest.y, tiles: weeds.nearest.tiles }, { x: 40, y: 9, tiles: 1 });
  // A family with three consumers names all of them and leads with the first the catalogue publishes.
  const machines = byFamily.get("machineTargets");
  assert.ok(machines !== undefined, "the furnace in view must produce a machine group");
  assert.deepEqual(machines.actions, ["machine_inspect", "machine_load", "machine_collect_output"]);
  assert.equal(machines.action, "machine_inspect");
  assert.equal(byFamily.get("farmAnimalPetTargets")?.action, "pet_farm_animal");
  assert.equal(byFamily.get("rockSourceTargets")?.action, "break_rock");
  // The container family's address is `chestId`, and the answer still names it: an id is what a caller dispatches with.
  const { body: withChest } = await affordances({
    ...fourKindsFarm(),
    chests: [{ chestId: "chest_a", x: 8, y: 9, displayName: "Chest", isFridge: false, items: [] }],
  });
  const chestGroup = (withChest.answer.groups as readonly Record<string, any>[]).find(
    (group) => group.family === "chests",
  );
  assert.equal(chestGroup?.nearest.targetId, "chest_a");
});

test("a session that publishes no target-bearing action says so, instead of blaming the world", async () => {
  // The farm has weeds, rock and machines in view; the SURFACE is what is empty here, and an answer that said "nothing
  // here" without saying which of the two was empty would send the next reader looking in the wrong place.
  const { body } = await ask(integration(busyFarm(), { count: 0 }, { registrations: [] }), { subject: "affordances" });
  assert.deepEqual(body.answer.groups, []);
  assert.match(body.answer.nothing_actionable_here, /surface/u);
});

test("nothing in view answers nothing_actionable_here rather than silence", async () => {
  const { registrations, capabilities } = liveSurface();
  // A world with no target of any declared family in it: still connected, still observed, nothing to do.
  const { chests: _chests, chestsSummary: _summary, ...bare } = snapshot;
  const untouched: Snapshot = { ...bare, capabilities, chests: [] };
  const empty = integration(untouched, { count: 0 }, { registrations, capabilities });
  const { body } = await ask(empty, { subject: "affordances" });
  assert.deepEqual(body.answer.groups, []);
  assert.equal(body.answer.omitted, 0);
  assert.match(body.answer.nothing_actionable_here, /target/u);
});

test("the answer is bounded, and every kind it dropped is counted", async () => {
  const farm = busyFarm();
  const declaredFamilies = new Set(CATALOG.map((action) => action.targetFamily).filter(Boolean));
  // Derived from the fixture itself: the families that are in view AND that some declared action consumes.
  const inView = Object.entries(farm).filter(
    ([field, value]) => declaredFamilies.has(field) && Array.isArray(value) && value.length > 0,
  ).length;
  assert.ok(
    inView > MAX_AFFORDANCE_GROUPS,
    `the fixture must put more kinds in view than the answer has room for, saw ${String(inView)}`,
  );
  const { body } = await affordances(farm);
  const groups = body.answer.groups as readonly unknown[];
  const omitted = body.answer.omitted as number;
  assert.equal(groups.length, MAX_AFFORDANCE_GROUPS, "the answer is capped");
  assert.equal(groups.length + omitted, inView, "nothing in view is dropped without being counted");
});

/**
 * Every action an affordance names must be one the action surface really declares AND one the Host really mounts, so a
 * family wired to a nonexistent or unmounted action cannot reach the model.
 *
 * Both populations are derived - the generated catalogue for the Mod's vocabulary, the adapter table for what the Host can
 * actually call - so this is not a list of actions, and it is the gate that goes red if a hand-written kind -> action
 * table is ever introduced beside the descriptor's own `targetFamily`.
 */
function groupsNamingUncallableActions(
  groups: readonly Record<string, any>[],
  declared: ReadonlySet<string>,
  mounted: ReadonlySet<string>,
) {
  return groups
    .flatMap((group) => (group.actions as readonly string[]).map((action) => ({ kind: group.kind, action })))
    .filter((entry) => !declared.has(entry.action) || !mounted.has(entry.action));
}

test("every action an affordance names is declared by the surface and mounted by the Host", async () => {
  const declared = new Set(CATALOG.map((action) => action.actionId));
  const mounted = new Set(STARDEW_ACTION_ADAPTERS.map((adapter) => adapter.actionId));
  assert.ok(declared.size > 50, `the Mod's catalogue must have been read (found ${String(declared.size)} actions)`);
  assert.ok(mounted.size > 50, `the Host's mount table must have been read (found ${String(mounted.size)} actions)`);
  const { body } = await affordances(busyFarm());
  const groups = body.answer.groups as readonly Record<string, any>[];
  const named = groups.flatMap((group) => group.actions as readonly string[]);
  assert.ok(named.length > 0, "the busy farm must name at least one action");
  const uncallable = groupsNamingUncallableActions(groups, declared, mounted);
  assert.deepEqual(
    uncallable,
    [],
    `an affordance naming an action the surface does not declare or the Host does not mount is an action the model cannot
call: ${JSON.stringify(uncallable)}`,
  );
  // Falsifier: the same check on a group naming an action neither side holds must report it by name.
  const fabricated = [{ kind: "weed", actions: ["cut_weeds", "ghost_action"] }];
  assert.deepEqual(groupsNamingUncallableActions(fabricated, declared, mounted), [
    { kind: "weed", action: "ghost_action" },
  ]);
});

test("a farm answer is a question-sized payload, not a second observation", async () => {
  // `stardew_observe` is ~6.9k tokens on a real farm. This is the answer that replaces reading 104 descriptors by hand and
  // comparing each family against the snapshot, so it has to stay cheap enough to ask on every plan step: ten kinds at
  // the cap measure 2015 bytes, and the ceiling leaves room for longer ids without becoming an observation.
  const { text } = await affordances(busyFarm());
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes <= 2560, `the affordance answer is ${String(bytes)} bytes; a question must stay question-sized`);
});

test("a typical answer is a question-sized payload, not a second observation", async () => {
  // The point of a bounded answer: the model can afford to ask this mid-plan. An observation is 800-1500 tokens, so a
  // lookup that costs a kilobyte has already failed at being a question.
  const { text } = await ask(integration(), { subject: "crops" });
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes <= 1024, `the crops answer is ${String(bytes)} bytes; a lookup must stay question-sized`);
  // Falsifier in the same shape: the same subject on a farm whose whole-map summaries are empty still answers, and does
  // not pad itself up to a floor.
  const { text: emptyText } = await ask(integration({ ...snapshot, wateringWhereabouts: [], harvestWhereabouts: [] }), {
    subject: "crops",
  });
  assert.ok(Buffer.byteLength(emptyText, "utf8") < bytes, "an empty farm must not answer larger than a busy one");
});
