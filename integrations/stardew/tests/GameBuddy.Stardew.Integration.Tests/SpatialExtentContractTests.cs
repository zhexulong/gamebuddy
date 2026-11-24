using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using Xunit;
using Xunit.Sdk;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE EXTENT GATE: a row that names a tile must also say how many tiles the thing on it covers, and that number must be
/// the ENGINE's.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR. Every target family on the wire names one tile - <c>x</c>/<c>y</c> - and every reader
/// downstream assumed the thing at that tile was one tile. A 2x3 bed therefore printed as <c>(9,8)</c>, indistinguishable
/// from a chair, and the companion spent four turns moving and replacing a piece it could not identify (measured
/// 2026-11-14, <c>round57</c>). The same shape hides a 2x2 boulder behind one of its four tiles and a 6x3 coop behind one
/// of its eighteen.
/// </para>
///
/// <para>
/// WHY THE POPULATION IS DERIVED AND NOT LISTED. <see cref="SnapshotEntityFamilies"/> walks
/// <see cref="BridgeSnapshot"/>'s own properties, so a family that gains a row type tomorrow joins this gate without an
/// edit here, and the counts this test prints (<c>families examined</c> / <c>carry an extent</c> / <c>missing</c>) are
/// the population rather than a comment about one. The comparison itself is against the engine member that computes the
/// footprint - <c>ResourceClump.width</c>/<c>height</c> here - so the gate fails on a one-tile row for a 2x2 boulder, not
/// on a number someone checked once.
/// </para>
///
/// <para>
/// WHAT THIS PROCESS CANNOT MEASURE, AND WHY THAT IS SAID RATHER THAN SKIPPED. Two of the three multi-tile families need
/// content a process without a save does not load:
/// <list type="bullet">
/// <item><description><c>worldObjectTargets</c> - publishing a piece of furniture reads <c>Furniture.DisplayName</c>,
/// which is <c>ItemRegistry.GetDataOrErrorItem(...)</c> against <c>Data/Objects</c> (<c>Furniture.cs:382</c>), and the
/// call throws <c>KeyNotFoundException: No item type definition found</c> the moment the projection runs here.</description></item>
/// <item><description><c>farmBuildingTargets</c> - <c>GameLocation.IsBuildableLocation()</c> reads
/// <c>Game1.multiplayer.isAlwaysActiveLocation</c> and then <c>GameStateQuery.CheckConditions</c>
/// (<c>GameLocation.cs:2456-2477</c>).</description></item>
/// </list>
/// For those two the derivation is pinned where it can be: <see cref="BothContentBoundExtentsAreReadFromTheEngine"/> reads
/// the SOURCE that writes the row and refuses a literal, so the row cannot acquire a hand-written footprint. That is a
/// source pin and is named as one; it is not a green measurement.
/// </para>
/// </summary>
public sealed class SpatialExtentContractTests
{
    /// <summary>The footprint disagreement, in the vocabulary the rest of this repository uses for a gate finding.</summary>
    private const string Disagrees = "published_extent_disagrees_with_the_engine";

