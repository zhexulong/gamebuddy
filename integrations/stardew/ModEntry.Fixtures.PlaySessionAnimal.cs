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

    /// <summary>The one item an animal house trough accepts.</summary>
    private const string PlaySessionHayQualifiedItemId = "(O)178";

    /// <summary>One stack, because a stack is what a player buys - not a silo and not a stockpile.</summary>
    private const int PlaySessionHayStack = 5;

    /// <summary>
    /// The method that installs this Given's targets. Named through `nameof` so the declaration cannot drift from the
    /// method it describes; read by `tools/lib/multiday-task-families.mjs`.
    /// </summary>
    internal const string PlaySessionAnimalGivenProvider = nameof(InstallNativeLocalPlaySessionAnimalGiven);

    /// <summary>
    /// The one TARGET FAMILY this Given makes publishable - the world advertisement the multi-day task gate reads.
    ///
    /// <para>
    /// WHY IT IS DECLARED HERE. `tend_the_animals` is one of the multi-day rotation's days, and the family it names is
    /// `animals_pets`; measured 2026-11-09, this Given was switched off in the composed world and nothing anywhere
    /// failed - a task went on being rotated into a world with no coop in it, and the single-action gate stayed green
    /// because its OWN fixture builds a coop. So the world states what it advertises, and the gate reads it: the entry is
    /// TRUE only while <see cref="InstallNativeLocalPlaySessionAnimalGiven"/> is actually invoked by the composed world,
    /// which the gate asks of this file rather than trusting this comment.
    /// </para>
    ///
    /// <para>
    /// The family name is not a taxonomy invented here: `pet_farm_animal`, `feed_animal`, `collect_animal_product` and
    /// `water_pet_bowl` are all declared `animals_pets` in `FarmhandActionDefinitions.cs`, and coop stock is the only
    /// target any of them addresses.
    /// </para>
    /// </summary>
    internal const string PlaySessionAnimalGivenFamily = "animals_pets";

    /// <summary>
    /// Whether the building NOW ON THE FARM is one the multi-day day cannot work around: its door has no approach the
    /// session can walk to, or the world fails the arm-time assertion with it standing here.
    ///
    /// <para>
    /// Returns null when the day survives, or a named reason when it does not. Both questions are asked with the
    /// composed world's ONE walkability rule (<see cref="NativeLocalMultiDayWalkable"/>), and the route half is not a
    /// second implementation of it - it is <see cref="AssertNativeLocalMultiDayHomeReachable"/> itself, caught. That
    /// assertion is what decides whether the run can start, so a building it would refuse is refused here, with the
    /// measured message it would have thrown; a private copy of "which routes the day needs" is exactly how the bin went
    /// unasked while this search only asked about the field.
    /// </para>
    ///
    /// <para>
    /// IT TAKES THE REAL BUILDING, not a footprint simulated with objects. Adding a stone to every footprint tile left
    /// out what a building actually does to the map (`GameLocation.updateLayout`, the animal door, the collision the
    /// engine answers for `occupiesTile`), so the search could pass a site the engine laid out differently. The caller
    /// therefore keeps the building in `farm.buildings` while this answers.
    /// </para>
    /// </summary>
    private string? RejectsThePlaySessionAnimalBuilding(
        Farmer player,
        Farm farm,
        Building building,
        Vector2 startTile,
        Vector2? mustRemainReachable)
    {
        Point door = building.getPointForHumanDoor();
        // Reachable means WALKABLE-TO, and the door tile itself is a building tile an actor never stands on: the
        // measured fact is an approach tile beside it the session's own start can walk to.
        Point from = new((int)startTile.X, (int)startTile.Y);
        bool approach = new[]
            {
                new Vector2(door.X, door.Y + 1), new Vector2(door.X - 1, door.Y),
                new Vector2(door.X + 1, door.Y), new Vector2(door.X, door.Y - 1),
            }
            .Any(tile => farm.isTileOnMap(tile)
                && NativeLocalMultiDayWalkableFrom(farm, from, new Point((int)tile.X, (int)tile.Y)));
        if (!approach)
            return $"no_approach:door={door.X},{door.Y}";
        // The composed world is the one that insists on the route home; a plain play-session world has no such promise to
        // keep, and asking it there would refuse every site in a farm whose porch and crossroads are different pieces.
        if (mustRemainReachable is null)
            return null;
        try
        {
            AssertNativeLocalMultiDayHomeReachable(player, farm);
            return null;
        }
        catch (InvalidOperationException refused)
        {
            return $"arm_refused:door={door.X},{door.Y};{refused.Message}";
        }
    }

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
        if (!TryFindNativeLocalPlaySessionAnimalSite(player, farm, coop, startTile, mustRemainReachable, out _, out string measured))
        {
            // NO SITE IS A REFUSAL, NOT A WORLD WITH ONE ANIMAL FEWER. This used to log a warning and return, and that
            // line is exactly how a coop could disappear with every gate still green: `tend_the_animals` kept being
            // rotated into a world with no animal in it. The reason is measured - how many free footprints were tried
            // and why each was refused - so "there is nowhere to put it" can be answered rather than assumed.
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_missing:start={startTile.X},{startTile.Y};{measured}");
        }
        coop.ReloadBuildingData(forUpgrade: false, forConstruction: true);
        coop.daysOfConstructionLeft.Value = 0;
        farm.buildings.Add(coop);
        farm.updateLayout();

        if (coop.GetIndoors() is not AnimalHouse house)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_interior_missing");

        Point door = coop.getPointForHumanDoor();
        // The search measured this building while it stood on the farm, and the world has changed since: the layout is
        // updated and the interior exists. The same question is asked of the building the world now holds, so a search
        // and a placement that disagree refuse the whole day BY NAME instead of quietly dropping the animal half.
        string? rejected = RejectsThePlaySessionAnimalBuilding(player, farm, coop, startTile, mustRemainReachable);
        if (rejected is not null)
        {
            farm.buildings.Remove(coop);
            farm.updateLayout();
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_rejected:origin={coop.tileX.Value},{coop.tileY.Value};{rejected}");
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

        // THE ASSERTION THE ABSENT COOP NEEDED. The world must now publish the family the `tend_the_animals` day names:
        // `pet_farm_animal` addresses `location.animals` of the house the actor walks into, so the row exists exactly when
        // that house holds a grown animal carrying a real engine id - and that id IS the target id the discovery derives
        // (`BuildFarmAnimalPetTargetId` hashes the location with `animal.myID`). Measured 2026-11-09: with this Given off,
        // the arm log said `animal_start=absent` and no gate anywhere failed.
        FarmAnimal published = house.animals.Values.Single();
        if (published.myID.Value <= 0 || !published.isAdult())
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_family_target_missing:family={PlaySessionAnimalGivenFamily};"
                    + $"animal={published.myID.Value};adult={published.isAdult().ToString().ToLowerInvariant()}");

        int walkableAfter = WalkableComponentSize(farm, startTile);
        this.Monitor.Log(
            "GameBuddy native-local-player initialized play-session animal Given before bridge attachment: "
                + $"building={coop.buildingType.Value};origin={coop.tileX.Value},{coop.tileY.Value};door={door.X},{door.Y};"
                + $"start={startTile.X},{startTile.Y};walkable_after={walkableAfter};"
                + $"family={PlaySessionAnimalGivenFamily};family_targets=1;animal={animal.myID.Value};type={animal.type.Value};"
                + $"tile={(int)animal.Tile.X},{(int)animal.Tile.Y};adult={animal.isAdult().ToString().ToLowerInvariant()};"
                + $"friendship={animal.friendshipTowardFarmer.Value};was_pet={animal.wasPet.Value.ToString().ToLowerInvariant()};"
                + $"house_animals={house.animals.Count()};production alone pets, feeds and collects.",
            LogLevel.Info);
    }

    /// <summary>
    /// The play-session world's HAY Given: one stack of Hay in the pack, which is what turns the coop's troughs into
    /// targets a day can reach.
    ///
    /// <para>
    /// WHY. The coop Given brought the house and one adult animal, and `feed_animal` still had no target in every
    /// multi-day run: `DiscoverFeedTroughTargets` (farmhandexecutioncontroller.cs:4178) publishes a trough only for a
    /// pack stack of `(O)178`, and the play-session world carried none. The action was in the catalog and unreachable in
    /// the world it was advertised for.
    /// </para>
    ///
    /// <para>
    /// NO SILO, because feeding does not go through one. `AnimalHouse.checkAction` (AnimalHouse.cs:58-69) takes the
    /// Hay from the actor's own hand - the empty trough tile is filled with `who.ActiveObject.getOne()` and
    /// `reduceActiveItemByOne()` charges the pack - while the silo pool is a different route that only
    /// `AnimalHouse.feedAllAnimals` (AnimalHouse.cs:195-224, via `GameLocation.GetHayFromAnySilo`, GameLocation.cs:16482)
    /// and the hay hopper read. So a stack in the pack is not a shortcut around the engine; it is the exact item the
    /// native seam consumes.
    /// </para>
    ///
    /// <para>
    /// A REAL PLAYER CAN BE IN THIS WORLD ON DAY ONE. The hay is bought, not conjured: `Data/Shops` shop `AnimalShop`
    /// (owner Marnie) lists `(O)178` at 50g with unlimited stock and no condition on the entry (measured 2026-11-09 by
    /// loading the shipped `Content/Data/Shops.xnb`). One stack is therefore a Given the engine already permits.
    /// </para>
    ///
    /// <para>
    /// IDEMPOTENT, AND ONLY HAY. A world that already holds Hay keeps exactly what it holds - no second stack, no
    /// backpack growth, no tools, no animal change. A pack with no room is a NAMED refusal rather than a world carrying
    /// one affordance fewer: an advertised `feed_animal` with no target for the whole session is the defect this Given
    /// exists to remove, so it must not be reproduced silently.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPlaySessionHayGiven(Farmer player)
    {
        StardewValley.Object? hay = player.Items.OfType<StardewValley.Object>()
            .FirstOrDefault(item => string.Equals(item.QualifiedItemId, PlaySessionHayQualifiedItemId, StringComparison.Ordinal) && item.Stack > 0);
        if (hay is null)
        {
            if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(PlaySessionHayQualifiedItemId, PlaySessionHayStack)) is not null)
                throw new InvalidOperationException("fixture_native_local_play_session_hay_inventory_full");
            hay = player.Items.OfType<StardewValley.Object>()
                .FirstOrDefault(item => string.Equals(item.QualifiedItemId, PlaySessionHayQualifiedItemId, StringComparison.Ordinal) && item.Stack > 0)
                ?? throw new InvalidOperationException("fixture_native_local_play_session_hay_missing_after_add");
        }

        // The stack is asked about AFTER the write, not assumed from it: `addItemToInventory` returns the leftover item
        // and a merged or refused add is exactly what a silent pass would hide.
        int slot = player.Items.IndexOf(hay);
        if (slot < 0 || hay.Stack < 1)
            throw new InvalidOperationException($"fixture_native_local_play_session_hay_slot_unresolved:slot={slot};stack={hay.Stack}");
        int hayTotal = player.Items.OfType<StardewValley.Object>()
            .Where(item => string.Equals(item.QualifiedItemId, PlaySessionHayQualifiedItemId, StringComparison.Ordinal))
            .Sum(item => item.Stack);
        this.Monitor.Log(
            "GameBuddy native-local-player initialized play-session hay Given before bridge attachment: "
                + $"hay_item={hay.QualifiedItemId};slot={slot};stack={hay.Stack};hay_total={hayTotal};silo=none;"
                + "troughs are the animal house interior's own; production alone places the hay.",
            LogLevel.Info);
    }

    /// <summary>
    /// The first free footprint whose REAL building leaves the day its ground and its route, measured on the farm.
    ///
    /// <para>
    /// Three facts, each one a live reading rather than a guess: the footprint is on the map with no building, object or
    /// terrain feature on it and does not cover the tile the session starts on; the session's start still belongs to a
    /// walkable piece of at least <see cref="PlaySessionMinimumComponentTiles"/> tiles with the building standing on it;
    /// and <see cref="RejectsThePlaySessionAnimalBuilding"/> passes - the door has an approach the start can walk to and
    /// the porch still reaches the field.
    /// </para>
    ///
    /// <para>
    /// THE BUILDING IS ADDED TO THE FARM AND REMOVED AGAIN, rather than simulated with stones on its footprint. Measured
    /// 2026-11-09: the simulation and the engine disagreed about the same site, this search certified a coop that severed
    /// door->field, and the arm-time assertion then refused the whole run - so the day had no animal at all and nothing
    /// said why. A simulated blocker is not the question; the collision the engine answers for a real building is.
    /// </para>
    ///
    /// <para>
    /// `measured` is the refusal as a reading - how many free footprints there were and why the first few were refused -
    /// so "there is nowhere to put it" is a measurement an operator can act on rather than a missing animal.
    /// </para>
    /// </summary>
    private bool TryFindNativeLocalPlaySessionAnimalSite(
        Farmer player,
        Farm farm,
        Building building,
        Vector2 startTile,
        Vector2? mustRemainReachable,
        out Vector2 site,
        out string measured)
    {
        site = Vector2.Zero;
        measured = "no_candidate";
        xTile.Layers.Layer? back = farm.map?.GetLayer("Back");
        if (back is null)
        {
            measured = "farm_has_no_back_layer";
            return false;
        }
        int freeFootprints = 0;
        List<string> rejected = new();
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
            freeFootprints += 1;
            // Stand the real building on the real farm, ask the composed world's own question, and take it down again.
            // The same footprint measured with stones on it asked a different question and got a different answer.
            //
            // FINISHED, because that is how the world will hold it: an under-construction footprint answers the collision
            // question for a work site (`Building.isTilePassable` short-circuits on it), so the door and animal-door tiles
            // would read differently here than after the day has built it.
            building.daysOfConstructionLeft.Value = 0;
            farm.buildings.Add(building);
            int fieldComponent = WalkableComponentSize(farm, startTile);
            string? rejection = fieldComponent >= PlaySessionMinimumComponentTiles
                ? RejectsThePlaySessionAnimalBuilding(player, farm, building, startTile, mustRemainReachable)
                : $"field_component_too_small:{fieldComponent}";
            farm.buildings.Remove(building);
            if (rejection is not null)
            {
                // Bounded, because a farm has thousands of candidate origins and the reason only has to be readable.
                if (rejected.Count < 8) rejected.Add($"{candidate.X},{candidate.Y}:{rejection}");
                continue;
            }
            site = new Vector2(candidate.X, candidate.Y);
            return true;
        }
        measured = $"free_footprints={freeFootprints};rejected={(rejected.Count == 0 ? "none" : string.Join("|", rejected))}";
        return false;
    }
}
