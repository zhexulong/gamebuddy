#!/usr/bin/env node
/**
 * Falsifier suite for `check-stardew-discovery-collection-coverage.mjs`.
 *
 * The gate's whole claim is that it fails, by name, when a discovery stops reading the collection its
 * published entities live in. Each case below is one way that claim could be false: a body that reads
 * the wrong collection, a collection named only in a comment, a scan that found nothing, a delegation
 * claim with no call behind it, a ratchet entry that outlived its fix.
 *
 * red-proof: self-check  the synthetic bodies below are violating samples the gate must reject
 *                        (`discovery_collection_missing`, `stale_known_gap`, `undeclared_discovery`, ...),
 *                        and the real Mod tree in `the repository tree is green` is the accepting sample
 *                        (tools/check-stardew-discovery-collection-coverage.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDiscoveryCollectionCoverage,
  collectionsRead,
  DISCOVERY_COLLECTIONS,
  KNOWN_DISCOVERY_GAPS,
  LOCATION_COLLECTIONS,
  MINIMUM_DIRECT_READ_FUNCTIONS,
  MINIMUM_DISCOVERY_FUNCTIONS,
  parseDiscoveries,
  readModSources,
} from "./check-stardew-discovery-collection-coverage.mjs";

const ROCK = "integrations/stardew/farmhandexecutioncontroller.cs";

/**
 * A one-file source holding exactly the bodies a case needs. The table, the collection universe and
 * the population floors are overridden per case so the rule under test is the only thing that can
 * produce a finding.
 */
function fixture(bodies, { path = "integrations/stardew/farmhandexecutioncontroller.fixture.cs" } = {}) {
  return [{ path, source: `internal static class Fixture\n{\n${bodies.join("\n")}\n}\n` }];
}

function run(sources, overrides = {}) {
  const declarations = overrides.declarations ?? {};
  return checkDiscoveryCollectionCoverage({
    sources,
    // A one-family fixture declares one family's universe: the collection universe, the ratchet and
    // the population floors are the real tree's business, so they are narrowed here rather than
    // shadowing the rule under test with findings about the other 77 families.
    collections: [...new Set(Object.values(declarations).flatMap((row) => row.mustRead ?? []))],
    knownGaps: [],
    minimumFunctions: 1,
    minimumDirectReads: 0,
    minimumCollections: 0,
    ...overrides,
  });
}

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

const CODE_SCAN_OBJECTS = `    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeRockSourceTarget>();
        return location.objects.Pairs.Select(pair => new BridgeRockSourceTarget("id", location.NameOrUniqueName, 0, 0, "(O)2", "Stone", 1)).ToArray();
    }`;

const CODE_SCAN_TERRAIN_ONLY = `    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeRockSourceTarget>();
        return location.terrainFeatures.Pairs.Select(pair => new BridgeRockSourceTarget("id", location.NameOrUniqueName, 0, 0, "(O)2", "Stone", 1)).ToArray();
    }`;

const ROCK_ROW = Object.freeze({ DiscoverRockSourceTargets: { mustRead: ["objects"] } });

test("a discovery that reads the wrong collection is red, naming the function and the collection", () => {
  const report = run(fixture([CODE_SCAN_TERRAIN_ONLY]), { declarations: ROCK_ROW });

  assert.equal(report.ok, false);
  assert.deepEqual(codes(report), ["discovery_collection_missing"]);
  assert.equal(report.findings[0].discovery, "DiscoverRockSourceTargets");
  assert.equal(report.findings[0].collection, "objects");
  assert.match(report.findings[0].detail, /location\.objects/);
});

test("a discovery that reads its entity's collection is green", () => {
  const report = run(fixture([CODE_SCAN_OBJECTS]), { declarations: ROCK_ROW });

  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.rows[0].direct, ["objects"]);
});

test("a collection named only in a comment or a string is not a read", () => {
  const commented = `    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        // Stones live in location.objects for every mine node (round30).
        string note = "location.objects";
        return Array.Empty<BridgeRockSourceTarget>();
    }`;
  const report = run(fixture([commented]), { declarations: ROCK_ROW });

  assert.deepEqual(codes(report), ["discovery_collection_missing"]);
  assert.deepEqual(report.rows[0].direct, []);
});

