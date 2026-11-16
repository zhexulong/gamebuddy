// red-proof: inject  the same renamed schema property -> `AssertionError ... expected []` at
//   tools/audit-stardew-discovery-channels.test.mjs:45, with the water_crop row whose `inSchema: false` and
//   `gap: 'missing_envelope_schema_field'` as `actual`
import assert from "node:assert/strict";
import test from "node:test";
import { auditDiscoveryChannels, loadModSources } from "./audit-stardew-discovery-channels.mjs";

// A real target-bearing action, used so the audit's declared-field table
// resolves exactly as it does in production.
const ACTION = "harvest_crop";
const FIELD = "harvestTargets";
const MODEL = "IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,";
const PROTOCOL = "harvestTargets?: readonly Readonly<{ targetId: string }>[];";
const TOOL_DESC_OK = `Copied from the ${FIELD} entries of the most recent observe.`;
const TOOL_DESC_WRONG = "Copied from the recipeTargets entries of the most recent observe.";

function surface(overrides = {}) {
  return {
    actions: [
      {
        actionId: ACTION,
        lifecycle: "published",
        kind: "execution",
        // The artifact's own shape: each declared argument is an object carrying its `type`, which is what the plan
        // builder filters on when it decides whether a builder method can exist for the action.
        argumentSchema: {
          x: { type: "integer" },
          y: { type: "integer" },
          expectedTargetId: { type: "string" },
        },
        ...overrides,
      },
    ],
  };
}
function tool(description) {
  // Constant-mount shape (36608fa): the tool is mounted unconditionally; its
  // `action` id must be followed by `toArgs`, and the description precedes the
  // parameter schema exactly as in production. The description prose below is
  // what the audit reads for the named-target-field check.
  return `makeGameActionTool({
   name: "stardew_${ACTION}",
   description:
    "${description}",
   parameters: {},
   action: "${ACTION}",
   toArgs: `;
}
function schemaWith(properties) {
  return { $defs: { snapshot: { properties } } };
}
/**
 * An action whose subject is raw coordinates and no snapshot family, so the visibility rule can be tested alone: the
 * target-description leg has nothing to say about it, and the lifecycle is the only thing that changes between cases.
 */
function coordinateSurface(lifecycle) {
  return {
    actions: [
      {
        actionId: "move_to_tile",
        lifecycle,
        kind: "execution",
        argumentSchema: { x: { type: "integer" }, y: { type: "integer" } },
      },
    ],
  };
}

test("the committed action surface has a complete discovery chain", () => {
  const report = auditDiscoveryChannels();
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap !== "tool_does_not_name_target_field"),
    [],
    "every target-bearing action must have an Agent surface and a real Mod/Host/schema field",
  );
  assert.ok(report.actionCount > 0);
  assert.ok(report.targetBearingCount > 0);
  // The population, said out loud: a green run that examined no surface cannot be told from a reader that stopped.
  assert.equal(report.agentSurface.measured, true);
  assert.ok(report.agentSurface.flatMounts > 0);
  assert.ok(report.agentSurface.planVocabulary > 0);
  // Every action the product claims is usable is reachable through at least one surface; anything offered by neither is
  // named with the lifecycle that decides whether that is the ladder's design or a hole, and the audit has no gap for it
  // only when the lifecycle is one the builder deliberately skips.
  for (const entry of report.agentSurface.unreachable) {
    const [actionId, lifecycle] = entry.split(":");
    assert.ok(
      !report.agentSurface.eligibleLifecycles.includes(lifecycle),
      `${actionId} is ${lifecycle} and no surface offers it`,
    );
  }
});

/**
 * HOP 5: the game's own content tables.
 *
 * <p>
 * The population is the engine's `Game1.*Data` caches, scanned out of the Mod's C# (and, when the decompiled tree is
 * present, out of `Game1.cs` too). Every one of them must be askable through `look_up({ subject: "data" })` or carry a
 * reason of the two honest kinds - and the reason list must expire when the table it excuses goes away.
 * </p>
 */
