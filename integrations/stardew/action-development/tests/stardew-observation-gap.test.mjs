import assert from "node:assert/strict";
import test from "node:test";
import {
  addressabilityCoverage,
  collectionCoverage,
  consumptionCoverage,
  fieldLevelCoverage,
  handlerFieldReads,
  locationCollectionPopulation,
  modMethodBodies,
  modRowFields,
  observationQuadrants,
  observeActionGaps,
  postconditionMutationCoverage,
  publicationGateCoverage,
  publicationGates,
  publishedRowFields,
  publishedSnapshotSurface,
  reconcile,
  snapshotParameterOrder,
  tileChannelCoverage,
  writeObservationSummary,
} from "../src/analysis/stardew-action-inventory-reconciliation.mjs";
import { parseDiscoveries } from "../src/analysis/stardew-mod-csharp-source.mjs";

/**
 * Falsifier suite for the observation-gap sections of the action-inventory reconciliation.
 *
 * The claim under test is narrow and specific: "the engine holds something, an action needs it, and no
 * snapshot family publishes it" is answered by a derivation, not by a list in the tool. Each case
 * below is one way that claim could be false - a collection the fabricated Mod does not read, a
 * channel it does read, an action whose target no family carries, and a ratchet entry that outlived
 * its subject.
 *
 * The real tree is measured once at the bottom, with a floor for every section, so the report cannot
 * pass by measuring nothing.
 */

/** The decompiled shape the sections read: one collection member, and the two tile channels. */
const GAME_LOCATION = `
public class GameLocation
{
	public readonly NetCollection<Building> buildings;
	public readonly NetVector2Dictionary<Object, NetRef<Object>> objects;
	public readonly NetCollection<Furniture> furniture;
	public readonly NetLongDictionary<FarmAnimal, NetRef<FarmAnimal>> animals;
	public OverlaidDictionary Objects
	{
		get
		{
			return objects;
		}
	}

	public string getTileProperty(int x, int y)
	{
		if (!isOutdoors.Value && doesTileHaveProperty(x, y, "Action", "Buildings") == "kitchen")
		{
			return null;
		}
		return doesTileHaveProperty(x, y, "TouchAction", "Back");
	}
}
`;

const GAME1 = `
public static IList<GameLocation> locations;
`;

const MINE_SHAFT = `
public class MineShaft
{
	public override bool checkAction(Location tileLocation, xTile.Dimensions.Rectangle viewport, Farmer who)
	{
		switch (getTileIndexAt(tileLocation, "Buildings", "mine"))
		{
		case 115:
			return true;
		}
		return base.checkAction(tileLocation, viewport, who);
	}
}
`;

const DECOMPILED = Object.freeze({
  "GameLocation.cs": GAME_LOCATION,
  "Game1.cs": GAME1,
  "MineShaft.cs": MINE_SHAFT,
});

/** A Mod source holding exactly the bodies a case needs. */
function fixture(bodies, path = "integrations/stardew/farmhandexecutioncontroller.fixture.cs") {
  return [{ path, source: `internal static class Fixture\n{\n${bodies.join("\n")}\n}\n` }];
}

const DISCOVER_OBJECTS_ONLY = `    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location.objects.Pairs.Select(pair => new BridgeRockSourceTarget("id", location.NameOrUniqueName, 0, 0, "(O)2", "Stone", 1)).ToArray();
    }`;

/** A published snapshot surface: one family, one row type with three fields. */
const MODELS = `
public sealed record BridgeSnapshot(
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null
);

public sealed record BridgeWorldObjectTarget(string TargetId, string Location, int X, int Y);
`;

const SURFACE = Object.freeze({
  actions: [
    { actionId: "place_owned_object", kind: "execution", argumentSchema: { expectedTargetId: { type: "string" } } },
    { actionId: "observe_scene", kind: "read_only", argumentSchema: {} },
  ],
});

const EMPTY_BASELINE = Object.freeze({ schema: "gamebuddy-stardew-observation-gap-baseline/v1", entries: [] });

/**
 * The wire schema, fabricated to match the fabricated Mod: one family per case, and the row fields the
 * section reads its verdict from. `publishedRowFields` resolves a family through its own `items.$ref`, so
 * this fixture is the same shape the real `protocol/bridge-v1.schema.json` has.
 */
const SCHEMA = Object.freeze({
  $defs: {
    snapshot: {
      properties: {
        worldObjectTargets: { type: "array", items: { $ref: "#/$defs/worldObjectTarget" }, maxItems: 48 },
      },
    },
    worldObjectTarget: { properties: { targetId: {}, location: {}, x: {}, y: {} } },
  },
});

/**
 * The Host's consumer inventory, fabricated: one family read only through a tool description.
 *
 * The cases below measure collections, channels, addressability, postconditions or gates, so the
 * consumption section must be handed an inventory that says "this family is read" - otherwise every
 * case would also be a case about F, and its finding list would say so. `perTurnLine` is the per-turn
 * nearby-target line's own table: it names a family none of these cases asserts on, so the table is
 * readable (the section reports an unreadable one) without consuming the families under test.
 */
const CONSUMPTION_FIXTURE = Object.freeze({
  inventory: `
export const REQUIRED_PROJECTED_KEYS = Object.freeze([
  "timeOfDay",
]);

const UNPROJECTED_OBSERVED_FAMILIES = Object.freeze([
  "worldObjectTargets",
  "chests",
]);

const WITHHELD_SCALAR_KEYS: Readonly<Record<string, string>> = Object.freeze({
  acceptedDailyQuest:
    "a planning flag that changes once a day",
});

export const PROJECTION_SOURCES = Object.freeze([
  "host/src/game-world-vocabulary.ts",
  "host/src/snapshot-projection.ts",
]);
`,
  tools: "Copy the expectedTargetId from the worldObjectTargets entries of the MOST RECENT observe result.",
  perTurnLine: `
export const TARGET_FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  soilTiles: "\u53ef\u52c4\u7684\u5730\u5757",
});
`,
  projectionSources: new Map([
    ["host/src/game-world-vocabulary.ts", ""],
    ["host/src/snapshot-projection.ts", ""],
  ]),
});

function observe(overrides = {}) {
  return observeActionGaps({
    sources: fixture([DISCOVER_OBJECTS_ONLY]),
    decompiled: DECOMPILED,
    // The named-type half of the collection test (`Inventory : IList<Item>`) needs the decompiled tree; the
    // fixtures declare their collection types locally, so an empty index is the fixture's own statement and
    // keeps this suite runnable on a checkout without `ref/external`.
    collectionTypes: new Set(),
    surface: SURFACE,
    models: MODELS,
    schema: SCHEMA,
    baseline: EMPTY_BASELINE,
    targetField: { place_owned_object: "WorldObjectTargets" },
    consumption: CONSUMPTION_FIXTURE,
    ...overrides,
  });
}

test("the collection population is derived from the decompiled type, not from a list here", () => {
  const population = locationCollectionPopulation({ gameLocation: GAME_LOCATION, game1: GAME1 });

  assert.deepEqual(
    population.map((entry) => entry.id),
    ["buildings", "objects", "furniture", "animals", "Game1.locations"],
  );
  // `Objects` is the property over `objects`: one collection, one row.
  assert.equal(population.filter((entry) => entry.id.toLowerCase() === "objects").length, 1);
});

/**
 * The actor's own members, in the shapes the type test has to tell apart: the pack behind an `Inventory`
 * (a named type that declares `IList<Item>`), a replicated string dictionary, a single-object holder, a
 * STATIC collection, and a method whose parameter list names a `List`.
 */
const FARMER = `
public class Farmer
{
	public readonly NetRef<Inventory> netItems = new NetRef<Inventory>(new Inventory());
	public readonly NetStringDictionary<Friendship, NetRef<Friendship>> friendshipData = new NetStringDictionary<Friendship, NetRef<Friendship>>();
	public readonly NetRef<Horse> mount = new NetRef<Horse>();
	public static Dictionary<int, HairStyleMetadata> hairStyleMetadata = new Dictionary<int, HairStyleMetadata>();

	public Inventory Items => netItems.Value;

	public void ShowPagedResponses(string prompt, List<KeyValuePair<string, string>> responses, bool autoSelectSingleChoice = false)
	{
	}
}
`;

/** `Game1`'s statics are the world: the location list, a content cache and a scheduling queue. */
const GAME1_WORLD = `
public static IList<GameLocation> locations;
public static IDictionary<string, ObjectData> objectData = new Dictionary<string, ObjectData>();
public static Queue<Action> morningQueue = new Queue<Action>();
`;

