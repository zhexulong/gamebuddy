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
    /// <summary>The one animal house the play-session world carries. A coop, because it is the smallest
    /// <see cref="AnimalHouse"/> the game ships and the world has to stay walkable.</summary>
    private const string PlaySessionAnimalBuildingType = "Coop";

    /// <summary>The one animal inside it.</summary>
    private const string PlaySessionAnimalType = "White Chicken";

    /// <summary>
    /// The play-session world's ANIMAL Given: one coop holding ONE adult animal, placed where the session's own
    /// crossroads can walk to its door.
    ///
    /// <para>
    /// WHY. `tend_the_animals` is one of the rotation's days, and three of its four actions are farm-animal actions
    /// (`pet_farm_animal`, `feed_animal`, `collect_animal_product`). Measured 2026-11-09: the composed multi-day world
    /// held crops, weeds, stone, loose soil and tools and <b>no animal at all</b>, so those actions could only ever be
    /// chosen by their single-action scenarios - a play session could not reach one no matter what the companion
    /// decided. A task the world cannot satisfy measures the world.
    /// </para>
    ///
    /// <para>
    /// ONE animal, not a stocked house, and the same reason the pet fixture gives: <c>DiscoverFarmAnimalPetTargets</c>
    /// filters the engine's own <c>wasPet</c> marker, so "the animal I touched left the published family" is only
    /// unambiguous when the family has exactly one member.
    /// </para>
    ///
    /// <para>
    /// THE ENGINE ENTRY IS THE CHEST FIXTURE'S, NOT A DEBUG COMMAND. A farm building is a world fact the save owns, so
    /// it is a real <see cref="Building"/> at a real site with a real lazily created interior - but placed through the
    /// public data-application path (<c>ReloadBuildingData(forUpgrade: false, forConstruction: true)</c>,
    /// <c>daysOfConstructionLeft = 0</c>, <c>buildings.Add</c>, <c>updateLayout</c>), which is exactly what
    /// <see cref="FindOrPlaceNativeLocalBuildingChestFixtureBuilding"/> already does for a Mill. Neither the debug
    /// <c>Build</c>/<c>ForceBuild</c> route nor <c>buildStructure</c> with <c>skipSafetyChecks</c> is used here: this
    /// site is CHOSEN against the live farm rather than forced onto whatever the terrain happens to hold.
    /// </para>
    ///
    /// <para>
    /// The animal is adopted by the house, which is what gives it its home, its position and its
    /// <c>animalsThatLiveHere</c> entry. Nothing here pets, feeds or collects: those are the actions' own business, and
    /// this initializer emits no receipt.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPlaySessionAnimalGiven(Farmer player, Farm farm, Vector2 startTile, Vector2? mustRemainReachable)
    {
        Building coop = new(PlaySessionAnimalBuildingType, Vector2.Zero);
        if (!TryFindNativeLocalPlaySessionAnimalSite(farm, coop, startTile, mustRemainReachable, out _))
        {
            // A usable world without the animal beats refusing the whole day: this fixture already degrades its prop
            // counts the same way ("placed N of M ... before the ground ran out"), and the fact is visible in this line
            // rather than in a world that silently has one animal fewer.
            this.Monitor.Log(
                $"GameBuddy play-session could not place its animal house: no free footprint keeps the ground and the route from {startTile.X},{startTile.Y}; animal_start=absent",
                LogLevel.Warn);
            return;
        }
        coop.ReloadBuildingData(forUpgrade: false, forConstruction: true);
        coop.daysOfConstructionLeft.Value = 0;
        farm.buildings.Add(coop);
        farm.updateLayout();

        if (coop.GetIndoors() is not AnimalHouse house)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_interior_missing");

        Point door = coop.getPointForHumanDoor();
        // Reachable means WALKABLE-TO, and the door tile itself is a building tile an actor never stands on: the
        // measured fact is an approach tile beside it that the session's own start can walk to, asked with the real
        // building already on the farm.
        Vector2? approach = new[]
            {
                new Vector2(door.X, door.Y + 1), new Vector2(door.X - 1, door.Y),
                new Vector2(door.X + 1, door.Y), new Vector2(door.X, door.Y - 1),
            }
            .Where(tile => farm.isTileOnMap(tile)
                && !farm.buildings.Any(building => building.occupiesTile((int)tile.X, (int)tile.Y))
                && farm.isTilePassable(tile)
                && IsReachableFromStart(farm, startTile, tile))
            .Cast<Vector2?>()
            .FirstOrDefault();
        // The site search SIMULATES the footprint; these two are the same questions asked of the real building. A
        // simulation that disagreed with the world must not cost the day its ground or its way home, so the house goes
        // back off the farm and the world carries one animal fewer - named, not silently.
        string? rejected = approach is null
            ? $"door_unreachable:door={door.X},{door.Y}"
            : mustRemainReachable is { } anchor && !IsReachableFromStart(farm, startTile, anchor)
                ? $"severed_route:door={door.X},{door.Y};anchor={anchor.X},{anchor.Y}"
                : null;
        if (rejected is not null)
        {
            farm.buildings.Remove(coop);
            farm.updateLayout();
            this.Monitor.Log(
                $"GameBuddy play-session removed the animal house it had placed at {coop.tileX.Value},{coop.tileY.Value}: {rejected}; animal_start=absent",
                LogLevel.Warn);
            return;
        }

        FarmAnimal animal = new(PlaySessionAnimalType, Game1.random.Next(int.MaxValue), player.UniqueMultiplayerID);
        house.adoptAnimal(animal);
        if (house.animals.Count() != 1)
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_house_not_single_occupant:{house.animals.Count()}");
        // `FarmAnimal` is constructed a newborn, and the world this fixture declares holds a GROWN animal:
        // `collect_animal_product` publishes only `isAdult()` animals, and the same animal is what `pet_farm_animal`
        // and `feed_animal` reach. `growFully` is the engine's own entry for exactly that transition (what the game calls
        // the morning a baby grows up), and the predicate is asked again after it rather than assumed to follow.
        if (!animal.isAdult())
            animal.growFully(Game1.random);
        if (!animal.isAdult())
            throw new InvalidOperationException("fixture_native_local_play_session_animal_not_adult");
        if (animal.wasPet.Value)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_already_petted");

        int walkableAfter = WalkableComponentSize(farm, startTile);
        this.Monitor.Log(
            "GameBuddy native-local-player initialized play-session animal Given before bridge attachment: "
                + $"building={coop.buildingType.Value};origin={coop.tileX.Value},{coop.tileY.Value};door={door.X},{door.Y};"
                + $"approach={(int)approach!.Value.X},{(int)approach.Value.Y};start={startTile.X},{startTile.Y};"
                + $"walkable_after={walkableAfter};animal={animal.myID.Value};type={animal.type.Value};"
                + $"tile={(int)animal.Tile.X},{(int)animal.Tile.Y};adult={animal.isAdult().ToString().ToLowerInvariant()};"
                + $"friendship={animal.friendshipTowardFarmer.Value};was_pet={animal.wasPet.Value.ToString().ToLowerInvariant()};"
                + $"house_animals={house.animals.Count()};production alone pets, feeds and collects.",
            LogLevel.Info);
    }

    /// <summary>
    /// The first free, walkable-from-the-crossroads footprint for the play-session animal house, measured against the
    /// ground the props actually left.
    ///
    /// <para>
    /// Four facts, each one a live reading rather than a guess: the footprint is on the map with no building, object or
    /// terrain feature on it; the session's start still belongs to a walkable piece of at least
    /// <see cref="PlaySessionMinimumComponentTiles"/> tiles with the footprint BLOCKED (the same simulation the prop
    /// search uses for its own guard, so a building that would fence the day in is refused rather than discovered
    /// afterwards); the coop's door has an approach tile the start can walk to; and, for the composed world, the route
    /// home survives.
    /// </para>
    /// </summary>
    private bool TryFindNativeLocalPlaySessionAnimalSite(
        Farm farm,
        Building building,
        Vector2 startTile,
        Vector2? mustRemainReachable,
        out Vector2 site)
    {
        site = Vector2.Zero;
        xTile.Layers.Layer? back = farm.map?.GetLayer("Back");
        if (back is null)
            return false;
        foreach (Point candidate in PlaySessionFixturePlacement.PlaceableCandidates(
            Enumerable.Range(0, back.LayerWidth)
                .SelectMany(x => Enumerable.Range(0, back.LayerHeight).Select(y => new Point(x, y))),
            new Point((int)startTile.X, (int)startTile.Y)))
        {
            building.tileX.Value = candidate.X;
            building.tileY.Value = candidate.Y;
            List<Vector2> footprint = new();
            bool free = true;
            for (int offsetX = 0; offsetX < building.tilesWide.Value && free; offsetX++)
            {
                for (int offsetY = 0; offsetY < building.tilesHigh.Value && free; offsetY++)
                {
                    Vector2 tile = new(candidate.X + offsetX, candidate.Y + offsetY);
                    free = farm.isTileOnMap(tile)
                        && !farm.objects.ContainsKey(tile)
                        && !farm.terrainFeatures.ContainsKey(tile)
                        && !farm.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y))
                        && farm.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
                    if (free)
                        footprint.Add(tile);
                }
            }
            if (!free)
                continue;
            // The candidate order excludes the actor's own ring, but a footprint is several tiles wide: a building
            // whose ORIGIN is two tiles away can still cover the tile the session starts on.
            if (footprint.Contains(startTile))
                continue;
            // Block the footprint the way a building would and ask the two questions the day depends on. The props are
            // placed the same way for their own guard, so choosing and judging ask one question.
            foreach (Vector2 tile in footprint)
                farm.objects[tile] = ItemRegistry.Create<StardewValley.Object>("(O)2", 1);
            bool keepsGround = WalkableComponentSize(farm, startTile) >= PlaySessionMinimumComponentTiles;
            bool keepsRoute = mustRemainReachable is not { } anchor
                || IsReachableFromStartPessimistic(
                    farm,
                    startTile,
                    anchor,
                    tile => farm.objects.ContainsKey(new Vector2(tile.X, tile.Y)));
            foreach (Vector2 tile in footprint)
                farm.objects.Remove(tile);
            if (!keepsGround || !keepsRoute)
                continue;
            site = new Vector2(candidate.X, candidate.Y);
            return true;
        }
        return false;
    }
}