test("the committed tree exposes or explains every engine content table", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources() });
  const tables = report.contentTables;
  assert.equal(tables.measured, true);
  assert.ok(tables.examined > 0, "a population of zero would agree with itself");
  assert.equal(
    tables.addressable + tables.withReason,
    tables.examined,
    `every table is addressable or explained: ${JSON.stringify(tables.rows.filter((row) => row.table === null && row.reasonKind === null))}`,
  );
  assert.ok(tables.addressable > 0, "a content-table hop with no queryable table is not measuring anything");
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap.startsWith("content_table")),
    [],
    "no engine content table may be unreachable without a stated reason",
  );
});

test("deleting one table mapping turns the content-table hop red, naming the table", () => {
  // The real registry, with the FarmAnimals entry pointing at a cache that is not the engine's. That is the shape of
  // "someone removed the mapping": the table is still declared, and the cache it was covering is now unreachable.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("ContentDataQuery.cs")
      ? { ...entry, source: entry.source.replace('"Game1.farmAnimalData"', '"Game1.farmAnimalDataRenamed"') }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "content_table_unreachable:Game1.farmAnimalData"),
    `the drift must be named: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
  assert.equal(report.ok, false);
});

test("an engine table nobody exposed and nobody explained is a finding, not a silence", () => {
  const report = auditDiscoveryChannels({
    modSources: loadModSources(),
    engine: "public static IDictionary<string, NewThingData> newThingData;",
  });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "content_table_unreachable:Game1.newThingData"),
    "a table a future game version adds must be a finding the moment the engine declares it",
  );
});

test("a reason whose table is gone is stale, so the exemption list cannot outlive what it excuses", () => {
  const report = auditDiscoveryChannels({ modSources: [] });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "stale_content_table_reason:Game1.weaponData"),
    `every reason must expire: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

/**
 * HOP 6: the building state an action depends on.
 *
 * <p>
 * `daysOfConstructionLeft` for a plain coop has exactly one channel - the `built` rows of `farmBuildingTargets` - and
 * that family is capped at `BuildFarmBuildingTargetLimit`. If the Mod ever stops ordering the countdown first, the cap
 * can drop the building the player is waiting on, and this is the assertion that says so.
 * </p>
 */
test("the committed tree carries every Building member an action depends on", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources() });
  assert.equal(report.buildingState.measured, true);
  assert.equal(report.buildingState.examined, 5);
  assert.equal(report.buildingState.carried, 5);
  assert.equal(
    report.buildingState.constructionFirst,
    true,
    "the cap must drop finished buildings before a building site",
  );
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap.startsWith("building_")),
    [],
  );
});