const GAME_LOCATION_WORLD = `
public class GameLocation
{
	public readonly NetCollection<Building> buildings;
	public static IList<string> defaultCrabPotFishTypes;
}
`;

/** A discovery that reads the PACK, so the pack is read and its sibling on the same actor is not. */
const DISCOVER_PACK = `    internal static IReadOnlyList<BridgeInventoryItemFact> DiscoverInventoryItemFacts(Farmer player)
    {
        return player.Items.Select((item, slot) => new BridgeInventoryItemFact("id", slot, "(O)1", "Stone")).ToArray();
    }`;

/** `Inventory : IList<Item>` - the one type fact that makes the pack a collection. */
const INVENTORY_SOURCE = `public class Inventory : INetObject<NetFields>, IList<Item>, ICollection<Item> { }`;

test("the collection population reaches the actor: the pack is in it, a member nothing reads reds", () => {
  const collectionTypes = new Set(["Inventory"]);
  const population = locationCollectionPopulation({
    gameLocation: GAME_LOCATION_WORLD,
    farmer: FARMER,
    game1: GAME1_WORLD,
    collectionTypes,
  });
  const ids = population.map((entry) => entry.id);

  // The defect this population was widened for: the pack is attached to the PLAYER, and a population derived
  // from `GameLocation` alone cannot see it. `Inventory` names no container genus in its own declaration, so the
  // type fact comes from the type's base list (`INVENTORY_SOURCE`), not from a name in this file.
  assert.ok(ids.includes("Farmer.Items"), `population: ${ids.join(", ")}`);
  assert.equal(population.find((entry) => entry.id === "Farmer.Items").type, "Inventory");
  assert.match(population.find((entry) => entry.id === "Farmer.Items").evidence, /^Farmer\.cs:\d+$/u);

  // `Game1`'s statics are the world map and its caches; a `Farmer`'s statics are class data, and a single-object
  // holder (`NetRef<Horse>`) is not a collection at all.
  assert.ok(ids.includes("Game1.locations"));
  assert.ok(ids.includes("Game1.objectData"));
  assert.ok(ids.includes("Game1.morningQueue"));
  assert.ok(!ids.includes("Farmer.hairStyleMetadata"), "a Farmer's static collection is class data, not its state");
  assert.ok(!ids.includes("GameLocation.defaultCrabPotFishTypes"));
  assert.ok(!ids.includes("Farmer.mount"), "a `NetRef<Horse>` holds one object");
  // A method's parameter list names a `List`, and a declaration is not a member.
  assert.ok(!ids.includes("Farmer.autoSelectSingleChoice"), `population: ${ids.join(", ")}`);

  const rows = collectionCoverage({ discoveries: parseDiscoveries(fixture([DISCOVER_PACK])), population });
  const pack = rows.find((row) => row.id === "Farmer.Items");
  assert.deepEqual(pack.readers, ["DiscoverInventoryItemFacts"], "the pack is read by a publisher, so it is not a gap");
  assert.equal(rows.find((row) => row.id === "Farmer.friendshipData").readBy, 0);

  const report = observe({
    sources: fixture([DISCOVER_PACK]),
    decompiled: { ...DECOMPILED, "GameLocation.cs": GAME_LOCATION_WORLD, "Farmer.cs": FARMER, "Game1.cs": GAME1_WORLD },
    collectionTypes,
  });
  const codes = report.findings.filter((finding) => finding.kind === "collection").map((finding) => finding.code);
  assert.ok(codes.includes("collection_never_read:Farmer.friendshipData"), codes.join(", "));
  assert.ok(!codes.includes("collection_never_read:Farmer.Items"), "a read collection is not a finding");
  assert.match(
    report.findings.find((finding) => finding.code === "collection_never_read:Farmer.friendshipData").detail,
    /Farmer\.cs:\d+/u,
    "the finding carries the declaration line the reader has to open",
  );
});

test("a discovery that reads objects but not furniture reports the furniture collection", () => {
  const population = locationCollectionPopulation({ gameLocation: GAME_LOCATION, game1: GAME1 });
  const rows = collectionCoverage({ discoveries: parseDiscoveries(fixture([DISCOVER_OBJECTS_ONLY])), population });

  assert.deepEqual(
    rows.filter((row) => row.readBy === 0).map((row) => row.id),
    ["buildings", "furniture", "animals", "Game1.locations"],
  );
  const report = observe();
  assert.deepEqual(
    report.collections.neverRead,
    ["buildings", "furniture", "animals", "Game1.locations"],
  );
  assert.ok(
    report.findings.some((finding) => finding.code === "collection_never_read:furniture"),
    "the furniture collection is invisible and the report must name it",
  );
});

test("a source that reads the tile Action property does not report that channel", () => {
  const readBoth = fixture([
    `    private static string? ReadAction(GameLocation location, int x, int y) => location.doesTileHaveProperty(x, y, "Action", "Buildings");`,
    `    private static string? ReadBuildingsIndex(GameLocation location, int x, int y) => location.map?.GetLayer("Buildings")?.Tiles[x, y]?.TileIndex.ToString();`,
  ]);
  const coverage = tileChannelCoverage({ sources: readBoth, decompiled: DECOMPILED });
  assert.deepEqual(
    coverage.rows.map((row) => [row.id, row.readBy]),
    [
      ["Action", 1],
      ["TouchAction", 0],
      ["Buildings", 1],
    ],
  );
  const report = observe({ sources: readBoth });
  assert.deepEqual(report.tileChannels.neverRead, ["TouchAction"]);
  assert.ok(report.findings.some((finding) => finding.code === "tile_channel_never_read:TouchAction"));
  assert.ok(!report.findings.some((finding) => finding.code === "tile_channel_never_read:Action"));
});

test("a channel named only in a comment is not a read, and a channel the engine lost is named", () => {
  const commented = fixture([
    `    // reads location.doesTileHaveProperty(x, y, "Action", "Buildings") once, in a comment`,
    `    private static string? Nothing(GameLocation location) => null;`,
  ]);
  const report = observe({ sources: commented });
  assert.deepEqual(report.tileChannels.neverRead, ["Action", "TouchAction", "Buildings"]);

  const drifted = observe({
    decompiled: { ...DECOMPILED, "MineShaft.cs": "public class MineShaft { }" },
  });
  assert.ok(
    drifted.findings.some((finding) => finding.code === "tile_channel_not_in_engine:Buildings"),
    "the Buildings channel declares MineShaft.checkAction as its engine site; losing it must be named",
  );
});