    /// <summary>
    /// THE GATE. Two boulders of different shapes, published through the REAL discovery method, each compared against the
    /// engine field that decides it - plus the family counts, read from the snapshot record itself.
    /// </summary>
    [Fact]
    public void EveryMultiTileEntityIsPublishedWithTheEnginesOwnFootprint()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.FreeOnePackSlot();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 2);

        // Two shapes, because one number that happens to be square cannot tell a swapped pair from a correct one.
        world.PlaceResourceClump(x: 5, y: 2, parentSheetIndex: 672, width: 2, height: 2);
        world.PlaceResourceClump(x: 7, y: 3, parentSheetIndex: 756, width: 2, height: 3);

        IReadOnlyList<BridgeDebrisTarget> debris = world.Rows("debrisTargets").Cast<BridgeDebrisTarget>().ToList();

        var findings = new List<string>();
        foreach (StardewValley.TerrainFeatures.ResourceClump clump in world.Farm.resourceClumps)
        {
            BridgeDebrisTarget row = debris.SingleOrDefault(candidate => candidate.ParentSheetIndex == clump.parentSheetIndex.Value)
                ?? throw new XunitException(
                    $"debrisTargets published no row for the {clump.width.Value}x{clump.height.Value} clump "
                    + $"({debris.Count} rows against {world.Farm.resourceClumps.Count} clumps)");
            Compare(findings, "debrisTargets", "resource_clump", row.W, row.H, (int)clump.width.Value, (int)clump.height.Value);
        }

        // The families the wire declares, and how many of them published an extent against this world. Both counts are
        // printed: "0 disagreements" means nothing without knowing how many rows were looked at, and a family this
        // headless world cannot drive is reported separately from one that published and disagreed.
        IReadOnlyList<EntityFamily> families = SnapshotEntityFamilies();
        var published = new Dictionary<string, IReadOnlyList<object>>(StringComparer.Ordinal)
        {
            ["debrisTargets"] = debris.Cast<object>().ToList(),
        };
        int driven = families.Count(family => published.ContainsKey(family.Name));
        int carries = families.Count(family => family.PublishedMultiTile(published));
        string population = string.Create(
            CultureInfo.InvariantCulture,
            $"families examined {families.Count} · carry an extent {carries} · missing {findings.Count} · "
            + $"driven by this world {driven} · undriven {families.Count - driven}");

        families.Should().NotBeEmpty("a population of zero families would make this gate agree with itself");
        findings.Should().BeEmpty($"{population}: {Disagrees}:<family>:<entity>:<published>:<engine>");
        carries.Should().BeGreaterThan(
            0,
            $"{population}: not one family published a row wider than a tile, so the extents this gate exists for were "
            + "never exercised - the world below holds a 2x2 and a 2x3 boulder");
    }

    /// <summary>
    /// An extent is not a fourth coordinate: the LEFT-TOP origin stays in <c>x</c>/<c>y</c>, and the two numbers beside it
    /// are the shape. Both halves of that are pinned here, because a row that moved the origin to the centre would break
    /// every extractor downstream while looking richer.
    /// </summary>
    [Fact]
    public void TheRowKeepsItsLeftTopOriginAndStatesTheShapeBesideIt()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.FreeOnePackSlot();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 2);
        world.PlaceResourceClump(x: 7, y: 3, parentSheetIndex: 756, width: 2, height: 3);

        BridgeDebrisTarget row = world.Rows("debrisTargets").Cast<BridgeDebrisTarget>().Single();

        row.X.Should().Be(7, "the row names the LEFT-TOP origin, which is the coordinate every extractor reads");
        row.Y.Should().Be(3);
        row.W.Should().Be(2, "the engine's own `ResourceClump.width` for this clump");
        row.H.Should().Be(3, "the engine's own `ResourceClump.height` - the pair is not square, so a swap is visible");
    }

    /// <summary>
    /// The two families this process cannot publish are pinned at their DECLARATION: the furniture row reads
    /// <c>Furniture.getTilesWide()</c>/<c>getTilesHigh()</c>, and the building row reads the standing building's own
    /// <c>tilesWide</c>/<c>tilesHigh</c> or the type's declared <c>Size</c>.
    ///
    /// <para>
    /// The negative half is the part with teeth: a numeric literal assigned to <c>W</c>/<c>H</c> in either file is a
    /// footprint nobody derives, which is the second spelling this projection exists to avoid.
    /// </para>
    /// </summary>
    [Fact]
    public void BothContentBoundExtentsAreReadFromTheEngine()
    {
        string furniture = Source("farmhandexecutioncontroller.worldobjectactions.cs") + ControllerPartials.Declaring("DiscoverWorldObjectTargets");
        furniture.Should().Contain("piece.getTilesWide()", "a furniture row's width is the engine's own sprite-derived footprint");
        furniture.Should().Contain("piece.getTilesHigh()");
        assertNoLiteral(furniture, "the furniture row");

        // THE PARTIAL THAT DECLARES THE ROW, not a named file: the discovery moved out of
        // `farmhandexecutioncontroller.buildfarmbuildingactions.cs` and into `farmhandtargetdiscovery.cs`, and a pin on
        // the old path read a file that no longer writes the row - green over the very thing it was written for, while
        // the `w`/`h` derivation lived one file away. `Declaring` answers where the member is, and throws when it is
        // nowhere or in two places.
        string building = ControllerPartials.Declaring("DiscoverBuildFarmBuildingTargets");
        Regex.Matches(building, @"data\.Size\.X,\s*\r?\n\s*data\.Size\.Y", RegexOptions.CultureInvariant)
            .Should()
            .ContainSingle(
                "a `build_site` row's w/h is the type's declared Size - the same declaration Building.cs:499-501 copies "
                + "into a standing building's own fields");
        building.Should().Contain("building.tilesWide.Value", "a `built` row's width is Building.tilesWide");
        building.Should().Contain("building.tilesHigh.Value");
        assertNoLiteral(building, "the farm-building row");

        static void assertNoLiteral(string source, string row)
        {
            Regex.IsMatch(source, @"\bW:\s*\d|\bH:\s*\d")
                .Should()
                .BeFalse($"{row} must derive its footprint from the engine rather than carry a tile count of its own");
        }
    }

    /// <summary>
    /// THE FALSIFIER. <see cref="Compare"/> is the only thing that decides a disagreement, so it has to be red on a real
    /// injected one: a 2x3 footprint published as one tile is the defect this whole gate exists for, and it must produce
    /// the named finding rather than a generic assertion failure.
    /// </summary>
    [Fact]
    public void TheComparisonIsRedWhenAMultiTileEntityIsPublishedAsOneTile()
    {
        var findings = new List<string>();
        Compare(findings, "worldObjectTargets", "placed_furniture", publishedW: 1, publishedH: 1, engineW: 2, engineH: 3);

        findings.Should().ContainSingle().Which.Should().Be(
            "published_extent_disagrees_with_the_engine:worldObjectTargets:placed_furniture:1x1:2x3");
    }

    /// <summary>
    /// A one-tile entity published as one tile is not a finding, and an extent the row and the engine agree on is not
    /// one either - the guard has to be able to be green on an honest row, or it is a check that always fails.
    /// </summary>
    [Fact]
    public void TheComparisonIsGreenWhenTheRowAgreesWithTheEngine()
    {
        var findings = new List<string>();
        Compare(findings, "worldObjectTargets", "removable_object", publishedW: 1, publishedH: 1, engineW: 1, engineH: 1);
        Compare(findings, "debrisTargets", "resource_clump", publishedW: 2, publishedH: 3, engineW: 2, engineH: 3);
        findings.Should().BeEmpty();
    }

    /// <summary>Compare one published pair against the engine's, recording the finding rather than throwing per row.</summary>
    private static void Compare(List<string> findings, string family, string entity, int publishedW, int publishedH, int engineW, int engineH)
    {
        if (publishedW == engineW && publishedH == engineH) return;
        findings.Add(string.Create(
            CultureInfo.InvariantCulture,
            $"{Disagrees}:{family}:{entity}:{publishedW}x{publishedH}:{engineW}x{engineH}"));
    }

    /// <summary>One source file of the Mod, read from the repository root the parity scan already resolves.</summary>
    private static string Source(string file) =>
        File.ReadAllText(Path.Combine(EngineParityCandidateScan.RepositoryRoot(), "integrations", "stardew", file));

    /// <summary>
    /// Every family <see cref="BridgeSnapshot"/> declares as a list of tile-addressed rows, read from the record itself.
    ///
    /// <para>
    /// THE RECORD IS THE AUTHORITY. A hand-written list of families here could only catch what its author remembered, and
    /// it fails open the first time the snapshot grows one - which is the whole reason the population is derived from the
    /// type the Mod's projection is built from.
    /// </para>
    /// </summary>
    private static IReadOnlyList<EntityFamily> SnapshotEntityFamilies()
    {
        var families = new List<EntityFamily>();
        foreach (PropertyInfo property in typeof(BridgeSnapshot).GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            Type? rowType = ListRowType(property.PropertyType);
            if (rowType is null) continue;
            if (!HasTileAddress(rowType)) continue;
            families.Add(new EntityFamily(WireName(property.Name), rowType));
        }

        return families;
    }

    /// <summary>The record's own property name as the wire spells it: `debrisTargets`, not `DebrisTargets`.</summary>
    private static string WireName(string propertyName) => propertyName[..1].ToLowerInvariant() + propertyName[1..];

    /// <summary>The row type of an <c>IReadOnlyList&lt;T&gt;</c> property, or null when the property is not one.</summary>
    private static Type? ListRowType(Type type)
    {
        if (!type.IsGenericType) return null;
        Type definition = type.GetGenericTypeDefinition();
        if (definition != typeof(IReadOnlyList<>) && definition != typeof(IList<>) && definition != typeof(List<>)) return null;
        return type.GetGenericArguments()[0];
    }

    /// <summary>Whether a row type names a tile: both an integer <c>X</c> and an integer <c>Y</c>.</summary>
    private static bool HasTileAddress(Type rowType) =>
        rowType.GetProperty("X")?.PropertyType == typeof(int) && rowType.GetProperty("Y")?.PropertyType == typeof(int);

    /// <summary>One entity family the snapshot declares, and what it published against the world this gate builds.</summary>
    private sealed class EntityFamily
    {
        internal EntityFamily(string name, Type rowType)
        {
            this.Name = name;
            this.RowType = rowType;
        }

        internal string Name { get; }

        internal Type RowType { get; }

        /// <summary>Whether the row type can carry an extent at all, read from its own members.</summary>
        internal bool DeclaresExtent =>
            this.RowType.GetProperty("W")?.PropertyType == typeof(int) == true
            && this.RowType.GetProperty("H")?.PropertyType == typeof(int) == true;

        /// <summary>
        /// Whether this family published a row wider than one tile against the world given - a fact about what reached
        /// the wire, read from the row the production discovery method produced, and `false` when this process cannot
        /// drive the family at all (reported separately as `undriven`).
        /// </summary>
        internal bool PublishedMultiTile(IReadOnlyDictionary<string, IReadOnlyList<object>> published)
        {
            if (!this.DeclaresExtent) return false;
            if (!published.TryGetValue(this.Name, out IReadOnlyList<object>? rows)) return false;
            PropertyInfo width = this.RowType.GetProperty("W")!;
            PropertyInfo height = this.RowType.GetProperty("H")!;
            return rows.Any(row => (int)width.GetValue(row)! > 1 || (int)height.GetValue(row)! > 1);
        }
    }
}
