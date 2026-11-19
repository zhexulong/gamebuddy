using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Netcode;
using StardewValley;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A radius-window discovery list publishes the tiles NEAREST the actor, and truncates only after it has ordered them.
///
/// <para>
/// WHY. These families scan a square window west-to-east from its north-west corner and stop at a row budget, so the rows
/// that survived were whichever tiles the loops reached first - the westernmost columns - wherever the actor stood, and
/// for the families whose candidate set really exceeds the budget, the rows she could act on were the ones dropped.
/// Ordering decides which rows the budget keeps; it removes nothing.
/// </para>
///
/// <para>
/// THE ORDER is <see cref="TargetOrdering.NearestFirstByChebyshev"/>'s: distance from the actor, then the backpack slot,
/// then the tile. Every assertion below is about a ROW (a tile, and the slot whose item would be spent there), because a
/// tile alone cannot tell two items' rows apart.
/// </para>
///
/// <para>
/// THE TWO FAMILIES THE ENGINE ALREADY LIMITS. Wood fence and placeable-object candidates both compose
/// <c>Utility.playerCanPlaceItemHere</c>, whose reach is the radius-1 ring (<c>isWithinTileWithLeeway</c> ->
/// <c>withinRadiusOfPlayer(..., 1, ...)</c>, Utility.cs:5718-5750; the radius-two branch needs
/// <c>Game1.isCheckingNonMousePlacement</c>, which the Mod never sets). The wood fence list therefore never offers more
/// than eight tiles and its budget never binds; the cases below pin the ring and the order rather than a truncation.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class TargetDiscoveryOrderTests
{
    private const string FertilizerId = "(O)369";
    private const string WoodFenceId = "(O)322";
    private const string CrabPotId = "(O)710";

    /// <summary>The Mod's own row budget for the world-object lane (<c>WorldObjectTargetLimit</c>).</summary>
    private const int PlacementRowBudget = 16;

    /// <summary>
    /// The set-level falsifier: a tilled field larger than the budget, where the surviving rows include soil at the
    /// actor's own feet. The scan order cannot produce that row - it stops in the window's sixth column.
    /// </summary>
    [Fact]
    public void TheFertilizerListPublishesTheNearestSoilRatherThanTheWesternmostColumns()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        Ground(world.Farm);
        for (int x = 2; x <= 14; x++)
        for (int y = 2; y <= 14; y++)
            world.PlaceEmptyHoeDirt(x, y);
        world.PutInPackSlot(0, FertilizerId, 5, StardewValley.Object.fertilizerCategory);

        List<BridgeFertilizerTarget> rows = Discover<BridgeFertilizerTarget>("DiscoverFertilizerTargets");
        string published = string.Join(" ", rows.Select(row => $"{row.X},{row.Y}"));

        rows.Should().HaveCount(64, $"a field of 169 tilled tiles is trimmed to the sixty-four-row budget: {published}");
        rows.Should().Contain(
            row => row.X == 8 && row.Y == 8,
            $"the soil she is standing on is the nearest row there is, and the west-column scan never reaches column eight: {published}");
        rows.Should().NotContain(
            row => row.X == 2 && row.Y == 8,
            $"the window's westernmost column is seven tiles away and is what the scan published in her place: {published}");
    }

    /// <summary>
    /// The fence list, pinned at what the engine actually offers it: the eight tiles of the radius-1 ring (the actor's own
    /// tile is refused - she occupies it), ordered by the tile rather than by the scan's column.
    /// </summary>
    [Fact]
    public void TheFenceListPublishesThePlacementRingOrderedByTile()
    {
        (TargetFamilyWorld world, Farm farm) = FarmWorld();
        using (world)
        {
            world.StandAt(8, 8);
            Ground(farm);
            Placeable(world, slot: 0, WoodFenceId);

            List<BridgeWoodFenceTarget> rows = Discover<BridgeWoodFenceTarget>("DiscoverWoodFenceTargets");
            string published = string.Join(" ", rows.Select(row => $"{row.X},{row.Y}"));

            rows.Should().HaveCount(
                8,
                $"the placement predicate reaches the radius-1 ring only, and the tile the actor stands on is occupied by "
                    + $"her own body: {published}");
            rows.Select(row => (row.X, row.Y)).Should().Equal(
                new[] { (7, 7), (8, 7), (9, 7), (7, 8), (9, 8), (7, 9), (8, 9), (9, 9) },
                $"distance is equal across the ring, so the tile decides - row by row of y, then x - where the scan "
                    + $"published column by column: {published}");
        }
    }

    /// <summary>
    /// The crab pot list is the one radius-window family whose predicate has no player-reach gate, so its budget really
    /// binds on a shore: every water tile a pot may go in is a candidate and the nearest ones survive.
    /// </summary>
    [Fact]
    public void TheCrabPotListPublishesTheNearestShoreRatherThanTheWesternmostWater()
    {
        (TargetFamilyWorld world, Farm farm) = FarmWorld();
        using (world)
        {
            world.StandAt(8, 8);
            Ground(farm);
            for (int x = 2; x <= 13; x++)
            for (int y = 2; y <= 13; y++)
                Water(farm, x, y);
            world.PutInPackSlot(0, CrabPotId, 1);

            List<BridgeCrabPotTarget> rows = Discover<BridgeCrabPotTarget>("DiscoverCrabPotTargets");
            string published = string.Join(" ", rows.Select(row => $"{row.X},{row.Y}"));

            rows.Should().HaveCountGreaterThan(
                0,
                $"a water block with land around it offers pot sites; an empty list means the fixture stopped building water: {published}");
            rows.Select(row => Distance(row.X, row.Y)).Should().BeInAscendingOrder(
                $"the budget is applied after the order, so the rows arrive nearest first: {published}");
            rows.Should().Contain(
                row => Distance(row.X, row.Y) <= 2,
                $"the shore within two tiles of the actor is the nearest water there is: {published}");
        }
    }

    /// <summary>
    /// The placement rows are published in distance order and the backpack slot decides a tie, so two machines that could
    /// both go on one tile are told apart by the slot whose machine would be spent there.
    ///
    /// <para>
    /// WHAT THE ENGINE OFFERS THIS FAMILY, measured on this fixture and pinned below so the next unit does not rebuild a
    /// wider world for it: <c>Utility.playerCanPlaceItemHere</c> admits the radius-1 RING only, and the tile the actor
    /// stands on is refused because <c>CanItemBePlacedHere</c> clears the Farmers bit from <c>ignorePassables</c> and
    /// <c>IsTileOccupiedBy</c> then counts her (GameLocation.cs:7290-7313, 7343-7352). Eight rows per placeable item, all
    /// at distance one - which is why ordering here moves rows within that ring and never chooses a nearer tile.
    /// </para>
    ///
    /// <para>
    /// THE OPEN DEFECT THIS PINS RATHER THAN FIXES: three placeable machines are twenty-four rows against a budget of
    /// sixteen, so the third machine's rows are dropped and an item she owns cannot be seen on any tile. Distance cannot
    /// separate them because every row ties at one; only a fairness rule (one row per item before any item gets a second)
    /// would. That is a product decision, and this assertion is the fact it arrives with.
    /// </para>
    /// </summary>
    [Fact]
    public void PlacementRowsArriveWithinTheRingAndTheSlotDecidesATie()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        for (int x = 7; x <= 9; x++)
        for (int y = 7; y <= 9; y++)
            world.MakeDiggable(x, y);
        Placeable(world, slot: 0, "(BC)12", bigCraftable: true);
        Placeable(world, slot: 1, "(BC)13", bigCraftable: true);
        Placeable(world, slot: 2, "(BC)21", bigCraftable: true);

        List<BridgeWorldObjectTarget> rows = WithoutContent(
            () => ExecutionManager.DiscoverWorldObjectTargets(world.Actor)
                .Where(row => string.Equals(row.Kind, "placement_candidate", StringComparison.Ordinal))
                .ToList());
        string published = string.Join(" ", rows.Select(row => $"s{row.Slot}@{row.X},{row.Y}"));

        rows.Should().HaveCount(
            PlacementRowBudget,
            $"three machines over the ring are twenty-four rows and the budget is {PlacementRowBudget}: {published}");
        rows.Should().NotContain(
            row => row.X == 8 && row.Y == 8,
            $"the engine refuses the tile she stands on - the farmer counts as an occupant - for every item: {published}");
        rows.Select(row => row.Slot).Should().BeInAscendingOrder(
            $"every row ties at distance one, so the backpack slot is what orders them: {published}");
        rows.Where(row => row.Slot == 0).Select(row => (row.X, row.Y)).Should().Equal(
            new[] { (7, 7), (8, 7), (9, 7), (7, 8), (9, 8), (7, 9), (8, 9), (9, 9) },
            $"within one slot the tile decides, row by row of y then x, where the map scan published column by column: {published}");
        rows.Should().NotContain(
            row => row.Slot == 2,
            $"the open defect, stated as a fact: twenty-four rows against a budget of sixteen drop the THIRD machine "
                + $"entirely, and no distance order separates rows that all tie at one: {published}");
    }

    private static int Distance(int x, int y) => Math.Max(Math.Abs(x - 8), Math.Abs(y - 8));

    /// <summary>
    /// The fixture's actor standing on a REAL <c>Farm</c> with its own map: two of the lists open with
    /// <c>player.currentLocation is not Farm</c>, which the shared fixture's plain <c>GameLocation</c> never satisfies.
    /// </summary>
    private static (TargetFamilyWorld World, Farm Farm) FarmWorld()
    {
        TargetFamilyWorld world = TargetFamilyWorld.Create();
        var farm = new Farm();
        var map = new xTile.Map();
        map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
        map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
        map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
        farm.map = map;
        typeof(GameLocation).GetField("name", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(farm, new NetString("ProbeFarmTheListsRead"));
        world.Actor.currentLocation = farm;
        Game1.game1!.instanceGameLocation = farm;
        return (world, farm);
    }

    /// <summary>The map's ground: a Back tile on every cell of the window, which the engine's own predicates read.</summary>
    private static void Ground(GameLocation location)
    {
        xTile.Layers.Layer back = location.map.GetLayer("Back")!;
        var sheet = new xTile.Tiles.TileSheet("spring", location.map, "Maps/spring_outdoorsTileSheet", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(64, 64));
        location.map.AddTileSheet(sheet);
        for (int x = 1; x <= 14; x++)
        for (int y = 1; y <= 14; y++)
            back.Tiles[x, y] = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
    }

    /// <summary>One water tile, declared the way a farm map declares it.</summary>
    private static void Water(GameLocation location, int x, int y)
    {
        xTile.Layers.Layer back = location.map.GetLayer("Back")!;
        xTile.Tiles.Tile tile = new xTile.Tiles.StaticTile(back, location.map.TileSheets[0], xTile.Tiles.BlendMode.Alpha, 0);
        tile.Properties["Water"] = "T";
        back.Tiles[x, y] = tile;
    }

    /// <summary>
    /// One item in a pack slot, built without a content manager: the category and the type are what <c>Item.isPlaceable</c>
    /// and the engine's placement branches read, and an item whose context tags are already computed never asks
    /// <c>ItemRegistry</c> for the type definition this process has none of.
    /// </summary>
    private static StardewValley.Object Placeable(TargetFamilyWorld world, int slot, string qualifiedItemId, bool bigCraftable = false)
    {
        var item = new StardewValley.Object
        {
            ItemId = qualifiedItemId[(qualifiedItemId.IndexOf(')') + 1)..],
            Category = -9,
            Stack = 1,
            Type = "Crafting",
        };
        item.bigCraftable.Value = bigCraftable;
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(item, qualifiedItemId);
        typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(item, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(item, false);
        world.Actor.Items[slot] = item;
        return item;
    }

    /// <summary>One of the discovery methods, through reflection because they are private to the execution manager.</summary>
    private static List<TTarget> Discover<TTarget>(string method) =>
        WithoutContent(() => ((IEnumerable<TTarget>)typeof(ExecutionManager)
            .GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object[] { Game1.player })!).ToList());

    /// <summary>
    /// Runs a discovery with the two engine tables its placement predicates LOAD on first use supplied as empty
    /// (`Data/WildTrees` and `Data/Flooring`), which is the truthful answer for a save whose data was never read here.
    /// </summary>
    private static List<TTarget> WithoutContent<TTarget>(Func<List<TTarget>> discover)
    {
        FieldInfo wildTreeSeeds = typeof(StardewValley.TerrainFeatures.Tree)
            .GetField("_WildTreeSeedLookup", BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo floorPaths = typeof(StardewValley.TerrainFeatures.Flooring)
            .GetField("_FloorPathItemLookup", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? seededWildTrees = wildTreeSeeds.GetValue(null);
        object? seededFloorPaths = floorPaths.GetValue(null);
        wildTreeSeeds.SetValue(null, new Dictionary<string, List<string>>(StringComparer.Ordinal));
        floorPaths.SetValue(null, new Dictionary<string, string>(StringComparer.Ordinal));
        try
        {
            return discover();
        }
        finally
        {
            wildTreeSeeds.SetValue(null, seededWildTrees);
            floorPaths.SetValue(null, seededFloorPaths);
        }
    }
}