test("a collection read behind a declared helper counts, and is still checked", () => {
  const withHelper = `    private static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        return OrderedStorageContainers(player).Select(chest => new BridgeChestState("id", 0, 0, "Chest", false, null)).ToList();
    }

    private static IEnumerable<Chest> OrderedStorageContainers(Farmer player) => LocationStorageContainers(player.currentLocation);

    private static IEnumerable<Chest> LocationStorageContainers(GameLocation location) => location.objects.Values.OfType<Chest>();`;
  const row = Object.freeze({
    DiscoverChestStates: { mustRead: ["objects"], via: ["OrderedStorageContainers", "LocationStorageContainers"] },
  });

  assert.deepEqual(run(fixture([withHelper]), { declarations: row }).findings, []);

  const helperWithoutRead = withHelper.replace("location.objects.Values.OfType<Chest>()", "Array.Empty<Chest>()");
  const report = run(fixture([helperWithoutRead]), { declarations: row });
  assert.deepEqual(codes(report), ["discovery_collection_missing"]);
  assert.equal(report.findings[0].collection, "objects");
});

test("a declared helper that no method declares is a finding, not a silent pass", () => {
  const report = run(fixture([CODE_SCAN_TERRAIN_ONLY]), {
    declarations: { DiscoverRockSourceTargets: { mustRead: ["objects"], via: ["EnumerateStones"] } },
  });

  assert.deepEqual(codes(report).sort(), ["discovery_collection_missing", "discovery_helper_not_declared"]);
});

test("a declared helper that nothing in the chain calls is a finding", () => {
  const sources = fixture([
    CODE_SCAN_TERRAIN_ONLY,
    `    private static IEnumerable<Object> EnumerateStones(GameLocation location) => location.objects.Values;`,
  ]);
  const report = run(sources, {
    declarations: { DiscoverRockSourceTargets: { mustRead: ["objects"], via: ["EnumerateStones"] } },
  });

  assert.deepEqual(codes(report).sort(), ["discovery_collection_missing", "discovery_helper_not_called"]);
});

test("a discovery with no declaration row is red, and a row with no discovery is stale", () => {
  const undeclared = run(fixture([CODE_SCAN_OBJECTS]), { declarations: {} });
  assert.deepEqual(codes(undeclared), ["undeclared_discovery"]);
  assert.equal(undeclared.findings[0].discovery, "DiscoverRockSourceTargets");
  assert.equal(undeclared.rows[0].required, null);

  const stale = run(fixture([CODE_SCAN_OBJECTS]), {
    declarations: {
      ...ROCK_ROW,
      DiscoverFurnitureTargets: { mustRead: [], why: "deleted with its lane" },
    },
  });
  assert.deepEqual(codes(stale), ["stale_discovery_declaration"]);
  assert.equal(stale.findings[0].discovery, "DiscoverFurnitureTargets");
});

test("a scan that found nothing is red, never vacuously green", () => {
  const report = run([], {
    declarations: ROCK_ROW,
    minimumFunctions: MINIMUM_DISCOVERY_FUNCTIONS,
    minimumDirectReads: MINIMUM_DIRECT_READ_FUNCTIONS,
    minimumCollections: 6,
  });

  assert.equal(report.ok, false);
  assert.ok(codes(report).includes("discovery_population_too_small"));
  assert.ok(codes(report).includes("stale_discovery_declaration"));
});

test("an empty declared universe must say what the family publishes instead", () => {
  const report = run(fixture([CODE_SCAN_OBJECTS]), { declarations: { DiscoverRockSourceTargets: { mustRead: [] } } });

  assert.deepEqual(codes(report), ["undeclared_universe_reason"]);
});

test("a required collection outside the declared universe is a finding", () => {
  const report = run(fixture([CODE_SCAN_OBJECTS]), {
    collections: ["objects"],
    declarations: { DiscoverRockSourceTargets: { mustRead: ["objects", "projectiles"] } },
  });

  assert.ok(codes(report).includes("unknown_collection"));
  assert.equal(report.findings.find((finding) => finding.code === "unknown_collection").collection, "projectiles");
});

test("a collection nothing reads and nothing requires is a finding", () => {
  const report = run(fixture([CODE_SCAN_OBJECTS]), {
    collections: ["objects", "projectiles"],
    declarations: ROCK_ROW,
  });

  assert.deepEqual(codes(report), ["collection_never_read"]);
  assert.equal(report.findings[0].collection, "projectiles");
});

test("a known gap that no longer holds is a finding until its entry is deleted", () => {
  const closed = run(fixture([CODE_SCAN_OBJECTS]), {
    declarations: ROCK_ROW,
    knownGaps: [
      { discovery: "DiscoverRockSourceTargets", collection: "objects", why: "recorded when it read terrainFeatures" },
    ],
  });

  assert.deepEqual(codes(closed), ["stale_known_gap"]);
  assert.equal(closed.findings[0].collection, "objects");
});