test("an action that names a target and publishes no family is reported", () => {
  const surface = {
    actions: [
      { actionId: "place_owned_object", kind: "execution", argumentSchema: { expectedTargetId: { type: "string" } } },
      { actionId: "rotate_furniture", kind: "execution", argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
      { actionId: "observe_scene", kind: "read_only", argumentSchema: { expectedTargetId: { type: "string" } } },
    ],
  };
  const published = new Set(
    publishedSnapshotSurface(MODELS).families.map((family) => family.field.toLowerCase()),
  );
  const coverage = addressabilityCoverage({
    surface,
    targetField: { place_owned_object: "WorldObjectTargets" },
    published,
  });

  assert.deepEqual(
    coverage.rows.map((row) => [row.actionId, row.family]),
    [
      ["place_owned_object", "WorldObjectTargets"],
      ["rotate_furniture", null],
    ],
  );
  assert.deepEqual(
    coverage.findings.map((finding) => finding.code),
    ["action_without_addressable_family:rotate_furniture"],
  );

  // The surface's own `targetFamily` is the second authority; when it names a family the action has one.
  const viaSurface = addressabilityCoverage({
    surface: {
      actions: [
        {
          actionId: "rotate_furniture",
          kind: "execution",
          targetFamily: "worldObjectTargets",
          argumentSchema: { expectedTargetId: { type: "string" } },
        },
      ],
    },
    targetField: {},
    published,
  });
  assert.deepEqual(viaSurface.findings, []);
  assert.equal(viaSurface.rows[0].family, "worldObjectTargets");

  // Two authorities naming different families is a finding, not a silent winner.
  const disagreeing = addressabilityCoverage({
    surface: {
      actions: [
        {
          actionId: "place_owned_object",
          kind: "execution",
          targetFamily: "chests",
          argumentSchema: { expectedTargetId: { type: "string" } },
        },
      ],
    },
    targetField: { place_owned_object: "WorldObjectTargets" },
    published,
  });
  assert.deepEqual(disagreeing.findings.map((finding) => finding.code), ["addressable_family_disagrees:place_owned_object"]);
});

const HANDLER = `internal sealed class FixtureActionHandler
{
    private LocalExecutionReceipt? Resolve(FarmhandActionRequest request) => request.ActionId switch
    {
        "rotate_furniture" => this.executions.RequestLocalRotateFurniture(request.RequestId, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0)),
        _ => null,
    };
}
`;

const CONTROLLER = `internal sealed partial class FarmhandExecutionController
{
    public LocalExecutionReceipt RequestLocalRotateFurniture(string requestId, int targetX, int targetY)
    {
        return this.ExecuteRotateFurniture(requestId, targetX, targetY);
    }

    private LocalExecutionReceipt ExecuteRotateFurniture(string requestId, int targetX, int targetY)
    {
        GameLocation location = Game1.player.currentLocation;
        location.furniture[0].rotation.Value = 1;
        this.revision++;
        return null;
    }
}
`;

test("a handler mutation no published row carries is reported, and the ratchet records it once", () => {
  const sources = [
    ...fixture([DISCOVER_OBJECTS_ONLY]),
    ...fixture([HANDLER], "integrations/stardew/Handlers/FixtureActionHandler.cs"),
    ...fixture([CONTROLLER], "integrations/stardew/farmhandexecutioncontroller.fixture.cs"),
  ];
  const vocabulary = publishedSnapshotSurface(MODELS).vocabulary;
  const mutations = postconditionMutationCoverage({ sources, vocabulary });

  assert.deepEqual(
    mutations.map((mutation) => [mutation.id, mutation.member, mutation.published]),
    [["rotate_furniture:rotation", "rotation", false]],
  );

  const reported = observe({ sources });
  assert.deepEqual(reported.findings.map((finding) => finding.code), [
    "collection_never_read:buildings",
    "collection_never_read:furniture",
    "collection_never_read:animals",
    "collection_never_read:Game1.locations",
    "tile_channel_never_read:Action",
    "tile_channel_never_read:TouchAction",
    "tile_channel_never_read:Buildings",
    "mutation_not_observable:rotate_furniture:rotation",
  ]);

  const baselined = observe({
    sources,
    baseline: {
      schema: "gamebuddy-stardew-observation-gap-baseline/v1",
      entries: [
        { kind: "mutation", id: "rotate_furniture:rotation", reason: "measured: the piece's rotation is not published" },
      ],
    },
  });
  assert.ok(!baselined.findings.some((finding) => finding.code.startsWith("mutation_not_observable")));
});

test("a baseline entry whose subject is now read fails as stale, and an unexplained one is a finding", () => {
  const baselined = observe({
    baseline: {
      schema: "gamebuddy-stardew-observation-gap-baseline/v1",
      entries: [
        { kind: "collection", id: "objects", reason: "recorded when nothing read the object layer" },
        { kind: "collection", id: "furniture", reason: "recorded as debt" },
        { kind: "collection", id: "animals" },
      ],
    },
  });

  assert.ok(
    baselined.findings.some((finding) => finding.code === "stale_baseline_entry:collection:objects"),
    "objects is read now, so its baseline entry must be deleted",
  );
  assert.ok(
    !baselined.findings.some((finding) => finding.code === "collection_never_read:furniture"),
    "a baselined collection is excused",
  );
  assert.ok(
    baselined.findings.some((finding) => finding.code === "baseline_entry_unexplained:collection:animals"),
    "a silent exception is not a ratchet",
  );
  assert.ok(
    !baselined.findings.some((finding) => finding.code === "baseline_entry_unknown_subject:collection:furniture"),
    "furniture is still unread, so its entry names a real subject",
  );
});

test("a mutation that no longer exists, or whose member is now published, is stale", () => {
  const models = `
public sealed record BridgeSnapshot(
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null
);

public sealed record BridgeWorldObjectTarget(string TargetId, string Location, int X, int Y, int Rotation);
`;
  const sources = [
    ...fixture([DISCOVER_OBJECTS_ONLY]),
    ...fixture([HANDLER], "integrations/stardew/Handlers/FixtureActionHandler.cs"),
    ...fixture([CONTROLLER], "integrations/stardew/farmhandexecutioncontroller.fixture.cs"),
  ];
  const publishedNow = observe({
    sources,
    models,
    baseline: {
      schema: "gamebuddy-stardew-observation-gap-baseline/v1",
      entries: [{ kind: "mutation", id: "rotate_furniture:rotation", reason: "recorded before rotation was published" }],
    },
  });
  assert.ok(
    publishedNow.findings.some((finding) => finding.code === "stale_baseline_entry:mutation:rotate_furniture:rotation"),
    "rotation is a published row field now",
  );

  const gone = observe({
    baseline: {
      schema: "gamebuddy-stardew-observation-gap-baseline/v1",
      entries: [{ kind: "mutation", id: "rotate_furniture:parentSheetIndex", reason: "recorded for a mutation that was removed" }],
    },
  });
  assert.ok(gone.findings.some((finding) => finding.code === "stale_baseline_entry:mutation:rotate_furniture:parentSheetIndex"));
  assert.ok(
    !gone.findings.some(
      (finding) => finding.code === "baseline_entry_unknown_subject:mutation:rotate_furniture:parentSheetIndex",
    ),
    "a mutation entry is judged by the mutation section, not by the subject lookup",
  );
});

const HAND_SWAP = `internal sealed partial class FarmhandExecutionController
{
    public LocalExecutionReceipt RequestLocalTalkToNpc(string requestId)
    {
        return this.ExecuteTalkToNpc(requestId);
    }

    private LocalExecutionReceipt ExecuteTalkToNpc(string requestId)
    {
        int previousSlot = Game1.player.CurrentToolIndex;
        Game1.player.CurrentToolIndex = FindEmptyHandSlot(Game1.player);
        Game1.player.CurrentToolIndex = previousSlot;
        return null;
    }
}
`;

const HAND_SWAP_HANDLER = `internal sealed class FixtureActionHandler
{
    private LocalExecutionReceipt? Resolve(FarmhandActionRequest request) => request.ActionId switch
    {
        "talk_to_npc" => this.executions.RequestLocalTalkToNpc(request.RequestId),
        _ => null,
    };
}
`;

/** The published slot the hand-swapping handlers mutate, beside the one family the fixture Mod discovers. */
const HAND_MODELS = `
public sealed record BridgeSnapshot(
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null,
    int? CurrentToolSlot = null
);

public sealed record BridgeWorldObjectTarget(string TargetId, string Location, int X, int Y);
`;

/**
 * D - one member, published under a different name.
 *
 * Nineteen handlers select the tool slot the native call needs and put it back, and `Farmer.CurrentToolIndex` is
 * published as the top-level `currentToolSlot`. Seventeen of them carried a baseline entry each, all saying that name
 * matching could not see the pair; the declared alias replaces the list. Both directions are asserted, because a
 * mapping that excuses everything is worse than the seventeen entries: a slot the snapshot does not publish is still a
 * finding, and the row vocabulary alone still cannot see the alias.
 */
test("the actor's active tool slot is carried by `currentToolSlot`, so a hand swap is observable", () => {
  const sources = [
    ...fixture([DISCOVER_OBJECTS_ONLY]),
    ...fixture([HAND_SWAP_HANDLER], "integrations/stardew/Handlers/FixtureActionHandler.cs"),
    ...fixture([HAND_SWAP]),
  ];
  const published = publishedSnapshotSurface(HAND_MODELS);
  assert.deepEqual(
    postconditionMutationCoverage({ sources, vocabulary: published.vocabulary, fields: published.fields }).map(
      (mutation) => [mutation.id, mutation.published],
    ),
    [["talk_to_npc:CurrentToolIndex", true]],
  );

  const withoutSnapshotFields = publishedSnapshotSurface(HAND_MODELS.replace("    int? CurrentToolSlot = null\n", ""));
  assert.deepEqual(
    postconditionMutationCoverage({ sources, vocabulary: withoutSnapshotFields.vocabulary }).map(
      (mutation) => mutation.published,
    ),
    [false],
    "the slot is a top-level snapshot field, which the row vocabulary does not carry",
  );

  const unpublishedSlot = publishedSnapshotSurface(HAND_MODELS.replace("CurrentToolSlot", "SomeOtherSlot"));
  assert.deepEqual(
    postconditionMutationCoverage({ sources, vocabulary: unpublishedSlot.vocabulary, fields: unpublishedSlot.fields }).map(
      (mutation) => mutation.published,
    ),
    [false],
    "a member no snapshot field publishes is still a gap",
  );
});

test("reconcile() appends the observation sections and leaves the three-way envelope alone without them", () => {
  const base = {
    selectorArtifact: { selectors: [], implementations: 0, source: { member: "GameLocation.performAction" } },
    remainingReport: {
      artifactKind: "stardew_remaining_actions_report",
      inputs: { candidates: "candidates.json", catalog: "catalog.json" },
      tiers: { A_catalog_intent_exists: [], B_no_catalog_intent: [], C_non_gameplay_writes: [] },
      counts: { unmatchedCandidateUnits: 0 },
    },
    register: { actions: [{ actionId: "place_owned_object" }] },
    catalog: { records: [] },
    // The three-way sections are not what this case measures: with no selectors and no verdict
    // tables, the completeness assertions have nothing to reconcile and the observation merge is the
    // only thing under test.
    rules: { selectorVerdicts: {}, methodVerdicts: {}, categoryDefaults: {} },
  };
  const without = reconcile(base);
  assert.equal(without.observationGaps, undefined);
  assert.deepEqual(
    Object.keys(without.counts).filter((key) => key.startsWith("observation")),
    [],
    "a caller that did not measure the observation gaps gets the envelope it always got",
  );

  const withObservation = reconcile({ ...base, observation: observe() });
  assert.equal(withObservation.observationGaps.schema, "gamebuddy-stardew-observation-gap/v1");
  assert.equal(withObservation.counts.observationCollectionNeverRead, 4);
  assert.equal(withObservation.counts.observationGapFindings, withObservation.observationGaps.findings.length);
  assert.equal(withObservation.counts.observationGapUngranted, withObservation.observationGaps.ungranted.length);
  assert.deepEqual(
    Object.keys(withObservation.groups),
    ["selectorLayer", "methodLayer", "rejectedLayer"],
    "the three-way sections are untouched",
  );
  assert.deepEqual(withObservation.counts.selectorRows, without.counts.selectorRows);
  assert.ok(
    withObservation.nonGuarantees.includes(
      "postcondition_mutation_matching_is_by_member_name_plus_one_declared_alias_and_is_a_ratchet_not_a_hard_red",
    ),
  );
});

test("the human summary names each section and every ungranted gap, on the same run as the JSON", () => {
  const lines = [];
  writeObservationSummary(observe(), (text) => lines.push(text));
  const text = lines.join("");

  assert.match(text, /observation gaps: 5 engine collections/);
  assert.match(text, /A collections\s+1 read, 4 never read \(buildings, furniture, animals, Game1\.locations\)/);
  assert.match(text, /B tile channels\s+0 read, 3 never read/);
  assert.match(text, /C addressability\s+1 target-bearing actions, 0 without a published family/);
  assert.match(text, /D postconditions\s+0 handlers/);
  assert.match(text, /E publication\s+0 advertisement gates over 0 families, 0 family\/action pair\(s\) gated off/);
  assert.match(
    text,
    /F consumption\s+1 published families: 0 read by a projection, 0 by the per-turn line, 1 named in a tool description; 0 with no consumer/,
  );
  assert.match(text, /on-demand delivery is not a gap/);
  assert.match(
    text,
    /G quadrants\s+0 local, 0 map-fixed \(0 untargeted\), 0 actor-owned, 1 undeclared \(WorldObjectTargets\): 0 map-fixed family\/action pair\(s\) with no per-turn line, 0 baselined with a reason, 0 ungranted/,
  );
  assert.match(text, /collection_never_read:furniture:/);
  assert.match(text, /ungranted observation gap\(s\)/);
});

test("the real tree is measured, and every red it reports is named", () => {
  const report = observeActionGaps({});

  assert.ok(report.collections.population.length >= 15, `population ${report.collections.population.length}`);
  assert.ok(report.tileChannels.channels.length >= 3);
  assert.ok(report.addressability.targetBearingActions >= 60, `target-bearing ${report.addressability.targetBearingActions}`);
  assert.ok(report.postconditionMutations.handlers >= 80, `handlers ${report.postconditionMutations.handlers}`);
  assert.ok(report.postconditionMutations.mutations.length >= 20);
  // The report must never read as green by measuring nothing: every section found something.
  assert.ok(report.collections.read.length >= 8);
  assert.ok(report.tileChannels.channels.some((row) => row.readBy > 0));
  // `largeTerrainFeatures` used to be named here: the bush discovery walked `terrainFeatures`, where a bush
  // cannot stand in a saved game. That gap is closed in the Mod (the discovery and `TryGetHarvestableBush`
  // both read `location.largeTerrainFeatures`), so the list is empty and stays an equality, not a floor:
  // a new finding has to be read and explained rather than absorbed.
  assert.ok(
    report.collections.read.includes("largeTerrainFeatures"),
    "the bush collection is read by a discovery",
  );

  // Sections E and F are measured, not floored: the one red left today is the family the Host's own inventory
  // does not classify, and it is not baselined. The equality is deliberate in both directions - a new gap or a fix
  // must fail here until this list is edited, so the report cannot go stale either way. The four gating gaps this
  // section reported on its first run (`RockSourceTargets:break_rock`, `TreeChopSourceTargets:chop_tree`,
  // `WorldObjectTargets:break_container`, `WorldObjectTargets:move_placed_furniture`) were fixed in the Mod, which
  // is why they are absent: the gate names the pre-rename action ids it was written against.
  assert.ok(report.publicationGating.gates.length >= 70, `gates ${report.publicationGating.gates.length}`);
  assert.ok(report.consumption.population >= 80, `families ${report.consumption.population}`);
  assert.ok(report.consumption.rows.some((row) => row.projections.length > 0));
  assert.ok(report.consumption.rows.some((row) => row.perTurnLine));
  assert.deepEqual(report.publicationGating.gatedOff, []);
  // Measured, not floored. `FarmAnimalPetTargets` is declared withheld by `snapshot-projection-coverage.ts` now
  // (`UNPROJECTED_OBSERVED_FAMILIES`), so the F section classifies it and no finding is left there; the G section's two
  // remaining map-fixed gaps carry baseline entries with their reasons. This pins F and G by their own kinds, because the
  // whole `ungranted` list is now shared with the field-level section that other work is landing in this same report.
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === "consumption" || finding.kind === "quadrant"),
    [],
  );
  // The advisory half is printed and counted, never red - `PendingLevelUpChoices` is exactly the shape of fact
  // that belongs there: published, delivered on demand, read by no line and targeted by no action.
  assert.ok(report.consumption.withoutConsumer.includes("PendingLevelUpChoices"));
  assert.deepEqual(report.consumption.unclassified, []);

  // G - quadrants, measured on the real tree. Every family is classified from its own discovery, or - for the three
  // `record BridgeSnapshot(...)` assembles by hand - from the declaration in `UNDISCOVERED_FAMILY_QUADRANTS`, so the
  // population is 83 (not a list here): 55 actor-bounded, 12 map-fixed, 16 the actor's own state, 0 with no answer.
  //
  // Re-measured 2026-11-07. The two quadrant exemptions that used to excuse `MineElevatorFloorTargets` and
  // `ShopTargets` are gone, and correctly so: both are read every turn now (`row.perTurnLine`, asserted below), so the gap they
  // excused is closed and `red`/`baselined` are 0. What moved with them: those two families left the actor-bounded
  // half, and `RefillWateringCanTargets` and `FixedInteractionPoints` entered the map-fixed half, which is why the four
  // numbers that are not `perTurnLine` moved together.
  //
  // Re-measured 2026-11-08: `Warps` was published with no `Discover*` to read, so the section called it undeclared
  // while the code plainly builds it from the current location's whole warp table; it is `map_fixed` now. The two
  // `actor_owned` arrivals are `PendingLevelUpChoices` (the actor's own unspent milestones) and `DiscoveryExclusions`
  // (the last radar pass's withheld counts, rows with no tile and no target id).
  assert.deepEqual(report.quadrant.counts, {
    local: 55,
    mapFixed: 12,
    actorOwned: 16,
    undeclared: 0,
    mapFixedUntargeted: 7,
    red: 0,
    baselined: 0,
    ungranted: 0,
  });
  assert.equal(report.quadrant.population, 83);
  assert.deepEqual(report.quadrant.undeclared, []);
  assert.deepEqual(report.quadrant.mapFixed, [
    "Warps",
    "DoorTargets",
    "RefillWateringCanTargets",
    "VillagerWhereabouts",
    "HarvestWhereabouts",
    "WateringWhereabouts",
    "CookingStationTargets",
    "MineElevatorFloorTargets",
    "ShopTargets",
    "MineEntranceTargets",
    "MailboxTargets",
    "FixedInteractionPoints",
  ]);
  // The per-turn nearby-target line closed the mine ladders, the mailbox and - measured 2026-11-07 - the elevator
  // floors and the shops. The `[State HUD: ...]` block that used to feed this channel was composed into text nobody
  // received and was deleted; the channel now reads the table `nearbyTargetFamilies` iterates into `<world-state>`.
  // Those last two used to be excused by a baseline entry; they are asserted as READ now, because an exemption that
  // outlives the defect it excused hides the next one.
  const perTurnRead = report.quadrant.rows.filter((row) => row.perTurnLine).map((row) => row.key);
  assert.ok(perTurnRead.includes("mineEntranceTargets"), "the way out of a mine level is in the per-turn block now");
  assert.ok(perTurnRead.includes("mailboxTargets"));
  for (const family of ["MineElevatorFloorTargets", "ShopTargets"]) {
    const row = report.quadrant.rows.find((entry) => entry.family === family);
    assert.ok(row, `${family} is not in the report at all`);
    assert.equal(row.quadrant, "map_fixed", `${family} is no longer map-fixed`);
    assert.equal(row.perTurnLine, true, `${family} left the per-turn read, so its closed gap has reopened`);
  }
  // Nothing map-fixed and targeted is left unread: a new one here has to be read and explained rather than absorbed.
  assert.deepEqual(
    report.quadrant.rows.filter((row) => row.quadrant === "map_fixed" && row.targeted && !row.perTurnLine).map((row) => row.family),
    [],
  );
  // The three families no `Discover*` publishes are classified by a declaration that names the code deciding them.
  // Nothing is left undeclared: a fourth family arriving without either has to be read and classified, not absorbed.
  assert.deepEqual(
    report.quadrant.rows.filter((row) => row.declared).map((row) => [row.family, row.quadrant]),
    [
      ["Warps", "map_fixed"],
      ["PendingLevelUpChoices", "actor_owned"],
      ["DiscoveryExclusions", "actor_owned"],
    ],
  );
});

