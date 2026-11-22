using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The one animal house the play-session world carries. A BARN, and the reason is the day's collect half.
    ///
    /// <para>
    /// IT WAS A COOP, whose smallest-<see cref="AnimalHouse"/> footprint is the easiest to place. A coop cannot supply
    /// `collect_animal_product` at all: that action addresses `animalProductTargets`, whose one admission is
    /// `FarmAnimal.CanGetProduceWithTool` (`farmhandexecutioncontroller.targetdiscovery.cs`), and that answers
    /// `FarmAnimalData.HarvestTool == tool.Name` - which is null for every coop animal (`host/src/protocol.ts`'s
    /// `harvestTool` note: "a hen drops its egg"). A hen's egg is a floor drop, so the coop's produce can never be a
    /// tool target and the day's third step was unreachable by construction, not by chance.
    /// </para>
    /// </summary>
    private const string PlaySessionAnimalBuildingType = "Barn";

    /// <summary>
    /// The one animal inside it: adult, and one whose produce a tool takes (a barn animal's `HarvestTool` is
    /// `Milk Pail`/`Shears`; see <see cref="PlaySessionAnimalType"/>'s own Given below, which also stocks that tool).
    /// </summary>
    private const string PlaySessionAnimalType = "White Cow";

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
    /// `water_pet_bowl` are all declared `animals_pets` in `FarmhandActionDefinitions.cs`, and animal-house stock is the
    /// only target any of them addresses.
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
    /// The play-session world's ANIMAL Given: one BARN holding ONE adult, milking animal, placed where the session's own
    /// crossroads can walk to its door - with the produce it can give and the tool that takes it.
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
    /// THE PRODUCE AND THE TOOL ARE PART OF THE GIVEN, because a house with an animal in it is not the same fact as a
    /// product an action can collect. Measured `round92` day 2 (2026-11-22, `tend_the_animals`): the world held one adult
    /// White Chicken with `currentProduce = null` and a pack with no Milk Pail or Shears, and the observation published
    /// `animalProductTargets: []` - so the day's collect half had nothing to address and the day could not be achieved
    /// however well the companion played it. A HEN NEVER COULD HAVE SUPPLIED IT: `CanGetProduceWithTool` answers
    /// `FarmAnimalData.HarvestTool == tool.Name`, a hen's harvest tool is null (her egg drops on the floor), and the
    /// action addresses tool-collected produce only. Hence a barn animal, and hence this Given states the product and
    /// puts the tool that takes it in the pack.
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
        Building barn = new(PlaySessionAnimalBuildingType, Vector2.Zero);
        if (!TryFindNativeLocalPlaySessionAnimalSite(player, farm, barn, startTile, mustRemainReachable, out _, out string measured))
        {
            // NO SITE IS A REFUSAL, NOT A WORLD WITH ONE ANIMAL FEWER. This used to log a warning and return, and that
            // line is exactly how an animal house could disappear with every gate still green: `tend_the_animals` kept
            // being rotated into a world with no animal in it. The reason is measured - how many free footprints were
            // tried and why each was refused - so "there is nowhere to put it" can be answered rather than assumed.
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_missing:start={startTile.X},{startTile.Y};{measured}");
        }
        barn.ReloadBuildingData(forUpgrade: false, forConstruction: true);
        barn.daysOfConstructionLeft.Value = 0;
        farm.buildings.Add(barn);
        farm.updateLayout();

        if (barn.GetIndoors() is not AnimalHouse house)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_interior_missing");

        Point door = barn.getPointForHumanDoor();
        // The search measured this building while it stood on the farm, and the world has changed since: the layout is
        // updated and the interior exists. The same question is asked of the building the world now holds, so a search
        // and a placement that disagree refuse the whole day BY NAME instead of quietly dropping the animal half.
        string? rejected = RejectsThePlaySessionAnimalBuilding(player, farm, barn, startTile, mustRemainReachable);
        if (rejected is not null)
        {
            farm.buildings.Remove(barn);
            farm.updateLayout();
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_rejected:origin={barn.tileX.Value},{barn.tileY.Value};{rejected}");
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

        // THE PRODUCT, AND WHERE IT COMES FROM. An adult animal with `currentProduce = null` is an animal whose product
        // the day before took, or one no morning has run for: the game sets `currentProduce` in `FarmAnimal.dayUpdate`
        // (`FarmAnimal.cs:1057`), which this fixture never runs. The id is not invented here -
        // `FarmAnimal.GetProduceID` (`:910`) is the engine's own resolver over `Data/FarmAnimals`, including the
        // friendship/condition filter a hand-copied item id would skip.
        if (string.IsNullOrWhiteSpace(animal.currentProduce.Value))
            animal.currentProduce.Value = animal.GetProduceID(Game1.random);
        if (string.IsNullOrWhiteSpace(animal.currentProduce.Value))
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_product_missing:type={animal.type.Value};animal={animal.myID.Value};"
                    + $"friendship={animal.friendshipTowardFarmer.Value}");

        // THE TOOL THE ACTION TAKES ITS SLOT FROM. `collect_animal_product`'s `slot` is the Milk Pail or Shears in the
        // pack (`FarmhandActionDefinitions.cs`: `Finishes(SelfWalked(SlotTarget(ItemSlotMeaning)))`), and discovery
        // publishes a row only for a tool the animal's own `HarvestTool` names - so the compatible tool is part of the
        // Given, exactly as the animal-product scenario's own fixture stocks it.
        Tool collectionTool = animal.CanGetProduceWithTool(new MilkPail()) ? new MilkPail() : new Shears();
        if (!animal.CanGetProduceWithTool(collectionTool))
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_not_collectable:type={animal.type.Value};"
                    + $"harvest_type={animal.GetHarvestType()};milkable={animal.CanGetProduceWithTool(new MilkPail())};"
                    + $"shearable={animal.CanGetProduceWithTool(new Shears())}");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == collectionTool.GetType())
            && player.addItemToInventory(collectionTool) is not null)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_tool_inventory_full");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == collectionTool.GetType()))
            throw new InvalidOperationException("fixture_native_local_play_session_animal_tool_missing_after_add");

        // THE ASSERTION THE ABSENT ANIMAL HOUSE NEEDED, now in both halves. The world must publish the family the
        // `tend_the_animals` day names: `pet_farm_animal` addresses `location.animals` of the house the actor walks into,
        // so the row exists exactly when that house holds a grown animal carrying a real engine id - and that id IS the
        // target id the discovery derives (`BuildFarmAnimalPetTargetId` hashes the location with `animal.myID`). Measured
        // 2026-11-09: with this Given off, the arm log said `animal_start=absent` and no gate anywhere failed. The other
        // half is `animalProductTargets`: `DiscoverAnimalProductTargets` requires adult, a produce id, a tool in the pack
        // that takes it, AND room in that pack for the produce, so each of the four is asked here rather than left to a
        // silent empty family (`round92`: the family was empty and nothing said so).
        FarmAnimal published = house.animals.Values.Single();
        if (published.myID.Value <= 0 || !published.isAdult())
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_family_target_missing:family={PlaySessionAnimalGivenFamily};"
                    + $"animal={published.myID.Value};adult={published.isAdult().ToString().ToLowerInvariant()}");
        string produceQualifiedItemId = "(O)" + published.currentProduce.Value;
        if (!player.couldInventoryAcceptThisItem(produceQualifiedItemId, 1))
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_product_inventory_full:produce={produceQualifiedItemId};"
                    + $"slots={player.MaxItems}");

        int walkableAfter = WalkableComponentSize(farm, startTile);
        this.Monitor.Log(
            "GameBuddy native-local-player initialized play-session animal Given before bridge attachment: "
                + $"building={barn.buildingType.Value};origin={barn.tileX.Value},{barn.tileY.Value};door={door.X},{door.Y};"
                + $"start={startTile.X},{startTile.Y};walkable_after={walkableAfter};"
                + $"family={PlaySessionAnimalGivenFamily};family_targets=1;animal={animal.myID.Value};type={animal.type.Value};"
                + $"tile={(int)animal.Tile.X},{(int)animal.Tile.Y};adult={animal.isAdult().ToString().ToLowerInvariant()};"
                + $"friendship={animal.friendshipTowardFarmer.Value};was_pet={animal.wasPet.Value.ToString().ToLowerInvariant()};"
                + $"house_animals={house.animals.Count()};produce={produceQualifiedItemId};tool={collectionTool.GetType().Name};"
                + "production alone pets, feeds and collects.",
            LogLevel.Info);
    }

    /// <summary>
    /// The play-session world's HAY Given: one stack of Hay in the pack, which is what turns the animal house's troughs
    /// into targets a day can reach.
    ///
    /// <para>
    /// WHY. The animal Given brought the house and one adult animal, and `feed_animal` still had no target in every
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
    /// `measured` is the refusal as a reading - how many free footprints there were, why the first few were refused, and
    /// WHICH rule refused the footprint of the first few origins that had none - so "there is nowhere to put it" is a
    /// measurement an operator can act on rather than a missing animal. The two halves are different questions and both
    /// are needed: `rejected` means the ground was there and the day would not survive the building, `blocked` means the
    /// ground itself was not on offer, naming the tile and the gate (`off_map`, `object`, `terrain_feature`, `building`,
    /// `not_placeable`). A bare `free_footprints=0` distinguishes neither, which is what made round93's refusal
    /// answerable only by re-reading this file.
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
        List<string> blocked = new();
        foreach (Point candidate in PlaySessionFixturePlacement.PlaceableCandidates(
            Enumerable.Range(0, back.LayerWidth)
                .SelectMany(x => Enumerable.Range(0, back.LayerHeight).Select(y => new Point(x, y))),
            new Point((int)startTile.X, (int)startTile.Y)))
        {
            building.tileX.Value = candidate.X;
            building.tileY.Value = candidate.Y;
            List<Vector2> footprint = new();
            string? blocker = null;
            for (int offsetX = 0; offsetX < building.tilesWide.Value && blocker is null; offsetX++)
            {
                for (int offsetY = 0; offsetY < building.tilesHigh.Value && blocker is null; offsetY++)
                {
                    Vector2 tile = new(candidate.X + offsetX, candidate.Y + offsetY);
                    // WHICH gate said no, on WHICH tile. A count of free footprints cannot answer this: measured
                    // `round93` (2026-11-22), the refusal was `free_footprints=0;rejected=none`, and that reads the
                    // same whether the farm has no room or one of these five rules refuses every tile in the world.
                    blocker = !farm.isTileOnMap(tile) ? $"{tile.X},{tile.Y}:off_map"
                        : farm.objects.ContainsKey(tile) ? $"{tile.X},{tile.Y}:object"
                        : farm.terrainFeatures.ContainsKey(tile) ? $"{tile.X},{tile.Y}:terrain_feature"
                        : farm.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y)) ? $"{tile.X},{tile.Y}:building"
                        : !farm.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true) ? $"{tile.X},{tile.Y}:not_placeable"
                        : null;
                    if (blocker is null)
                        footprint.Add(tile);
                }
            }
            if (blocker is not null)
            {
                // Bounded for the same reason `rejected` is: a farm has thousands of candidate origins and the
                // reason only has to be readable.
                if (blocked.Count < 8) blocked.Add($"{candidate.X},{candidate.Y}@{blocker}");
                continue;
            }
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
        measured = $"free_footprints={freeFootprints};rejected={(rejected.Count == 0 ? "none" : string.Join("|", rejected))};"
            + $"blocked={(blocked.Count == 0 ? "none" : string.Join("|", blocked))}";
        return false;
    }
}
