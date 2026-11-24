using System.Globalization;
using GameBuddy.Stardew.Core;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;
using StardewValley.GameData.Machines;
using StardewValley.GameData.Minecarts;
using StardewValley.GameData.Museum;
using StardewValley.GameData.Shops;
using StardewValley.Locations;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Quests;
using StardewValley.SpecialOrders;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

internal sealed class FarmhandTargetDiscovery
{
    private readonly IMonitor monitor;
    private readonly GroundItemPickupLedger groundItemTargets;
    private readonly Func<int> tick;

    internal FarmhandTargetDiscovery(IMonitor monitor, GroundItemPickupLedger groundItemTargets, Func<int> tick)
    {
        this.monitor = monitor;
        this.groundItemTargets = groundItemTargets;
        this.tick = tick;
    }

    /// <summary>
    /// A radius-window family, from the held stacks that could supply it to the rows it publishes: scan the window
    /// around the actor once per source stack, admit each tile through <see cref="IsPublishedTargetTileInRadius"/>, ask
    /// the family for the row that tile would produce, and ORDER THE WHOLE FAMILY BEFORE TRIMMING it to `rowBudget`.
    ///
    /// <para>
    /// THE TWO ORDERS ARE DIFFERENT ONES. The window is walked west-to-east from its north-west corner, so the scan's
    /// order is the map's while the order a row is published in is the actor's; a family that truncated while it walked
    /// published whichever tiles the loops reached first - the westernmost columns - wherever she stood. Each family
    /// loses differently to that: the fence list's legal tiles are a ring, the crab-pot list's are a shore scattered
    /// through the window, and the fertilizer list's are a solid tilled block in which the westmost columns alone would
    /// fill all sixty-four rows and never name the soil she is standing in.
    /// </para>
    ///
    /// <para>
    /// The published order is <see cref="TargetOrdering.NearestFirstByChebyshev"/>'s - distance, then slot, then tile.
    /// Three things differ per family and all three are arguments: the predicate (`isSource`, plus whatever `buildRow`
    /// admits and refuses by returning null), the cap (`RadiusWindowRowBudget` for the fence and crab-pot lists,
    /// `FertilizerRowBudget` for the fertilizer list - each the Host's declared `maxItems` for the family it caps,
    /// never a literal at the call site), and the natural key `identify` reads a row's tile and slot back out of.
    /// Ordering removes nothing: a row the actor was never shown is a target the dispatch can never name.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<T> NearestFirstRadiusWindowRows<T>(
        Farmer player,
        Func<StardewValley.Object, bool> isSource,
        int rowBudget,
        Func<StardewValley.Object, int, int, int, T?> buildRow,
        Func<T, TargetCandidate> identify)
        where T : class
    {
        List<T> candidates = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object source || !isSource(source)) continue;
            for (int x = Math.Max(0, player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius); x <= player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius); y <= player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius; y++)
            {
                if (!FarmhandTargetDiscovery.IsPublishedTargetTileInRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius)) continue;
                if (buildRow(source, slot, x, y) is not { } row) continue;
                candidates.Add(row);
            }
        }

        return TargetOrdering.NearestFirstByChebyshev(candidates, (int)player.Tile.X, (int)player.Tile.Y, identify)
            .Take(rowBudget).ToArray();
    }

    internal static IReadOnlyList<BridgeWearableTarget> DiscoverWearableTargets(Farmer player)
    {
        List<BridgeWearableTarget> result = new(ExecutionManager.WearableBodySlots.Length);
        foreach (string bodySlot in ExecutionManager.WearableBodySlots)
        {
            if (!ExecutionManager.TryReadWearableBodySlot(player, bodySlot, out Item? occupant)) continue;
            result.Add(new BridgeWearableTarget(
                ExecutionManager.BuildWearableTargetId(player, bodySlot),
                bodySlot,
                occupant?.QualifiedItemId,
                occupant?.DisplayName));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeAnimalDoorTarget> DiscoverAnimalDoorTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeAnimalDoorTarget>();
        List<BridgeAnimalDoorTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null) continue;
            // `Building.doAction` answers an under-construction building with the `UnderConstruction` dialogue and
            // nothing else (Building.cs:937-940), and the animal door's own toggle is gated on the same countdown
            // (`daysOfConstructionLeft.Value <= 0`, Building.cs:976). The door exists on the map and the engine refuses it.
            if (building.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("animalDoorTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            if (!ExecutionManager.TryDescribeAnimalDoor(building, out string buildingType, out bool isOpen)) continue;
            Point door = building.getPointForHumanDoor();
            if (!ExecutionManager.IsTileWithinChebyshevRadius(player, door.X, door.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeAnimalDoorTarget(
                ExecutionManager.BuildAnimalDoorTargetId(location, building, isOpen),
                location.NameOrUniqueName,
                door.X,
                door.Y,
                buildingType,
                isOpen));
            if (result.Count >= 16) break;
        }
        return result;
    }

    /// <summary>
    /// The tiles of a STANDING structure's own tile data that lie OUTSIDE its footprint: the porch, walkway and deck
    /// rows it draws.
    ///
    /// <para>
    /// THE QUESTION IS THE ENGINE'S, AND IT IS ASKED OF THE STRUCTURE. <c>Building.doesTileHaveProperty</c>
    /// (Building.cs:2419-2432) maps the tile into the type's declared tile properties by subtracting the origin, and
    /// <c>GreenhouseBuilding.doesTileHaveProperty</c> (GreenhouseBuilding.cs:60-97) widens that answer to a one-tile halo
    /// and to the two rows in front of the door - <c>humanDoor.X - 1 .. +1</c> by <c>humanDoor.Y + 1 .. +2</c>, which on
    /// the standard Farm's `25,10` 7x6 greenhouse with `humanDoor 3,5` is <c>27..29 x 16..17</c>. Measured `round98`: the
    /// map under those rows is ordinary <c>Diggable</c> farm soil, so every producer that asked the map read a doorstep as
    /// field, and a cauliflower was sown in the doorway.
    /// </para>
    ///
    /// <para>
    /// <c>Type</c>/<c>Back</c> IS THE FILTER, and it is the word <c>GroundSurface</c> reads for one tile: the greenhouse
    /// answers <c>Buildable</c> and <c>NoSpawn</c> on its halo as well, and those say what may be put there rather than
    /// what the ground is. The footprint itself is skipped because a row already publishes it as <c>W</c>/<c>H</c>: the
    /// porch is the part of the structure that is not the structure.
    /// </para>
    /// </summary>
    private static IReadOnlyList<TilePoint> DescribeOwnTiles(Building building, out int omitted)
    {
        omitted = 0;
        int left = building.tileX.Value - 1;
        int right = building.tileX.Value + Math.Max(1, building.tilesWide.Value);
        int top = building.tileY.Value;
        int bottom = building.tileY.Value + Math.Max(1, building.tilesHigh.Value) + 1;
        var tiles = new List<TilePoint>();
        for (int y = top; y <= bottom; y += 1)
        for (int x = left; x <= right; x += 1)
        {
            if (x >= building.tileX.Value && x < building.tileX.Value + Math.Max(1, building.tilesWide.Value)
                && y >= building.tileY.Value && y < building.tileY.Value + Math.Max(1, building.tilesHigh.Value))
                continue;
            string value = "";
            if (!building.doesTileHaveProperty(x, y, "Type", "Back", ref value) || value.Length == 0) continue;
            if (tiles.Count >= ExecutionManager.OwnTileLimit)
            {
                omitted += 1;
                continue;
            }
            tiles.Add(new TilePoint(x, y));
        }
        return tiles;
    }

    internal static IReadOnlyList<BridgeFarmBuildingTarget> DiscoverBuildFarmBuildingTargets(Farmer player, out int omitted)
    {
        omitted = 0;
        GameLocation? location = player.currentLocation;
        if (location is null || !location.IsBuildableLocation() || Game1.buildingData is null)
            return Array.Empty<BridgeFarmBuildingTarget>();

        List<BridgeFarmBuildingTarget> result = new();
        int siteCount = 0;
        int builtCount = 0;

        foreach (KeyValuePair<string, BuildingData> entry in Game1.buildingData)
        {
            if (siteCount >= ExecutionManager.BuildFarmBuildingTargetLimit) break;
            BuildingData data = entry.Value;
            if (string.IsNullOrEmpty(entry.Key) || data is null || data.Size.X <= 0 || data.Size.Y <= 0) continue;
            if (!string.IsNullOrEmpty(data.BuildingToUpgrade)) continue;
            if (Game1.player.Money < data.BuildCost) continue;
            if (ExecutionManager.CountBuildFarmBuildingMaterials(ExecutionManager.BuildFarmBuildingMaterials(data)) < ExecutionManager.BuildFarmBuildingMaterials(data).Sum(material => material.Amount)) continue;

            Vector2? site = ExecutionManager.FindFarmBuildingSite(player, location, data);
            if (site is null) continue;
            (int x, int y) = ((int)site.Value.X, (int)site.Value.Y);
            result.Add(new BridgeFarmBuildingTarget(
                ExecutionManager.BuildFarmBuildingSiteTargetId(location, entry.Key, x, y),
                "build_site",
                location.NameOrUniqueName,
                x,
                y,
                entry.Key,
                string.IsNullOrEmpty(data.Name) ? entry.Key : data.Name,
                data.BuildCost,
                data.BuildDays,
                "none",
                -1,
                // The type's own declared size - the tiles the commission will take. The structure does not exist yet,
                // so `Building.tilesWide` has nothing to answer for; `Data/Buildings`' `Size` is the same declaration the
                // engine copies into those fields when the building goes up (Building.cs:499-501).
                data.Size.X,
                data.Size.Y));
            siteCount++;
        }

        List<Building> standing = location.buildings
            .Where(static building => building is not null)
            .OrderByDescending(static building => building.daysOfConstructionLeft.Value > 0)
            .ThenBy(static building => building.id.Value)
            .ToList();
        foreach (Building building in standing)
        {
            if (builtCount >= ExecutionManager.BuildFarmBuildingTargetLimit)
            {
                omitted += 1;
                continue;
            }
            // The countdown is a PUBLISHED FIELD of the `built` row, not a filter: a building still being built is a
            // building standing on the farm, and `Building.dayUpdate` only ever decrements this while it is above zero
            // (Building.cs:1582-1590), so a negative value names no state the engine can produce.
            BuildingData? data = building.GetData();
            // The porch is a fact about a structure that STANDS STILL: a building being moved (`isMoving`, the placement
            // preview) is not on the map it is drawn over, and `GreenhouseBuilding.doesTileHaveProperty` refuses every
            // tile while it is (GreenhouseBuilding.cs:62-65) - so a moving building has no porch to publish rather than a
            // porch wherever the preview is. The DOOR is unaffected: `getPointForHumanDoor()` is the row's own origin plus
            // the offset its data declares, which is true whether or not the sprite is being dragged.
            IReadOnlyList<TilePoint>? ownTiles = null;
            int ownTilesOmitted = 0;
            if (!building.isMoving)
            {
                ownTiles = FarmhandTargetDiscovery.DescribeOwnTiles(building, out ownTilesOmitted);
                if (ownTiles.Count == 0) ownTiles = null;
            }
            result.Add(new BridgeFarmBuildingTarget(
                $"built_{building.id.Value:N}",
                "built",
                location.NameOrUniqueName,
                building.tileX.Value,
                building.tileY.Value,
                building.buildingType.Value,
                string.IsNullOrEmpty(building.buildingType.Value) ? "none" : building.buildingType.Value,
                data?.BuildCost ?? 0,
                data?.BuildDays ?? 0,
                building.id.Value.ToString("D"),
                building.daysOfConstructionLeft.Value,
                // The standing building's own footprint (Building.cs:64-68), which is what `occupiesTile` reads.
                Math.Max(1, building.tilesWide.Value),
                Math.Max(1, building.tilesHigh.Value),
                // The door through the ONE authority that decides whether a building has one at all: `BuildingContactOf`
                // reads the type's declared `Data/Buildings.HumanDoor` and answers a POINT only when it is declared,
                // which is why a silo carries no `humanDoor` instead of the origin corner a raw NetPoint holds.
                ExecutionManager.BuildingContactOf(building).HumanDoor,
                ownTiles,
                ownTilesOmitted > 0 ? ownTilesOmitted : null));
            builtCount++;
        }

        return result;
    }

    internal static IReadOnlyList<BridgeBuildingChestTarget> DiscoverBuildingChestTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBuildingChestTarget>();
        List<BridgeBuildingChestTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null) continue;
            // An under-construction building has no chest the engine will open: `Building.doAction` answers it with the
            // `UnderConstruction` dialogue and performs nothing else (Building.cs:937-940).
            if (building.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("buildingChestTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            BuildingData? data = building.GetData();
            if (data?.Chests is null) continue;
            foreach (BuildingChest declared in data.Chests)
            {
                if (result.Count >= 16) break;
                if (declared is null || string.IsNullOrWhiteSpace(declared.Id)) continue;
                if (declared.Type is not (BuildingChestType.Load or BuildingChestType.Collect)) continue;
                Chest? chest = building.GetBuildingChest(declared.Id);
                if (chest is null) continue;
                if (!ExecutionManager.TryFindBuildingChestInteractionTile(building, declared.Id, out int tileX, out int tileY)) continue;
                if (!ExecutionManager.IsTileWithinChebyshevRadius(player, tileX, tileY, ExecutionManager.TargetDiscoveryRadius)) continue;
                BridgeBuildingChestTarget target = new(
                    ExecutionManager.BuildBuildingChestTargetId(location, building, declared.Id, declared.Type, tileX, tileY),
                    location.NameOrUniqueName,
                    tileX,
                    tileY,
                    building.buildingType.Value,
                    declared.Id,
                    ExecutionManager.DescribeBuildingChestBranch(declared.Type),
                    ExecutionManager.BuildingChestSlotCount(chest),
                    ExecutionManager.BuildingChestItemCount(chest));
                if (declared.Type == BuildingChestType.Load && ExecutionManager.TryFindLoadableInventorySlot(building, chest, out int slot, out string itemId, out int stack))
                    target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = itemId, LoadInputStack = stack };
                result.Add(target);
            }
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeColorTarget> DiscoverColorTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeColorTarget>();
        List<BridgeColorTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (result.Count >= ExecutionManager.ColorTargetLimit)
                break;
            Vector2 tile = pair.Key;
            if (pair.Value is null || !ExecutionManager.TryDescribeColorableChest(pair.Value, out Chest? chest))
                continue;
            if (!ExecutionManager.IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeColorTarget(
                ExecutionManager.BuildColorTargetId(location, (int)tile.X, (int)tile.Y, chest!),
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                ExecutionManager.FormatColor(chest!.playerChoiceColor.Value)));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeRecipeTarget> DiscoverCookingRecipeTargets(Farmer player)
    {
        Dictionary<string, string>? table = CraftingRecipe.cookingRecipes;
        if (table is null) return Array.Empty<BridgeRecipeTarget>();
        List<BridgeRecipeTarget> result = new();
        foreach (string recipeKey in player.cookingRecipes.Keys.OrderBy(key => key, StringComparer.Ordinal))
        {
            if (!table.ContainsKey(recipeKey)) continue;
            if (ExecutionManager.TryBuildWireRecipeIdentity(table.Keys, recipeKey) is not { } wireIdentity) continue;
            CraftingRecipe recipe = new(recipeKey, isCookingRecipe: true);
            result.Add(new BridgeRecipeTarget(wireIdentity, recipe.DisplayName, recipe.doesFarmerHaveIngredientsInInventory(null), ExecutionManager.MissingRecipeIngredients(player, recipe)));
        }
        return result
            .OrderByDescending(target => target.IngredientsAvailable)
            .Take(64)
            .ToArray();
    }

    internal static IReadOnlyList<BridgeCookingStationTarget> DiscoverCookingStationTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCookingStationTarget>();
        List<BridgeCookingStationTarget> result = new();
        if (!location.IsOutdoors)
        {
            int width = location.map.Layers[0].LayerWidth;
            int height = location.map.Layers[0].LayerHeight;
            for (int x = 0; x < width && result.Count < 16; x++)
            for (int y = 0; y < height && result.Count < 16; y++)
            {
                string actionToken = location.doesTileHaveProperty(x, y, "Action", "Buildings")?.Split(' ')[0] ?? string.Empty;
                if (!string.Equals(actionToken, "kitchen", StringComparison.Ordinal)
                    && !string.Equals(actionToken, "Kitchen", StringComparison.Ordinal))
                    continue;
                result.Add(new BridgeCookingStationTarget(ExecutionManager.BuildCookingStationTargetId(location, x, y, "kitchen"), location.NameOrUniqueName, x, y, "kitchen"));
            }
        }
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (result.Count >= 16) break;
            if (pair.Value.QualifiedItemId != "(BC)278") continue;
            result.Add(new BridgeCookingStationTarget(ExecutionManager.BuildCookingStationTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, "cookout_kit"), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, "cookout_kit"));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeRecipeTarget> DiscoverCraftingRecipeTargets(Farmer player)
    {
        Dictionary<string, string>? table = CraftingRecipe.craftingRecipes;
        if (table is null) return Array.Empty<BridgeRecipeTarget>();
        List<BridgeRecipeTarget> result = new();
        foreach (string recipeKey in player.craftingRecipes.Keys.OrderBy(key => key, StringComparer.Ordinal))
        {
            if (!table.ContainsKey(recipeKey)) continue;
            if (ExecutionManager.TryBuildWireRecipeIdentity(table.Keys, recipeKey) is not { } wireIdentity) continue;
            CraftingRecipe recipe = new(recipeKey, isCookingRecipe: false);
            if (!string.Equals(recipe.name, recipeKey, StringComparison.Ordinal)) continue;
            result.Add(new BridgeRecipeTarget(wireIdentity, recipe.DisplayName, recipe.doesFarmerHaveIngredientsInInventory(), ExecutionManager.MissingRecipeIngredients(player, recipe)));
        }
        return result
            .OrderByDescending(target => target.IngredientsAvailable)
            .Take(64)
            .ToArray();
    }

    internal static IReadOnlyList<BridgeWaterTarget> DiscoverWaterTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null || location.map.Layers.Count == 0) return Array.Empty<BridgeWaterTarget>();
        if (!location.canFishHere()) return Array.Empty<BridgeWaterTarget>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        (int X, int Y) actor = ((int)player.Tile.X, (int)player.Tile.Y);
        Func<(int X, int Y), bool> isStandable = tile =>
            StardewBodyController.IsStandableTile(location, player, new Vector2(tile.X, tile.Y))
            && !ExecutionManager.IsWarpBufferTile(location, tile);
        Func<(int X, int Y), bool> isReachable = StardewBodyController.BuildWalkableComponent(location, player) is { } component
            ? tile => component(new Vector2(tile.X, tile.Y))
            : _ => true;
        List<(int X, int Y)> candidates = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            if (!location.isTileFishable(x, y)) continue;
            if (ExecutionManager.SelectToolApproachTile((x, y), actor, isStandable, isReachable) is null) continue;
            candidates.Add((x, y));
        }
        return candidates
            .OrderBy(tile => ExecutionManager.ChebyshevDistance(player, tile.X, tile.Y))
            .ThenBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .Take(ExecutionManager.MaximumWaterTargets)
            .Select(tile => new BridgeWaterTarget(ExecutionManager.BuildWaterTargetId(location, tile.X, tile.Y), tile.X, tile.Y))
            .ToArray();
    }

    internal static IReadOnlyList<BridgeFixedInteractionPoint> DiscoverFixedInteractionPoints(Farmer player, out int omitted)
    {
        omitted = 0;
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeFixedInteractionPoint>();
        if (location.map.Layers.Count == 0) return Array.Empty<BridgeFixedInteractionPoint>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<BridgeFixedInteractionPoint> result = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            if (!ExecutionManager.TryDescribeFixedInteractionPoint(location, x, y, out string kind, out string? actionWord)) continue;
            if (result.Count < ExecutionManager.MaximumFixedInteractionPoints) result.Add(new BridgeFixedInteractionPoint(x, y, kind, actionWord));
            else omitted++;
        }

        return result;
    }

    internal static IReadOnlyList<BridgeWarpItemTarget> DiscoverWarpItemTargets(Farmer player)
    {
        List<BridgeWarpItemTarget> result = new();
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object candidate)
                continue;
            if (!ExecutionManager.TryGetWarpTotemDestination(candidate.QualifiedItemId, out string destination, out int destinationX, out int destinationY))
                continue;
            result.Add(new BridgeWarpItemTarget(
                slot,
                candidate.QualifiedItemId,
                candidate.DisplayName,
                candidate.Stack,
                destination,
                destinationX,
                destinationY));
            if (result.Count >= 16)
                break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgePanSiteTarget> DiscoverPanSites(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgePanSiteTarget>();
        BridgePanSiteTarget? site = ExecutionManager.ReadLivePanSite(location);
        if (site is null)
            return Array.Empty<BridgePanSiteTarget>();
        if (!ExecutionManager.IsTileWithinChebyshevRadius(player, site.X, site.Y, ExecutionManager.PanNativeReachTiles))
            return Array.Empty<BridgePanSiteTarget>();
        return new[] { site };
    }

    internal static IReadOnlyList<BridgeMailboxTarget> DiscoverMailboxTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgeMailboxTarget>();
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return Array.Empty<BridgeMailboxTarget>();

        int pending = Game1.mailbox.Count;
        string? head = pending > 0 ? Game1.mailbox[0] : null;
        List<BridgeMailboxTarget> result = new();
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (!ExecutionManager.IsMailboxTile(location, x, y))
                    continue;
                result.Add(new BridgeMailboxTarget(
                    ExecutionManager.BuildMailboxTargetId(location, x, y, pending, head),
                    location.NameOrUniqueName,
                    x,
                    y,
                    pending));
                if (result.Count >= 4)
                    return result;
            }
        }
        return result;
    }

    internal static IReadOnlyList<BridgeMinecartTarget> DiscoverMinecartTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || location.map is null)
            return Array.Empty<BridgeMinecartTarget>();

        IReadOnlyDictionary<string, MinecartNetworkData>? networks = ExecutionManager.TryLoadMinecartNetworks();
        if (networks is null)
            return Array.Empty<BridgeMinecartTarget>();

        List<BridgeMinecartTarget> result = new();
        foreach ((int x, int y, string networkId) in DiscoverMinecartStations(player, location))
        {
            if (!networks.TryGetValue(networkId, out MinecartNetworkData? network) || network.Destinations is null)
                continue;
            if (!ExecutionManager.IsMinecartNetworkUnlocked(network, location))
                continue;

            foreach (MinecartDestinationData destination in network.Destinations)
            {
                if (destination is null || !ExecutionManager.IsMinecartDestinationAvailable(destination, location))
                    continue;
                result.Add(ExecutionManager.BuildMinecartTarget(networkId, destination, x, y));
                if (result.Count >= 24) return result;
            }
        }
        return result;
    }

    internal static IEnumerable<(int X, int Y, string NetworkId)> DiscoverMinecartStations(
        Farmer player, StardewValley.GameLocation location)
    {
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        int minX = Math.Max(0, player.TilePoint.X - ExecutionManager.MinecartTargetDiscoveryRadius);
        int maxX = Math.Min(width - 1, player.TilePoint.X + ExecutionManager.MinecartTargetDiscoveryRadius);
        int minY = Math.Max(0, player.TilePoint.Y - ExecutionManager.MinecartTargetDiscoveryRadius);
        int maxY = Math.Min(height - 1, player.TilePoint.Y + ExecutionManager.MinecartTargetDiscoveryRadius);
        for (int x = minX; x <= maxX; x++)
        {
            for (int y = minY; y <= maxY; y++)
            {
                string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
                if (action is null || !action.StartsWith("MinecartTransport", StringComparison.Ordinal))
                    continue;
                string[] parts = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                string networkId = parts.Length > 1 && !string.IsNullOrWhiteSpace(parts[1]) ? parts[1] : "Default";
                yield return (x, y, networkId);
            }
        }
    }

    internal static IReadOnlyList<BridgeMineElevatorFloorTarget> DiscoverMineElevatorFloors()
    {
        Farmer? player = Game1.player;
        if (player is null || !ExecutionManager.TryFindMineElevatorTile(player.currentLocation, out _, out _))
            return Array.Empty<BridgeMineElevatorFloorTarget>();
        if (player.currentLocation is not MineShaft shaft || shaft.mineLevel > ExecutionManager.HighestElevatorMineLevel)
            return Array.Empty<BridgeMineElevatorFloorTarget>();

        int lowest = MineShaft.lowestLevelReached;
        int current = shaft.mineLevel;
        List<BridgeMineElevatorFloorTarget> targets = new();
        foreach (int floor in ExecutionManager.SelectableMineFloors(lowest))
        {
            targets.Add(new BridgeMineElevatorFloorTarget(
                ExecutionManager.MineElevatorFloorTargetId(floor),
                floor,
                IsCurrentFloor: floor == current,
                IsMineEntrance: floor == 0));
        }
        return targets;
    }

    internal static IReadOnlyList<BridgeDoor> DiscoverExitTiles(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();

        List<BridgeDoor> exits = new();
        HashSet<(int X, int Y)> named = new();
        foreach (BridgeDoor door in DiscoverDoorTargets(player))
        {
            if (named.Add((door.SourceX, door.SourceY)))
                exits.Add(door);
        }

        foreach (StardewValley.Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName))
                continue;
            if (!FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                continue;
            if (named.Add((warp.X, warp.Y)))
                exits.Add(new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY));
        }

        return exits;
    }

    internal static IReadOnlyList<BridgeMuseumRewardTarget> DiscoverMuseumRewardTargets(Farmer player)
    {
        if (Game1.getLocationFromName(ExecutionManager.MuseumLocationName) is not LibraryMuseum museum)
            return Array.Empty<BridgeMuseumRewardTarget>();
        List<(string RewardKey, Item Item)> collectable = ExecutionManager.ReadCollectableMuseumRewards(museum, player);
        if (collectable.Count == 0)
            return Array.Empty<BridgeMuseumRewardTarget>();
        return new[]
        {
            new BridgeMuseumRewardTarget(
                ExecutionManager.BuildMuseumRewardTargetId(museum.NameOrUniqueName, collectable.Select(entry => entry.RewardKey).ToArray()),
                museum.NameOrUniqueName,
                collectable.Count),
        };
    }

    internal static IReadOnlyList<BridgeObeliskTarget> DiscoverObeliskTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        if (player is null || player.currentLocation is not StardewValley.GameLocation location)
            return Array.Empty<BridgeObeliskTarget>();

        List<BridgeObeliskTarget> targets = new();

        foreach (Building building in location.buildings)
        {
            if (building is null)
                continue;
            // An obelisk under construction cannot be used: `Building.doAction` answers it with the `UnderConstruction`
            // dialogue and performs nothing else (Building.cs:937-940).
            if (building.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("obeliskTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            if (!ExecutionManager.TryGetObeliskWarp(building.buildingType.Value, out string destination, out _, out _, out bool forceDismount))
                continue;
            targets.Add(new BridgeObeliskTarget(
                ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskBuildingRoute, location.NameOrUniqueName, building.buildingType.Value, building.tileX.Value, building.tileY.Value),
                ExecutionManager.ObeliskBuildingRoute,
                location.NameOrUniqueName,
                building.tileX.Value,
                building.tileY.Value,
                building.buildingType.Value,
                destination,
                forceDismount));
        }

        // Route B: IslandWest's own "FarmObelisk" tile. The tile exists only after
        // the Island_W_Obelisk override is applied (IslandWest.cs:425-440), so an
        // island without the upgrade advertises nothing here.
        if (location is StardewValley.Locations.IslandWest islandWest && islandWest.farmObelisk.Value)
        {
            xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
            if (buildings is not null)
            {
                int minX = Math.Max(0, player.TilePoint.X - ExecutionManager.ObeliskTargetDiscoveryRadius);
                int maxX = Math.Min(buildings.LayerWidth - 1, player.TilePoint.X + ExecutionManager.ObeliskTargetDiscoveryRadius);
                int minY = Math.Max(0, player.TilePoint.Y - ExecutionManager.ObeliskTargetDiscoveryRadius);
                int maxY = Math.Min(buildings.LayerHeight - 1, player.TilePoint.Y + ExecutionManager.ObeliskTargetDiscoveryRadius);
                for (int x = minX; x <= maxX; x++)
                {
                    for (int y = minY; y <= maxY; y++)
                    {
                        string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
                        if (action is null || !ExecutionManager.IsFarmObeliskAction(action))
                            continue;
                        targets.Add(new BridgeObeliskTarget(
                            ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskIslandFarmTileRoute, location.NameOrUniqueName, ExecutionManager.IslandFarmObeliskAction, x, y),
                            ExecutionManager.ObeliskIslandFarmTileRoute,
                            location.NameOrUniqueName,
                            x,
                            y,
                            ExecutionManager.IslandFarmObeliskDisplayName,
                            ExecutionManager.IslandFarmObeliskDestination,
                            false));
                    }
                }
            }
        }

        return targets.Take(ExecutionManager.MaximumPublishedObeliskTargets).ToArray();
    }

    internal static IReadOnlyList<BridgePedestalTarget> DiscoverPedestalTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePedestalTarget>();
        List<BridgePedestalTarget> result = new();
        foreach ((Vector2 tile, StardewValley.Object placed) in location.objects.Pairs)
        {
            if (placed is not StardewValley.Objects.ItemPedestal pedestal || pedestal.heldObject.Value is not StardewValley.Object held
                || (int)tile.X < 0 || (int)tile.X > 1000 || (int)tile.Y < 0 || (int)tile.Y > 1000
                || !ExecutionManager.IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgePedestalTarget(ExecutionManager.BuildPedestalTargetId(location, (int)tile.X, (int)tile.Y, pedestal, held),
                location.NameOrUniqueName, (int)tile.X, (int)tile.Y, held.QualifiedItemId, held.Stack));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeFenceGateTarget> DiscoverFenceGateTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFenceGateTarget>();
        List<BridgeFenceGateTarget> result = new();
        foreach ((Vector2 tile, StardewValley.Object placed) in location.objects.Pairs)
        {
            if (placed is not StardewValley.Fence fence || !fence.isGate.Value || fence.getDrawSum() == 0 || (fence.gatePosition.Value != 0 && fence.gatePosition.Value != 88)
                || (int)tile.X < 0 || (int)tile.X > 1000 || (int)tile.Y < 0 || (int)tile.Y > 1000
                || !ExecutionManager.IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFenceGateTarget(ExecutionManager.BuildFenceGateTargetId(location, (int)tile.X, (int)tile.Y, fence), location.NameOrUniqueName,
                (int)tile.X, (int)tile.Y, fence.gatePosition.Value == 88));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeFishPondTarget> DiscoverFishPondTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFishPondTarget>();
        List<BridgeFishPondTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null) continue;
            // A pond under construction is not a pond the engine will open: `Building.doAction` answers it with the
            // `UnderConstruction` dialogue and performs nothing else (Building.cs:937-940).
            if (building.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("fishPondTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            if (!ExecutionManager.TryDescribeFishPond(building, out bool hasFish, out int occupants) || !hasFish) continue;
            Point door = building.getPointForHumanDoor();
            if (!ExecutionManager.IsTileWithinChebyshevRadius(player, door.X, door.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFishPondTarget(
                ExecutionManager.BuildFishPondTargetId(location, building),
                location.NameOrUniqueName,
                door.X,
                door.Y,
                building.buildingType.Value,
                occupants,
                ((FishPond)building).fishType.Value ?? string.Empty));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeDailyQuestTarget> DiscoverDailyQuestTargets()
    {
        if (!Game1.CanAcceptDailyQuest() || Game1.questOfTheDay is not Quest quest)
            return Array.Empty<BridgeDailyQuestTarget>();
        return new[]
        {
            new BridgeDailyQuestTarget(ExecutionManager.BuildDailyQuestTargetId(quest), quest.questType.Value, quest.questTitle),
        };
    }

    internal static IReadOnlyList<BridgeShippingBinTarget> DiscoverShippingBinTargets(Farmer player)
    {
        if (player.currentLocation is not (Farm or StardewValley.Locations.IslandWest)) return Array.Empty<BridgeShippingBinTarget>();
        if (ExecutionManager.ResolveShippingBin(player) is not ExecutionManager.ResolvedShippingBin bin) return Array.Empty<BridgeShippingBinTarget>();
        int slot = -1;
        for (int candidate = 0; candidate < player.Items.Count; candidate++)
        {
            if (player.Items[candidate] is StardewValley.Object item && item.Stack > 0 && item.canBeShipped())
            {
                slot = candidate;
                break;
            }
        }
        if (slot < 0) return Array.Empty<BridgeShippingBinTarget>();
        StardewValley.Object shippable = (StardewValley.Object)player.Items[slot]!;
        return new[]
        {
            new BridgeShippingBinTarget(
                bin.TargetId,
                bin.TileX,
                bin.TileY,
                slot,
                shippable.QualifiedItemId,
                ExecutionManager.RequireDisplayName(shippable.QualifiedItemId),
                shippable.Stack),
        };
    }

    internal static IReadOnlyList<BridgeShopTarget> DiscoverShopTargets(Farmer player, DiscoveryExclusionRecorder? exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgeShopTarget>();

        List<BridgeShopTarget> targets = new();
        foreach (ExecutionManager.DiscoveredShopCounter counter in ExecutionManager.EnumerateShopCounters(location))
        {
            if (!counter.OpensNow)
            {
                if (exclusions is not null)
                    exclusions.Record("shopTargets", DiscoveryExclusionReasons.ShopClosedToday);
                continue;
            }
            targets.Add(ExecutionManager.PublishShopCounter(counter, location, player));
        }

        return targets.Take(ExecutionManager.MaxShopTargets).ToArray();
    }

    internal static List<ExecutionManager.DiscoveredShopCounter> DiscoverVendorStallTargets(GameLocation location, out bool roomDeclaresStalls)
    {
        roomDeclaresStalls = false;
        List<ExecutionManager.DiscoveredShopCounter> counters = new();
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return counters;

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            return counters;
        }

        bool festivalOpen = Utility.IsPassiveFestivalOpen("DesertFestival");
        for (int y = 0; y < buildings.LayerHeight && counters.Count < ExecutionManager.MaxTileShopTargets; y++)
        {
            for (int x = 0; x < buildings.LayerWidth && counters.Count < ExecutionManager.MaxTileShopTargets; x++)
            {
                var tile = buildings.Tiles[x, y];
                if (tile is null || !tile.Properties.TryGetValue("Action", out var actionValue))
                    continue;
                if (!string.Equals(
                        ArgUtility.SplitBySpace(actionValue.ToString()).FirstOrDefault(),
                        ExecutionManager.DesertVendorAction,
                        StringComparison.Ordinal))
                    continue;
                roomDeclaresStalls = true;
                // The engine's own occupant rule: the vendor is the character on the tile ABOVE the stall's action tile
                // (`new Rectangle(tile_location.X, tile_location.Y - 1, 1, 1)`, DesertFestival.cs:748-751).
                NPC? vendor = location.characters.FirstOrDefault(
                    character => character is not null && character.TilePoint.X == x && character.TilePoint.Y == y - 1);
                if (vendor is null)
                    continue;
                string shopId = ExecutionManager.DesertVendorShopPrefix + vendor.Name;
                if (!shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null)
                    continue;
                ShopOwnerData? resolvedOwner = ExecutionManager.ResolveCurrentShopOwner(shopData, vendor.Name);
                counters.Add(new ExecutionManager.DiscoveredShopCounter(
                    ExecutionManager.ShopTargetId(shopId, vendor.Name, x, y),
                    shopId,
                    shopData,
                    vendor.Name,
                    x,
                    y,
                    festivalOpen && ExecutionManager.OpensNow(resolvedOwner),
                    festivalOpen ? resolvedOwner?.ClosedMessage : null,
                    resolvedOwner));
            }
        }

        return counters;
    }

    internal static IEnumerable<ExecutionManager.DiscoveredShopCounter> DiscoverTileShopTargets(GameLocation location)
    {
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            yield break;

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            yield break;
        }

        HashSet<string> seen = new(StringComparer.Ordinal);
        int found = 0;
        for (int y = 0; y < buildings.LayerHeight && found < ExecutionManager.MaxTileShopTargets; y++)
        {
            for (int x = 0; x < buildings.LayerWidth && found < ExecutionManager.MaxTileShopTargets; x++)
            {
                var tile = buildings.Tiles[x, y];
                if (tile is null || !tile.Properties.TryGetValue("Action", out var actionValue))
                    continue;
                string action = actionValue.ToString();
                if (!ExecutionManager.TryResolveTileShop(action, out string shopId)
                    || !shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null
                    || !seen.Add(shopId))
                    continue;

                found++;
                yield return new ExecutionManager.DiscoveredShopCounter(
                    ExecutionManager.ShopTargetId(shopId, string.Empty, x, y),
                    shopId,
                    shopData,
                    string.Empty,
                    x,
                    y,
                    OpensNow: true,
                    ClosedMessage: null,
                    Owner: null);
            }
        }
    }

    internal static IReadOnlyList<BridgeSpecialOrderTarget> DiscoverSpecialOrderTargets()
    {
        FarmerTeam team = Game1.player.team;
        List<BridgeSpecialOrderTarget> result = new();
        foreach (SpecialOrder order in team.availableSpecialOrders)
        {
            string orderType = order.orderType.Value;
            if (team.acceptedSpecialOrderTypes.Contains(orderType))
                continue;
            if (team.specialOrders.Any(candidate => string.Equals(candidate.questKey.Value, order.questKey.Value, StringComparison.Ordinal)))
                continue;
            if (SpecialOrder.GetSpecialOrder(order.questKey.Value, order.generationSeed.Value) is null)
                continue;
            result.Add(new BridgeSpecialOrderTarget(
                ExecutionManager.BuildSpecialOrderTargetId(order),
                order.questKey.Value,
                order.orderType.Value,
                order.generationSeed.Value));
            if (result.Count >= 4)
                break;
        }
        return result;
    }

    internal static IReadOnlyList<string> DiscoverActiveSpecialOrderKeys()
    {
        List<string> keys = new();
        foreach (SpecialOrder order in Game1.player.team.specialOrders)
        {
            keys.Add(order.questKey.Value);
            if (keys.Count >= 8)
                break;
        }
        return keys;
    }

    internal const int RadiusWindowRowBudget = 16;

    internal const int FertilizerRowBudget = 64;

    internal static bool IsTargetTileAddressable(GameLocation? location, int x, int y)
    {
        if (location is null || !location.isTileOnMap(x, y)) return false;
        foreach ((int neighbourX, int neighbourY) in CardinalNeighbours(x, y))
        {
            if (!location.isTileOnMap(neighbourX, neighbourY)) continue;
            if (location.isTilePassable(new Vector2(neighbourX, neighbourY))) return true;
        }

        return false;
    }

    internal static (int X, int Y)[] CardinalNeighbours(int x, int y) => new[]
    {
        (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1),
    };

    internal static bool IsPublishedTargetTileInRadius(Farmer player, int x, int y, int radius) =>
        ExecutionManager.IsTileWithinChebyshevRadius(player, x, y, radius) && IsTargetTileAddressable(player.currentLocation, x, y);

    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player) =>
        player.currentLocation is { } location ? DiscoverDoorTargets(location, player) : Array.Empty<BridgeDoor>();

    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(StardewValley.GameLocation location, Farmer actor)
    {
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            if (ExecutionManager.DescribeDoor(location, point.X, point.Y, location.getWarpFromDoor(point, actor)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            if (ExecutionManager.DescribeDoor(location, point.X, point.Y, ExecutionManager.ResolveDoorWarp(location, point)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        foreach (StardewValley.Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName)) continue;
            if (!FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                continue;
            if (ExecutionManager.DescribeDoor(location, warp.X, warp.Y, warp) is { } exit)
                result.TryAdd((exit.SourceX, exit.SourceY), exit);
        }

        return result.Values.Take(64).ToArray();
    }

    internal static IReadOnlyList<BridgeNpcRelationshipTarget> DiscoverNpcRelationshipTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeNpcRelationshipTarget>();
        List<string> questTargets = QuestTargetNpcNames(player);
        List<string> orderRequesters = LiveSpecialOrderRequesters(player);
        return location.characters
            .OfType<StardewValley.NPC>()
            .Where(npc => npc.IsVillager
                && !string.IsNullOrWhiteSpace(npc.Name)
                && IsPublishedTargetTileInRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, ExecutionManager.TargetDiscoveryRadius))
            .Take(64)
            .Select(npc =>
            {
                Friendship friendship = player.friendshipData.TryGetValue(npc.Name, out Friendship? record)
                    ? record
                    : new Friendship();
                return new BridgeNpcRelationshipTarget(
                    ExecutionManager.BuildNpcRelationshipTargetId(location, npc.Name),
                    (int)npc.Tile.X,
                    (int)npc.Tile.Y,
                    npc.Name,
                    friendship.Points,
                    friendship.Status.ToString(),
                    friendship.TalkedToToday,
                    friendship.GiftsToday,
                    friendship.GiftsThisWeek,
                    DescribeNpcMarker(npc, questTargets, orderRequesters));
            })
            .ToArray();
    }

    internal static string DescribeNpcMarker(StardewValley.NPC npc, IReadOnlyList<string> questTargets, IReadOnlyList<string> specialOrderRequesters)
    {
        string name = npc.Name;
        if (questTargets.Any(target => string.Equals(target, name, StringComparison.Ordinal)))
            return ExecutionManager.NpcMarkerQuest;
        if (specialOrderRequesters.Any(requester => string.Equals(requester, name, StringComparison.Ordinal)))
            return ExecutionManager.NpcMarkerSpecialOrder;
        if (npc.hasTemporaryMessageAvailable() || npc.TemporaryDialogue is { Count: > 0 })
            return ExecutionManager.NpcMarkerDialogue;
        return ExecutionManager.NpcMarkerNone;
    }

    internal static List<string> QuestTargetNpcNames(Farmer player)
    {
        List<string> names = new();
        foreach (Quest quest in player.questLog)
        {
            if (quest.completed.Value) continue;
            string? target = quest switch
            {
                ItemDeliveryQuest delivery => delivery.target.Value,
                ResourceCollectionQuest collection => collection.target.Value,
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(target) && !names.Contains(target, StringComparer.Ordinal))
                names.Add(target);
        }
        return names;
    }

    internal static List<string> LiveSpecialOrderRequesters(Farmer player)
    {
        List<string> names = new();
        foreach (SpecialOrder order in player.team.specialOrders)
        {
            string requester = order.requester.Value;
            if (!string.IsNullOrWhiteSpace(requester) && !names.Contains(requester, StringComparer.Ordinal))
                names.Add(requester);
        }
        return names;
    }

    internal static IReadOnlyList<BridgeVillagerWhereabouts> DiscoverVillagerWhereabouts()
    {
        List<BridgeVillagerWhereabouts> result = new();
        Utility.ForEachVillager(villager =>
        {
            if (result.Count >= 64)
                return false;
            StardewValley.GameLocation? location = villager.currentLocation;
            if (location is null || string.IsNullOrWhiteSpace(villager.Name))
                return true;
            result.Add(new BridgeVillagerWhereabouts(
                ExecutionManager.BuildNpcRelationshipTargetId(location, villager.Name),
                villager.Name,
                string.IsNullOrWhiteSpace(villager.displayName) ? villager.Name : villager.displayName,
                location.NameOrUniqueName,
                (int)villager.Tile.X,
                (int)villager.Tile.Y,
                ReferenceEquals(location, Game1.currentLocation)));
            return true;
        });
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ThenBy(entry => entry.NpcName, StringComparer.Ordinal)
            .ToArray();
    }

    internal static IReadOnlyList<BridgeWateringWhereabouts> DiscoverWateringWhereabouts(DiscoveryExclusionRecorder exclusions)
    {
        List<BridgeWateringWhereabouts> result = new();
        Vector2 playerTile = Game1.player?.Tile ?? Vector2.Zero;
        foreach (GameLocation location in Game1.locations)
        {
            if (result.Count >= 64) break;
            int needsWaterCount = 0;
            Vector2? nearest = null;
            float nearestDistance = float.MaxValue;
            bool sameMap = string.Equals(
                location.NameOrUniqueName,
                Game1.player?.currentLocation?.NameOrUniqueName,
                StringComparison.Ordinal);
            foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || dirt.crop is null)
                    continue;
                if (dirt.crop.dead.Value)
                {
                    exclusions.Record("wateringWhereabouts", DiscoveryExclusionReasons.Dead);
                    continue;
                }
                if (!ExecutionManager.CropNeedsWater(dirt))
                    continue;
                needsWaterCount++;
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            if (needsWaterCount > 0)
            {
                result.Add(new BridgeWateringWhereabouts(
                    location.NameOrUniqueName,
                    needsWaterCount,
                    nearest is null ? null : (int)nearest.Value.X,
                    nearest is null ? null : (int)nearest.Value.Y));
            }
        }
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ToArray();
    }

    internal static IReadOnlyList<BridgeHarvestWhereabouts> DiscoverHarvestWhereabouts(DiscoveryExclusionRecorder exclusions)
    {
        List<BridgeHarvestWhereabouts> result = new();
        foreach (GameLocation location in Game1.locations)
        {
            if (result.Count >= 64) break;
            int readyCount = 0;
            Vector2? nearest = null;
            float nearestDistance = float.MaxValue;
            Vector2 playerTile = Game1.player?.Tile ?? Vector2.Zero;
            bool sameMap = string.Equals(
                location.NameOrUniqueName,
                Game1.player?.currentLocation?.NameOrUniqueName,
                StringComparison.Ordinal);
            foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || dirt.crop is null
                    || dirt.crop.forageCrop.Value)
                    continue;
                if (!dirt.readyForHarvest())
                {
                    exclusions.Record("harvestWhereabouts", DiscoveryExclusionReasons.NotReady);
                    continue;
                }
                if (dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
                {
                    exclusions.Record("harvestWhereabouts", DiscoveryExclusionReasons.WrongHarvestMethod);
                    continue;
                }
                readyCount++;
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            if (readyCount > 0)
            {
                result.Add(new BridgeHarvestWhereabouts(
                    location.NameOrUniqueName,
                    readyCount,
                    nearest is null ? null : (int)nearest.Value.X,
                    nearest is null ? null : (int)nearest.Value.Y));
            }
        }
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ToArray();
    }

    internal static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        List<BridgePetTarget> result = new();
        foreach (Pet pet in location.characters.OfType<Pet>()
            .Where(pet => IsPublishedTargetTileInRadius(player, (int)pet.Tile.X, (int)pet.Tile.Y, ExecutionManager.TargetDiscoveryRadius))
            .Take(16))
        {
            BridgePetTarget target = new(
                ExecutionManager.BuildPetTargetId(location, (int)pet.Tile.X, (int)pet.Tile.Y, pet),
                (int)pet.Tile.X,
                (int)pet.Tile.Y,
                pet.petType.Value,
                pet.friendshipTowardFarmer.Value,
                pet.lastPetDay.TryGetValue(player.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays,
                Stationary: !(pet.GetCurrentPetBehavior()?.WalkInDirection ?? false));
            // The row states the day fact either way; the reason states why it is not a target. A pet petted today is
            // excluded rather than published-and-refused because there is nothing left to do with it - the second pet
            // opens `AnimalQueryMenu` instead (Pet.cs:641-643) - but an empty list must not be the only evidence.
            if (target.PettedToday)
            {
                exclusions.Record("petTargets", DiscoveryExclusionReasons.PettedToday);
                continue;
            }
            result.Add(target);
        }
        return result;
    }

    internal static IReadOnlyList<BridgeFarmAnimalPetTarget> DiscoverFarmAnimalPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFarmAnimalPetTarget>();
        List<BridgeFarmAnimalPetTarget> result = new();
        foreach (FarmAnimal animal in location.animals.Values
            .Where(animal => IsPublishedTargetTileInRadius(player, (int)animal.Tile.X, (int)animal.Tile.Y, ExecutionManager.TargetDiscoveryRadius))
            .OrderBy(animal => ExecutionManager.ChebyshevDistance(player, (int)animal.Tile.X, (int)animal.Tile.Y))
            .ThenBy(animal => animal.Tile.X)
            .ThenBy(animal => animal.Tile.Y))
        {
            if (result.Count >= 16) break;
            // The day marker the engine itself sets on the first manual pet and clears overnight (FarmAnimal.cs:745-749,
            // :976). Filtered rather than published-and-refused - there is nothing left to do with it - and now
            // RECORDED, so the empty list says "already petted" instead of "no animals here".
            if (animal.wasPet.Value)
            {
                exclusions.Record("farmAnimalPetTargets", DiscoveryExclusionReasons.PettedToday);
                continue;
            }
            result.Add(new BridgeFarmAnimalPetTarget(
                ExecutionManager.BuildFarmAnimalPetTargetId(location, animal),
                (int)animal.Tile.X,
                (int)animal.Tile.Y,
                animal.type.Value,
                animal.friendshipTowardFarmer.Value));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeMachineTarget> DiscoverMachineTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeMachineTarget>();
        return location.objects.Pairs
            .Where(pair => pair.Value.GetMachineData() is not null
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.Object machine = pair.Value;
                string? held = machine.heldObject.Value?.QualifiedItemId;
                string? input = machine.lastInputItem.Value?.QualifiedItemId;
                BridgeMachineTarget target = new(
                    ExecutionManager.BuildMachineTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, machine.QualifiedItemId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    machine.QualifiedItemId,
                    ExecutionManager.RequireDisplayName(machine.QualifiedItemId),
                    machine.readyForHarvest.Value,
                    machine.MinutesUntilReady,
                    held,
                    input,
                    null,
                    null,
                    null,
                    // Ready means the machine's OWN lifecycle finished: `readyForHarvest` is set exactly when the window
                    // reaches zero (Object.cs:2581-2585), so a ready machine that holds something is collectable whatever
                    // it is - the state, not a Keg id, is what the collect action needs.
                    machine.readyForHarvest.Value && machine.MinutesUntilReady == 0 && machine.heldObject.Value is not null,
                    machine.GetMachineData() is not null,
                    Accepts: ExecutionManager.ReadMachineInputAcceptance(machine));
                if (machine.heldObject.Value is null && !machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0 && ExecutionManager.IsMachineInteractionObject(machine))
                {
                    for (int slot = 0; slot < player.Items.Count; slot++)
                    {
                        // The row publishes the input the ACTION will accept: the machine's own admission decides whether
                        // it takes this stack (Object.performObjectDropInAction, probe: true - the call GameLocation.checkAction
                        // makes at GameLocation.cs:7768-7772), and the machine's own rows decide how many it consumes. Discovery
                        // and the action therefore publish and enforce the same fact instead of two guesses at it.
                        if (player.Items[slot] is not StardewValley.Object carried
                            || !machine.performObjectDropInAction(carried, probe: true, player)
                            || !ExecutionManager.TryReadMachineLoadRequirement(machine, carried, player, location, out ExecutionManager.MachineLoadRequirement requirement))
                            continue;
                        target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = carried.QualifiedItemId, LoadInputStack = requirement.ConsumedCount };
                        break;
                    }
                }
                return target;
            })
            .ToArray();
    }

    internal static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopSourceTarget>();

        List<BridgeTreeChopSourceTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in ExecutionManager.NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
            string? exclusion = ExecutionManager.TreeChopSourceExclusion(tree);
            if (exclusion is not null)
            {
                exclusions.Record("treeChopSourceTargets", exclusion);
                continue;
            }
            int x = (int)pair.Key.X;
            int y = (int)pair.Key.Y;
            result.Add(new BridgeTreeChopSourceTarget(
                ExecutionManager.BuildTreeChopSourceTargetId(location, x, y, tree),
                location.NameOrUniqueName,
                x,
                y,
                tree.treeType.Value,
                tree.growthStage.Value,
                tree.health.Value,
                tree.stump.Value,
                tree.hasMoss.Value,
                tree.tapped.Value));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeTreeChopResultTarget> DiscoverTreeChopResultTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopResultTarget>();

        return location.terrainFeatures.Pairs
            // `health == 5f` IS THE READBACK of this action's own swing: `performTreeFall` sets `stump.Value = true;
            // health.Value = 5f;` on the hit that fells the tree (Tree.cs:1495-1496). Neither `hasMoss` nor `tapped`
            // is a second state to filter on: the same call clears the tap (`tapped.Value = false`, Tree.cs:1488) and
            // moss only ever grows on a standing tree (`growthStage >= 14 && !stump.Value`, Tree.cs:991) and is cleared
            // for a stump every day (Tree.cs:985-988) - a tapper cannot even be placed on one (Object.cs:6568). A felled
            // subject is therefore never mossy or tapped, so a predicate for either would withhold nothing.
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value && tree.growthStage.Value >= StardewValley.TerrainFeatures.Tree.treeStage
                && tree.health.Value == 5f
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeChopResultTarget(
                    ExecutionManager.BuildTreeChopResultTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value,
                    tree.health.Value, tree.stump.Value, tree.hasMoss.Value, tree.tapped.Value);
            })
            .ToArray();
    }

    internal static IReadOnlyList<BridgeTreeStumpTarget> DiscoverTreeStumpTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeStumpTarget>();

        return ExecutionManager.NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player)
            .Take(16)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeStumpTarget(ExecutionManager.BuildTreeStumpTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value, tree.health.Value);
            })
            .ToArray();
    }

    internal static IReadOnlyList<BridgeTreeSaplingTarget> DiscoverTreeSaplingTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeTreeSaplingTarget>();
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => StardewValley.Object.isWildTreeSeed(item.ItemId) && item.Stack >= 1);
        int rowLimit = TargetRowBudget.PerKeyRowLimit(heldStacks, TargetRowBudget.PlanNodes);
        List<BridgeTreeSaplingTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object sapling || !StardewValley.Object.isWildTreeSeed(sapling.ItemId) || sapling.Stack < 1)
                continue;
            int stackRows = TargetRowBudget.RowsOneKeyCanSpend(rowLimit, sapling.Stack);
            if (stackRows < 1)
                continue;
            List<BridgeTreeSaplingTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius); x <= player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius); y <= player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsPublishedTargetTileInRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius) || !ExecutionManager.CanPlantWildTreeSeedAt(location, sapling.QualifiedItemId, x, y))
                        continue;
                    rowsForThisStack.Add(new BridgeTreeSaplingTarget(ExecutionManager.BuildTreeSaplingTargetId(location, x, y, sapling.QualifiedItemId), slot, x, y, sapling.QualifiedItemId, ExecutionManager.RequireDisplayName(sapling.QualifiedItemId)));
                }
            }
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(stackRows));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeWeedTarget> DiscoverWeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWeedTarget>();
        return ExecutionManager.NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null
                && pair.Value.IsWeeds()
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player)
            .Take(16)
            .Select(pair => new BridgeWeedTarget(
                ExecutionManager.BuildWeedTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.MinutesUntilReady, pair.Value.IsWeeds()))
            .ToArray();
    }

    internal static IReadOnlyList<BridgeCaskTarget> DiscoverCaskTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCaskTarget>();
        List<BridgeCaskTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is not StardewValley.Objects.Cask cask
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCaskTarget(ExecutionManager.BuildCaskTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, cask), location.NameOrUniqueName,
                (int)pair.Key.X, (int)pair.Key.Y, cask.heldObject.Value is not null, cask.heldObject.Value?.QualifiedItemId));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeMannequinTarget> DiscoverMannequinTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Mannequin && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)).Take(16)
            .Select(pair => new BridgeMannequinTarget(ExecutionManager.BuildMannequinTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y)).ToArray() ?? Array.Empty<BridgeMannequinTarget>();
    }

    internal static IReadOnlyList<BridgeSignTarget> DiscoverSignTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Sign && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)).Take(16)
            .Select(pair => { StardewValley.Objects.Sign sign = (StardewValley.Objects.Sign)pair.Value; return new BridgeSignTarget(ExecutionManager.BuildSignTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, sign), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, sign.displayItem.Value is not null, sign.displayItem.Value?.QualifiedItemId); }).ToArray() ?? Array.Empty<BridgeSignTarget>();
    }

    internal static IReadOnlyList<BridgeSiloTarget> DiscoverSiloTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSiloTarget>();
        List<BridgeSiloTarget> result = new();
        foreach (StardewValley.Buildings.Building building in location.buildings.Where(building => building.buildingType.Value == "Silo").Take(16))
        {
            Vector2 tile = new(building.tileX.Value, building.tileY.Value);
            Point door = building.getPointForHumanDoor();
            if (!IsPublishedTargetTileInRadius(player, door.X, door.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSiloTarget(ExecutionManager.BuildSiloTargetId(location, building), location.NameOrUniqueName, door.X, door.Y, location.piecesOfHay.Value));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeLanternSlot> DiscoverLanternSlots(Farmer player) => player.Items.Select((item, slot) => (item, slot)).Where(pair => pair.item is StardewValley.Tools.Lantern).Take(16)
        .Select(pair => { StardewValley.Tools.Lantern lantern = (StardewValley.Tools.Lantern)pair.item!; return new BridgeLanternSlot(pair.slot, lantern.on, lantern.fuelLeft); }).ToArray();

    internal static IReadOnlyList<BridgeGrassTarget> DiscoverGrassTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeGrassTarget>();
        List<BridgeGrassTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.Grass grass
                || grass.numberOfWeeds.Value <= 0
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000
                || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeGrassTarget(
                ExecutionManager.BuildGrassTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, grass),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                grass.grassType.Value, grass.numberOfWeeds.Value));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeScytheCropTarget> DiscoverScytheCropTargets(Farmer player, GroundSurface? surfaces = null)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeScytheCropTarget>();
        // The same observation-scoped reading `soilTiles` and `seedTargets` use: a row about a crop tile is a row about
        // the ground under it, and a second spelling of "is this paved" is the defect `GroundSurface` exists to remove.
        surfaces ??= GroundSurface.Of(location);
        List<BridgeScytheCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is null
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            bool forageCrop = dirt.crop.forageCrop.Value;
            bool readyForHarvest = dirt.readyForHarvest();
            StardewValley.GameData.Crops.HarvestMethod harvestMethod = dirt.crop.GetHarvestMethod();
            bool dead = dirt.crop.dead.Value;
            if (!ExecutionManager.ScytheCropTarget(
                    hasCrop: true,
                    forageCrop: forageCrop,
                    readyForHarvest: readyForHarvest,
                    harvestMethod: harvestMethod,
                    dead: dead,
                    out bool deadCrop))
                continue;
            string? harvestId = dirt.crop.indexOfHarvest.Value;
            string cropSeedId = dirt.crop.netSeedIndex.Value ?? harvestId ?? "unknown";
            // A dead crop's produce can never be harvested (Crop.harvest refuses it), so promising a
            // `qualifiedHarvestItemId` for one would be a fact the action cannot deliver. The wire requires a
            // non-empty string there, and "none" is the same word the receipt uses for the same absence.
            string qualifiedHarvestItemId = deadCrop || harvestId is null
                ? ExecutionManager.DeadCropHarvestItemId
                : StardewValley.ItemRegistry.Create(harvestId, 1).QualifiedItemId;
            GroundSurface.Reading ground = surfaces.At((int)pair.Key.X, (int)pair.Key.Y);
            result.Add(new BridgeScytheCropTarget(
                ExecutionManager.BuildScytheCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                cropSeedId,
                qualifiedHarvestItemId,
                ExecutionManager.RequireDisplayName(cropSeedId),
                readyForHarvest,
                dead,
                forageCrop,
                ExecutionManager.HarvestMethodName(harvestMethod),
                ground.Surface,
                ground.Owner));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeClearHoeDirtTarget> DiscoverClearHoeDirtTargets(Farmer player, GroundSurface? surfaces = null)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeClearHoeDirtTarget>();
        surfaces ??= GroundSurface.Of(location);
        return ExecutionManager.NearestFirst(location.terrainFeatures.Pairs.Where(pair => IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)
            && pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt && dirt.crop is null
            && !(location.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)), player)
            .Take(8).Select(pair =>
            {
                GroundSurface.Reading ground = surfaces.At((int)pair.Key.X, (int)pair.Key.Y);
                return new BridgeClearHoeDirtTarget(ExecutionManager.BuildClearHoeDirtTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, Crop: false, Ground: true, ground.Surface, ground.Owner);
            }).ToArray();
    }

    internal static IReadOnlyList<BridgeArtifactSpotTarget> DiscoverArtifactSpotTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeArtifactSpotTarget>();
        return location.objects.Pairs
            .Where(pair => (int)pair.Key.X is >= 0 and <= 1000 && (int)pair.Key.Y is >= 0 and <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius, player)
                && NativeItemPredicates.IsArtifactSpot(pair.Value)
                && location.isTileOnMap(pair.Key)
                && !location.terrainFeatures.ContainsKey(pair.Key)
                && location.GetHoeDirtAtTile(pair.Key) is null
                && pair.Value is not StardewValley.Objects.IndoorPot
                && new[] { pair.Key + new Vector2(-1f, 0f), pair.Key + new Vector2(1f, 0f), pair.Key + new Vector2(0f, -1f), pair.Key + new Vector2(0f, 1f) }
                    .Any(standing => StardewBodyController.IsStandableTile(location, player, standing)))
            .OrderBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .Take(8)
            .Select(pair => new BridgeArtifactSpotTarget(ExecutionManager.BuildArtifactSpotTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, ExecutionManager.RequireDisplayName(pair.Value.QualifiedItemId)))
            .ToArray();
    }

    internal static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeRockSourceTarget>();
        // ORDER BEFORE THE CAP.
        //
        // `location.objects.Pairs` is a Dictionary's hash buckets, so "the first eight" was eight arbitrary rocks - and
        // the Agent walks them in the order it is given. That is the pendulum the chain-nearest-neighbour work was
        // written for, except that work sits in `synthesizePrograms`, which has NO production caller: the Agent uses
        // `stardew_plan_work` and reads these targets directly. Measured 2026-10-27, an audit of the chain-fixed run
        // found the published order was hash order and the Host-side ordering was never reached.
        //
        // Nearest-first because the list IS the walking order for a caller that consumes it sequentially; X/Y breaks
        // ties so the same world always yields the same list. The cap stays eight - only which eight changes.
        // Nearest first, then cap: `objects.Pairs` is hash-bucket order, so "the first eight" was eight arbitrary
        // rocks and the Agent walked them in that order. `NearestFirst` carries the reason.
        //
        // The predicate is the NATIVE CATEGORY, not "the basic pickaxe finishes it in one swing". It used to be
        // conjoined with `MinutesUntilReady == 1`, so every stone whose durability is above one - which is every mine
        // node (MineShaft.cs:1733-1798, :4351-4460) and half the mountain ore (Farm.cs:540-606) - was invisible to the
        // radar while `break_rock_source` refused it. Each published row carries its real durability in `health`, so the
        // Agent can see how many swings remain; the action itself decides what one landing swing is worth.
        return ExecutionManager.NearestFirst(location.objects.Pairs
            .Where(pair => IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius) && NativeItemPredicates.IsBreakableStone(pair.Value)), player)
            .Take(8).Select(pair => new BridgeRockSourceTarget(ExecutionManager.BuildRockSourceTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, ExecutionManager.RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.MinutesUntilReady)).ToArray();
    }

    internal static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(Farmer player, DiscoveryExclusionRecorder? exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDebrisTarget>();
        List<BridgeDebrisTarget> result = new();
        for (int index = 0; index < location.resourceClumps.Count && result.Count < 64; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            int x = (int)clump.Tile.X;
            int y = (int)clump.Tile.Y;
            if (!ExecutionManager.IsDebrisTargetWithinPlayerRadius(clump, player)) continue;
            // The native requirement table lives in ONE place now
            // (ExecutionManager.TryGetDebrisToolRequirement, mirroring ResourceClump.performToolAction), so
            // discovery and admission cannot drift apart.
            if (!ExecutionManager.TryGetDebrisToolRequirement(clump, out string toolKind, out int requiredUpgrade))
                continue;
            int usableSlot = -1;
            for (int slot = 0; slot < player.Items.Count; slot++)
            {
                if (player.Items[slot] is Tool candidate && ExecutionManager.IsValidDebrisTool(clump, candidate, out _, out _))
                {
                    usableSlot = slot;
                    break;
                }
            }
            if (usableSlot < 0)
            {
                // The clump is HERE and the swing is refused - `ResourceClump.performToolAction` returns false unless
                // the tool is the matching family at or above this clump's level (ResourceClump.cs:150-234). Dropping
                // the row was a snapshot reporting a cleared farm to a companion standing beside the boulder. The row
                // CANNOT be the target itself: `BridgeDebrisTarget.slot` is the inventory slot to swing with and the
                // Host validates it as a slot, so a clump with no usable tool has no honest value for it. The count is
                // what is publishable: the clump is there and nothing in the pack would swing it.
                if (exclusions is not null)
                    exclusions.Record("debrisTargets", DiscoveryExclusionReasons.ToolInsufficient);
                continue;
            }
            result.Add(new BridgeDebrisTarget(ExecutionManager.BuildDebrisTargetId(location, index, clump), usableSlot, x, y, clump.parentSheetIndex.Value, toolKind, requiredUpgrade, (int)clump.health.Value, Math.Max(1, clump.width.Value), Math.Max(1, clump.height.Value)));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeWateringCanFact> DiscoverWateringCanFacts(Farmer player) => player.Items
        .Select((item, slot) => (item, slot))
        .Where(entry => entry.item is WateringCan)
        .Take(36)
        .Select(entry =>
        {
            WateringCan can = (WateringCan)entry.item!;
            return new BridgeWateringCanFact(entry.slot, can.QualifiedItemId, ExecutionManager.DescribeTool(can) ?? "watering_can", can.WaterLeft, can.waterCanMax);
        })
        .ToArray();

    internal static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeRefillWateringCanTarget>();
        if (location.map.Layers.Count == 0) return Array.Empty<BridgeRefillWateringCanTarget>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<(int X, int Y)> candidates = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
            if (location.CanRefillWateringCanOnTile(x, y)) candidates.Add((x, y));
        return candidates
            .OrderBy(tile => ExecutionManager.ChebyshevDistance(player, tile.X, tile.Y))
            .ThenBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .Take(ExecutionManager.MaximumRefillWateringCanTargets)
            .Select(tile => new BridgeRefillWateringCanTarget(ExecutionManager.BuildRefillWateringCanTargetId(location, tile.X, tile.Y), tile.X, tile.Y))
            .ToArray();
    }

    internal static IReadOnlyList<BridgePetBowlTarget> DiscoverPetBowlTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetBowlTarget>();
        List<BridgePetBowlTarget> result = new();
        foreach (StardewValley.Buildings.PetBowl bowl in location.buildings.OfType<StardewValley.Buildings.PetBowl>())
        {
            if (bowl.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            if (bowl.watered.Value)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            foreach (Vector2 tile in ExecutionManager.PetBowlWaterableTiles(bowl))
            {
                if (!IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
                result.Add(new BridgePetBowlTarget(ExecutionManager.BuildPetBowlTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y));
            }
            if (result.Count >= 8) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeSlimeHutchTroughTarget> DiscoverSlimeHutchTroughTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        if (player.currentLocation is not StardewValley.SlimeHutch hutch)
            return Array.Empty<BridgeSlimeHutchTroughTarget>();
        List<BridgeSlimeHutchTroughTarget> result = new();
        for (int y = ExecutionManager.SlimeHutchTroughFirstRow; y <= ExecutionManager.SlimeHutchTroughLastRow; y++)
        {
            if (!ExecutionManager.IsSlimeHutchTroughTile(ExecutionManager.SlimeHutchTroughColumn, y)) continue;
            if (hutch.waterSpots[y - ExecutionManager.SlimeHutchTroughFirstRow])
            {
                exclusions.Record("slimeHutchTroughTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            if (!IsPublishedTargetTileInRadius(player, ExecutionManager.SlimeHutchTroughColumn, y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSlimeHutchTroughTarget(ExecutionManager.BuildSlimeHutchTroughTargetId(hutch, ExecutionManager.SlimeHutchTroughColumn, y), ExecutionManager.SlimeHutchTroughColumn, y));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeToolSlot> DiscoverToolSlots(IList<Item?> items)
    {
        List<BridgeToolSlot> slots = new();
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool) continue;
            slots.Add(new BridgeToolSlot(
                slot,
                ExecutionManager.DescribeTool(tool) ?? "tool",
                tool.UpgradeLevel >= 0 ? tool.UpgradeLevel : null,
                ExecutionManager.ToolCategory(tool) ?? "unknown"));
        }

        return slots;
    }

    internal static IReadOnlyList<BridgeFeedTroughTarget> DiscoverFeedTroughTargets(Farmer player)
    {
        if (player.currentLocation is not AnimalHouse location) return Array.Empty<BridgeFeedTroughTarget>();
        List<BridgeFeedTroughTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object hay || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius); x <= player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius && result.Count < 32; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius); y <= player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius && result.Count < 32; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsPublishedTargetTileInRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius) || location.doesTileHaveProperty(x, y, "Trough", "Back") is null || location.objects.ContainsKey(tile))
                        continue;
                    result.Add(new BridgeFeedTroughTarget(ExecutionManager.BuildFeedTroughTargetId(location, slot, x, y, hay.Stack), slot, x, y, hay.Stack));
                }
            }
        }
        return result;
    }

    internal static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestState>();
        List<BridgeChestState> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in ExecutionManager.OrderedStorageContainers(player, location))
        {
            IList<StardewValley.Item> inventory = chest.GetItemsForPlayer();
            List<BridgeChestItem> items = new();
            for (int slot = 0; slot < inventory.Count; slot++)
            {
                StardewValley.Item? item = inventory[slot];
                if (item is null || item.Stack <= 0) continue;
                items.Add(new BridgeChestItem(slot, item.QualifiedItemId, ExecutionManager.RequireDisplayName(item.QualifiedItemId), item.Stack));
            }
            result.Add(new BridgeChestState(
                ExecutionManager.BuildContainerTargetId(location, x, y, chest, isFridge),
                x,
                y,
                ExecutionManager.DescribeContainerName(chest),
                isFridge,
                items));
        }
        return result;
    }

    internal static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> DiscoverStorageContainers(
        Farmer player, StardewValley.GameLocation location) =>
        ExecutionManager.LocationStorageContainers(location)
            .Where(container => ExecutionManager.IsStorageContainer(container.Chest) && ExecutionManager.IsChestTargetInRange(player, container.X, container.Y));

    internal IReadOnlyList<BridgeAnimalProductTarget> DiscoverAnimalProductTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeAnimalProductTarget>();
        List<BridgeAnimalProductTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not Tool tool || tool is not MilkPail and not Shears) continue;
            foreach (FarmAnimal animal in location.animals.Values)
            {
                if (result.Count >= 32) return result;
                int x = (int)animal.Tile.X;
                int y = (int)animal.Tile.Y;
                if (!IsPublishedTargetTileInRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius) || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool)) continue;
                StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
                if (!player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack)) continue;
                result.Add(new BridgeAnimalProductTarget(ExecutionManager.BuildAnimalProductTargetId(location, slot, animal, tool), slot, x, y, animal.type.Value, produce.QualifiedItemId, ExecutionManager.RequireDisplayName(produce.QualifiedItemId), tool is MilkPail ? "milk_pail" : "shears", produceStack));
            }
        }
        // Fixture-only diagnostic: a native AnimalHouse may synchronize its
        // occupant positions/produce after Farmhand arrival. Record the exact
        // live predicate facts if discovery still fail-closes; never mutate
        // inventory, animals, or action state here.
        if (result.Count == 0 && location.NameOrUniqueName.StartsWith("Barn", StringComparison.Ordinal))
        {
            string candidates = string.Join(",", location.animals.Values
                .Where(animal => animal.isAdult() && animal.currentProduce.Value is not null)
                .Select(animal =>
                {
                    int x = (int)animal.Tile.X;
                    int y = (int)animal.Tile.Y;
                    StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                    return $"{animal.type.Value}@{x},{y}:produce={produce.QualifiedItemId}:in_range={ExecutionManager.IsAnimalProductTargetInRange(player, x, y)}:shears={animal.CanGetProduceWithTool(new Shears())}:milk={animal.CanGetProduceWithTool(new MilkPail())}:inventory={player.couldInventoryAcceptThisItem(produce.QualifiedItemId, animal.hasEatenAnimalCracker.Value ? 2 : 1)}";
                }));
            this.monitor.Log($"GameBuddy animal-product discovery fail-closed: location={location.NameOrUniqueName}; player={(int)player.Tile.X},{(int)player.Tile.Y}; candidates={candidates}", LogLevel.Trace);
        }
        return result;
    }

    internal static IReadOnlyList<BridgeInventoryItemFact> DiscoverInventoryItemFacts(Farmer player)
    {
        List<BridgeInventoryItemFact> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            if (player.Items[slot] is not Item item || string.IsNullOrWhiteSpace(item.QualifiedItemId))
                continue;
            int stack = item is StardewValley.Object obj ? obj.Stack : 1;
            if (stack < 1) continue;
            result.Add(new BridgeInventoryItemFact(slot, item.QualifiedItemId, ExecutionManager.RequireDisplayName(item.QualifiedItemId), stack));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeFoodTarget> DiscoverFoodTargets(Farmer player)
    {
        List<BridgeFoodTarget> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object food)
                continue;
            bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
            if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
                continue;
            result.Add(new BridgeFoodTarget(slot, food.QualifiedItemId, ExecutionManager.RequireDisplayName(food.QualifiedItemId), food.Stack, food.Edibility, isDrink));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeForageTarget> DiscoverForageTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeForageTarget>();
        return ExecutionManager.NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null && pair.Value.isForage() && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player)
            .Take(64)
            .Select(pair => new BridgeForageTarget(ExecutionManager.BuildForageTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, ExecutionManager.RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.Stack, pair.Value.isForage()))
            .ToArray();
    }

    internal IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(Farmer player)
    {
        const int discoveryRadius = ExecutionManager.TargetDiscoveryRadius;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeItemTarget>();
        List<BridgeItemTarget> result = new();
        Dictionary<string, int> inventoryAtPublicationByItemId = new(StringComparer.Ordinal);
        for (int debrisIndex = 0; debrisIndex < location.debris.Count && result.Count < 64; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = ExecutionManager.GetChunkTile(chunk);
                if (IsPublishedTargetTileInRadius(player, tile.X, tile.Y, discoveryRadius))
                {
                    string targetId = ExecutionManager.BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                    int stack = Math.Max(1, debris.item?.Stack ?? 1);
                    if (!inventoryAtPublicationByItemId.TryGetValue(qualifiedItemId, out int inventoryAtPublication))
                        inventoryAtPublicationByItemId[qualifiedItemId] = inventoryAtPublication = ExecutionManager.CountQualifiedItem(player, qualifiedItemId);
                    this.groundItemTargets.Record(new GroundItemPublication(
                        targetId,
                        location.NameOrUniqueName,
                        tile.X,
                        tile.Y,
                        qualifiedItemId,
                        stack,
                        inventoryAtPublication,
                        this.tick()));
                    result.Add(new BridgeItemTarget(targetId, tile.X, tile.Y, qualifiedItemId, ExecutionManager.RequireDisplayName(qualifiedItemId), stack));
                    if (result.Count >= 64) break;
                }
                chunkIndex++;
            }
        }
        return result;
    }

    internal static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(Farmer player, GroundSurface? surfaces = null)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSeedTarget>();
        // One reading per OBSERVATION: the same instance walks this family and `till_soil`'s, and a caller that passes none
        // is an observation of its own (a test driving one family, a fixture asking about one tile).
        surfaces ??= GroundSurface.Of(location);
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => item.Category == StardewValley.Object.SeedsCategory);
        int rowLimit = TargetRowBudget.PerKeyRowLimit(heldStacks, TargetRowBudget.PlanNodes);
        List<BridgeSeedTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
                continue;
            int stackRows = TargetRowBudget.RowsOneKeyCanSpend(rowLimit, seed.Stack);
            if (stackRows < 1)
                continue;
            List<BridgeSeedTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius); x <= player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius); y <= player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsPublishedTargetTileInRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    bool canPlantThisSeedHere = dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false);
                    if (dirt.crop is not null || !canPlantThisSeedHere)
                        continue;
                    GroundSurface.Reading ground = surfaces.At(x, y);
                    rowsForThisStack.Add(new BridgeSeedTarget(ExecutionManager.BuildSeedTargetId(location, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId, ExecutionManager.RequireDisplayName(seed.QualifiedItemId), canPlantThisSeedHere, dirt.crop is not null, ground.Surface, ground.Owner));
                }
            }
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(stackRows));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeWoodFenceTarget> DiscoverWoodFenceTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeWoodFenceTarget>();
        return NearestFirstRadiusWindowRows<BridgeWoodFenceTarget>(
            player,
            source => source.QualifiedItemId == "(O)322" && source.Stack > 0,
            RadiusWindowRowBudget,
            (source, slot, x, y) => ExecutionManager.IsLegalEmptyFarmFenceTile(farm, new Vector2(x, y), source)
                ? new BridgeWoodFenceTarget(ExecutionManager.BuildWoodFenceTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)322", ExecutionManager.RequireDisplayName("(O)322"))
                : null,
            row => new TargetCandidate(row.X, row.Y, row.Slot));
    }

    internal static IReadOnlyList<BridgeBaitCrabPotTarget> DiscoverBaitCrabPotTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBaitCrabPotTarget>();
        List<BridgeBaitCrabPotTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object bait || bait.QualifiedItemId != "(O)685" || bait.Stack <= 0) continue;
            foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
            {
                Vector2 tile = pair.Key;
                StardewValley.Object placed = pair.Value;
                if (result.Count >= 16) return result;
                if (placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || !IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
                // `CrabPot.NeedsBait` is false for a pot that already carries bait (CrabPot.cs:64-71), and the drop-in
                // that fills one is gated on that same predicate (:239). The pot exists and is not a bait target.
                if (crabPot.bait.Value is not null)
                {
                    exclusions.Record("baitCrabPotTargets", DiscoveryExclusionReasons.AlreadyBaited);
                    continue;
                }
                result.Add(new BridgeBaitCrabPotTarget(ExecutionManager.BuildBaitCrabPotTargetId(location, slot, (int)tile.X, (int)tile.Y), location.NameOrUniqueName, slot, (int)tile.X, (int)tile.Y, "(O)710", ExecutionManager.RequireDisplayName("(O)710"), "(O)685", crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), 1));
            }
        }
        return result;
    }

    internal static IReadOnlyList<BridgeCrabPotCollectTarget> DiscoverCrabPotCollectTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCrabPotCollectTarget>();
        List<BridgeCrabPotCollectTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (result.Count >= 16) break;
            Vector2 tile = pair.Key;
            if (pair.Value is not StardewValley.Objects.CrabPot crabPot
                || crabPot.QualifiedItemId != "(O)710"
                || crabPot.owner.Value != player.UniqueMultiplayerID
                || !crabPot.readyForHarvest.Value
                || crabPot.tileIndexToShow != 714
                || crabPot.heldObject.Value is null
                || !IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCrabPotCollectTarget(
                ExecutionManager.BuildCollectCrabPotTargetId(location, (int)tile.X, (int)tile.Y),
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                "(O)710",
                ExecutionManager.RequireDisplayName("(O)710"),
                crabPot.heldObject.Value.QualifiedItemId,
                Math.Max(1, crabPot.heldObject.Value.Stack)));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeCrabPotTarget> DiscoverCrabPotTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeCrabPotTarget>();
        return NearestFirstRadiusWindowRows<BridgeCrabPotTarget>(
            player,
            source => source.QualifiedItemId == "(O)710" && source.Stack > 0,
            RadiusWindowRowBudget,
            (_, slot, x, y) => StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, x, y)
                ? new BridgeCrabPotTarget(ExecutionManager.BuildCrabPotTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)710", ExecutionManager.RequireDisplayName("(O)710"))
                : null,
            row => new TargetCandidate(row.X, row.Y, row.Slot));
    }

    internal static IReadOnlyList<BridgeFertilizerTarget> DiscoverFertilizerTargets(Farmer player, GroundSurface? surfaces = null)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFertilizerTarget>();
        surfaces ??= GroundSurface.Of(location);
        return NearestFirstRadiusWindowRows<BridgeFertilizerTarget>(
            player,
            source => source.Category == StardewValley.Object.fertilizerCategory,
            FertilizerRowBudget,
            (source, slot, x, y) =>
            {
                Vector2 tile = new(x, y);
                if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                    || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                    return null;
                bool canApplyFertilizer = dirt.CanApplyFertilizer(source.QualifiedItemId);
                if (!canApplyFertilizer)
                    return null;
                GroundSurface.Reading ground = surfaces.At(x, y);
                return new BridgeFertilizerTarget(ExecutionManager.BuildFertilizerTargetId(location, slot, x, y, source.QualifiedItemId), slot, x, y, source.QualifiedItemId, ExecutionManager.RequireDisplayName(source.QualifiedItemId), canApplyFertilizer, ground.Surface, ground.Owner);
            },
            row => new TargetCandidate(row.X, row.Y, row.Slot));
    }

    internal static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player, DiscoveryExclusionRecorder exclusions, GroundSurface? surfaces = null)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        surfaces ??= GroundSurface.Of(location);
        List<BridgeHarvestTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in ExecutionManager.NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
            StardewValley.Crop crop = dirt.crop!;
            // `HoeDirt.readyForHarvest()` is the engine's readiness answer (HoeDirt.cs:465). A crop still growing is
            // not a harvest row, and until now the only evidence of it was the row's absence.
            if (!dirt.readyForHarvest())
            {
                exclusions.Record("harvestTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            // `Crop.GetHarvestMethod()` (HoeDirt.cs:483): a scythe crop is taken by a TOOL swing and has its own family
            // (`scythe_crop`), so a grab row for it would promise an interaction the engine does not offer.
            if (crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
            {
                exclusions.Record("harvestTargets", DiscoveryExclusionReasons.WrongHarvestMethod);
                continue;
            }
            string harvestId = crop.indexOfHarvest.Value;
            StardewValley.Item? harvestItem = StardewValley.ItemRegistry.Create(harvestId, 1);
            GroundSurface.Reading ground = surfaces.At((int)pair.Key.X, (int)pair.Key.Y);
            result.Add(new BridgeHarvestTarget(
                ExecutionManager.BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, harvestId),
                (int)pair.Key.X,
                (int)pair.Key.Y,
                crop.netSeedIndex.Value ?? harvestId,
                harvestItem.QualifiedItemId,
                harvestItem.DisplayName,
                crop.RegrowsAfterHarvest(),
                dirt.readyForHarvest(),
                crop.forageCrop.Value,
                ExecutionManager.HarvestMethodName(crop.GetHarvestMethod()),
                ground.Surface,
                ground.Owner));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player, DiscoveryExclusionRecorder exclusions, GroundSurface? surfaces = null)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCropTarget>();
        surfaces ??= GroundSurface.Of(location);
        List<BridgeCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in ExecutionManager.NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null }
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
            // The tile's own water state, which `water_crop` refuses on (HoeDirt.cs:391-394). It is the exclusion the
            // companion was told nothing about: a farm whose every crop was already watered answered `[]`.
            if (dirt.isWatered())
            {
                exclusions.Record("cropTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            // The other half of `ExecutionManager.CropNeedsWater`, still read through that ONE spelling so this family and the whole-map
            // count cannot disagree: the crop itself needs no water (`HoeDirt.needsWatering`, HoeDirt.cs:380).
            if (!ExecutionManager.CropNeedsWater(dirt)) continue;
            StardewValley.Crop crop = dirt.crop!;
            string cropId = crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown";
            // `Crop.GetData()` is the engine's own `Data/Crops` lookup for THIS crop (Crop.cs:330 -> Game1.cropData), the
            // same row `look_up({table:"Crops"})` answers with. Null is a fact - a content pack can add a seed whose
            // data row the engine cannot resolve - so the five data fields stay null and `CropFactsUnknown` says why.
            StardewValley.GameData.Crops.CropData? data = crop.GetData();
            GroundSurface.Reading ground = surfaces.At((int)pair.Key.X, (int)pair.Key.Y);
            result.Add(new BridgeCropTarget(
                TargetId: ExecutionManager.BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, crop.indexOfHarvest.Value),
                X: (int)pair.Key.X,
                Y: (int)pair.Key.Y,
                CropId: cropId,
                DisplayName: ExecutionManager.RequireDisplayName(crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown"),
                Watered: dirt.isWatered(),
                Harvestable: dirt.readyForHarvest(),
                DaysToHarvest: data is null ? null : data.DaysInPhase.Sum(),
                RegrowDays: data?.RegrowDays,
                HarvestMethod: data is null ? null : ExecutionManager.HarvestMethodName(data.HarvestMethod),
                IsRaised: data?.IsRaised,
                Seasons: data?.Seasons is null
                    ? null
                    : data.Seasons.Select(static season => Utility.getSeasonKey(season)).Distinct().ToArray(),
                FullyGrown: crop.fullyGrown.Value,
                TileBlockedNow: ExecutionManager.IsTileBlockedForFarmer(location, player, (int)pair.Key.X, (int)pair.Key.Y),
                CropFactsUnknown: data is null ? ExecutionManager.CropFactsUnknownToken : null,
                Surface: ground.Surface,
                SurfaceOwner: ground.Owner));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player, out int omitted, GroundSurface? surfaces = null)
    {
        omitted = 0;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSoilTile>();
        // The same observation-scoped reading `seedTargets` uses, so the two families cannot price the same tile twice or
        // disagree about it; see `GroundSurface.CostLine` for what one observation pays.
        surfaces ??= GroundSurface.Of(location);
        FarmableBlocks blocks = new(location);
        List<(int Distance, BridgeSoilTile Tile)> candidates = new();
        int originX = player.TilePoint.X;
        int originY = player.TilePoint.Y;
        for (int x = originX - ExecutionManager.SoilTileDiscoveryRadius; x <= originX + ExecutionManager.SoilTileDiscoveryRadius; x++)
        {
            if (x < 0) continue;
            for (int y = originY - ExecutionManager.SoilTileDiscoveryRadius; y <= originY + ExecutionManager.SoilTileDiscoveryRadius; y++)
            {
                if (y < 0) continue;
                Vector2 tile = new(x, y);
                // The engine's own occupancy read: `terrainFeatures[tile] as HoeDirt`, which is what `till_soil`
                // refuses on and what `plant_seed` requires. Read once, so the row's state and the branch below
                // cannot disagree.
                bool hoeDirt = location.GetHoeDirtAtTile(tile) is not null;
                if (!hoeDirt && !ExecutionManager.IsTillableTile(location, x, y))
                    continue;
                (int BlockX, int BlockY, int BlockW, int BlockH) block = blocks.Of(x, y);
                GroundSurface.Reading ground = surfaces.At(x, y);
                candidates.Add((Math.Max(Math.Abs(x - originX), Math.Abs(y - originY)), new BridgeSoilTile(x, y, hoeDirt, block.BlockX, block.BlockY, block.BlockW, block.BlockH, ground.Surface, ground.Owner)));
            }
        }
        BridgeSoilTile[] ordered = candidates
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Tile.Y)
            .ThenBy(candidate => candidate.Tile.X)
            .Select(candidate => candidate.Tile)
            .ToArray();
        int published = Math.Min(ordered.Length, ExecutionManager.MaximumDiscoveredSoilTiles);
        omitted = ordered.Length - published;
        return ordered[..published];
    }

    private sealed class FarmableBlocks
    {
        private readonly StardewValley.GameLocation location;
        private readonly Dictionary<(int X, int Y), bool> farmable = new();
        private readonly Dictionary<(int X, int Y), (int BlockX, int BlockY, int BlockW, int BlockH)> blocks = new();

        internal FarmableBlocks(StardewValley.GameLocation location) => this.location = location;

        internal (int BlockX, int BlockY, int BlockW, int BlockH) Of(int x, int y)
        {
            if (this.blocks.TryGetValue((x, y), out (int BlockX, int BlockY, int BlockW, int BlockH) measured))
                return measured;
            List<(int X, int Y)> region = new();
            Stack<(int X, int Y)> pending = new();
            int minX = x, minY = y, maxX = x, maxY = y;
            pending.Push((x, y));
            this.blocks[(x, y)] = (x, y, 1, 1);
            while (pending.Count > 0)
            {
                (int tileX, int tileY) = pending.Pop();
                region.Add((tileX, tileY));
                foreach ((int stepX, int stepY) in CardinalNeighbours(tileX, tileY))
                {
                    if (this.blocks.ContainsKey((stepX, stepY)) || !this.IsFarmable(stepX, stepY)) continue;
                    this.blocks[(stepX, stepY)] = (stepX, stepY, 1, 1);
                    pending.Push((stepX, stepY));
                }
            }
            foreach ((int tileX, int tileY) in region)
            {
                if (tileX < minX) minX = tileX;
                if (tileY < minY) minY = tileY;
                if (tileX > maxX) maxX = tileX;
                if (tileY > maxY) maxY = tileY;
            }
            (int BlockX, int BlockY, int BlockW, int BlockH) box = (minX, minY, maxX - minX + 1, maxY - minY + 1);
            foreach ((int tileX, int tileY) in region)
                this.blocks[(tileX, tileY)] = box;
            return box;
        }

        /// <summary>
        /// Whether this tile belongs to the soil family at all: ground already under the Hoe, or ground that could carry
        /// the Hoe once whatever stands on it is cleared.
        ///
        /// <para>
        /// WHAT A STRIP IS A STRIP OF. It used to be "ground the Hoe admits right now", so the farm's field - one
        /// rectangle with rocks, weeds, grass and twigs on it - answered as a scatter of small boxes: measured on the
        /// `3x20` slice, the biggest was `28x19`, one row short of the shape, while the ground it sat in was the whole
        /// field. A block is the ground a patch can be OPENED in, so the permanent half of the Hoe's admission is asked of
        /// the tile (<see cref="ExecutionManager.DescribeSoilGroundRefusal"/>) and the occupant only has to be something
        /// some published action takes away (`TileOccupantKind.UnclearableReason`, the vocabulary `Clears` declarations
        /// are read against). A bush or a fruit tree is not that, and it still ends a block.
        /// </para>
        /// <para>
        /// One engine read plus two calls to predicates that already exist, and the answer is kept because a walk asks
        /// about the same neighbour from several of its members.
        /// </para>
        /// </summary>
        private bool IsFarmable(int x, int y)
        {
            if (this.farmable.TryGetValue((x, y), out bool known)) return known;
            if (!this.location.isTileOnMap(x, y))
            {
                this.farmable[(x, y)] = false;
                return false;
            }
            bool answer = this.location.GetHoeDirtAtTile(new Vector2(x, y)) is not null
                || (ExecutionManager.DescribeSoilGroundRefusal(this.location, x, y) is null
                    && IsOccupantClearable(this.location, x, y));
            this.farmable[(x, y)] = answer;
            return answer;
        }

        /// <summary>
        /// Whether what stands on this tile is nothing, or a kind some published action declares it clears.
        /// </summary>
        private static bool IsOccupantClearable(StardewValley.GameLocation location, int x, int y)
        {
            string kind = TileOccupancy.Of(location, x, y);
            return string.Equals(kind, TileOccupantKind.None, StringComparison.Ordinal)
                || TileOccupantKind.UnclearableReason(kind) is null;
        }
    }

    internal static IReadOnlyList<BridgeRaftTarget> DiscoverRaftTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null)
            return Array.Empty<BridgeRaftTarget>();

        return ExecutionManager.AdjacentCardinalTiles(player)
            .Where(tile => location.isWaterTile((int)tile.X, (int)tile.Y))
            .Take(16)
            .Select(tile => new BridgeRaftTarget(ExecutionManager.BuildRaftTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y))
            .ToArray();
    }

    internal static IReadOnlyList<BridgeHorseTarget> DiscoverHorseTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHorseTarget>();
        return location.characters.OfType<Horse>()
            .Where(horse => !string.IsNullOrWhiteSpace(horse.Name)
                && !string.Equals(horse.Name, "Horse", StringComparison.Ordinal)
                && horse.rider is null
                && ExecutionManager.IsTileWithinChebyshevRadius(player, (int)horse.Tile.X, (int)horse.Tile.Y, ExecutionManager.TargetDiscoveryRadius))
            .Take(16)
            .Select(horse => new BridgeHorseTarget(ExecutionManager.BuildHorseTargetId(location, horse), (int)horse.Tile.X, (int)horse.Tile.Y, horse.Name))
            .ToArray();
    }

    internal static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeMineEntranceTarget>();

        // Inside a mine level this family publishes that level's own LADDER tiles, in both directions:
        //
        //  - the way OUT is tile 115, which the level's shipped Buildings layer carries at its stairs, so it
        //    exists whether or not anything has been cleared. Measured 2026-11-03 (round30): a companion that
        //    entered level 1 was published `warps: 0`, `doorTargets: 0` and no descent ladder, so every way out
        //    was unnamable and it stayed in the mine until it passed out at 02:00;
        //  - the way DOWN is tile 173, which exists only after a stone is broken or a level is cleared
        //    (`createLadderDown`, MineShaft.cs:3587-3612).
        //
        // A shaft has no `Mine` Action tile, so reporting the entrance scan here would report nothing at all.
        if (location is MineShaft shaft)
        {
            List<BridgeMineEntranceTarget> ladders = new();
            if (ExecutionManager.TryFindMineExitLadderTile(shaft, out int exitX, out int exitY))
                ladders.Add(new BridgeMineEntranceTarget(ExecutionManager.BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, ExecutionManager.MineExitLadderSelector), exitX, exitY));
            if (ExecutionManager.TryFindMineLadderTile(shaft, out int ladderX, out int ladderY))
                ladders.Add(new BridgeMineEntranceTarget(ExecutionManager.BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, ExecutionManager.MineLadderSelector), ladderX, ladderY));
            return ladders;
        }

        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<BridgeMineEntranceTarget> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius); x <= Math.Min(width - 1, player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius); x++)
        for (int y = Math.Max(0, player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius); y <= Math.Min(height - 1, player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius); y++)
        {
            string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
            if (action is null || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), ExecutionManager.MineEntranceSelector, StringComparison.Ordinal))
                continue;
            result.Add(new BridgeMineEntranceTarget(ExecutionManager.BuildMineEntryTargetId(location.NameOrUniqueName, x, y, ExecutionManager.MineEntranceSelector), x, y));
            if (result.Count == 16) return result;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeFruitTreeTarget> DiscoverFruitTreeTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFruitTreeTarget>();
        List<BridgeFruitTreeTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.FruitTree fruitTree ||
                !fruitTree.IsInSeasonHere() || !fruitTree.fruit.Any(item => item is not null)
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !ExecutionManager.IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFruitTreeTarget(ExecutionManager.BuildFruitTreeTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, fruitTree), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeShakeTreeTarget> DiscoverShakeTreeTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeShakeTreeTarget>();
        List<BridgeShakeTreeTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.Tree tree || tree.stump.Value || !tree.hasSeed.Value || tree.wasShakenToday.Value
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !ExecutionManager.IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, ExecutionManager.TargetDiscoveryRadius)) continue;
            result.Add(new BridgeShakeTreeTarget(ExecutionManager.BuildShakeTreeTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, tree), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y));
            if (result.Count >= 16) break;
        }
        return result;
    }

    internal static IReadOnlyList<BridgeBushTarget> DiscoverBushTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBushTarget>();
        List<BridgeBushTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            ExecutionManager.PublishBushTarget(location, player, pair.Key, pair.Value, result);
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
            ExecutionManager.PublishBushTarget(location, player, large.Tile, large, result);
        return result;
    }

    internal static IReadOnlyList<BridgeWorldObjectTarget> DiscoverWorldObjectTargets(Farmer player, out int omitted)
    {
        omitted = 0;
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWorldObjectTarget>();
        List<BridgeWorldObjectTarget> result = new();
        HashSet<string> publishedTargetIds = new(StringComparer.Ordinal);
        int actorX = (int)player.Tile.X;
        int actorY = (int)player.Tile.Y;
        List<BridgeWorldObjectTarget> placements = new();
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object owned
                || owned.Stack <= 0
                || !(owned.bigCraftable.Value || owned is Furniture))
                continue;
            for (int x = Math.Max(0, actorX - ExecutionManager.TargetDiscoveryRadius); x <= actorX + ExecutionManager.TargetDiscoveryRadius; x++)
            for (int y = Math.Max(0, actorY - ExecutionManager.TargetDiscoveryRadius); y <= actorY + ExecutionManager.TargetDiscoveryRadius; y++)
            {
                Vector2 tile = new(x, y);
                if (!ExecutionManager.IsTileWithinChebyshevRadius(player, x, y, ExecutionManager.TargetDiscoveryRadius)) continue;
                if (!location.isTileOnMap(tile) || location.objects.ContainsKey(tile)) continue;
                if (!Utility.playerCanPlaceItemHere(location, owned, x * 64 + 32, y * 64 + 32, player) || !owned.canBePlacedHere(location, tile)) continue;
                // ONE IDENTITY, MANY TILES: the id names the piece in this slot (see `ExecutionManager.BuildOwnedObjectPlacementTargetId`),
                // so every tile the piece may lawfully go to is its own ROW carrying the same id. The dedupe key is
                // therefore the row - id and tile - not the id alone, or the first placeable tile would be the only one
                // ever advertised.
                string placementTargetId = ExecutionManager.BuildOwnedObjectPlacementTargetId(location, slot, owned.QualifiedItemId);
                if (!publishedTargetIds.Add($"{placementTargetId}@{x},{y}")) continue;
                placements.Add(new BridgeWorldObjectTarget(
                    placementTargetId,
                    "placement_candidate",
                    location.NameOrUniqueName,
                    x,
                    y,
                    slot,
                    owned.QualifiedItemId,
                    ExecutionManager.RequireDisplayName(owned.QualifiedItemId),
                    null,
                    null,
                    // The object does not exist yet: the row names a TILE it may be put on, so the extent is the tile.
                    1,
                    1));
            }
        }
        // ORDER FIRST, THEN TRIM. The scan above reaches tiles west-to-east from the map's own corner, so truncating while
        // it walks published whichever tiles the loops hit first: with three placeable machines over the same nine tiles -
        // the engine offers no more than the radius-1 ring (`Utility.playerCanPlaceItemHere` -> `isWithinTileWithLeeway`,
        // Utility.cs:5718-5750) - the sixteen-row budget held every tile of the first machine, six of the second and none
        // of the third. Distance from the actor decides now, and the two tie-breaks make one unchanged world publish one
        // order: the backpack slot first (the one fact that tells two machines' rows on the SAME tile apart), then the
        // tile itself. Ordering removes nothing; it decides which sixteen of the rows survive the budget.
        IReadOnlyList<BridgeWorldObjectTarget> orderedPlacements = TargetOrdering.NearestFirstByChebyshev(
            placements,
            actorX,
            actorY,
            placement => new TargetCandidate(placement.X, placement.Y, placement.Slot));
        int keptPlacements = Math.Min(orderedPlacements.Count, ExecutionManager.WorldObjectTargetLimit);
        omitted += orderedPlacements.Count - keptPlacements;
        result.AddRange(orderedPlacements.Take(keptPlacements));
        // THE MAP IS THE SUBJECT AND THE PACK IS EVIDENCE. This walk used to sit INSIDE a backpack loop, and that loop
        // skipped every slot whose item was not a heavy hitter - so an actor carrying no axe or pickaxe published no
        // object row at all, and the seed parcel the game leaves standing in the farmhouse was simply not in her world.
        // (Measured 2026-11-23, `round95` `FarmHouse`.) Whether she can swing at a thing is the ACTION's answer
        // (`tool_not_owned:axe_or_pickaxe`, `remove_placed_item_target_not_removable`), never a reason for the radar to
        // erase it. What the row states is the tool fact, and it prefers an owned slot:
        //   `breakable_container`  - swingable by any heavy hitter (`BreakableContainer.cs:118`); `slot` is one she owns.
        //   `removable_object`     - an axe or a pickaxe removes it (`ExecutionManager.IsRemovableByAnyLaneTool`); `slot` is one she owns
        //                            THAT removes it.
        //   `non_removable_object` - no axe and no pickaxe removes it; `slot` is -1 and the removal action names why.
        // A tool she does not own is `slot: -1` and the action's refusal, not a row that never existed.
        //
        // The tile is admitted through the family-wide place rule every tile-publishing discovery here uses
        // (`IsPublishedTargetTileInRadius`): on the map, and with a cardinal neighbour the body can stand on. That is a
        // bound on WHERE a row may name - a cell no body can be sent beside is a coordinate, not a target - and never a
        // filter on WHAT stands there.
        //
        // AND A SUBJECT ITS OWN FAMILY ALREADY NAMES IS NOT A SECOND ROW HERE (`SubjectsOwnedBySiblingFamilies`). The
        // existence rule above is about what the WORLD holds, not about who gets to describe it: the container family
        // publishes the farmhouse's starter gift box by name and contents, so a second row about the same box here
        // states nothing new - it only states it with an id the registry cannot resolve. That row is COUNTED rather
        // than dropped: `omitted` says a subject the room holds is not in this list.
        List<BridgeWorldObjectTarget> objectCandidates = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            Vector2 tile = pair.Key;
            StardewValley.Object placed = pair.Value;
            if (placed is null || !IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            if (ExecutionManager.OwningSiblingFamily(placed) is not null)
            {
                omitted++;
                continue;
            }
            bool container = placed is BreakableContainer;
            bool removable = !container && ExecutionManager.IsRemovableByAnyLaneTool(placed);
            string targetId = container
                ? ExecutionManager.BuildBreakableContainerTargetId(location, (int)tile.X, (int)tile.Y, placed)
                : ExecutionManager.BuildPlacedItemTargetId(location, (int)tile.X, (int)tile.Y, placed);
            if (!publishedTargetIds.Add(targetId)) continue;
            objectCandidates.Add(new BridgeWorldObjectTarget(
                targetId,
                container ? "breakable_container" : removable ? "removable_object" : "non_removable_object",
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                ExecutionManager.LaneRemovalToolSlot(player, container, placed),
                placed.QualifiedItemId,
                ExecutionManager.RequireDisplayName(placed.QualifiedItemId),
                null,
                null,
                // An object in `location.objects` occupies exactly the tile it is keyed by - the engine's own
                // container and placement predicates read one tile - so this branch states 1x1 rather than omitting
                // the pair.
                1,
                1));
        }
        // ORDER FIRST, THEN TRIM, AND STATE THE CUT: the map walk reaches tiles in the dictionary's own order, so
        // truncating while it walks published whichever object it happened to meet first. Distance from the actor
        // decides, the slot breaks the tie, and the count below says how many rows the budget left out - a reader that
        // receives sixteen object rows can then tell a room with sixteen objects from one it lost the far end of.
        IReadOnlyList<BridgeWorldObjectTarget> orderedObjects = TargetOrdering.NearestFirstByChebyshev(
            objectCandidates,
            actorX,
            actorY,
            row => new TargetCandidate(row.X, row.Y, row.Slot));
        int keptObjects = Math.Min(orderedObjects.Count, ExecutionManager.WorldObjectTargetLimit);
        omitted += orderedObjects.Count - keptObjects;
        result.AddRange(orderedObjects.Take(keptObjects));
        // PLACED FURNITURE IS PART OF THE ROOM, and nothing published it.
        //
        // Furniture lives in `location.furniture`, not `location.objects`, and this Mod never read that collection - a grep
        // for it finds one comment. So a house's bed, sofa, rug and paintings were literally invisible to the companion
        // while `place_owned_object` could ADD to the same invisible collection (Game1.cs:7033-7043). Measured 2026-11-03
        // (`round30`): it crafted a stone sign and planted it in front of the farmhouse door, and the frame it was reading
        // carried one door, three placement candidates and one colour target - no furniture at all, so "there is nothing
        // here yet" was the truthful reading of its own snapshot.
        //
        // Published as `placed_furniture` with `Slot: -1`: this lane has no tool that picks furniture up, and advertising a
        // slot would promise one. The removal action refuses a furniture tile by name (see
        // `remove_placed_item_furniture_move_unsupported`) rather than `target_not_found`, so the companion learns the
        // difference between "not there" and "there, but I cannot move it".
        //
        // The piece also carries its own `currentRotation` and `rotations`, because those are the two facts an action on
        // it needs and the only place they exist: `rotations < 2` is why `rotate_furniture` refuses by name instead of
        // turning nothing, and `currentRotation` before/after is the only witness that a turn happened. A caller cannot
        // derive either - the target id deliberately excludes anything the piece's own use changes.
        int furnitureCount = 0;
        foreach (Furniture piece in location.furniture)
        {
            if (piece is null) continue;
            Vector2 tile = piece.TileLocation;
            if (!IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            string targetId = ExecutionManager.BuildPlacedFurnitureTargetId(location, (int)tile.X, (int)tile.Y, piece);
            if (!publishedTargetIds.Add(targetId)) continue;
            if (furnitureCount >= ExecutionManager.WorldObjectTargetLimit)
            {
                omitted++;
                continue;
            }
            result.Add(new BridgeWorldObjectTarget(
                targetId,
                "placed_furniture",
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                -1,
                piece.QualifiedItemId,
                ExecutionManager.RequireDisplayName(piece.QualifiedItemId),
                piece.currentRotation.Value,
                piece.rotations.Value,
                // THE FOOTPRINT THE ENGINE COMPUTES, not a table here: `getTilesWide()`/`getTilesHigh()` divide the
                // piece's own sprite-derived `boundingBox` by 64 (Furniture.cs:1413-1421), which is why a 2x3 bed and a
                // 1x1 chair arrive as different rows. `Math.Max(1, ...)` only because a piece whose bounding box this
                // process never calculated would divide to 0, and 0 tiles is not a footprint any caller can use.
                Math.Max(1, piece.getTilesWide()),
                Math.Max(1, piece.getTilesHigh())));
            furnitureCount++;
        }
        int pedestalCount = 0;
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is not StardewValley.Objects.ItemPedestal pedestal || pedestal.heldObject.Value is not null)
                continue;
            Vector2 tile = pair.Key;
            if (!IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, ExecutionManager.TargetDiscoveryRadius))
                continue;
            string targetId = ExecutionManager.BuildPedestalDepositTargetId(location, (int)tile.X, (int)tile.Y, pedestal);
            if (!publishedTargetIds.Add(targetId)) continue;
            if (pedestalCount >= ExecutionManager.WorldObjectTargetLimit)
            {
                omitted++;
                continue;
            }
            result.Add(new BridgeWorldObjectTarget(
                targetId,
                "empty_pedestal",
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                -1,
                pedestal.QualifiedItemId,
                ExecutionManager.RequireDisplayName(pedestal.QualifiedItemId),
                null,
                null,
                1,
                1));
            pedestalCount++;
        }
        // THE WIRE'S OWN BOUND, LAST AND SEPARATELY COUNTED. The four caps above are fairness BETWEEN kinds (sixteen
        // placement rows may not eat every object row); this one is the bound the Host declares for the family, and it
        // refuses the WHOLE snapshot past it rather than trimming - `SNAPSHOT_FAMILY_RULES` holds `worldObjectTargets` at
        // 48, so a 49-row frame is not a longer list, it is a frame the bridge closes. `ExecutionManager.WorldObjectTargetFamilyLimit` is
        // that number, pinned to the Host's own declaration by `RadiusWindowBudgetAuthorityTests`.
        int keptRows = Math.Min(result.Count, ExecutionManager.WorldObjectTargetFamilyLimit);
        omitted += result.Count - keptRows;
        if (keptRows < result.Count) result.RemoveRange(keptRows, result.Count - keptRows);
        return result;
    }
}