const GATED_MODELS = `
public sealed record BridgeSnapshot(
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null,
    IReadOnlyList<BridgeChestState>? Chests = null
);

public sealed record BridgeWorldObjectTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeChestState(string TargetId, int OccupiedSlots);
`;

/**
 * A snapshot builder whose `WorldObjectTargets` gate admits one of the two actions that need it, and
 * whose `Chests` gate admits both of the ones that need it.
 */
const GATED_SNAPSHOT = `
    internal static IReadOnlyList<BridgeWorldObjectTarget> DiscoverWorldObjectTargets(Farmer player)
    {
        return Array.Empty<BridgeWorldObjectTarget>();
    }

    internal static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        return Array.Empty<BridgeChestState>();
    }

    internal BridgeSnapshot CreateBridgeSnapshot(Farmer player, IReadOnlyList<string> advertisedCapabilities)
    {
        return new BridgeSnapshot(
            advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) ? DiscoverWorldObjectTargets(player) : null,
            advertisedCapabilities.Contains("chest_store", StringComparer.Ordinal) || advertisedCapabilities.Contains("chest_retrieve", StringComparer.Ordinal) ? DiscoverChestStates(player) : null
        );
    }
`;

/** The same builder after the missing action joined the gate: the gap is gone, so its ratchet entry is stale. */
const GATED_SNAPSHOT_FIXED = GATED_SNAPSHOT.replace(
  `advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) ?`,
  `advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) || advertisedCapabilities.Contains("move_placed_furniture", StringComparer.Ordinal) ?`,
);

