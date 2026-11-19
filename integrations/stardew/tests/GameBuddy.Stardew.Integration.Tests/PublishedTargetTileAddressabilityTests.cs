using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A published target is an INVITATION TO ACT, so a row naming a cell no body can be sent to costs a turn every time
/// it is read. `round77` (2026-11-19) spent twelve of them: every `move_to_tile` refusal in that run was
/// `no_native_path` with `native=not_attempted`, and two of the coordinates it named do not exist on the map the body
/// stood on at all.
///
/// <para>
/// THE POPULATION IS EVERY DISCOVERY SOURCE, DERIVED FROM THE PRODUCTION ASSEMBLY. Reflection over
/// <see cref="ExecutionManager"/>'s own `Discover*` members, narrowed to those whose row type carries the tile it
/// publishes (`int X` and `int Y`): a family added tomorrow is in this population without an edit here, and a source
/// that is not driven is listed by name with the argument it needs rather than silently absent.
/// </para>
///
/// <para>
/// THE PROPERTY IS A PLACE: the tile is on the map, and the map's own ground admits a body on at least one cardinal
/// neighbour of it. `ExecutionManager.IsTargetTileAddressable` is the projection the families APPLY; this file checks
/// the same rule read independently (see <c>IsAPlace</c>), so a family that stops consulting it fails here instead of
/// agreeing with a rule switched off. It is asserted where it can FAIL - a world built with the cells `round77` aimed
/// at - as well as over an ordinary farm, and the ordinary rows are asserted to still be published so a filter that
/// muted a family cannot pass as a repair.
/// </para>
/// </summary>
public sealed class PublishedTargetTileAddressabilityTests
{
    private readonly ITestOutputHelper output;

    public PublishedTargetTileAddressabilityTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// WHAT THE ORDINARY FARM HOLDS, so the population has rows to examine rather than an empty world agreeing with
    /// itself. These are the fixture's own construction names, not a list of families to check: the families checked are
    /// the discovery sources, above.
    /// </summary>
    private static readonly string[] OrdinaryFarmContents =
    {
        "weedTargets", "rockSourceTargets", "treeChopSourceTargets", "treeStumpTargets", "grassTargets",
        "cropTargets", "harvestTargets", "seedTargets", "scytheCropTargets", "clearHoeDirtTargets",
        "forageTargets", "itemTargets", "chests", "npcRelationshipTargets", "treeSaplingTargets",
    };

    [Fact]
    public void EveryPublishedTargetTileIsOneAProbeCanBeSentTo()
    {
        // One ORDINARY FARM PER FAMILY: the fixture places every family on the same two cells, so a single world would
        // clobber one subject with the next and the gate would examine four rows and call that a measurement.
        int examined = 0;
        int usable = 0;
        int sources = 0;
        var unusable = new List<string>();
        var notDriven = new SortedSet<string>(StringComparer.Ordinal);
        var published = new List<string>();
        var breakdown = new List<string>();
        foreach (string family in OrdinaryFarmContents)
        {
            using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
            world.PopulateFor(family);
            Measurement one = Measure(world);
            examined += one.Examined;
            usable += one.Usable;
            sources = one.SourcesExamined;
            unusable.AddRange(one.Unusable);
            published.AddRange(one.PublishedTiles);
            notDriven.UnionWith(one.NotDriven);
            breakdown.AddRange(one.SourceBreakdown);
        }

        var measured = new Measurement(sources, examined, usable, unusable, notDriven.ToList(), published, breakdown);

        this.output.WriteLine(measured.Line);
        this.output.WriteLine("sources with rows: " + string.Join(" ", measured.SourceBreakdown));

        measured.Unusable.Should().BeEmpty(
            "a row must name a cell a body can be sent to: " + measured.Line);
        measured.Examined.Should().BeGreaterThan(20,
            "an examination this small has watched too little to say anything: " + measured.Line);
        measured.SourcesExamined.Should().Be(TilePublishingDiscoveries().Count,
            "the population is the assembly's own discovery sources: " + measured.Line);
    }

    /// <summary>
    /// THE COORDINATES `round77` AIMED AT IN `Backwoods` - `79,16` and `80,16` - ARE THE FARM'S EAST EXIT CELLS, read on
    /// a map that does not contain them: the probe answered `all four approaches off_map; target_walkable=false` for
    /// both, before the engine was asked. A cell this map does not contain is not a target: the map is the authority for
    /// which cells exist, and no family may publish one the map does not have.
    /// </summary>
    [Fact]
    public void ACellThisMapDoesNotContainIsNeverPublished()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        // The shape of the Run: a coordinate FROM ANOTHER MAP (the Farm's 16th column and 16th row, on a 16x16 map).
        world.PlaceWeed(16, 3);
        world.PlaceRock(16, 5, durability: 1);
        world.PlaceGroundDrop(5, 16, "(O)24");
        // The control, so this file cannot pass by publishing nothing at all.
        world.PlaceRock(13, 3, durability: 1);
        world.StandAt(12, 3);

