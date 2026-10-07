using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The building type the fixture places when the save owns no animal door.</summary>
    private const string ToggleAnimalDoorFixtureBuildingType = "Coop";

    /// <summary>
    /// toggle_animal_door pre-attachment Given: one FINISHED coop/barn whose data declares
    /// an animal door, that door in a KNOWN closed state, and the actor standing one tile
    /// from the building's human door — the tile the action publishes and admits reach
    /// against.
    ///
    /// Only that declared Given is established. The toggle itself — the native
    /// <c>Building.ToggleAnimalDoor</c> call and the observed flip of
    /// <c>animalDoorOpen</c> — belongs to production, and this fixture emits no receipt.
    ///
    /// The door state is SET here rather than observed on purpose. The action under test is
    /// the TRANSITION, so the starting state has to be known, and neither route to an
    /// existing animal building guarantees one: a save that already owns the coop carries
    /// whatever state it was left in, and the target-version <c>SetupBigFarm</c> route calls
    /// <c>Building.doAction</c> after construction, whose result depends on global
    /// right-click state (recorded in
    /// design/archive/legacy-sources/22_STARDEW_NATIVE_LOCAL_CLOSURE_BOARD.md:118). Setting
    /// the state is exactly the fixture's job; proving the transition from it is not.
    ///
    /// Every step asserts its own fact, so a wrong fixture fails loudly here rather than
    /// looking like a product bug later (same convention as the sibling
    /// WithdrawSiloHay/UseObelisk fixtures). The door predicate is the same
    /// <c>ExecutionManager.TryDescribeAnimalDoor</c> the action admits with, so the
    /// fixture and the product cannot disagree about what an animal door is.
    /// </summary>
    private void InitializeNativeLocalToggleAnimalDoorFixture(Farmer player, GameLocation farm)
    {
        // A save that already owns a finished building with an animal door is reused; the
        // bootstrapped stable template owns none, so one is built.
        Building? building = null;
        Vector2? standing = null;
        foreach (Building candidate in farm.buildings)
        {
            if (candidate is null || candidate.daysOfConstructionLeft.Value > 0)
                continue;
            if (!ExecutionManager.TryDescribeAnimalDoor(candidate, out _, out _))
                continue;
            Vector2? tile = FindNativeLocalToggleAnimalDoorStandingTile(farm, candidate);
            if (tile is null)
                continue;
            building = candidate;
            standing = tile;
            break;
        }

        if (building is null || standing is null)
        {
            building = PlaceNativeLocalToggleAnimalDoorFixtureBuilding(farm);
            standing = FindNativeLocalToggleAnimalDoorStandingTile(farm, building)
                ?? throw new InvalidOperationException("fixture_native_local_toggle_animal_door_standing_tile_missing");
        }

        building.animalDoorOpen.Value = false;
        building.animalDoorOpenAmount.Value = 0f;
        if (building.animalDoorOpen.Value || building.animalDoorOpenAmount.Value != 0f)
            throw new InvalidOperationException("fixture_native_local_toggle_animal_door_state_not_set");

        Point door = building.getPointForHumanDoor();
        if (door.X < 0 || door.Y < 0 || !farm.isTileOnMap(new Vector2(door.X, door.Y)))
            throw new InvalidOperationException("fixture_native_local_toggle_animal_door_door_missing");

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized coop animal-door precondition before bridge attachment: "
                + $"building={building.buildingType.Value};origin={building.tileX.Value},{building.tileY.Value};door={door.X},{door.Y};"
                + $"animal_door_open=false;standing={(int)standing.Value.X},{(int)standing.Value.Y}; production alone toggles the door and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// Places the declared Given's coop on the farm: the first origin whose whole footprint
    /// is buildable and whose human door has a walkable neighbour. Nothing is toggled and no
    /// other native state is written.
    /// </summary>
    private static Building PlaceNativeLocalToggleAnimalDoorFixtureBuilding(GameLocation farm)
    {
        xTile.Layers.Layer? back = farm.map?.GetLayer("Back");
        if (back is null)
            throw new InvalidOperationException("fixture_native_local_toggle_animal_door_map_missing");

        // One constructed candidate, re-tiled while scanning: the target-version constructor
        // resolves the building's size, human door and animal door, so a Coop that declares no
        // animal door at all fails HERE — loudly — instead of surfacing later as a product
        // refusal that looks like a bug in the action.
        Building candidate = new(ToggleAnimalDoorFixtureBuildingType, Vector2.Zero);
        if (!ExecutionManager.TryDescribeAnimalDoor(candidate, out _, out _))
            throw new InvalidOperationException("fixture_native_local_toggle_animal_door_declared_door_missing");

        for (int y = 0; y < back.LayerHeight; y++)
        {
            for (int x = 0; x < back.LayerWidth; x++)
            {
                candidate.tileX.Value = x;
                candidate.tileY.Value = y;

                bool footprintFree = true;
                for (int offsetX = 0; offsetX < candidate.tilesWide.Value && footprintFree; offsetX++)
                {
                    for (int offsetY = 0; offsetY < candidate.tilesHigh.Value && footprintFree; offsetY++)
                    {
                        Vector2 tile = new(x + offsetX, y + offsetY);
                        footprintFree = farm.isTileOnMap(tile)
                            && !farm.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y))
                            && farm.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
                    }
                }
                if (!footprintFree)
                    continue;
                if (FindNativeLocalToggleAnimalDoorStandingTile(farm, candidate) is null)
                    continue;

                candidate.daysOfConstructionLeft.Value = 0;
                farm.buildings.Add(candidate);
                farm.updateLayout();
                return candidate;
            }
        }

        throw new InvalidOperationException("fixture_native_local_toggle_animal_door_placement_missing");
    }

    /// <summary>
    /// A walkable tile one Chebyshev step from the building's human door and outside every
    /// building footprint — the exact reach horizon <c>toggle_animal_door</c> admits on.
    /// Preferred order is the cardinal ring first, then the diagonals.
    /// </summary>
    private static Vector2? FindNativeLocalToggleAnimalDoorStandingTile(GameLocation farm, Building building)
    {
        Point door = building.getPointForHumanDoor();
        if (door.X < 0 || door.Y < 0)
            return null;

        Vector2[] ring =
        {
            new(door.X, door.Y + 1), new(door.X - 1, door.Y), new(door.X + 1, door.Y), new(door.X, door.Y - 1),
            new(door.X - 1, door.Y + 1), new(door.X + 1, door.Y + 1), new(door.X - 1, door.Y - 1), new(door.X + 1, door.Y - 1),
        };
        return ring
            .Where(tile => !building.occupiesTile((int)tile.X, (int)tile.Y)
                && !farm.buildings.Any(other => other is not null && !ReferenceEquals(other, building) && other.occupiesTile((int)tile.X, (int)tile.Y))
                && IsFixtureWalkableFarmTile(farm, tile))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }
}