const GATED_TARGET_FIELD = Object.freeze({
  place_owned_object: "WorldObjectTargets",
  move_placed_furniture: "WorldObjectTargets",
  chest_store: "Chests",
  chest_retrieve: "Chests",
});

function gateScan(source) {
  const sources = fixture([source]);
  return publicationGates({
    sources,
    parameters: snapshotParameterOrder(GATED_MODELS),
    discoveryRows: new Map(parseDiscoveries(sources).map((discovery) => [discovery.name, discovery.row])),
  });
}

test("a gate whose enabling set omits an action that needs the family is red, naming both", () => {
  const scan = gateScan(GATED_SNAPSHOT);
  assert.deepEqual(scan.findings, []);
  // The family name of a positional argument comes from `record BridgeSnapshot(...)`, not from the call site.
  assert.deepEqual(
    scan.gates.map((gate) => [gate.family, gate.gatedBy]),
    [
      ["WorldObjectTargets", ["place_owned_object"]],
      ["Chests", ["chest_retrieve", "chest_store"]],
    ],
  );

  const coverage = publicationGateCoverage({ gates: scan.gates, targetField: GATED_TARGET_FIELD });
  assert.deepEqual(
    coverage.findings.map((finding) => finding.code),
    ["family_gated_off:WorldObjectTargets:move_placed_furniture"],
    "`Chests` admits both actions that need it, so only the world-object gate is a gap",
  );
  assert.equal(coverage.findings[0].id, "WorldObjectTargets:move_placed_furniture");
  assert.match(coverage.findings[0].detail, /place_owned_object/);
  assert.match(coverage.findings[0].detail, /move_placed_furniture/);
  assert.deepEqual(
    coverage.rows.map((row) => [row.family, row.missing]),
    [
      ["Chests", []],
      ["WorldObjectTargets", ["move_placed_furniture"]],
    ],
  );
});

test("a call site that binds the wrong family is reported instead of silently claiming a gate", () => {
  // The first positional argument publishes a `BridgeChestState` list where the record declares a
  // `BridgeWorldObjectTarget` list. A reader that trusted the index alone would claim a Chests gate for
  // WorldObjectTargets; the row type is what catches it.
  const misbound = gateScan(`
    internal static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        return Array.Empty<BridgeChestState>();
    }

    internal BridgeSnapshot CreateBridgeSnapshot(Farmer player, IReadOnlyList<string> advertisedCapabilities)
    {
        return new BridgeSnapshot(
            advertisedCapabilities.Contains("chest_store", StringComparer.Ordinal) ? DiscoverChestStates(player) : null,
            null
        );
    }
`);
  assert.deepEqual(misbound.gates, []);
  assert.deepEqual(misbound.findings.map((finding) => finding.code), ["publication_gate_unparsed:WorldObjectTargets"]);
  assert.match(misbound.findings[0].detail, /BridgeChestState/);
  assert.equal(misbound.findings[0].id, null, "an unreadable gate must not be baselinable");
});

test("a gating gap can be baselined once, and an entry whose gap is fixed fails as stale", () => {
  const sources = fixture([GATED_SNAPSHOT]);
  const report = observe({ sources, models: GATED_MODELS, targetField: GATED_TARGET_FIELD });
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === "gating").map((finding) => finding.code),
    ["family_gated_off:WorldObjectTargets:move_placed_furniture"],
  );

  const baseline = {
    schema: "gamebuddy-stardew-observation-gap-baseline/v1",
    entries: [
      { kind: "gating", id: "WorldObjectTargets:move_placed_furniture", reason: "measured: the gate omits this action" },
    ],
  };
  const baselined = observe({ sources, models: GATED_MODELS, targetField: GATED_TARGET_FIELD, baseline });
  assert.deepEqual(
    baselined.findings.filter((finding) => finding.kind === "gating"),
    [],
    "a baselined gating gap is excused",
  );

  // The same entry against a gate that now admits the action: the ratchet must not keep excusing it.
  const fixed = observe({
    sources: fixture([GATED_SNAPSHOT_FIXED]),
    models: GATED_MODELS,
    targetField: GATED_TARGET_FIELD,
    baseline,
  });
  assert.ok(
    fixed.findings.some((finding) => finding.code === "stale_baseline_entry:gating:WorldObjectTargets:move_placed_furniture"),
    "the gate admits the action now, so the baseline entry must be deleted",
  );
});

