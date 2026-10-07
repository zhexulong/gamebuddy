using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>How many tappers the fixture hands the actor: one to place, one left over.</summary>
    private const int WorldObjectFixtureTapperStack = 2;

    /// <summary>The game's twig litter item, asserted with the game's own `IsTwig()` predicate by the fixture.</summary>
    private const string WorldObjectFixtureTwigId = "(O)294";

    /// <summary>
    /// The world-object lane's pre-attachment Given (scenario
    /// <c>native_world_object_v1</c>): one placeable bigCraftable in the backpack, one
    /// object already placed on a world tile that an axe/pickaxe removes, one breakable
    /// container, and an axe plus a pickaxe to act with. The actor is warped onto a
    /// standing tile whose three neighbours are the three targets, so every action under
    /// test starts inside its own reach (Chebyshev-1 of the target tile).
    ///
    /// Only that declared Given is established. No action is called, no receipt is
    /// minted and no postcondition is claimed: placing the object, removing the placed
    /// object and breaking the container all belong to production.
    ///
    /// Two deliberate choices:
    ///   * the placeable item is a TAPPER (<c>(BC)105</c>) on a mature untapped tree.
    ///     That is this lane's absorption case — a tapper is a bigCraftable and takes
    ///     <c>Object.placementAction</c>'s bigCraftable branch exactly like any other
    ///     machine, with the tree as the item's own data-driven constraint
    ///     (<c>Object.canBePlacedHere</c>'s tapper branch). The tree is world state this
    ///     fixture establishes, and the native branch's own <c>tapped</c> flip is what the
    ///     runner then asserts from the receipt.
    ///   * the placed object is an ordinary crafted machine (<c>(BC)12</c>), i.e.
    ///     <c>Type == "Crafting"</c> and <c>Fragility != 2</c>, which is the exact pair of
    ///     facts <c>Object.performToolAction</c> reads before it lets a tool remove it.
    ///     Both are asserted here, so a fixture that builds something unremovable fails
    ///     loudly instead of surfacing as a product refusal later.
    ///
    /// Every step asserts its own fact, and the asset-placement rules mirror what the
    /// native call needs rather than what is convenient.
    /// </summary>
    private void InstallNativeLocalWorldObjectFixture(Farmer player, GameLocation farm)
    {
        if (farm is null || farm.map is null)
            throw new InvalidOperationException("fixture_native_local_world_object_location_missing");

        (Vector2 Standing, Vector2 Placement, Vector2 Removal, Vector2 WrongToolRemoval, Vector2 Container)? chosen = null;
        int width = farm.map.Layers[0].LayerWidth;
        int height = farm.map.Layers[0].LayerHeight;
        foreach (Vector2 candidate in Enumerable.Range(0, width)
            .SelectMany(x => Enumerable.Range(0, height).Select(y => new Vector2(x, y))))
        {
            if (!farm.isTileOnMap(candidate)
                || !farm.isTilePassable(candidate)
                || farm.objects.ContainsKey(candidate)
                || farm.terrainFeatures.ContainsKey(candidate)
                || farm.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                continue;
            Vector2 placementTile = candidate + new Vector2(0f, -1f);
            Vector2 removalTile = candidate + new Vector2(0f, 1f);
            Vector2 wrongToolRemovalTile = candidate + new Vector2(-1f, 0f);
            Vector2 containerTile = candidate + new Vector2(1f, 0f);
            bool targetsFree = new[] { placementTile, removalTile, wrongToolRemovalTile, containerTile }.All(tile =>
                farm.isTileOnMap(tile)
                && !farm.objects.ContainsKey(tile)
                && !farm.terrainFeatures.ContainsKey(tile)
                && !farm.resourceClumps.Any(clump => clump is not null && clump.getBoundingBox().Contains((int)tile.X * 64, (int)tile.Y * 64)));
            if (!targetsFree)
                continue;
            chosen = (candidate, placementTile, removalTile, wrongToolRemovalTile, containerTile);
            break;
        }
        if (chosen is null)
            throw new InvalidOperationException("fixture_native_local_world_object_tiles_missing");

        Vector2 standing = chosen.Value.Standing;
        Vector2 placementAt = chosen.Value.Placement;
        Vector2 removalAt = chosen.Value.Removal;
        Vector2 wrongToolRemovalAt = chosen.Value.WrongToolRemoval;
        Vector2 containerAt = chosen.Value.Container;

        // Given 1: a mature, untapped tree the tapper can be placed on. `Tree` data is the
        // game's own (`Data/WildTrees`); the fixture does not pick which tree types may be
        // tapped, and asserts the game's answer.
        StardewValley.TerrainFeatures.Tree tree = new("1", StardewValley.TerrainFeatures.Tree.treeStage);
        farm.terrainFeatures.Add(placementAt, tree);
        tree.Location = farm;
        tree.Tile = placementAt;
        if (!ReferenceEquals(farm.terrainFeatures[placementAt], tree)
            || tree.stump.Value
            || tree.tapped.Value
            || !(tree.GetData()?.CanBeTapped() ?? false))
            throw new InvalidOperationException("fixture_native_local_world_object_tree_not_tappable");

        // Given 2: the item to place, plus the two seam tools, in the backpack.
        if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(BC)105", WorldObjectFixtureTapperStack)) is not null)
            throw new InvalidOperationException("fixture_native_local_world_object_tapper_inventory_full");
        StardewValley.Object[] tappers = player.Items.OfType<StardewValley.Object>()
            .Where(item => item.QualifiedItemId == "(BC)105" && item.Stack > 0)
            .ToArray();
        if (tappers.Length != 1 || tappers[0].Stack != WorldObjectFixtureTapperStack || !tappers[0].bigCraftable.Value)
            throw new InvalidOperationException("fixture_native_local_world_object_tapper_missing_after_add");
        if (!player.Items.OfType<Tool>().Any(tool => tool is StardewValley.Tools.Axe)
            && player.addItemToInventory(new StardewValley.Tools.Axe()) is not null)
            throw new InvalidOperationException("fixture_native_local_world_object_axe_inventory_full");
        if (!player.Items.OfType<Tool>().Any(tool => tool is StardewValley.Tools.Pickaxe)
            && player.addItemToInventory(new StardewValley.Tools.Pickaxe()) is not null)
            throw new InvalidOperationException("fixture_native_local_world_object_pickaxe_inventory_full");
        if (!player.Items.OfType<Tool>().Any(tool => tool is StardewValley.Tools.Axe)
            || !player.Items.OfType<Tool>().Any(tool => tool is StardewValley.Tools.Pickaxe))
            throw new InvalidOperationException("fixture_native_local_world_object_tools_missing_after_add");

        // Given 3: an object already placed on a world tile, carrying the exact facts the
        // native removal branch reads.
        StardewValley.Object placed = ItemRegistry.Create<StardewValley.Object>("(BC)12");
        if (placed.Type != "Crafting" || placed.Fragility == 2)
            throw new InvalidOperationException($"fixture_native_local_world_object_placed_item_unremovable:type={placed.Type ?? "none"};fragility={placed.Fragility}");
        placed.Location = farm;
        placed.TileLocation = removalAt;
        farm.objects.Add(removalAt, placed);
        if (!farm.objects.TryGetValue(removalAt, out StardewValley.Object? placedAfter) || !ReferenceEquals(placedAfter, placed))
            throw new InvalidOperationException("fixture_native_local_world_object_placed_item_missing_after_add");

        // Given 4: one breakable container, built by the game's own constructor so its hit
        // budget and debris come from the target version rather than from this fixture.
        BreakableContainer container = new(containerAt, BreakableContainer.barrelId);
        container.Location = farm;
        container.TileLocation = containerAt;
        farm.objects.Add(containerAt, container);
        if (!farm.objects.TryGetValue(containerAt, out StardewValley.Object? containerAfter) || !ReferenceEquals(containerAfter, container))
            throw new InvalidOperationException("fixture_native_local_world_object_container_missing_after_add");

        // Given 5: one twig. It is the lane's real tool asymmetry — the native branch removes
        // a twig with an AXE only (Object.cs:1182 `IsTwig() && t is Axe`), so a pickaxe that
        // would silently no-op natively has to be refused by name. The item id comes from the
        // game's own data and the fixture asserts the predicate it claims, so a target version
        // whose twig is a different id fails HERE rather than as a product refusal later.
        StardewValley.Object twig = ItemRegistry.Create<StardewValley.Object>(WorldObjectFixtureTwigId);
            // The game's OWN ground-litter spawn is exactly this object (GameLocation.cs:17226 does
            // `objects.Add(vector, ItemRegistry.Create<Object>(Game1.random.Choose("(O)294", "(O)295")))`),
            // so asserting IsTwig() asks the right question with the game's own predicate. An earlier
            // version ALSO rejected Fragility == 2, which was wrong twice: that is the state the game
            // spawns, AND it is what the native axe branch SETS when the twig is struck
            // (Object.cs:1184 `fragility.Value = 2`). Runtime fact: a registry-created `(O)294` ALREADY
            // reports Fragility 2, and the native branch ignores fragility entirely - so the product must
            // not treat fragility as a precondition either.
            if (!twig.IsTwig())
            throw new InvalidOperationException($"fixture_native_local_world_object_twig_missing:item={twig.QualifiedItemId};name={twig.name ?? "none"};category={twig.Category};fragility={twig.Fragility}");
        twig.Location = farm;
        twig.TileLocation = wrongToolRemovalAt;
        farm.objects.Add(wrongToolRemovalAt, twig);
        if (!farm.objects.TryGetValue(wrongToolRemovalAt, out StardewValley.Object? twigAfter) || !ReferenceEquals(twigAfter, twig))
            throw new InvalidOperationException("fixture_native_local_world_object_twig_missing_after_add");

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standing.X, (int)standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized world-object precondition before bridge attachment: "
                + $"location={farm.NameOrUniqueName};standing={(int)standing.X},{(int)standing.Y};"
                + $"placement_tile={(int)placementAt.X},{(int)placementAt.Y};placement_item=(BC)105;placement_stack={WorldObjectFixtureTapperStack};"
                + $"tree_tapped=false;removal_tile={(int)removalAt.X},{(int)removalAt.Y};removal_item={placed.QualifiedItemId};removal_type={placed.Type};"
                + $"container_tile={(int)containerAt.X},{(int)containerAt.Y};container_item={container.QualifiedItemId};"
                + $"wrong_tool_removal_tile={(int)wrongToolRemovalAt.X},{(int)wrongToolRemovalAt.Y};wrong_tool_removal_item={twig.QualifiedItemId};"
                + "production alone places the item, removes the placed object and breaks the container.",
            LogLevel.Info);
    }
}
