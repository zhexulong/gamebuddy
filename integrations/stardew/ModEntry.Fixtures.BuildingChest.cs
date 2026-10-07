using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;
using StardewValley.Inventories;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The building type the fixture places when the save owns no chest-bearing building.</summary>
    private const string BuildingChestFixtureBuildingType = "Mill";

    /// <summary>
    /// load_building_chest pre-attachment Given: one FINISHED building whose DATA declares both
    /// a Load and a Collect chest, a Load chest that is EMPTY, and the actor HOLDING an item the
    /// Load chest's own conversion accepts, one quantum above what that conversion requires —
    /// so a successful load consumes exactly one quantum and must leave the remainder in the
    /// hand.
    ///
    /// Only that declared Given is established. The load itself — the native
    /// `Building.PerformBuildingChestAction` call, the quantised transfer and both observed
    /// halves — belongs to production, and this fixture emits no receipt.
    /// </summary>
    private void InitializeNativeLocalBuildingChestFixture(Farmer player, GameLocation farm) =>
        InstallNativeLocalBuildingChestFixture(player, farm, multiStackOutput: false);

    /// <summary>
    /// collect_building_chest_output's second declared Given: the SAME building and actor as its
    /// sibling, but the Collect chest holds TWO stacks, which is the state the owner ruled must
    /// be refused by name (`building_chest_requires_menu`) instead of being handed to the
    /// container menu the native branch would open. Nothing is collected here.
    /// </summary>
    private void InitializeNativeLocalBuildingChestMultiStackFixture(Farmer player, GameLocation farm) =>
        InstallNativeLocalBuildingChestFixture(player, farm, multiStackOutput: true);

    /// <summary>
    /// Establish the building-chest pair's declared Given on the farm. Every step asserts its
    /// own fact so a wrong fixture fails loudly here rather than looking like a product bug
    /// later, and the chest layout is written through the game's own inventory API
    /// (`IInventory.Clear`/`Add`) rather than by fabricating a chest list.
    /// </summary>
    private void InstallNativeLocalBuildingChestFixture(Farmer player, GameLocation farm, bool multiStackOutput)
    {
        Building building = FindOrPlaceNativeLocalBuildingChestFixtureBuilding(farm);
        if (!TryFindBuildingChestFixturePair(building, out string loadChestId, out string collectChestId))
            throw new InvalidOperationException("fixture_native_local_building_chest_declared_chest_missing");

        Chest loadChest = building.GetBuildingChest(loadChestId)
            ?? throw new InvalidOperationException("fixture_native_local_building_chest_load_chest_missing");
        Chest outputChest = building.GetBuildingChest(collectChestId)
            ?? throw new InvalidOperationException("fixture_native_local_building_chest_collect_chest_missing");

        // The accepted item comes from the Load chest's OWN conversion and is validated with
        // the same predicate the native Load branch admits with (Building.cs:741-744, :766).
        if (!TryFindBuildingChestFixtureAcceptedItem(building, loadChest, out string itemId, out int requiredCount))
            throw new InvalidOperationException("fixture_native_local_building_chest_accepted_item_missing");

        // The Load chest starts EMPTY: the runner asserts the chest's own count of the held item
        // grew by exactly one quantum, and a pre-stocked chest would make that reading ambiguous.
        loadChest.GetItemsForPlayer().Clear();
        if (loadChest.GetItemsForPlayer().Any(item => item is not null))
            throw new InvalidOperationException("fixture_native_local_building_chest_load_chest_not_empty");

        // The Collect chest carries the declared Given: one stack, or two for the >= 2-stack
        // refusal. Appended through the inventory rather than `Chest.addItem`, which would MERGE
        // the second stack into the first and leave only one slot. The item is the same accepted
        // item: the native Collect branch never inspects what the single stack is
        // (Utility.cs:2045-2085 moves whatever is there).
        IInventory output = outputChest.GetItemsForPlayer();
        output.Clear();
        output.Add(ItemRegistry.Create<StardewValley.Object>(itemId, 2));
        if (multiStackOutput) output.Add(ItemRegistry.Create<StardewValley.Object>(itemId, 3));
        int expectedStacks = multiStackOutput ? 2 : 1;
        if (output.Count(item => item is not null) != expectedStacks)
            throw new InvalidOperationException("fixture_native_local_building_chest_collect_stack_count_mismatch");

        StardewValley.Object held = ItemRegistry.Create<StardewValley.Object>(itemId, requiredCount + 1);
        if (player.addItemToInventory(held) is not null)
            throw new InvalidOperationException("fixture_native_local_building_chest_inventory_full");
        // The action selects the slot as the held one around its native call (the machine_load
        // precedent), so the Given is only that the item is IN the pack; the slot is deliberately
        // NOT pre-selected and the item is deliberately one quantum more than a single load needs,
        // so a successful load must leave a remainder behind.
        int slot = player.Items.IndexOf(held);
        if (slot < 0 || player.Items[slot] is not StardewValley.Object)
            throw new InvalidOperationException("fixture_native_local_building_chest_slot_missing");

        if (!ExecutionManager.TryFindBuildingChestInteractionTile(building, loadChestId, out int chestTileX, out int chestTileY))
            throw new InvalidOperationException("fixture_native_local_building_chest_interaction_tile_missing");
        if (!ExecutionManager.TryFindBuildingChestInteractionTile(building, collectChestId, out int outputTileX, out int outputTileY))
            throw new InvalidOperationException("fixture_native_local_building_chest_output_tile_missing");
        Vector2? standing = FindNativeLocalBuildingChestStandingTile(farm, building, chestTileX, chestTileY);
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_building_chest_standing_tile_missing");
        // Both chests must be inside the horizon the snapshot publishes targets within, or the
        // runner could not read the sibling target its wrong-branch assertion needs.
        if (ChebyshevTileDistance(standing.Value, new Vector2(chestTileX, chestTileY)) > ExecutionManager.TargetDiscoveryRadius
            || ChebyshevTileDistance(standing.Value, new Vector2(outputTileX, outputTileY)) > ExecutionManager.TargetDiscoveryRadius)
            throw new InvalidOperationException("fixture_native_local_building_chest_target_out_of_discovery_radius");

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized building-chest precondition before bridge attachment: "
                + $"building={building.buildingType.Value};origin={building.tileX.Value},{building.tileY.Value};load_chest={loadChestId};"
                + $"collect_chest={collectChestId};item={itemId};required_count={requiredCount};held_slot={slot};held_stack={held.Stack};"
                + $"collect_stacks={expectedStacks};load_chest_tile={chestTileX},{chestTileY};collect_chest_tile={outputTileX},{outputTileY};"
                + $"standing={(int)standing.Value.X},{(int)standing.Value.Y}; production alone loads or collects and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// A finished chest-bearing building already on the farm, else the declared Given: a
    /// constructed building of <see cref="BuildingChestFixtureBuildingType"/> placed on the first
    /// free footprint. A save that already owns such a building is reused, so the fixture never
    /// rewrites a player's farm layout for nothing.
    ///
    /// A freshly constructed building has NO chest objects: the game creates them while applying
    /// the data of a building that has loaded or is being constructed
    /// (`LoadFromBuildingData` Building.cs:567-594, reached for a new building through
    /// `performActionOnConstruction` :1143). The fixture therefore calls the same public data
    /// application (`ReloadBuildingData(forUpgrade: false, forConstruction: true)`, :479) and not
    /// `performActionOnConstruction`, which would additionally manufacture a construction timer,
    /// a sound and the build mail.
    /// </summary>
    private static Building FindOrPlaceNativeLocalBuildingChestFixtureBuilding(GameLocation farm)
    {
        foreach (Building candidate in farm.buildings)
        {
            if (candidate is null || candidate.daysOfConstructionLeft.Value > 0)
                continue;
            if (!TryFindBuildingChestFixturePair(candidate, out _, out _))
                continue;
            return candidate;
        }

        xTile.Layers.Layer? back = farm.map?.GetLayer("Back");
        if (back is null)
            throw new InvalidOperationException("fixture_native_local_building_chest_map_missing");

        Building placed = new(BuildingChestFixtureBuildingType, Vector2.Zero);
        if (!TryFindBuildingChestFixturePair(placed, out _, out _))
            throw new InvalidOperationException("fixture_native_local_building_chest_declared_chest_missing");

        for (int y = 0; y < back.LayerHeight; y++)
        {
            for (int x = 0; x < back.LayerWidth; x++)
            {
                placed.tileX.Value = x;
                placed.tileY.Value = y;

                bool footprintFree = true;
                for (int offsetX = 0; offsetX < placed.tilesWide.Value && footprintFree; offsetX++)
                {
                    for (int offsetY = 0; offsetY < placed.tilesHigh.Value && footprintFree; offsetY++)
                    {
                        Vector2 tile = new(x + offsetX, y + offsetY);
                        footprintFree = farm.isTileOnMap(tile)
                            && !farm.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y))
                            && farm.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
                    }
                }
                if (!footprintFree || FindNativeLocalBuildingChestFixtureStandingTile(farm, placed) is null)
                    continue;

                placed.ReloadBuildingData(forUpgrade: false, forConstruction: true);
                placed.daysOfConstructionLeft.Value = 0;
                farm.buildings.Add(placed);
                farm.updateLayout();
                if (!TryFindBuildingChestFixturePair(placed, out string liveLoadChestId, out string liveCollectChestId)
                    || placed.GetBuildingChest(liveLoadChestId) is null
                    || placed.GetBuildingChest(liveCollectChestId) is null)
                    throw new InvalidOperationException("fixture_native_local_building_chest_construction_missing");
                return placed;
            }
        }

        throw new InvalidOperationException("fixture_native_local_building_chest_placement_missing");
    }

    /// <summary>
    /// The declared Load/Collect chest ids of one building, or false when its data declares no
    /// such pair. Read from `BuildingData.Chests` and never from a hardcoded building type, so a
    /// mod-provided building with the same declaration is servable by the same fixture.
    /// </summary>
    private static bool TryFindBuildingChestFixturePair(Building building, out string loadChestId, out string collectChestId)
    {
        loadChestId = string.Empty;
        collectChestId = string.Empty;
        BuildingData? data = building.GetData();
        if (data?.Chests is null)
            return false;
        foreach (BuildingChest declared in data.Chests)
        {
            if (declared is null || string.IsNullOrWhiteSpace(declared.Id))
                continue;
            if (declared.Type == BuildingChestType.Load && loadChestId.Length == 0)
                loadChestId = declared.Id;
            if (declared.Type == BuildingChestType.Collect && collectChestId.Length == 0)
                collectChestId = declared.Id;
        }
        return loadChestId.Length > 0 && collectChestId.Length > 0;
    }

    /// <summary>
    /// One real Object whose own context tags satisfy a conversion of the Load chest, plus that
    /// conversion's `RequiredCount`. The item is found by asking the item registry about each
    /// declared Object and then validating it with `Building.IsValidObjectForChest` — the very
    /// predicate the native Load branch admits with — so the fixture cannot hand production an
    /// item production would refuse.
    /// </summary>
    private static bool TryFindBuildingChestFixtureAcceptedItem(Building building, Chest loadChest, out string itemId, out int requiredCount)
    {
        itemId = string.Empty;
        requiredCount = 0;
        BuildingData? data = building.GetData();
        if (data?.ItemConversions is null)
            return false;
        foreach (BuildingItemConversion conversion in data.ItemConversions)
        {
            if (conversion is null
                || conversion.RequiredCount <= 0
                || !string.Equals(conversion.SourceChest, loadChest.Name, StringComparison.Ordinal))
                continue;
            foreach (string candidateId in Game1.objectData.Keys)
            {
                StardewValley.Object candidate = ItemRegistry.Create<StardewValley.Object>("(O)" + candidateId, 1, 0, allowNull: true);
                if (candidate is null)
                    continue;
                if (!building.IsValidObjectForChest(candidate, loadChest))
                    continue;
                itemId = candidate.QualifiedItemId;
                requiredCount = conversion.RequiredCount;
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// A walkable tile one Chebyshev step from the Load chest's interaction tile and outside
    /// every building footprint — the exact reach horizon `load_building_chest` admits on.
    /// Preferred order is the cardinal ring first, then the diagonals. Shares
    /// <see cref="IsFixtureWalkableFarmTile"/> with the sibling fixtures.
    /// </summary>
    private static Vector2? FindNativeLocalBuildingChestStandingTile(GameLocation farm, Building building, int tileX, int tileY)
    {
        Vector2[] ring =
        {
            new(tileX, tileY + 1), new(tileX - 1, tileY), new(tileX + 1, tileY), new(tileX, tileY - 1),
            new(tileX - 1, tileY + 1), new(tileX + 1, tileY + 1), new(tileX - 1, tileY - 1), new(tileX + 1, tileY - 1),
        };
        return ring
            .Where(tile => !building.occupiesTile((int)tile.X, (int)tile.Y)
                && !farm.buildings.Any(other => other is not null && !ReferenceEquals(other, building) && other.occupiesTile((int)tile.X, (int)tile.Y))
                && IsFixtureWalkableFarmTile(farm, tile))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }

    /// <summary>
    /// The standing tile used only while SCANNING for a free footprint, before the building is
    /// placed: the building in question is not on the farm yet, so the footprint test reduces to
    /// the chest interaction tiles the placement will need to be reachable from.
    /// </summary>
    private static Vector2? FindNativeLocalBuildingChestFixtureStandingTile(GameLocation farm, Building building)
    {
        if (!TryFindBuildingChestFixturePair(building, out string loadChestId, out _))
            return null;
        if (!ExecutionManager.TryFindBuildingChestInteractionTile(building, loadChestId, out int tileX, out int tileY))
            return null;
        return FindNativeLocalBuildingChestStandingTile(farm, building, tileX, tileY);
    }
}