test("a published family nothing consumes is advisory, red only when an action targets it", () => {
  const noConsumer = { ...CONSUMPTION_FIXTURE, tools: "" };
  const coverage = consumptionCoverage({
    families: ["WorldObjectTargets", "UnclassifiedTargets"],
    ...noConsumer,
    targetField: { place_owned_object: "WorldObjectTargets", caveat_action: "UnclassifiedTargets" },
  });
  assert.deepEqual(
    coverage.rows.map((row) => [row.family, row.consumed, row.classified, row.targeted]),
    [
      ["WorldObjectTargets", false, true, true],
      ["UnclassifiedTargets", false, false, true],
    ],
  );
  assert.deepEqual(
    coverage.findings.map((finding) => finding.code),
    [
      "family_without_consumer_and_targeted:WorldObjectTargets",
      "family_unclassified_by_consumer_inventory:UnclassifiedTargets",
    ],
    "an unconsumed family an action targets is red; an unclassified one is red for the other reason",
  );
  assert.equal(
    coverage.findings[1].id,
    null,
    "an unclassified family is a decision gap, so it cannot be baselined away",
  );
  assert.deepEqual(coverage.unclassified, ["UnclassifiedTargets"]);
  // Both are on the advisory list, and only one of them is a finding: the list is a report, not a backlog.
  assert.deepEqual(
    coverage.rows.filter((row) => !row.consumed).map((row) => row.family),
    ["WorldObjectTargets", "UnclassifiedTargets"],
  );

  // Untargeted and unconsumed is advisory only: nothing has to act through it.
  const untargeted = consumptionCoverage({ families: ["WorldObjectTargets"], ...noConsumer, targetField: {} });
  assert.deepEqual(untargeted.findings, []);
  assert.deepEqual(
    untargeted.rows.filter((row) => !row.consumed).map((row) => row.family),
    ["WorldObjectTargets"],
  );
});

test("a family consumed only by the per-turn line is not red", () => {
  const perTurnLine = `export const TARGET_FAMILY_LABELS = Object.freeze({
  worldObjectTargets: "可交互的物件",
});`;
  const coverage = consumptionCoverage({
    families: ["WorldObjectTargets"],
    ...CONSUMPTION_FIXTURE,
    tools: "",
    perTurnLine,
    targetField: { place_owned_object: "WorldObjectTargets" },
  });
  assert.deepEqual(
    coverage.rows.map((row) => [row.family, row.perTurnLine, row.consumed]),
    [["WorldObjectTargets", true, true]],
  );
  assert.deepEqual(coverage.findings, []);
  assert.deepEqual(
    coverage.rows.filter((row) => !row.consumed),
    [],
    "a per-turn line is a consumer, so the family is not advisory either",
  );
});

test("an inventory whose tables cannot be read is reported instead of classifying nothing", () => {
  const coverage = consumptionCoverage({
    families: ["WorldObjectTargets"],
    inventory: "export const SOMETHING_ELSE = Object.freeze([]);\n",
    tools: "",
    perTurnLine: "",
    projectionSources: new Map(),
    targetField: {},
  });
  assert.deepEqual(
    coverage.findings.filter((finding) => finding.code.startsWith("consumption_inventory_unreadable")).map((finding) => finding.code),
    [
      "consumption_inventory_unreadable:PROJECTION_SOURCES",
      "consumption_inventory_unreadable:UNPROJECTED_OBSERVED_FAMILIES",
      "consumption_inventory_unreadable:REQUIRED_PROJECTED_KEYS",
      "consumption_inventory_unreadable:WITHHELD_SCALAR_KEYS",
      "consumption_inventory_unreadable:TARGET_FAMILY_LABELS",
    ],
  );
  // And the consequence is stated rather than hidden: an inventory that classifies nothing classifies nothing,
  // so every published family is unclassified and red until the tables are readable again.
  assert.deepEqual(coverage.unclassified, ["WorldObjectTargets"]);
  assert.ok(coverage.findings.some((finding) => finding.code === "family_unclassified_by_consumer_inventory:WorldObjectTargets"));
});

/**
 * G - quadrants, as a gate.
 *
 * The defect: a fact that belongs to the MAP was delivered as if it belonged to a radius around the actor, so the only
 * way to ask was an observe - and `mineEntranceTargets` published the way out of a mine level whole-map while no per-turn
 * line read it. Each case below is one way the derivation could lie: a whole-layer scan called local, a radius scan
 * called map-fixed, an actor-owned family called map-fixed, or a ratchet entry that outlived its gap.
 */
const QUADRANT_SOURCES = `
    private static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(Farmer player)
    {
        List<BridgeMineEntranceTarget> result = new();
        for (int x = player.TilePoint.X - TargetDiscoveryRadius; x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
        {
            result.Add(new BridgeMineEntranceTarget("mine_entrance_0", x, 0));
        }
        if (player.currentLocation is MineShaft shaft && TryFindMineTileWithIndex(shaft, 115, out int exitX, out int exitY))
        {
            result.Add(new BridgeMineEntranceTarget("mine_entrance_1", exitX, exitY));
        }
        return result;
    }

    private static bool TryFindMineTileWithIndex(GameLocation location, int tileIndex, out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (buildings.Tiles[x, y].TileIndex == tileIndex) return true;
            }
        }
        return false;
    }

    private static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player)
    {
        return location.objects.Pairs.Where(pair => Utility.tileWithinRadiusOfPlayer(0, 0, TargetDiscoveryRadius, player))
            .Select(pair => new BridgeCropTarget("crop_1", 0, 0)).ToArray();
    }

    private static IReadOnlyList<BridgeFoodTarget> DiscoverFoodTargets(Farmer player)
    {
        return player.Items.Select((item, slot) => new BridgeFoodTarget(slot)).ToArray();
    }
`;

const QUADRANT_FAMILIES = Object.freeze([
  { name: "MineEntranceTargets", row: "BridgeMineEntranceTarget" },
  { name: "CropTargets", row: "BridgeCropTarget" },
  { name: "FoodTargets", row: "BridgeFoodTarget" },
]);

const QUADRANT_TARGET_FIELD = Object.freeze({
  use_mine_ladder: "MineEntranceTargets",
  enter_mine: "MineEntranceTargets",
  water_crop: "CropTargets",
  use_item: "FoodTargets",
});

function quadrants({ perTurnFamilies = new Set() } = {}) {
  const sources = fixture([QUADRANT_SOURCES]);
  return observationQuadrants({
    families: QUADRANT_FAMILIES,
    discoveries: parseDiscoveries(sources),
    bodies: modMethodBodies(sources),
    perTurnFamilies,
    targetField: QUADRANT_TARGET_FIELD,
  });
}

test("a map-fixed family an action targets and no per-turn line prints is red, and a family of the table closes it", () => {
  const before = quadrants();
  assert.deepEqual(
    before.rows.map((row) => [row.family, row.quadrant]),
    [
      ["MineEntranceTargets", "map_fixed"],
      ["CropTargets", "local"],
      ["FoodTargets", "actor_owned"],
    ],
    "the ladder family publishes a whole-map branch; the crop scan is actor-bounded; the pack is neither",
  );
  assert.deepEqual(before.findings.map((finding) => finding.code), [
    "map_fixed_family_not_in_a_per_turn_line:MineEntranceTargets",
  ]);
  // The evidence names BOTH branches, because that mixed shape is the reason the rule exists: the entrance window alone
  // would have classified this family local, and the ladder - the one fact the companion needs - would have stayed hidden.
  const ladder = before.rows[0];
  assert.match(ladder.evidence[0], /map-fixed: a whole-layer scan inside TryFindMineTileWithIndex/u);
  assert.match(ladder.evidence[0], /actor-bounded: a scan window around the actor/u);

  const after = quadrants({ perTurnFamilies: new Set(["mineEntranceTargets"]) });
  assert.deepEqual(after.findings, [], "the line reads the family now, so the observe is no longer the only way to ask");
  assert.deepEqual(after.counts, {
    local: 1,
    mapFixed: 1,
    actorOwned: 1,
    undeclared: 0,
    mapFixedUntargeted: 0,
    red: 0,
  });
});

test("a radius-bounded or actor-owned family is never reported by the quadrant rule", () => {
  const report = quadrants();
  const reported = report.findings.map((finding) => finding.id);
  // The crop scan calls the engine's radius helper, so its rows are already around the actor: an observe is the delivery
  // policy the Host documents, not a gap. The pack is not map content at all, so there is no quadrant to get wrong.
  assert.ok(!reported.includes("CropTargets"));
  assert.ok(!reported.includes("FoodTargets"));
  assert.match(report.rows[1].evidence[0], /actor-bounded: an actor-radius helper/u);
  assert.match(report.rows[2].evidence[0], /no location and no map read/u);
});