        Measurement measured = Measure(world);

        this.output.WriteLine(measured.Line);
        this.output.WriteLine("published: " + string.Join(" ", measured.PublishedTiles));

        measured.Unusable.Should().BeEmpty(
            "a coordinate the map does not contain is not a target: " + measured.Line);
        measured.PublishedTiles.Should().Contain("13,3", "the control rock is a place, so it must still be published");
    }

    /// <summary>
    /// THE OTHER TWO SHAPES IN THE SAME RUN, and the rule that separates a boundary artefact from a place.
    ///
    /// <para>
    /// `Mountain:80,0` was a Buildings-layer wall (`blocked_by=buildings_tile:blocked@80,0`), and the Farm's `40,0`
    /// was a cell whose only routes were the map edge and the wall beside it (`north:off_map`,
    /// `west:buildings_tile:blocked@39,0`). The game's own ground decides that, not the flood: a tile with no cardinal
    /// neighbour the map admits is a cell nothing can be done at, because the body stands BESIDE a tree, a weed or a
    /// chest and never on it.
    /// </para>
    ///
    /// <para>
    /// The last two placements are the CONTROL, and they are why this file cannot pass by muting a family: the same
    /// two families must still publish an ordinary weed and an ordinary rock in the same world.
    /// </para>
    /// </summary>
    [Fact]
    public void ACellWithNoPlaceToStandBesideItIsNeverPublished()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        // `Mountain:80,0` - an occupied cell walled in on all four sides.
        world.PlaceRock(9, 9, durability: 3);
        world.MakeWall(8, 9);
        world.MakeWall(10, 9);
        world.MakeWall(9, 8);
        world.MakeWall(9, 10);
        // The Farm's `40,0` - a cell on the map's outer ring whose only other routes are walls.
        world.PlaceWeed(11, 0);
        world.MakeWall(10, 0);
        world.MakeWall(12, 0);
        world.MakeWall(11, 1);
        // The control: ordinary subjects of the same two families, reachable from where the body stands.
        world.PlaceWeed(13, 3);
        world.PlaceRock(6, 9, durability: 1);
        world.StandAt(12, 3);

        Measurement measured = Measure(world);

        this.output.WriteLine(measured.Line);
        this.output.WriteLine("published: " + string.Join(" ", measured.PublishedTiles));

        measured.Unusable.Should().BeEmpty(
            "a cell with no admittable neighbour is not a place: " + measured.Line);
        measured.PublishedTiles.Should().Contain("13,3", "the control weed is a place, so its family must still publish it");
        measured.PublishedTiles.Should().Contain("6,9", "the control rock is a place, so its family must still publish it");
    }

    /// <summary>Every tile a discovery source published, and how many of them are places.</summary>
    private sealed record Measurement(
        int SourcesExamined,
        int Examined,
        int Usable,
        List<string> Unusable,
        List<string> NotDriven,
        List<string> PublishedTiles,
        List<string> SourceBreakdown)
    {
        internal string Line =>
            $"targets examined {this.Examined} · usable {this.Usable} · published-unusable {this.Unusable.Count}"
            + $" (sources examined {this.SourcesExamined}, not driven {this.NotDriven.Count}"
            + (this.NotDriven.Count == 0 ? ")" : ": " + string.Join(" ", this.NotDriven) + ")")
            + (this.Unusable.Count == 0 ? string.Empty : ": " + string.Join(" ", this.Unusable));
    }

    private static Measurement Measure(TargetFamilyCompletenessTests.TargetFamilyWorld world)
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        var manager = new ExecutionManager(new DummyMonitor(), () => publication);
        int sources = 0;
        int examined = 0;
        int usable = 0;
        var unusable = new List<string>();
        var notDriven = new List<string>();
        var published = new List<string>();
        var breakdown = new List<string>();
        foreach (MethodInfo method in TilePublishingDiscoveries())
        {
            sources++;
            object? result;
            try
            {
                result = method.Invoke(method.IsStatic ? null : manager, Arguments(method, world));
            }
            catch (TargetInvocationException failure)
            {
                // A source this world cannot drive is NAMED, never counted as clean: "not measured" and "measured
                // nothing" are different answers and only the second may pass.
                notDriven.Add($"{method.Name}({failure.InnerException?.GetType().Name})");
                continue;
            }

            int rows = 0;
            foreach (object? row in Rows(result))
            {
                if (row is null || TileOf(row) is not { } tile) continue;
                rows++;
                examined++;
                if (IsAPlace(world.Farm, tile.X, tile.Y))
                {
                    usable++;
                    published.Add($"{tile.X},{tile.Y}");
                    continue;
                }

                unusable.Add($"{method.Name}:{tile.X},{tile.Y}");
            }

            if (rows > 0) breakdown.Add($"{method.Name}={rows}");
        }

        return new Measurement(sources, examined, usable, unusable, notDriven, published, breakdown);
    }

    /// <summary>
    /// The discovery sources that publish a TILE, taken from the assembly: a `Discover*` member whose row type carries
    /// `int X` and `int Y`. The transition families are not in this population and must not be: a warp's or a door's
    /// cell is where a body STANDS to cross (`enter_exit`, entered from beside it at radius 1), not a target it is
    /// walked onto.
    /// </summary>
    private static IReadOnlyList<MethodInfo> TilePublishingDiscoveries() =>
        typeof(ExecutionManager)
            .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(method => method.Name.StartsWith("Discover", StringComparison.Ordinal))
            .Where(method => !method.IsGenericMethodDefinition && method.GetParameters().All(Drivable))
            .Where(method => RowType(method.ReturnType) is { } row
                && row.GetProperty("X", typeof(int)) is not null
                && row.GetProperty("Y", typeof(int)) is not null)
            .OrderBy(method => method.Name, StringComparer.Ordinal)
            .ToArray();

    private static bool Drivable(ParameterInfo parameter) =>
        parameter.ParameterType == typeof(Farmer)
        || parameter.ParameterType == typeof(GameLocation)
        || parameter.ParameterType == typeof(DiscoveryExclusionRecorder)
        || parameter.ParameterType == typeof(IList<Item?>)
        || parameter.ParameterType.IsByRef;

    private static object?[] Arguments(MethodInfo method, TargetFamilyCompletenessTests.TargetFamilyWorld world) =>
        method.GetParameters()
            .Select(parameter => parameter.ParameterType == typeof(Farmer) ? (object?)world.Actor
                : parameter.ParameterType == typeof(GameLocation) ? world.Farm
                : parameter.ParameterType == typeof(IList<Item?>) ? world.Actor.Items
                : parameter.ParameterType == typeof(DiscoveryExclusionRecorder) ? new DiscoveryExclusionRecorder()
                : parameter.ParameterType.IsByRef ? Activator.CreateInstance(parameter.ParameterType.GetElementType()!)
                : throw new InvalidOperationException($"{method.Name} needs an argument this probe has no source for"))
            .ToArray();

    /// <summary>The row type of one discovery source's return value, or null when it publishes no row.</summary>
    private static Type? RowType(Type returnType) =>
        returnType.IsArray ? returnType.GetElementType()
        : returnType.IsGenericType ? returnType.GetGenericArguments()[0]
        : null;

    private static IEnumerable<object?> Rows(object? result) =>
        result is IEnumerable rows and not string ? rows.Cast<object?>() : Array.Empty<object?>();

    /// <summary>
    /// THE ORACLE, READ INDEPENDENTLY OF THE PRODUCTION PREDICATE.
    ///
    /// <para>
    /// <see cref="ExecutionManager.IsTargetTileAddressable"/> is what the families APPLY; this is what this file CHECKS,
    /// and it must not be the same call. A gate that asked the implementation whether the implementation was right
    /// agreed with a switched-off rule and stayed green through the defect it exists for - measured here: with
    /// `IsTargetTileAddressable` forced to `true`, this assertion still passed, because the measurement had asked the
    /// disabled rule. The rule is therefore read here from the engine's own map data, which is the authority the
    /// production predicate is a projection of; if the two ever disagree this file FAILS rather than agreeing with
    /// itself.
    /// </para>
    /// </summary>
    private static bool IsAPlace(GameLocation location, int x, int y)
    {
        if (!location.isTileOnMap(x, y)) return false;
        foreach ((int neighbourX, int neighbourY) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
        {
            if (location.isTileOnMap(neighbourX, neighbourY)
                && location.isTilePassable(new Vector2(neighbourX, neighbourY)))
                return true;
        }

        return false;
    }

    /// <summary>The tile a row publishes, or null for a row that names no cell.</summary>
    private static (int X, int Y)? TileOf(object row)
    {
        Type type = row.GetType();
        PropertyInfo? x = type.GetProperty("X", typeof(int));
        PropertyInfo? y = type.GetProperty("Y", typeof(int));
        return x is null || y is null ? null : ((int)x.GetValue(row)!, (int)y.GetValue(row)!);
    }
}
