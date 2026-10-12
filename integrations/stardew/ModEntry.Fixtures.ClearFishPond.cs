using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// clear_fish_pond pre-attachment Given: one FINISHED fish pond in the current location that
    /// HOLDS fish, and the actor standing one Chebyshev step from the pond's human door — the tile
    /// the action publishes and admits reach against.
    ///
    /// Only that declared Given is established. The clearing itself — the native
    /// <c>FishPond.ClearPond()</c> call, the reset pond and the ejected debris — belongs to
    /// production, and this fixture emits no receipt.
    ///
    /// WHY THE FISH ARE SET HERE RATHER THAN FOUND: the action EMPTIES the pond, so the starting
    /// state has to be known and non-empty. A save that happens to own a pond carries whatever it
    /// was left with (possibly empty, possibly mid-quest), so the fixture sets both halves of the
    /// precondition the product reads — a resolvable fish type and a positive occupant count — and
    /// then asserts them THROUGH the product's own predicate so the two cannot disagree.
    ///
    /// The fish type is not guessed: it is taken from the game's own pond data
    /// (<c>Data/FishPondData</c>), because a fish that has no pond entry is not a pond fish at all
    /// and a fixture that invented one would be testing a world the game cannot produce.
    /// </summary>
    private void InitializeNativeLocalClearFishPondFixture(Farmer player, GameLocation location)
    {
        string fishType = ResolveNativeLocalClearFishPondFixtureFishType();

        // A save that already owns a finished pond is reused; the bootstrapped stable template owns
        // none, so one is placed.
        FishPond? pond = null;
        Vector2? standing = null;
        foreach (Building candidate in location.buildings)
        {
            if (candidate is not FishPond existing || existing.daysOfConstructionLeft.Value > 0)
                continue;
            Vector2? tile = FindNativeLocalClearFishPondStandingTile(location, existing);
            if (tile is null)
                continue;
            pond = existing;
            standing = tile;
            break;
        }

        if (pond is null || standing is null)
        {
            pond = PlaceNativeLocalClearFishPondFixtureBuilding(location);
            standing = FindNativeLocalClearFishPondStandingTile(location, pond)
                ?? throw new InvalidOperationException("fixture_native_local_clear_fish_pond_standing_tile_missing");
        }

        // The Given, set explicitly: a finished pond holding at least one fish of a type the game
        // itself declares as a pond fish.
        pond.daysOfConstructionLeft.Value = 0;
        pond.fishType.Value = fishType;
        pond.currentOccupants.Value = 1;
        pond.daysSinceSpawn.Value = 0;
        pond.lastUnlockedPopulationGate.Value = 0;
        pond.goldenAnimalCracker.Value = false;

        // Two assertions, both through the GAME's own resolution rather than ours: the pond must report
        // pond data for this fish (`FishPond.GetFishPondData`, public at :181), and that resolution must
        // accept the id we set. A fish the pond could never hold fails HERE, loudly.
        if (!ExecutionManager.TryDescribeFishPond(pond, out bool hasFish, out int occupants) || !hasFish || occupants < 1)
            throw new InvalidOperationException(
                $"fixture_native_local_clear_fish_pond_not_stocked:fish_type={pond.fishType.Value ?? "none"};occupants={pond.currentOccupants.Value}");
        if (pond.GetFishPondData() is null)
            throw new InvalidOperationException($"fixture_native_local_clear_fish_pond_fish_type_unresolvable:{pond.fishType.Value}");

        Point door = pond.getPointForHumanDoor();
        if (door.X < 0 || door.Y < 0 || !location.isTileOnMap(new Vector2(door.X, door.Y)))
            throw new InvalidOperationException("fixture_native_local_clear_fish_pond_door_missing");

        player.warpFarmer(new Warp(0, 0, location.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=clear_fish_pond"
                + $";location={location.NameOrUniqueName}"
                + $";pond_id={ExecutionManager.BuildFishPondTargetId(location, pond)}"
                + $";tile={door.X},{door.Y}"
                + $";standing={standing.Value.X},{standing.Value.Y}"
                + $";fish_type={pond.fishType.Value}"
                + $";occupants={pond.currentOccupants.Value}",
            LogLevel.Info);
    }

    /// <summary>
    /// A pond fish id, decided BY THE GAME rather than by a list here: iterate `Data/Fish`'s own keys (a plain
    /// string table, so no external GameData type is needed) and take the first id the pond resolver accepts —
    /// `FishPond.GetRawData` is `public static` and answers exactly "is this a fish a pond can hold?", honouring
    /// the `fish_pond_ignore` tag and the `RequiredTags`/`Precedence` rules the game itself applies.
    /// </summary>
    private static string ResolveNativeLocalClearFishPondFixtureFishType()
    {
        Dictionary<string, string>? fish;
        try
        {
            fish = Game1.content.Load<Dictionary<string, string>>("Data/Fish");
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException($"fixture_native_local_clear_fish_pond_data_unreadable:{exception.GetType().Name}");
        }

        foreach (string key in fish?.Keys ?? Enumerable.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(key))
                continue;
            if (FishPond.GetRawData(key) is not null)
                return key;
        }

        throw new InvalidOperationException("fixture_native_local_clear_fish_pond_no_pond_fish_declared");
    }

    /// <summary>
    /// A finished fish pond placed on free ground whose human door has a walkable neighbour, or a loud
    /// failure. The constructor resolves the pond's size and door, so a pond that cannot exist at all
    /// fails here rather than surfacing later as a product refusal that looks like a bug.
    /// </summary>
    private static FishPond PlaceNativeLocalClearFishPondFixtureBuilding(GameLocation location)
    {
        xTile.Layers.Layer? back = location.map?.GetLayer("Back");
        if (back is null)
            throw new InvalidOperationException("fixture_native_local_clear_fish_pond_map_missing");

        for (int y = 0; y < back.LayerHeight; y++)
        {
            for (int x = 0; x < back.LayerWidth; x++)
            {
                FishPond candidate = new(Vector2.Zero);
                candidate.tileX.Value = x;
                candidate.tileY.Value = y;

                bool footprintFree = true;
                for (int offsetX = 0; offsetX < candidate.tilesWide.Value && footprintFree; offsetX++)
                {
                    for (int offsetY = 0; offsetY < candidate.tilesHigh.Value && footprintFree; offsetY++)
                    {
                        Vector2 tile = new(x + offsetX, y + offsetY);
                        footprintFree = location.isTileOnMap(tile)
                            && !location.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y))
                            && location.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
                    }
                }
                if (!footprintFree || FindNativeLocalClearFishPondStandingTile(location, candidate) is null)
                    continue;

                candidate.daysOfConstructionLeft.Value = 0;
                location.buildings.Add(candidate);
                location.updateLayout();
                return candidate;
            }
        }

        throw new InvalidOperationException("fixture_native_local_clear_fish_pond_placement_missing");
    }

    /// <summary>
    /// A walkable tile one Chebyshev step from the pond's human door and outside every building
    /// footprint — the exact reach horizon `clear_fish_pond` admits on. Cardinal ring first, then the
    /// diagonals.
    /// </summary>
    private static Vector2? FindNativeLocalClearFishPondStandingTile(GameLocation location, Building pond)
    {
        Point door = pond.getPointForHumanDoor();
        if (door.X < 0 || door.Y < 0)
            return null;

        Vector2[] ring =
        {
            new(door.X, door.Y + 1), new(door.X - 1, door.Y), new(door.X + 1, door.Y), new(door.X, door.Y - 1),
            new(door.X - 1, door.Y + 1), new(door.X + 1, door.Y + 1), new(door.X - 1, door.Y - 1), new(door.X + 1, door.Y - 1),
        };

        // The shared fixture walkability predicate: on the map, passable, no object, nothing occupying it for a
        // farmer. `GameLocation.isTilePassable` has a different overload set than the one I first reached for.
        return ring
            .Where(tile => !pond.occupiesTile((int)tile.X, (int)tile.Y)
                && !location.buildings.Any(other => other is not null && !ReferenceEquals(other, pond) && other.occupiesTile((int)tile.X, (int)tile.Y))
                && IsFixtureWalkableFarmTile(location, tile))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }
}