test("a family nothing discovers is classified by its declaration, and a family with neither stays undeclared", () => {
  const declared = observationQuadrants({
    families: [
      { name: "Warps", row: "BridgeWarp" },
      { name: "DiscoveryExclusions", row: "BridgeDiscoveryExclusion" },
    ],
    discoveries: [],
    bodies: new Map(),
    perTurnFamilies: new Set(),
    targetField: {},
  });
  // Two families `record BridgeSnapshot(...)` assembles by hand: the warp table at the call site and the exclusion
  // recorder's counts. Neither has a `Discover*`, so the derivation has no body - and the declaration says where the
  // quadrant IS decidable instead of letting the report say less than the tree does.
  assert.deepEqual(
    declared.rows.map((row) => [row.family, row.quadrant, row.declared]),
    [
      ["Warps", "map_fixed", true],
      ["DiscoveryExclusions", "actor_owned", true],
    ],
  );
  assert.match(declared.rows[0].evidence[0], /farmhandexecutioncontroller\.cs:2366/u);
  assert.match(declared.rows[1].evidence[0], /DiscoveryExclusionReasons\.cs:159/u);
  assert.deepEqual(declared.findings, [], "a declared quadrant is not a quadrant error");

  const unclassified = observationQuadrants({
    families: [{ name: "PackedItems", row: "BridgeItemTarget" }],
    discoveries: [],
    bodies: new Map(),
    perTurnFamilies: new Set(),
    targetField: { travel: "PackedItems" },
  });
  assert.equal(unclassified.rows[0].quadrant, "undeclared");
  assert.equal(unclassified.rows[0].declared, false);
  assert.deepEqual(unclassified.findings, [], "no evidence is not evidence of a quadrant error");
  assert.deepEqual(unclassified.rows[0].evidence, []);

  // A declaration is only a fallback: a family that gains its own discovery is classified by that body again, so the
  // declared text cannot outlive the fact it described.
  const discovered = observationQuadrants({
    families: [{ name: "Warps", row: "BridgeWarp" }],
    discoveries: parseDiscoveries(fixture([DISCOVERED_WARPS])),
    bodies: modMethodBodies(fixture([DISCOVERED_WARPS])),
    perTurnFamilies: new Set(),
    targetField: {},
  });
  assert.equal(discovered.rows[0].quadrant, "local");
  assert.equal(discovered.rows[0].declared, false, "the declaration is dead text once a Discover* exists");
});

const DISCOVERED_WARPS = `    private static IReadOnlyList<BridgeWarp> DiscoverWarps(Farmer player)
    {
        return player.currentLocation.warps
            .Where(warp => Utility.tileWithinRadiusOfPlayer(warp.X, warp.Y, TargetDiscoveryRadius, player))
            .Select(warp => new BridgeWarp(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY, true))
            .ToArray();
    }`;

const MAP_FIXED_OBJECTS = `
    private static IReadOnlyList<BridgeWorldObjectTarget> DiscoverWorldObjectTargets(Farmer player)
    {
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (location.objects.ContainsKey(new Vector2(x, y))) return new[] { new BridgeWorldObjectTarget("o", 1, x, y) };
            }
        }
        return Array.Empty<BridgeWorldObjectTarget>();
    }
`;

test("a quadrant gap can be baselined once, and an entry whose family now has a per-turn line fails as stale", () => {
  const sources = fixture([MAP_FIXED_OBJECTS]);
  const baseline = {
    schema: "gamebuddy-stardew-observation-gap-baseline/v1",
    entries: [{ kind: "quadrant", id: "WorldObjectTargets", reason: "measured: the family is whole-map and no line reads it" }],
  };

  const red = observe({ sources });
  assert.deepEqual(
    red.findings.filter((finding) => finding.kind === "quadrant").map((finding) => finding.code),
    ["map_fixed_family_not_in_a_per_turn_line:WorldObjectTargets"],
  );

  const excused = observe({ sources, baseline });
  assert.deepEqual(excused.findings.filter((finding) => finding.kind === "quadrant"), []);
  assert.equal(excused.quadrant.counts.baselined, 1);

  const inPerTurnLineNow = observe({
    sources,
    baseline,
    consumption: {
      ...CONSUMPTION_FIXTURE,
      perTurnLine: `export const TARGET_FAMILY_LABELS = Object.freeze({
  worldObjectTargets: "可交互的物件",
});`,
    },
  });
  const stale = inPerTurnLineNow.findings.find(
    (finding) => finding.code === "stale_baseline_entry:quadrant:WorldObjectTargets",
  );
  assert.ok(stale, "a line reads the family now, so the baseline entry must be deleted rather than excusing the next one");
  assert.match(stale.detail, /printed by a family of host\/src\/game-world-vocabulary\.ts/u);
});

test("a quadrant baseline entry that names no published family is neither stale nor silently accepted", () => {
  const report = observe({
    baseline: {
      schema: "gamebuddy-stardew-observation-gap-baseline/v1",
      entries: [{ kind: "quadrant", id: "NoSuchTargets", reason: "recorded against a family that was renamed" }],
    },
  });
  assert.ok(
    report.findings.some((finding) => finding.code === "baseline_entry_unknown_subject:quadrant:NoSuchTargets"),
    "an entry that names nothing excuses nothing",
  );
  assert.ok(!report.findings.some((finding) => finding.code.startsWith("stale_baseline_entry:quadrant:")));
});

/* ------------------------------------------------------------------------------------------------ *
 * H - field-level coverage.
 *
 * Section D asks whether the member a handler MUTATES is carried by some family, so it stayed green while
 * `water_crop` decided from `HoeDirt.isWatered()` and the row it was handed (`BridgeCropTarget`) carried no
 * water state at all. Each case below is one way the section could lie: a read reported against the wrong
 * family, a member called carried because a field is merely present, a carried member silently excusing a
 * baselined gap, and a handler whose reads could not be extracted counted as clean.
 * ------------------------------------------------------------------------------------------------ */

const CROP_ROW_FIELDS = Object.freeze({ targetId: {}, x: {}, y: {}, cropId: {}, displayName: {} });

/** The wire schema for one crop family, with exactly the fields the case gives it. */
function cropSchema(fields) {
  return {
    $defs: {
      snapshot: {
        properties: { cropTargets: { type: "array", items: { $ref: "#/$defs/cropTarget" }, maxItems: 64 } },
      },
      cropTarget: { properties: fields },
    },
  };
}

const WATER_HANDLER = `internal sealed class FieldActionHandler
{
    private LocalExecutionReceipt? Resolve(FarmhandActionRequest request) => request.ActionId switch
    {
        "water_crop" => this.executions.RequestLocalWaterCrop(request.RequestId, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0)),
        _ => null,
    };
}
`;

/** The shipped shape: the target is the HoeDirt at the tile, and the decision is its water state. */
const WATER_CONTROLLER = `internal sealed partial class FarmhandExecutionController
{
    public LocalExecutionReceipt RequestLocalWaterCrop(string requestId, int targetX, int targetY)
    {
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (!location.terrainFeatures.TryGetValue(new Vector2(targetX, targetY), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || !dirt.isWatered())
            return null;
        return null;
    }
}
`;

const CROP_MODELS = `
public sealed record BridgeSnapshot(
    IReadOnlyList<BridgeCropTarget>? CropTargets = null
);

public sealed record BridgeCropTarget(string TargetId, int X, int Y, string CropId, string DisplayName);
`;

/** The same record after the fix: the row states the water state the handler decides from. */
const CROP_MODELS_WITH_WATERED = CROP_MODELS.replace(
  "string CropId, string DisplayName);",
  "string CropId, string DisplayName, bool Watered);",
);

function fieldSources(controller = WATER_CONTROLLER, handler = WATER_HANDLER) {
  return [
    ...fixture([handler], "integrations/stardew/Handlers/FieldActionHandler.cs"),
    ...fixture([controller], "integrations/stardew/farmhandexecutioncontroller.field.cs"),
  ];
}

const FIELD_TARGET_FIELD = Object.freeze({ water_crop: "CropTargets" });

test("a handler that decides from a member its row does not carry is red, naming action, member and family", () => {
  const sources = fieldSources();
  const scan = fieldLevelCoverage({
    sources,
    surface: SURFACE,
    models: CROP_MODELS,
    schema: cropSchema(CROP_ROW_FIELDS),
    targetField: FIELD_TARGET_FIELD,
  });

  assert.deepEqual(
    scan.rows.map((row) => [row.actionId, row.family, row.members.map((member) => [member.member, member.carried])]),
    [["water_crop", "cropTargets", [["isWatered", false]]]],
    "the read is the HoeDirt's own water state, checked against the family the surface declares",
  );
  assert.deepEqual(scan.counts, {
    readMembers: 1,
    carried: 0,
    absent: 1,
    unparsed: 0,
    noFamily: 0,
    noRow: 0,
    handlersWithReads: 1,
  });

  const report = observe({
    sources,
    models: CROP_MODELS,
    schema: cropSchema(CROP_ROW_FIELDS),
    targetField: FIELD_TARGET_FIELD,
  });
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === "field").map((finding) => finding.code),
    ["field_unobservable:water_crop:isWatered:cropTargets"],
  );
});

