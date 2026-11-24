using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;
using StardewValley.TerrainFeatures;
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
    /// unasked while the old site search only asked about the field.
    /// </para>
    ///
    /// <para>
    /// IT TAKES THE REAL BUILDING, not a footprint simulated with objects. Adding a stone to every footprint tile left
    /// out what a building actually does to the map (`GameLocation.updateLayout`, the animal door, the collision the
    /// engine answers for `occupiesTile`), so a simulated footprint could certify a site the engine lays out differently.
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
        // measured fact is an approach tile beside it the anchor can walk to.
        //
        // THE ANCHOR IS THE ONE THE SITE WAS BUILT FROM. This block used to ask from the session's spawn tile while
        // `PlaySessionAnimalFixedSite` placed the barn one offset from the FARMHOUSE door - two anchors, one question -
        // and measured `round99`: `no_approach:door=68,21;from=4,39`, a free apron tile at `68,22` that the farmhouse
        // front door reaches in six tiles and the spawn tile sixty away could not reach at all. The road the day walks
        // is the farmhouse one (asserted separately, below, from `mustRemainReachable`), so the approach is asked from
        // that same tile and a spawn point cannot refuse a world the day can use.
        Point from = mustRemainReachable is { } anchor
            ? new Point((int)anchor.X, (int)anchor.Y)
            : NativeLocalMultiDayDoorStandingSpot(player, farm);
        // The four tiles are asked one by one and each answer is kept: a bare `no_approach:door=68,21` said a door
        // could not be used while naming neither the ring tile that was standing-room nor what stood there, and
        // `round99` spent five launches between "the map walls it", "a prop took it" and "the site is wrong"
        // because the refusal carried none of the three.
        List<(Vector2 Tile, string Why)> ring = PlaySessionAnimalDoorApproach(farm, building)
            .Select(tile =>
            {
                Point point = new((int)tile.X, (int)tile.Y);
                string kind = NativeLocalMultiDayTileKind(farm, point);
                bool reachable = NativeLocalMultiDayWalkableFrom(farm, from, point);
                return (tile, $"{point.X},{point.Y}:kind={kind}:reachable={(reachable ? "true" : "false")}");
            })
            .ToList();
        bool approach = ring.Exists(entry => entry.Why.EndsWith(":reachable=true", StringComparison.Ordinal));
        if (!approach)
        {
            return $"{PlaySessionAnimalNoApproachRefusal}:door={door.X},{door.Y};from={from.X},{from.Y};ring=[{string.Join("|", ring.Select(entry => entry.Why))}]";
        }
        // THE ROAD THE DAY WALKS TO THIS HOUSE, from the tile it begins at: the farmhouse door when the composed world
        // promises one, the session's own start otherwise. It is asked HERE, of the building standing on the fixed site,
        // because the props below can only be held off a road this file has measured - and a road the map walls off is
        // refused by name instead of being walked around.
        Point routeFrom = mustRemainReachable is { } home ? new Point((int)home.X, (int)home.Y) : from;
        NativeLocalMultiDayRoad route = NativeLocalMultiDayAnimalPorchRoad(
            routeFrom,
            door,
            NativeLocalMultiDayWalkable(farm),
            tile => NativeLocalMultiDayTileKind(farm, tile));
        if (route.Unmeasured)
            return $"{PlaySessionAnimalRouteUnmeasuredRefusal}:door={door.X},{door.Y};route_from={routeFrom.X},{routeFrom.Y}";
        if (route.Tiles.Count == 0)
        {
            return $"{PlaySessionAnimalRouteBlockedRefusal}:door={door.X},{door.Y};route_from={routeFrom.X},{routeFrom.Y};"
                + $"route_blocked_by={route.BlockedBy}@{route.BlockedAt.X},{route.BlockedAt.Y}";
        }
        // The composed world is the one that insists on the route home; a plain play-session world has no such promise to
        // keep, and asking it there would refuse every site in a farm whose porch and crossroads are different pieces.
        if (mustRemainReachable is null)
            return null;
        try
        {
            // This building's own door, because it is the one standing in `farm.buildings` right now: the
            // question is whether the world can walk to this house's porch, not to whatever was sited last.
            AssertNativeLocalMultiDayHomeReachable(player, farm, door);
            return null;
        }
        catch (InvalidOperationException refused)
        {
            return $"{PlaySessionAnimalArmRefusedRefusal}:door={door.X},{door.Y};{refused.Message}";
        }
    }

    /// <summary>
    /// WHERE THE BARN STANDS, as a FIXED offset from the tile a farmer stands on when they leave the farmhouse: one tile
    /// east and three tiles south, which puts the barn's door row in the yard in front of the house.
    ///
    /// <para>
    /// THE SITE IS GIVEN, NOT SEARCHED FOR. `tend_the_animals` is a day about the animals beside the house the companion
    /// sleeps in, and the search this replaced stood the house wherever a seven-by-four footprint happened to be free.
    /// Measured across six launches (2026-11-22/23): no ground at `56,11` (the fixture's own spread soil), then no vacancy
    /// under the props, then `object=2332` of 5195 candidates counted as walls, and finally a barn at `origin=5,34` whose
    /// door stood sixty tiles from the farmhouse porch (`animal_building_unreachable_from_house:door=66,15;porch=6,37`).
    /// Every repair answered a footprint the search had picked; the farm never had to hold a house there at all. A real
    /// farm has one a few steps from its front door.
    /// </para>
    ///
    /// <para>
    /// THE ANCHOR IS THE DAY'S OWN DOOR. <see cref="NativeLocalMultiDayDoorStandingSpot"/> is the tile the composed
    /// world's route assertion starts from, so the site and the walk to it cannot be about two different farmhouses.
    /// </para>
    /// </summary>
    private static readonly Vector2 PlaySessionAnimalHouseDoorOffset = new(1f, 3f);

    /// <summary>
    /// The play-session world's ANIMAL Given: one BARN holding ONE adult, milking animal, standing at a fixed site beside
    /// the farmhouse - with the produce it can give and the tool that takes it.
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
    /// action addresses tool-collected produce only. Hence a barn, and hence this Given states the product and puts the
    /// tool that takes it in the pack.
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
    /// <c>Build</c>/<c>ForceBuild</c> route nor <c>buildStructure</c> with <c>skipSafetyChecks</c> is used here: the site
    /// is judged by the engine's own placement rule before the building stands on it.
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
        // (1) THE ROW, from the engine's own table: the type id names a `Data/Buildings` entry, and a world without it is
        // refused by name rather than given a building invented here (see `RequireNativeLocalPlaySessionAnimalBuildingData`).
        BuildingData data = RequireNativeLocalPlaySessionAnimalBuildingData();
        Building barn = new(PlaySessionAnimalBuildingType, Vector2.Zero);
        barn.ReloadBuildingData(forUpgrade: false, forConstruction: true);

        // (2) THE SITE, a fixed offset from the farmhouse door rather than a footprint found by searching the farm.
        Point site = PlaySessionAnimalFixedSite(player, farm, out Point houseDoor);
        barn.tileX.Value = site.X;
        barn.tileY.Value = site.Y;
        // FINISHED, because that is how the world will hold it: an under-construction footprint answers the collision
        // question for a work site (`Building.isTilePassable` short-circuits on it), so the door and animal-door tiles
        // would read differently here than after the day has built it.
        barn.daysOfConstructionLeft.Value = 0;

        Point door = barn.getPointForHumanDoor();
        List<Vector2> footprint = PlaySessionAnimalFootprint(barn, site);
        // THE TWO THINGS THE DAY NEEDS FREE, and only those: the tiles the house stands on, and the ring its door is used
        // from. What a player sweeps before building is cleared; what only a destructive swing opens refuses the day by
        // name (`ClearPlaySessionAnimalSite`).
        List<Vector2> ring = PlaySessionFixturePlacement.DoorApproachTiles(door)
            .Select(tile => new Vector2(tile.X, tile.Y))
            .ToList();
        int cleared = ClearPlaySessionAnimalSite(farm, footprint, ring, site, door);

        // (3) THE ENGINE'S OWN PLACEMENT RULE, asked of the fixed tile: `buildStructure`'s footprint, its additional
        // placement tiles and its human-door rule, tile for tile (see `FindFarmBuildingSiteBlockage`). A tile it refuses
        // is where this Given stops, naming the tile and the rule: the fixed tile is not placeable, and no repair loop is
        // run to find one that is - a task the world cannot hold is a rotation defect, not a launch defect.
        if (ExecutionManager.FindFarmBuildingSiteBlockage(farm, data, site.X, site.Y) is { } blocked)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_blocked:row={PlaySessionAnimalBuildingType};origin={site.X},{site.Y};"
                    + $"tile={blocked.X},{blocked.Y};rule={blocked.Why}");
        }

        farm.buildings.Add(barn);
        farm.updateLayout();

        if (barn.GetIndoors() is not AnimalHouse house)
            throw new InvalidOperationException("fixture_native_local_play_session_animal_interior_missing");

        // THE WORLD THE BUILDING NOW STANDS IN, asked again: the layout is updated and the interior exists, so the
        // building the farm holds is the one the day's actions will address. A door with no approach, or a porch the
        // farmhouse can no longer walk to, refuses the whole day BY NAME instead of quietly dropping the animal half.
        string? rejected = RejectsThePlaySessionAnimalBuilding(player, farm, barn, startTile, mustRemainReachable);
        if (rejected is not null)
        {
            farm.buildings.Remove(barn);
            farm.updateLayout();
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_rejected:origin={barn.tileX.Value},{barn.tileY.Value};{rejected}");
        }
        // Remembered for the composed world's own assertion, which runs after the props exist (see
        // `nativeLocalPlaySessionAnimalDoor`): the door of the house that actually stands here.
        this.nativeLocalPlaySessionAnimalDoor = door;
        // THE ROAD THE DAY WALKS TO THIS HOUSE, held exactly like the ground it stands on: the props are placed nearest
        // the session's start first, so without the road in this list the next prop takes a tile between the farmhouse
        // and the porch and the arm-time assertion then refuses a world whose parts were each placed lawfully - measured
        // 2026-11-23, the launch after the mannequin fix: `play-session dropped 1 prop(s) a later placement cut off: 9,33`,
        // then `animal_building_unreachable_from_house:door=66,15;porch=6,37`.
        //
        // It is the walk `RejectsThePlaySessionAnimalBuilding` just accepted this building by
        // (`NativeLocalMultiDayAnimalPorchRoad`, the world's one walkability rule), so the road the props are held off and
        // the road the arm-time assertion walks cannot be two roads. If they ever disagree the day is refused by name
        // rather than armed on a world with no way to its animals.
        Point routeFrom = mustRemainReachable is { } home
            ? new Point((int)home.X, (int)home.Y)
            : NativeLocalMultiDayDoorStandingSpot(player, farm);
        NativeLocalMultiDayRoad route = NativeLocalMultiDayAnimalPorchRoad(
            routeFrom,
            door,
            NativeLocalMultiDayWalkable(farm),
            tile => NativeLocalMultiDayTileKind(farm, tile));
        if (route.Unmeasured)
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_route_unmeasured:door={door.X},{door.Y};route_from={routeFrom.X},{routeFrom.Y}");
        if (route.Tiles.Count == 0)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_route_blocked:door={door.X},{door.Y};route_from={routeFrom.X},{routeFrom.Y};"
                    + $"route_blocked_by={route.BlockedBy}@{route.BlockedAt.X},{route.BlockedAt.Y}");
        }
        // AND THE GROUND IT NEEDS KEPT FREE. The road is part of the same list as the footprint and the ring, not a
        // second one: what the props may not take is one set of tiles.
        this.nativeLocalPlaySessionAnimalHeldTiles = PlaySessionFixturePlacement.TilesHeldByBuilding(
            footprint,
            door,
            route.Tiles);

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
                + $"building={barn.buildingType.Value};row={PlaySessionAnimalBuildingType};"
                + $"size={barn.tilesWide.Value}x{barn.tilesHigh.Value};origin={barn.tileX.Value},{barn.tileY.Value};"
                + $"door={door.X},{door.Y};house_door={houseDoor.X},{houseDoor.Y};"
                // HOW FAR THE DAY WALKS TO ITS ANIMALS: the door's tile distance from the farmhouse porch, and the road
                // the props are held off. A barn two steps away makes `tend_the_animals` a real day; one across the farm
                // makes it a walk, and this line says which world was armed.
                + $"door_distance={Math.Max(Math.Abs(door.X - houseDoor.X), Math.Abs(door.Y - houseDoor.Y))};"
                + $"start={startTile.X},{startTile.Y};walkable_after={walkableAfter};cleared={cleared};"
                + $"route_from={routeFrom.X},{routeFrom.Y};route_held={route.Tiles.Count}tiles;"
                + $"animal_house_held={this.nativeLocalPlaySessionAnimalHeldTiles.Count};"
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
    /// The first wall in a footprint, with the tile it stands on and whether the site needs the clearing.
    ///
    /// <para>
    /// ONE PASS, ONE ANSWER, so the two places that ask the question - the site's admission and the tile-by-tile re-read
    /// the clearing leaves behind - cannot drift into two loops that break at different tiles or count different
    /// walls.
    /// </para>
    /// </summary>
    private static string? PlaySessionAnimalFootprintFirstWall(
        GameLocation location,
        IEnumerable<Vector2> footprint,
        out Vector2 refusedTile,
        out bool clearing)
    {
        refusedTile = Vector2.Zero;
        clearing = false;
        foreach (Vector2 tile in footprint)
        {
            string? wall = PlaySessionAnimalFootprintWall(location, tile, out _, out string clearer);
            if (wall is not null)
            {
                refusedTile = tile;
                return wall;
            }
            clearing |= clearer.Length > 0;
        }
        return null;
    }


    /// <summary>The refusal a site gets when its door has no approach the session's start can walk to.</summary>
    private const string PlaySessionAnimalNoApproachRefusal = "no_approach";

    /// <summary>
    /// The refusal a site gets when something the fixture cannot move walls the road from the farmhouse to that door -
    /// a bush, another building, or the map itself. The rejection carries `route_blocked_by=&lt;kind&gt;@x,y`, the tile and
    /// what stands there in the vocabulary a refusal receipt publishes, so the next reader does not have to re-derive
    /// which of the four neighbours of the frontier was the wall.
    /// </summary>
    internal const string PlaySessionAnimalRouteBlockedRefusal = "route_blocked";

    /// <summary>
    /// The refusal a site gets when the road probe gave up before it could answer - the third zero, kept apart from both
    /// "there is a road" and "the map walls it": a flood that exceeded its budget is no claim, and no site is chosen on a
    /// claim the probe declined to make.
    /// </summary>
    internal const string PlaySessionAnimalRouteUnmeasuredRefusal = "route_unmeasured";

    /// <summary>
    /// A tile the house may not stand on for a reason that has nothing to do with what occupies it: the map's own edge, a
    /// building already there, or ground `CanItemBePlacedHere` refuses. Named here so the three are told apart from the
    /// occupants.
    /// </summary>
    internal const string PlaySessionAnimalOffMapRefusal = "off_map";

    private const string PlaySessionAnimalBuildingRefusal = "building";

    internal const string PlaySessionAnimalNotPlaceableRefusal = "not_placeable";

    /// <summary>
    /// A tile the clearing would have had to destroy: the only published action that removes its occupant is declared
    /// destructive (<see cref="FarmhandClearingDeclaration.Destructive"/>), so the swing would level what the player put
    /// there. A fixture may not spend that, and it says which swing instead of quietly skipping the tile.
    /// </summary>
    internal const string PlaySessionAnimalDestructiveClearRefusal = "no_safe_clear";

    /// <summary>
    /// A tile the fixture TRIED to clear and did not come free of. Its own name rather than the occupant that is left
    /// behind, because "the clearing failed" and "nothing can clear this" are two different reports.
    /// </summary>
    internal const string PlaySessionAnimalClearingFailedRefusal = "clearing_failed";

    /// <summary>
    /// What stands on one footprint tile, as the FIXTURE sees it: the wall rule that refuses the tile, or null with the
    /// occupant word and the published action that clears it (`clearer` empty when the tile is already free).
    ///
    /// <para>
    /// ONE VOCABULARY, TWO READS. What stands on the tile is <see cref="TileOccupancy.Of"/> - the same classifier the
    /// rectangle query and the `where.occupant` filter answer with - and whether that is a wall is
    /// <see cref="ClearingActionSurface.ClearersOf"/> over <see cref="FarmhandActionCatalog.Registrations"/>, the join the
    /// route refusals already use. No kind-to-action table lives here, and none could: the answer is the catalogue's own
    /// `Clears` declaration, so a row that stops accepting an occupant stops opening this tile in the same commit.
    /// </para>
    /// <para>
    /// THE ORDER IS OCCUPANT FIRST, THEN WHAT THE MAP ALLOWS. A weed on water is the weed's report, not `not_placeable`'s,
    /// because the weed is what the caller can act on before the second question is asked. The three non-occupant walls
    /// keep their own words: `off_map` for a tile the map does not hold, `building` for a house already standing there, and
    /// `not_placeable` for water, a cliff, a floor the map does not accept an object on, or a tile a clump's own footprint
    /// covers without holding its origin.
    /// </para>
    /// </summary>
    internal static string? PlaySessionAnimalFootprintWall(GameLocation location, Vector2 tile, out string occupant, out string clearer)
    {
        occupant = TileOccupantKind.None;
        clearer = string.Empty;
        if (!location.isTileOnMap(tile))
            return PlaySessionAnimalOffMapRefusal;
        occupant = TileOccupancy.Of(location, (int)tile.X, (int)tile.Y);
        if (occupant != TileOccupantKind.None)
        {
            IReadOnlyList<FarmhandClearingOffer> clearers =
                ClearingActionSurface.ClearersOf(occupant, FarmhandActionCatalog.Registrations);
            if (clearers.Count == 0)
                return occupant;
            // NOTHING IT WOULD HAVE TO DESTROY IS OPENED: the destructive filter is
            // `FarmhandForEachHealing.ClearanceFor`'s own rule, in this file's words rather than a second spelling of the
            // question.
            FarmhandClearingOffer? safe = clearers.FirstOrDefault(offer => !offer.Destructive);
            if (safe is null)
                return $"{PlaySessionAnimalDestructiveClearRefusal}:{occupant}:{clearers[0].ActionId}";
            clearer = safe.ActionId;
            return null;
        }
        if (location.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y)))
            return PlaySessionAnimalBuildingRefusal;
        return location.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true)
            ? null
            : PlaySessionAnimalNotPlaceableRefusal;
    }

    /// <summary>
    /// The clearing <see cref="PlaySessionAnimalFootprintWall"/> just promised, performed on the layers the classifier
    /// read and then RE-READ tile by tile.
    ///
    /// <para>
    /// It is the occupant's removal, not a swing: this fixture has no actor, no pack and no stamina, and the day's own
    /// actions are the only bodies allowed to earn a receipt. What a player's swing leaves is what this leaves - the
    /// occupant out of the layer it stood in (`Object.performToolAction`'s weed and stone branches, the clump's own
    /// teardown) - and the reading states it as `cleared=`, so the log never claims the farm came that way.
    /// </para>
    /// <para>
    /// A REMOVAL THAT DOES NOT COME FREE IS NAMED, NOT SHRUGGED AT: the tile is re-asked through the same classifier, and
    /// an occupant still standing there returns the running count with the failure detail
    /// (`<occupant>@x,y:-><what is left>`). The caller refuses the site and stops - the alternative was to place the
    /// house on whatever the removal missed.
    /// </para>
    /// </summary>
    internal static int ClearPlaySessionAnimalFootprint(
        GameLocation location,
        IEnumerable<Vector2> footprint,
        Dictionary<string, int> clearedKinds,
        out string? failure)
    {
        int cleared = 0;
        failure = null;
        foreach (Vector2 tile in footprint)
        {
            string occupant = TileOccupancy.Of(location, (int)tile.X, (int)tile.Y);
            if (occupant == TileOccupantKind.None)
                continue;
            if (!location.objects.Remove(tile)
                && !location.terrainFeatures.Remove(tile)
                && location.resourceClumps.RemoveWhere(clump => clump.occupiesTile((int)tile.X, (int)tile.Y)) == 0)
            {
                failure = $"{occupant}@{tile.X},{tile.Y}:not_in_the_layer_that_named_it";
                return cleared;
            }
            string after = TileOccupancy.Of(location, (int)tile.X, (int)tile.Y);
            if (after != TileOccupantKind.None)
            {
                failure = $"{occupant}@{tile.X},{tile.Y}:->{after}";
                return cleared;
            }
            clearedKinds[occupant] = clearedKinds.TryGetValue(occupant, out int seen) ? seen + 1 : 1;
            cleared += 1;
        }
        return cleared;
    }

    /// <summary>
    /// The refusal a site gets when its door is approachable but the farmhouse can no longer walk to that porch - the
    /// building's own footprint can be what stands in the way.
    /// </summary>
    private const string PlaySessionAnimalArmRefusedRefusal = "arm_refused";



    /// <summary>The tiles the building would stand on if its top-left corner were at this origin.</summary>
    private static List<Vector2> PlaySessionAnimalFootprint(Building building, Point origin)
    {
        List<Vector2> footprint = new();
        for (int offsetX = 0; offsetX < building.tilesWide.Value; offsetX++)
            for (int offsetY = 0; offsetY < building.tilesHigh.Value; offsetY++)
                footprint.Add(new Vector2(origin.X + offsetX, origin.Y + offsetY));
        return footprint;
    }

    /// <summary>
    /// The tiles an actor stands on to use the building's door, asked by <see cref="RejectsThePlaySessionAnimalBuilding"/>:
    /// an approach tile the session's start can walk to is what "the door is usable" means. The ring itself is
    /// <see cref="PlaySessionFixturePlacement.DoorApproachTiles"/>, because the same four tiles are what the props may
    /// not take once the house stands on them.
    /// </summary>
    private static List<Vector2> PlaySessionAnimalDoorApproach(GameLocation farm, Building building)
    {
        Point door = building.getPointForHumanDoor();
        return PlaySessionFixturePlacement.DoorApproachTiles(door)
            .Select(tile => new Vector2(tile.X, tile.Y))
            .Where(tile => farm.isTileOnMap(tile))
            .ToList();
    }

    /// <summary>
    /// The `Data/Buildings` row the play-session animal house is built from, or a named refusal when the table has no
    /// such row.
    ///
    /// <para>
    /// AN OBJECT AUTHORED OUTSIDE THE ENGINE'S TABLE IS ONE THE ENGINE CANNOT PLACE. The mannequin crash taught it -
    /// `Mannequin` has no `Data/Mannequins` row while `MannequinMale` does, and the hand-built one could not be drawn -
    /// and a building has the same rule: the row IS the footprint, the human door, the indoor map and the animal-house
    /// type this Given then asserts. The row is read here rather than assumed from the type id, so a world whose
    /// `Data/Buildings` has no such row refuses by name instead of standing a building the engine knows nothing about.
    /// </para>
    /// </summary>
    private static BuildingData RequireNativeLocalPlaySessionAnimalBuildingData()
    {
        if (Game1.buildingData is null || Game1.buildingData.Count == 0)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_building_table_missing:table=Data/Buildings;row={PlaySessionAnimalBuildingType}");
        }
        if (!Game1.buildingData.TryGetValue(PlaySessionAnimalBuildingType, out BuildingData? row) || row is null)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_building_row_missing:table=Data/Buildings;row={PlaySessionAnimalBuildingType}");
        }
        if (row.Size.X <= 0 || row.Size.Y <= 0 || row.HumanDoor == new Point(-1, -1))
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_building_row_unusable:row={PlaySessionAnimalBuildingType};"
                    + $"size={row.Size.X},{row.Size.Y};human_door={row.HumanDoor.X},{row.HumanDoor.Y}");
        }
        return row;
    }

    /// <summary>
    /// The barn's top-left corner: <see cref="PlaySessionAnimalHouseDoorOffset"/> from the tile a farmer stands on when
    /// they leave the farmhouse - the same tile the composed world's route assertion starts from
    /// (<see cref="NativeLocalMultiDayDoorStandingSpot"/>), so the site and the walk to it cannot be about two doors.
    /// </summary>
    private static Point PlaySessionAnimalFixedSite(Farmer player, Farm farm, out Point houseDoor)
    {
        houseDoor = NativeLocalMultiDayDoorStandingSpot(player, farm);
        return new Point(
            houseDoor.X + (int)PlaySessionAnimalHouseDoorOffset.X,
            houseDoor.Y + (int)PlaySessionAnimalHouseDoorOffset.Y);
    }

    /// <summary>
    /// The footprint and the door ring the house owns, cleared of what a published action opens and of nothing else.
    ///
    /// <para>
    /// TWO LISTS, ONE PASS. A tile is first judged by <see cref="PlaySessionAnimalFootprintWall"/> - the classifier the
    /// rectangle query and the `where.occupant` filter answer with - so a tile no published action opens (a grassy tuft
    /// whose only swing is destructive, a bush, an object with its own action) refuses the whole day BY NAME with the
    /// tile and the reason, rather than being quietly built over. What is left is ground a player sweeps before
    /// building, and <see cref="ClearPlaySessionAnimalFootprint"/> takes exactly that off the farm.
    /// </para>
    ///
    /// <para>
    /// THE RING IS CLEARED WITH THE FOOTPRINT because it is the same question one tile further out: the door's four
    /// neighbour tiles are where the actor stands to use the house, and a weed on one of them is a door the day cannot
    /// walk to. Those tiles are held against the props as well (see `nativeLocalPlaySessionAnimalHeldTiles`), so they
    /// are the same set of tiles in both places.
    /// </para>
    /// </summary>
    private static int ClearPlaySessionAnimalSite(
        GameLocation farm,
        IReadOnlyList<Vector2> footprint,
        IReadOnlyList<Vector2> ring,
        Point site,
        Point door)
    {
        List<Vector2> owned = footprint.Concat(ring).ToList();
        string? wall = PlaySessionAnimalFootprintFirstWall(farm, owned, out Vector2 wallTile, out _);
        if (wall is not null)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_wall:origin={site.X},{site.Y};door={door.X},{door.Y};"
                    + $"tile={(int)wallTile.X},{(int)wallTile.Y};why={wall}");
        }
        Dictionary<string, int> clearedKinds = new(StringComparer.Ordinal);
        int cleared = ClearPlaySessionAnimalFootprint(farm, owned, clearedKinds, out string? failure);
        if (failure is not null)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_animal_site_{PlaySessionAnimalClearingFailedRefusal}:"
                    + $"origin={site.X},{site.Y};door={door.X},{door.Y};{failure}");
        }
        return cleared;
    }
}