test("a known gap records the miss instead of failing, and a gap without a measurement is a finding", () => {
  const open = run(fixture([CODE_SCAN_TERRAIN_ONLY]), {
    declarations: { DiscoverRockSourceTargets: { mustRead: ["objects"] } },
    knownGaps: [{ discovery: "DiscoverRockSourceTargets", collection: "objects", why: "measured 2026-11-04" }],
  });
  assert.deepEqual(open.findings, []);
  assert.deepEqual(open.rows[0].knownGaps, ["objects"]);

  const unexplained = run(fixture([CODE_SCAN_TERRAIN_ONLY]), {
    declarations: ROCK_ROW,
    knownGaps: [{ discovery: "DiscoverRockSourceTargets", collection: "objects", why: "" }],
  });
  assert.deepEqual(codes(unexplained), ["unknown_known_gap"]);
});

test("an expression-bodied discovery is measured, not skipped", () => {
  const sources = fixture([
    `    internal static IReadOnlyList<BridgeLanternSlot> DiscoverLanternSlots(Farmer player) => location.objects.Pairs.Select(pair => new BridgeLanternSlot(0, 0)).ToArray();`,
  ]);
  const report = run(sources, { declarations: { DiscoverLanternSlots: { mustRead: ["objects"] } } });

  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.rows[0].direct, ["objects"]);
  assert.deepEqual(report.findings, []);
});

test("the population is a return-type declaration, so a Target-less discovery channel is included", () => {
  const sources = fixture([
    `    private static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player) => Array.Empty<BridgeDoor>();
    private static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player) => Array.Empty<BridgeSoilTile>();
    private static IReadOnlyList<string> DescribeSomething(Farmer player) => Array.Empty<string>();`,
  ]);
  const names = parseDiscoveries(sources).map((discovery) => discovery.name);

  assert.deepEqual(names, ["DiscoverDoorTargets", "DiscoverSoilTiles"]);
});

test("reads are collected per collection name, not per receiver", () => {
  const reads = collectionsRead(
    "foreach (var o in farm.objects.Values) { farm.furniture.Add(o); } player.currentLocation?.animals.Count();",
  );

  assert.deepEqual([...reads].sort(), ["animals", "furniture", "objects"]);
});

test("the repository tree is green and the scan is not vacuous", () => {
  const sources = readModSources();
  const report = checkDiscoveryCollectionCoverage({ sources });

  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
  assert.ok(
    report.discoveryCount >= MINIMUM_DISCOVERY_FUNCTIONS,
    `found ${report.discoveryCount} Discover* functions, below the ${MINIMUM_DISCOVERY_FUNCTIONS} floor`,
  );
  assert.ok(report.directReadCount >= MINIMUM_DIRECT_READ_FUNCTIONS);
  assert.ok(
    report.rows.every((row) => row.required !== null),
    `undeclared: ${report.rows
      .filter((row) => row.required === null)
      .map((row) => row.name)
      .join(", ")}`,
  );
  assert.ok(
    report.rows.every((row) => row.path.startsWith("integrations/stardew/") && !row.path.includes("/tests/")),
    "a test file entered the population",
  );
  // The one recorded gap, so deleting its entry cannot pass unnoticed either.
  assert.deepEqual(
    report.knownGaps,
    KNOWN_DISCOVERY_GAPS.map((gap) => ({ discovery: gap.discovery, collection: gap.collection })),
  );
  assert.ok(Object.keys(DISCOVERY_COLLECTIONS).length >= report.discoveryCount);
  assert.ok(LOCATION_COLLECTIONS.includes("furniture") && LOCATION_COLLECTIONS.includes("largeTerrainFeatures"));
});

test("the real rock discovery losing its object scan is red, named", () => {
  const sources = readModSources();
  const rockSource = sources.find((source) => source.path === ROCK);
  assert.ok(rockSource, `${ROCK} is not in the Mod source scan`);

  const injected = sources.map((source) => {
    if (source.path !== ROCK) return source;
    const declaration = source.source.indexOf("DiscoverRockSourceTargets(Farmer player)");
    assert.ok(declaration > 0, "the rock discovery declaration moved; the injection no longer targets it");
    return {
      ...source,
      source:
        source.source.slice(0, declaration) +
        source.source
          .slice(declaration)
          .replace(
            "NearestFirst(location.objects.Pairs",
            "NearestFirst(Array.Empty<KeyValuePair<Vector2, StardewValley.Object>>()",
          ),
    };
  });
  const report = checkDiscoveryCollectionCoverage({ sources: injected });

  assert.equal(report.ok, false);
  const missing = report.findings.filter((finding) => finding.code === "discovery_collection_missing");
  assert.deepEqual(
    missing.map((finding) => `${finding.discovery}:${finding.collection}`),
    ["DiscoverRockSourceTargets:objects"],
  );
});