test("the same member is carried once the row publishes it, which is the water-crop fix", () => {
  const sources = fieldSources();
  const schema = cropSchema({ ...CROP_ROW_FIELDS, watered: {} });
  const scan = fieldLevelCoverage({
    sources,
    surface: SURFACE,
    models: CROP_MODELS_WITH_WATERED,
    schema,
    targetField: FIELD_TARGET_FIELD,
  });

  // `isWatered` and the published `watered` are one fact under two spellings, so the record/schema cross-check
  // stays silent and the read is carried by the FIELD, not merely by the member's name appearing nearby.
  assert.deepEqual(scan.rows[0].members, [
    { member: "isWatered", field: "watered", carried: true, id: "water_crop:isWatered:cropTargets" },
  ]);
  assert.deepEqual(scan.findings, []);
  assert.equal(scan.counts.carried, 1);
  assert.equal(scan.counts.absent, 0);

  const report = observe({
    sources,
    models: CROP_MODELS_WITH_WATERED,
    schema,
    targetField: FIELD_TARGET_FIELD,
  });
  assert.deepEqual(report.findings.filter((finding) => finding.kind === "field"), []);
});

test("a field baseline entry whose member the row now carries fails as stale", () => {
  const sources = fieldSources();
  const baseline = {
    schema: "gamebuddy-stardew-observation-gap-baseline/v1",
    entries: [
      { kind: "field", id: "water_crop:isWatered:cropTargets", reason: "recorded before the row carried the water state" },
    ],
  };

  const beforeFix = observe({ sources, models: CROP_MODELS, schema: cropSchema(CROP_ROW_FIELDS), targetField: FIELD_TARGET_FIELD, baseline });
  assert.deepEqual(
    beforeFix.findings.filter((finding) => finding.kind === "field"),
    [],
    "a baselined read is excused while the row still does not carry it",
  );
  assert.equal(beforeFix.fieldLevel.counts.baselined, 1);

  const afterFix = observe({
    sources,
    models: CROP_MODELS_WITH_WATERED,
    schema: cropSchema({ ...CROP_ROW_FIELDS, watered: {} }),
    targetField: FIELD_TARGET_FIELD,
    baseline,
  });
  const stale = afterFix.findings.find(
    (finding) => finding.code === "stale_baseline_entry:field:water_crop:isWatered:cropTargets",
  );
  assert.ok(stale, "the row carries `watered` now, so the entry must be deleted rather than excusing the next gap");
  assert.match(stale.detail, /carries `isWatered` now/u);
});

const UNPARSED_HANDLER = `internal sealed class UnparsedActionHandler
{
    private LocalExecutionReceipt? Resolve(FarmhandActionRequest request) => request.ActionId switch
    {
        "till_soil" => this.executions.RequestLocalTillSoil(request.RequestId, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0)),
        "chest_store" => this.executions.RequestLocalChestStore(request.RequestId),
        _ => null,
    };
}
`;

/**
 * Two handlers the extraction rule cannot reduce to a member: one reads no location value at all, and one
 * binds the target and then uses it only inside an evidence string.
 */
const UNPARSED_CONTROLLER = `internal sealed partial class FarmhandExecutionController
{
    public LocalExecutionReceipt RequestLocalTillSoil(string requestId, int targetX, int targetY)
    {
        if (Game1.player.Items.Count == 0) return null;
        return null;
    }

    public LocalExecutionReceipt RequestLocalChestStore(string requestId)
    {
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (!location.objects.TryGetValue(new Vector2(1, 1), out StardewValley.Object? chest)) return null;
        string evidence = $"chest={chest.QualifiedItemId}";
        return null;
    }
}
`;

test("a handler whose reads cannot be extracted is counted unparsed, printed, and never treated as clean", () => {
  const sources = fieldSources(UNPARSED_CONTROLLER, UNPARSED_HANDLER);
  const scan = fieldLevelCoverage({
    sources,
    surface: SURFACE,
    models: CROP_MODELS,
    schema: cropSchema(CROP_ROW_FIELDS),
    targetField: FIELD_TARGET_FIELD,
  });

  assert.deepEqual(scan.unparsed, [
    { actionId: "chest_store", reason: "no_decision_read_through_a_location_bound_value" },
    { actionId: "till_soil", reason: "no_location_bound_engine_value" },
  ]);
  assert.deepEqual(scan.rows, [], "an unparsed handler contributes no reading and no verdict");
  assert.equal(scan.counts.handlersWithReads, 0);
  assert.equal(scan.counts.readMembers, 0);
  assert.equal(scan.counts.carried, 0);

  // And the report prints it rather than reporting a clean section.
  const lines = [];
  writeObservationSummary(
    observe({ sources, models: CROP_MODELS, schema: cropSchema(CROP_ROW_FIELDS), targetField: FIELD_TARGET_FIELD }),
    (text) => lines.push(text),
  );
  assert.match(lines.join(""), /H field coverage\s+read 0 members across 0 handlers; carried 0; absent 0 \(0 red, 0 baselined\); unparsed 2, no family 0, no schema row 0/u);
});

test("the field-level section on the real tree: every decision read is a row field, and the four left are baselined", () => {
  const report = observeActionGaps({});

  // Printed separately from the verdicts because member extraction is heuristic: 21 reads across 10 handlers,
  // 90 handlers whose target decision is delegated to a helper or a type outside the engine vocabulary (re-measured
  // 2026-11-07: 84 was the count before the families the quadrant section now lists as `RefillWateringCanTargets` and
  // `FixedInteractionPoints` joined the surface). The four absent members are unchanged, and they are the baselined
  // ones: three `crop` reads on a family whose own subject IS the crop, and `needsWatering`, whose answer `watered`
  // already publishes.
  assert.deepEqual(report.fieldLevel.counts, { readMembers: 21, carried: 17, absent: 4, red: 0, baselined: 4 });
  assert.equal(report.fieldLevel.handlers, report.postconditionMutations.handlers);
  assert.equal(report.fieldLevel.handlersWithReads, 10);
  assert.equal(report.fieldLevel.unparsed.length, 90);
  assert.ok(report.fieldLevel.unparsed.every((entry) => entry.reason.length > 0));
  assert.ok(
    !report.fieldLevel.unparsed.some((entry) => report.fieldLevel.rows.some((row) => row.actionId === entry.actionId)),
    "a handler is either measured or unparsed, never both",
  );

  // THE FIX THIS SECTION FOUND: `water_crop` reads the HoeDirt's water state and the row carries it as `watered`.
  const waterCrop = report.fieldLevel.rows.find((row) => row.actionId === "water_crop");
  assert.deepEqual(waterCrop.members, [
    { member: "crop", field: null, carried: false, id: "water_crop:crop:cropTargets" },
    { member: "isWatered", field: "watered", carried: true, id: "water_crop:isWatered:cropTargets" },
    { member: "needsWatering", field: null, carried: false, id: "water_crop:needsWatering:cropTargets" },
  ]);

  // The fourteen rows this section called too thin, each now carrying the engine's own answer:
  const readings = Object.fromEntries(
    report.fieldLevel.rows.map((row) => [row.actionId, row.members.map(({ member, field }) => [member, field])]),
  );
  assert.deepEqual(readings, {
    clear_hoedirt: [["crop", "crop"]],
    cut_weeds: [["IsWeeds", "isWeeds"]],
    fertilize_tile: [["CanApplyFertilizer", "canApplyFertilizer"]],
    harvest_crop: [
      ["GetHarvestMethod", "harvestMethod"],
      ["crop", null],
      ["forageCrop", "forageCrop"],
      ["readyForHarvest", "readyForHarvest"],
    ],
    machine_inspect: [["GetMachineData", "machineData"]],
    pickup_forage: [
      ["QualifiedItemId", "qualifiedItemId"],
      ["isForage", "isForage"],
    ],
    plant_seed: [
      ["canPlantThisSeedHere", "canPlantThisSeedHere"],
      ["crop", "crop"],
    ],
    scythe_crop: [
      ["GetHarvestMethod", "harvestMethod"],
      ["crop", null],
      ["dead", "dead"],
      ["forageCrop", "forageCrop"],
      ["readyForHarvest", "readyForHarvest"],
    ],
    till_soil: [["HoeDirt", "hoeDirt"]],
    water_crop: [
      ["crop", null],
      ["isWatered", "watered"],
      ["needsWatering", null],
    ],
  });

  assert.deepEqual(
    report.ungranted.filter((finding) => finding.kind === "field"),
    [],
    "an equality in both directions: a fixed row reports nothing, and a new gap has to be read rather than absorbed",
  );
});
