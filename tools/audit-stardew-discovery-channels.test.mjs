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

function surface() {
  return {
    actions: [
      {
        actionId: ACTION,
        lifecycle: "published",
        kind: "execution",
        argumentSchema: { x: "integer", y: "integer", expectedTargetId: "string" },
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

test("the committed action surface has a complete discovery chain", () => {
  const report = auditDiscoveryChannels();
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap !== "tool_does_not_name_target_field"),
    [],
    "every target-bearing action must have an Agent tool and a real Mod/Host/schema field",
  );
  assert.ok(report.actionCount > 0);
  assert.ok(report.targetBearingCount > 0);
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

  // 4. A missing Agent tool must be caught.
  const noTool = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: "// no makeGameActionTool mount at all",
  });
  assert.ok(noTool.gaps.some((gap) => gap.gap === "no_agent_tool"));

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
test("the committed tree gives every tile-area fact one owner, and the shared one is really shared", () => {
  const report = auditDiscoveryChannels({ modSources: loadModSources() });
  const tileArea = report.tileArea;
  assert.equal(tileArea.measured, true);
  assert.ok(tileArea.examined > 0, "a population of zero would agree with itself");
  assert.equal(tileArea.owned, tileArea.examined, JSON.stringify(tileArea.rows));
  assert.equal(
    tileArea.shared,
    1,
    "`tillable` is the one fact a second publication also answers, so it is the one that must be a single function",
  );
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
    entry.path.endsWith("farmhandexecutioncontroller.cs")
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