test("removing the construction-first ordering turns the building hop red, naming the fact", () => {
  const broken = loadModSources().map((entry) => ({
    ...entry,
    source: entry.source.replace(
      /OrderByDescending\([^;]*daysOfConstructionLeft\.Value\s*>\s*0\)/u,
      "OrderBy(static building => building.id.Value)",
    ),
  }));
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "building_construction_cap_can_drop_the_building:daysOfConstructionLeft"),
    `a capped family must publish the row a player is waiting on: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

test("a Building member with no published family is named", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources(), models: "// no Bridge* family at all" });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "building_member_unpublished:daysOfConstructionLeft:FarmBuildingTargets"),
  );
});

test("the audit reports one hole per broken layer rather than passing silently", () => {
  // 1. A missing envelope-schema entry must be caught: the schema has
  //    additionalProperties:false, so an undeclared field cannot be shipped.
  const noSchema = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({}),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.deepEqual(
    noSchema.gaps.map((gap) => gap.gap),
    ["missing_envelope_schema_field"],
    "the schema leg must not be assumed from the Mod and Host legs",
  );

  // 2. A tool whose prose names a field that does not exist must be caught:
  //    this is exactly the craft_item/cook_recipe `recipeTargets` drift.
  const wrongName = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_WRONG),
  });
  assert.equal(wrongName.ok, false);
  assert.ok(
    wrongName.gaps.some((gap) => gap.gap.startsWith("tool_names_wrong_field:")),
    "a description that points at a non-existent field must be reported",
  );

  // 3. A missing Mod wire field must be caught even when Host and schema agree.
  const noMod = auditDiscoveryChannels({
    surface: surface(),
    models: "// no such list",
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.deepEqual(
    noMod.gaps.map((gap) => gap.gap),
    ["missing_mod_wire_field"],
  );

  // 4. An action NO SURFACE offers must be caught. `object` is not an argument kind a Body Program node may carry, so
  //    the plan builder generates no method for it; with no flat mount either, the Agent cannot reach the action at all.
  const noSurface = auditDiscoveryChannels({
    surface: surface({ argumentSchema: { x: { type: "object" } } }),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: "// no makeGameActionTool mount at all",
  });
  assert.ok(noSurface.gaps.some((gap) => gap.gap === "no_agent_tool"));

  // 5. A fully wired action passes, so the audit is not vacuously failing.
  const wired = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.equal(wired.ok, true, JSON.stringify(wired.gaps));
});

/**
 * HOP 1's surface is TWO surfaces: the flat mounts a composition may drop, and the plan vocabulary the Game composition
 * actually hands the Agent. `runtime-core.internal.ts` drops every adapter action tool when `planActionSurface` is
 * declared - the live Game materializer declares it - so a gate that demanded a flat mount would report an action the
 * Agent can reach through `builder.<actionId>`, and would demand one of every experimental action, which by the ladder
 * has no surface at all.
 */
test("an action the Agent reaches through the plan vocabulary is not reported as missing a tool", () => {
  const viaBuilder = auditDiscoveryChannels({
    surface: coordinateSurface("published"),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({}),
    gameTools: "// the Game composition mounts no per-action tool at all",
  });
  assert.deepEqual(viaBuilder.gaps, [], JSON.stringify(viaBuilder.gaps));
  assert.equal(viaBuilder.rows[0].planVisible, true);
  assert.equal(viaBuilder.rows[0].toolVisible, false);
});

test("an experimental action no surface offers is the ladder's own design, not a hole", () => {
  const experimental = auditDiscoveryChannels({
    surface: coordinateSurface("experimental"),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({}),
    gameTools: "// no makeGameActionTool mount at all",
  });
  assert.deepEqual(experimental.gaps, [], JSON.stringify(experimental.gaps));
  assert.deepEqual(experimental.agentSurface.unreachable, ["move_to_tile:experimental"]);
});

test("a plan vocabulary that cannot be read is blocked by name, not read as an empty surface", () => {
  const unreadable = auditDiscoveryChannels({
    surface: surface({ lifecycle: "experimental" }),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: "// no makeGameActionTool mount at all",
    planScript: "// the builder's declarations were renamed",
  });
  assert.ok(
    unreadable.gaps.some((gap) => gap.gap === "plan_vocabulary_declaration_unreadable"),
    JSON.stringify(unreadable.gaps.map((gap) => gap.gap)),
  );
  assert.equal(unreadable.agentSurface.measured, false);
  assert.deepEqual(unreadable.agentSurface.eligibleLifecycles, []);
});

/**
 * HOP 7: the facts one tile-area row publishes.
 *
 * <p>
 * The rectangle query answers a fact per tile - is it tillable, what is stored on it, is it hoed, would the planner step
 * onto it - and each of those is a question the game already answers somewhere. The population is the WIRE's own row
 * definition, so a field added there without an owner stops the audit; the owner check reads the Mod's sources, so a
 * renamed owner, a duplicated declaration and a "shared" fact that stopped being shared are all findings rather than
 * prose nobody re-read.
 * </p>
 */
test("the committed tree gives every tile-area fact one owner, and the shared ones are really shared", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources() });
  const tileArea = report.tileArea;
  assert.equal(tileArea.measured, true);
  assert.ok(tileArea.examined > 0, "a population of zero would agree with itself");
  assert.equal(tileArea.owned, tileArea.examined, JSON.stringify(tileArea.rows));
  // The population is the declaration's own `SharedWith` column: every fact the table says a second publication
  // answers must be a fact that publication's body actually calls. `tillable` is shared with the soil discovery and
  // `occupantKind` with the `for_each` pass's row; a third one is admitted by declaring it, and a declared one that
  // stopped being called fails here by name.
  const declaredShared = tileArea.rows.filter((row) => row.sharedWith !== null);
  assert.ok(declaredShared.length > 0, "the table declares which facts a second publication also answers");
  assert.equal(tileArea.shared, declaredShared.length, JSON.stringify(tileArea.rows));
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap.startsWith("tile_area")),
    [],
  );
});

test("a tile-area fact with no declared owner is named", () => {
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("TileAreaQuery.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            '        ("tillable", "ExecutionManager.IsTillableTile", "ExecutionManager.DiscoverSoilTiles"),\n',
            "",
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tile_area_fact_unowned:tillable"),
    `a field on the wire with nobody owning it must be named: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
  assert.equal(report.ok, false);
});

