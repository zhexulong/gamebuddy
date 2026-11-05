import assert from "node:assert/strict";
import test from "node:test";
import {
  addressabilityCoverage,
  collectionCoverage,
  consumptionCoverage,
  locationCollectionPopulation,
  observeActionGaps,
  postconditionMutationCoverage,
  publicationGateCoverage,
  publicationGates,
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
 * The Host's consumer inventory, fabricated: one family read only through a tool description.
 *
 * The cases below measure collections, channels, addressability, postconditions or gates, so the
 * consumption section must be handed an inventory that says "this family is read" - otherwise every
 * case would also be a case about F, and its finding list would say so.
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
  "host/src/snapshot-hud.ts",
  "host/src/snapshot-projection.ts",
]);
`,
  tools: "Copy the expectedTargetId from the worldObjectTargets entries of the MOST RECENT observe result.",
  hud: "",
  projectionSources: new Map([
    ["host/src/snapshot-hud.ts", ""],
    ["host/src/snapshot-projection.ts", ""],
  ]),
});

function observe(overrides = {}) {
  return observeActionGaps({
    sources: fixture([DISCOVER_OBJECTS_ONLY]),
    decompiled: DECOMPILED,
    surface: SURFACE,
    models: MODELS,
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
      "postcondition_mutation_matching_is_by_property_name_and_is_a_ratchet_not_a_hard_red",
    ),
  );
});

test("the human summary names each section and every ungranted gap, on the same run as the JSON", () => {
  const lines = [];
  writeObservationSummary(observe(), (text) => lines.push(text));
  const text = lines.join("");

  assert.match(text, /observation gaps: 5 replicated location collections/);
  assert.match(text, /A collections\s+1 read, 4 never read \(buildings, furniture, animals, Game1\.locations\)/);
  assert.match(text, /B tile channels\s+0 read, 3 never read/);
  assert.match(text, /C addressability\s+1 target-bearing actions, 0 without a published family/);
  assert.match(text, /D postconditions\s+0 handlers/);
  assert.match(text, /E publication\s+0 advertisement gates over 0 families, 0 family\/action pair\(s\) gated off/);
  assert.match(
    text,
    /F consumption\s+1 published families: 0 read by a projection, 0 by a HUD line, 1 named in a tool description; 0 with no consumer/,
  );
  assert.match(text, /on-demand delivery is not a gap/);
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
  assert.ok(report.consumption.rows.some((row) => row.hud));
  assert.deepEqual(report.publicationGating.gatedOff, []);
  assert.deepEqual(report.ungranted.map((finding) => finding.code), [
    "family_unclassified_by_consumer_inventory:FarmAnimalPetTargets",
  ]);
  // The advisory half is printed and counted, never red - `PendingLevelUpChoices` is exactly the shape of fact
  // that belongs there: published, delivered on demand, read by no line and targeted by no action.
  assert.ok(report.consumption.withoutConsumer.includes("PendingLevelUpChoices"));
  assert.deepEqual(report.consumption.unclassified, ["FarmAnimalPetTargets"]);
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

test("a family consumed only by a HUD line is not red", () => {
  const hud = `export const SNAPSHOT_HUD_LINES = Object.freeze([
    { name: "objects", fields: ["worldObjectTargets"], render: (snapshot) => String(snapshot.worldObjectTargets?.length ?? 0) },
  ]);`;
  const coverage = consumptionCoverage({
    families: ["WorldObjectTargets"],
    ...CONSUMPTION_FIXTURE,
    tools: "",
    hud,
    targetField: { place_owned_object: "WorldObjectTargets" },
  });
  assert.deepEqual(coverage.rows.map((row) => [row.family, row.hud, row.consumed]), [["WorldObjectTargets", true, true]]);
  assert.deepEqual(coverage.findings, []);
  assert.deepEqual(
    coverage.rows.filter((row) => !row.consumed),
    [],
    "a HUD line is a consumer, so the family is not advisory either",
  );
});

test("an inventory whose tables cannot be read is reported instead of classifying nothing", () => {
  const coverage = consumptionCoverage({
    families: ["WorldObjectTargets"],
    inventory: "export const SOMETHING_ELSE = Object.freeze([]);\n",
    tools: "",
    hud: "",
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
    ],
  );
  // And the consequence is stated rather than hidden: an inventory that classifies nothing classifies nothing,
  // so every published family is unclassified and red until the tables are readable again.
  assert.deepEqual(coverage.unclassified, ["WorldObjectTargets"]);
  assert.ok(coverage.findings.some((finding) => finding.code === "family_unclassified_by_consumer_inventory:WorldObjectTargets"));
});