test("a declared fact the wire does not carry is named, so the table cannot grow a fiction", () => {
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("TileAreaQuery.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            '        ("passable",',
            '        ("fixture", "TileAreaQuery.DescribeTile", null),\n        ("passable",',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tile_area_fact_unpublished:fixture"),
    `an owner for a fact nothing publishes is a claim without a subject: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

test("an owner that names no function in the Mod is named", () => {
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("TileAreaQuery.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            '("tillable", "ExecutionManager.IsTillableTile",',
            '("tillable", "ExecutionManager.IsDiggableSoilTile",',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tile_area_fact_owner_missing:tillable:ExecutionManager.IsDiggableSoilTile"),
    `an owner that does not exist is a rename nobody followed: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

test("the soil discovery answering with its own predicate turns the shared fact red", () => {
  // The drift this hop exists for: `tillable` in the rectangle and the soil rows in the observation are the same fact,
  // so the day the discovery hand-rolls the check instead of calling the one function, the two channels start
  // disagreeing about which ground the hoe admits.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("farmhandexecutioncontroller.targetdiscovery.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            "if (!hoeDirt && !IsTillableTile(location, x, y))",
            'if (!hoeDirt && location.doesTileHaveProperty(x, y, "Diggable", "Back") is null)',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tile_area_fact_two_spellings:tillable:ExecutionManager.DiscoverSoilTiles"),
    `a second spelling of the tillable predicate must be named: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

test("a row definition nobody can read is blocked, never green", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources(), schema: {} });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tile_area_rows_unread"),
    "zero population is blocked with its reason: an empty set agrees with itself",
  );
});

/**
 * HOP 8: every producer of a tillability answer.
 *
 * <p>
 * Hop 7's population is the wire's `tileAreaRow`, and that is why it stayed green through the defect this hop exists
 * for: the `for_each` row the companion was dispatched from published `tillable` from the map's `Diggable` property
 * alone, so two of its rows were `HoeDirt` while `till_soil` refused both at the same revision. The population here is
 * scanned out of the Mod's sources - every read of `Diggable` and every publication of the word - so the next site to
 * answer the question is a finding without this file changing.
 * </p>
 */
test("the committed tree has one tillability answer and every producer reaches it", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources() });
  const tillability = report.tillability;
  assert.equal(tillability.measured, true);
  assert.ok(tillability.examined > 0, "a population of zero would agree with itself");
  assert.deepEqual(
    tillability.rows.filter((row) => !row.agrees && row.word === null),
    [],
    `every producer must reach the one walk: ${JSON.stringify(tillability.rows.filter((row) => !row.agrees && row.word === null))}`,
  );
  // The population must hold each SHAPE of producer, not a count of today's: the walk, the boolean every publication
  // reads, the assignment that feeds the `for_each` row, and the rectangle's named-argument publication. A shape that
  // stops being found is a producer that left the population silently.
  const shapes = tillability.rows.flatMap((row) => row.kinds).join(" | ");
  for (const shape of [
    "is the one walk",
    "is the one boolean",
    "assigns a local `tillable`",
    "publishes a `Tillable` field",
  ])
    assert.ok(shapes.includes(shape), `the population lost the \`${shape}\` shape; it holds only: ${shapes}`);
  // The different-word bucket is derived from the live source too: one word, and it is not `tillable` spelled twice.
  assert.equal(
    new Set(tillability.words).size,
    tillability.words.length,
    `two spellings of one word: ${tillability.words}`,
  );
  assert.ok(!tillability.words.includes("tillable"), "a different word cannot be the same word");
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap.startsWith("tillability")),
    [],
  );
});

test("the loop row re-deriving `tillable` from the map property is named", () => {
  // The measured defect, replayed with the line that shipped: `tillable` from `doesTileHaveProperty("Diggable")` alone,
  // which answered true on a `HoeDirt` tile while the executor refused it at the same revision.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("FarmhandForEachFarmWorld.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            "bool tillable = ExecutionManager.IsTillableTile(this.farm, x, y);",
            'bool tillable = this.farm.doesTileHaveProperty(x, y, "Diggable", "Back") is not null;',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  const disagreements = report.gaps.filter((gap) => gap.gap === "tillability_producer_disagrees");
  assert.ok(
    disagreements.some((gap) => gap.subject.includes("FarmhandForEachFarmWorld.cs")),
    `the row the companion is dispatched from must be named: ${JSON.stringify(report.gaps.map((gap) => `${gap.gap}:${gap.subject}`))}`,
  );
  assert.equal(report.ok, false);
  assert.ok(report.tillability.disagree > 0, "and the summary line must say so");
});

test("a fixture that re-derives the predicate it stands the run on is named", () => {
  // The fixture is the input to every live proof: a `till_soil` slice whose tile was chosen by a re-derived predicate
  // proves the fixture's idea of tillable, not the game's.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("ModEntry.Fixtures.HostAutomation.TillSoil.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            ".Where(tile => ExecutionManager.IsTillableTile(farm, (int)tile.X, (int)tile.Y))",
            '.Where(tile => farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null)',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.gap === "tillability_producer_disagrees" &&
        gap.subject.includes("ModEntry.Fixtures.HostAutomation.TillSoil.cs"),
    ),
    `the fixture's own copy must be named: ${JSON.stringify(report.gaps.map((gap) => `${gap.gap}:${gap.subject}`))}`,
  );
});

test("a producer written in a file nothing lists still joins the population", () => {
  // The population is the SCAN, not a table of the files that had the defect. A fourth producer appearing tomorrow in a
  // file this gate has never heard of must be a finding by existing.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("farmhandexecutioncontroller.targetdiscovery.cs")
      ? {
          ...entry,
          source: `${entry.source}\n\n// injected\ninternal sealed class InjectedProducer\n{\n    public bool Answer(StardewValley.GameLocation location, int x, int y) =>\n        location.doesTileHaveProperty(x, y, "Diggable", "Back") is not null;\n}\n`,
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.gap === "tillability_producer_disagrees" &&
        gap.subject.includes("farmhandexecutioncontroller.targetdiscovery.cs"),
    ),
    `a new producer is in the population by existing: ${JSON.stringify(report.gaps.map((gap) => `${gap.gap}:${gap.subject}`))}`,
  );
});

test("the projection growing a clause of its own is named", () => {
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("farmhandexecutioncontroller.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            "return location.GetHoeDirtAtTile(new Vector2(x, y)) is null && DescribeSoilRefusal(location, x, y) is null;",
            'return location.doesTileHaveProperty(x, y, "Diggable", "Back") is not null\n            && location.GetHoeDirtAtTile(new Vector2(x, y)) is null;',
          ),
        }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  const named = report.tillability.rows.filter(
    (row) => !row.agrees && row.word === null && row.why.some((why) => why.includes("re-derivation")),
  );
  assert.ok(
    named.length > 0,
    `a second clause list inside the projection is the drift this measures: ${JSON.stringify(report.tillability.rows)}`,
  );
});

test("a different word that stopped answering its own question is named", () => {
  // An exemption that never expires is debt. The entry names a member that answers `buildable`; the moment it stops
  // reading the property it was declared against, the declaration is a claim without a subject.
  const broken = loadModSources().map((entry) =>
    entry.path.endsWith("farmhandexecutioncontroller.buildfarmbuildingactions.cs")
      ? { ...entry, source: entry.source.replace("IsBuildableAtLocation", "IsPlaceableAtLocation") }
      : entry,
  );
  const report = auditDiscoveryChannels({ modSources: broken });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tillability_different_word_stale:IsBuildableAtLocation"),
    `a stale different-word entry must go red: ${JSON.stringify(report.gaps.map((gap) => gap.gap))}`,
  );
});

test("a tillability population of zero is blocked with its reason", () => {
  const report = auditDiscoveryChannels({ modSources: [] });
  assert.ok(
    report.gaps.some((gap) => gap.gap === "tillability_producers_unread"),
    "zero population is blocked, never green",
  );
  assert.equal(report.tillability.examined, 0);
});
