using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
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
        bool approach = PlaySessionAnimalDoorApproach(farm, building)
            .Any(tile => NativeLocalMultiDayWalkableFrom(farm, from, new Point((int)tile.X, (int)tile.Y)));
        if (!approach)
            return $"{PlaySessionAnimalNoApproachRefusal}:door={door.X},{door.Y}";
        // The composed world is the one that insists on the route home; a plain play-session world has no such promise to
        // keep, and asking it there would refuse every site in a farm whose porch and crossroads are different pieces.
        if (mustRemainReachable is null)
            return null;
        try
        {
            // The CANDIDATE's own door, because this building is the one standing in `farm.buildings` right now: the
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
        if (!TryFindNativeLocalPlaySessionAnimalSite(player, farm, barn, startTile, mustRemainReachable, out _, out int cleared, out string refusalMessage))
        {
            // NO SITE IS A REFUSAL, NOT A WORLD WITH ONE ANIMAL FEWER. This used to log a warning and return, and that
            // line is exactly how an animal house could disappear with every gate still green: `tend_the_animals` kept
            // being rotated into a world with no animal in it. The search builds the whole message, because WHICH refusal
            // it is depends on what it measured: no free footprint at all is a map with no ground for the house, while
            // footprints that were all refused is a map with ground and no approach or no road - and those are different
            // repairs, named by different codes rather than by one `site_missing` a relaunch cannot tell apart.
            throw new InvalidOperationException(refusalMessage);
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
        // Remembered for the composed world's own assertion, which runs after the props exist (see
        // `nativeLocalPlaySessionAnimalDoor`): the door of the house that actually stands here.
        this.nativeLocalPlaySessionAnimalDoor = door;
        // AND THE GROUND IT NEEDS KEPT FREE. The props below are placed nearest the crossroads first, which is exactly
        // where this house was sited, so without this list the next prop takes a tile the house is reached from and the
        // arm-time porch assertion then refuses a world whose parts were each placed lawfully.
        this.nativeLocalPlaySessionAnimalHeldTiles = PlaySessionFixturePlacement.TilesHeldByBuilding(
            PlaySessionAnimalFootprint(barn, new Point(barn.tileX.Value, barn.tileY.Value)),
            door);

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
                + $"start={startTile.X},{startTile.Y};walkable_after={walkableAfter};cleared={cleared};"
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
    /// The first footprint the day's own ground and route survive, measured on the farm.
    ///
    /// <para>
    /// Four facts, each one a live reading rather than a guess: every footprint tile is empty ground (or a tile a
    /// published action clears, and this search then clears it); the footprint does not cover the tile the session starts
    /// on; the session's start still belongs to a walkable piece of at least
    /// <see cref="PlaySessionMinimumComponentTiles"/> tiles with the building standing on it; and
    /// <see cref="RejectsThePlaySessionAnimalBuilding"/> passes - the door has an approach the start can walk to and the
    /// porch still reaches the field.
    /// </para>
    ///
    /// <para>
    /// A TILE IS JUDGED BY WHAT THE MAP HOLDS AND WHAT THE ACTION CATALOGUE DOES ABOUT IT, in the ONE vocabulary
    /// <c>TileOccupancy.Of</c> answers and the ONE join `ClearingActionSurface.ClearersOf` is: a weed, a stone or a twig
    /// is not ground the farm lacks, it is ground a player opens before building, and the search CLEARS it instead of
    /// counting it as a wall. Measured `round93` (2026-11-22): `object=2332` of 5195 candidates - the farm's own debris,
    /// held against a house a player would simply have swept clear. What stays a wall is what no published action opens
    /// AT ALL, or only by spending a destructive swing: the objects-layer `object` whose own action is not a way through
    /// (forage, a machine, a chest), a grassy tuft or a crop the catalogue marks destructive, a fruit tree, a bush, and a
    /// kind the vocabulary names without a clearer. A tree, a stump and a clump are NOT walls: `chop_tree`, `chop_stump`,
    /// `clear_debris` and `break_resource_clump` all declare them, non-destructively.
    /// </para>
    ///
    /// <para>
    /// WHAT IT CLEARS IS WHAT IT THEN STANDS THE HOUSE ON. A footprint measured as available and then handing the
    /// placement a weed would refuse itself at `barn.ReloadBuildingData`/`updateLayout`, so the occupant is taken out of
    /// the layer the classifier read it from and the tile is re-read before the candidate is probed: a clearing that does
    /// not come free is `clearing_failed`, counted per candidate and left behind rather than placed on. The count of
    /// tiles each candidate needed `cleared` travels with its entry and with the accepted site, so the arm log says what
    /// the fixture did to the farm.
    /// </para>
    ///
    /// <para>
    /// THE CANDIDATE IS JUDGED ON THE GROUND IT WOULD ACTUALLY GET, and that ground is UNTILLED: the play-session
    /// Given spreads no soil (a fixture may not pre-satisfy the hoeing a task asks for - see
    /// `InitializeNativeLocalPlaySessionFixture`'s own rule), so a field tile carries a terrain feature only where the
    /// MAP put one. A building, an object with its own action, a destructive-only occupant or a not-placeable tile still
    /// refuses the candidate, by name.
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
    /// `refusalMessage` is the whole message the caller throws, and its CODE is chosen by what this search measured,
    /// because the two failures are different repairs: `fixture_native_local_play_session_animal_site_missing` when the
    /// map offers no free footprint at all (no ground for the house), and `fixture_map_cannot_hold_animal_building`
    /// when footprints existed and every one of them was refused by a probe (ground, but no approach or no road). The
    /// second names the LEAST-BAD candidate, because a house one repair away from usable is not the same finding as a
    /// map with nowhere to put one.
    /// </para>
    ///
    /// <para>
    /// THE READING answers what each rule refused: `eliminated` counts the candidates EACH rule refused (`object=...,
    /// no_safe_clear:grass:cut_grass=..., arm_refused=...`, in the vocabulary's own words), `blocked`/`rejected` name the
    /// first few with their tiles, `cleared_total`/`cleared_kinds` count the tiles THIS SEARCH removed from the farm, and
    /// `footprints` counts the candidates whose ground the house could actually take - the ground the farm already had and
    /// the ground the search cleared, told apart by the `cleared=` on each entry. A bare `footprints=0` distinguishes none
    /// of them - it reads the same whether the farm has no room or one rule refuses every tile in the world - which is
    /// what made round93's refusal answerable only by re-reading this file.
    /// </para>
    ///
    /// <para>
    /// `candidates` counts the origin candidates the pool offered and `tried` counts the ones this loop actually judged,
    /// so the reading says whether the search exhausted the map or stopped early: `tried &lt; candidates` is a search that
    /// gave up, and every free footprint it admits is probed on the farm before the next candidate is considered.
    /// </para>
    /// </summary>
    private bool TryFindNativeLocalPlaySessionAnimalSite(
        Farmer player,
        Farm farm,
        Building building,
        Vector2 startTile,
        Vector2? mustRemainReachable,
        out Vector2 site,
        out int clearedTiles,
        out string refusalMessage)
    {
        site = Vector2.Zero;
        clearedTiles = 0;
        refusalMessage = "no_candidate";
        xTile.Layers.Layer? back = farm.map?.GetLayer("Back");
        if (back is null)
        {
            refusalMessage = "farm_has_no_back_layer";
            return false;
        }
        int footprints = 0;
        int tried = 0;
        // WHAT THE WHOLE SEARCH TOOK OFF THE FARM, beside the count the accepted site reports: a candidate refused after
        // its ground was cleared still cost it, and the refusal is the only message that can say so.
        int clearedTotal = 0;
        // WHAT THE SEARCH ITSELF TOOK OFF THE FARM, keyed by the occupant word it read: the answer to "how much work did
        // the fixture do", which a cleared site otherwise hides.
        Dictionary<string, int> clearedKinds = new(StringComparer.Ordinal);
        // HOW MANY CANDIDATES EACH RULE ELIMINATED, not just a count of the survivors. round93's refusal was
        // `free_footprints=0;rejected=none`, which reads the same whether the farm has no room left or ONE rule refuses
        // every tile in the world - and it was the second. The tally is keyed by the gate names themselves, so the
        // count and the reason cannot drift apart.
        Dictionary<string, int> eliminated = new(StringComparer.Ordinal);
        List<string> rejected = new();
        List<string> blocked = new();
        // The LEAST-BAD refused footprint, for the map-level refusal below.
        Point best = default;
        string? bestRule = null;
        int bestProgress = 0;
        List<Point> candidates = PlaySessionFixturePlacement.PlaceableCandidates(
                Enumerable.Range(0, back.LayerWidth)
                    .SelectMany(x => Enumerable.Range(0, back.LayerHeight).Select(y => new Point(x, y))),
                new Point((int)startTile.X, (int)startTile.Y))
            .ToList();
        foreach (Point candidate in candidates)
        {
            tried += 1;
            building.tileX.Value = candidate.X;
            building.tileY.Value = candidate.Y;
            List<Vector2> footprint = PlaySessionAnimalFootprint(building, candidate);
            string? refusal = PlaySessionAnimalFootprintFirstWall(farm, footprint, out Vector2 refusedTile, out bool clearing);
            if (refusal is not null)
            {
                CountPlaySessionAnimalRefusal(eliminated, refusal);
                // Bounded for the same reason `rejected` is: a farm has thousands of candidate origins and the reason
                // only has to be readable.
                if (blocked.Count < 8) blocked.Add($"{candidate.X},{candidate.Y}@{refusedTile.X},{refusedTile.Y}:{refusal}");
                continue;
            }
            // The candidate order excludes the actor's own ring, but a footprint is several tiles wide: a building
            // whose ORIGIN is two tiles away can still cover the tile the session starts on.
            if (footprint.Contains(startTile))
            {
                CountPlaySessionAnimalRefusal(eliminated, PlaySessionAnimalStartTileRefusal);
                continue;
            }
            // THE CLEARING THE ADMISSION ABOVE ASSUMED, RUN BEFORE THE HOUSE STANDS. A footprint measured as available
            // and then handed to the placement with a weed still on it would refuse itself at `updateLayout`, so the
            // ground the search just certified is made the ground it described.
            int cleared = 0;
            if (clearing)
            {
                cleared = ClearPlaySessionAnimalFootprint(farm, footprint, clearedKinds, out string? failingClearing);
                clearedTotal += cleared;
                if (failingClearing is not null)
                {
                    CountPlaySessionAnimalRefusal(eliminated, PlaySessionAnimalClearingFailedRefusal);
                    if (blocked.Count < 8)
                        blocked.Add($"{candidate.X},{candidate.Y}:{PlaySessionAnimalClearingFailedRefusal}:{failingClearing};cleared={cleared}");
                    continue;
                }
            }
            // THE TILE THAT WAS CLEARED IS JUDGED AGAIN, because a weed under a tilled tile comes free of the object layer
            // and leaves ground the house still may not take - which `not_placeable` now says instead of being hidden by
            // the occupant that was just removed.
            refusal = clearing ? PlaySessionAnimalFootprintFirstWall(farm, footprint, out refusedTile, out _) : null;
            if (refusal is not null)
            {
                CountPlaySessionAnimalRefusal(eliminated, refusal);
                if (blocked.Count < 8)
                    blocked.Add($"{candidate.X},{candidate.Y}@{refusedTile.X},{refusedTile.Y}:{refusal};cleared={cleared}");
                continue;
            }
            // A FOOTPRINT IS GROUND THE HOUSE CAN STAND ON, whether the farm already had it clear or the search cleared
            // it: the two are told apart by `cleared=`, not by leaving one of them out of the count.
            footprints += 1;
            string? rejection = ProbePlaySessionAnimalFootprint(player, farm, building, startTile, mustRemainReachable);
            if (rejection is not null)
            {
                string rule = PlaySessionAnimalRule(rejection);
                CountPlaySessionAnimalRefusal(eliminated, rule);
                // Bounded, because a farm has thousands of candidate origins and the reason only has to be readable.
                if (rejected.Count < 8)
                    rejected.Add(cleared > 0 ? $"{candidate.X},{candidate.Y}:{rejection};cleared={cleared}" : $"{candidate.X},{candidate.Y}:{rejection}");
                int progress = PlaySessionAnimalRefusalProgress(rule);
                if (progress > bestProgress)
                {
                    bestProgress = progress;
                    best = candidate;
                    bestRule = rule;
                }
                continue;
            }
            site = new Vector2(candidate.X, candidate.Y);
            clearedTiles = cleared;
            return true;
        }
        string reading = $"candidates={candidates.Count};tried={tried};"
            + $"eliminated={(eliminated.Count == 0 ? "none" : string.Join("|", eliminated.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{pair.Key}={pair.Value}")))};"
            + $"cleared_total={clearedTotal};"
            + $"cleared_kinds={(clearedKinds.Count == 0 ? "none" : string.Join("|", clearedKinds.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{pair.Key}={pair.Value}")))};"
            + $"rejected={(rejected.Count == 0 ? "none" : string.Join("|", rejected))};"
            + $"blocked={(blocked.Count == 0 ? "none" : string.Join("|", blocked))}";
        // NO FOOTPRINT AT ALL is a map with no ground for the house; footprints that were all refused is a map with
        // ground but no approach or no road. Different repairs, so different codes.
        refusalMessage = bestRule is null
            ? $"fixture_native_local_play_session_animal_site_missing:start={startTile.X},{startTile.Y};footprints={footprints};{reading}"
            : $"fixture_map_cannot_hold_animal_building:footprints={footprints};best={best.X},{best.Y}:{bestRule};start={startTile.X},{startTile.Y};{reading}";
        return false;
    }

    /// <summary>The refusal a building uses when its footprint would cover the tile the session starts on.</summary>
    private const string PlaySessionAnimalStartTileRefusal = "start_tile";

    /// <summary>
    /// The first wall in a footprint, with the tile it stands on and whether the footprint needs the search's clearing.
    ///
    /// <para>
    /// ONE PASS, ONE ANSWER, so the two places that ask the question - the admission and the re-ask after the clearing -
    /// cannot drift into two loops that break at different tiles or count different walls.
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

    /// <summary>
    /// Stand the REAL building on the real farm, ask the composed world's own question, and take it down again - the same
    /// footprint measured with stones on it asked a different question and got a different answer.
    ///
    /// <para>
    /// FINISHED, because that is how the world will hold it: an under-construction footprint answers the collision question
    /// for a work site (<c>Building.isTilePassable</c> short-circuits on it), so the door and animal-door tiles would read
    /// differently here than after the day has built it.
    /// </para>
    /// </summary>
    private string? ProbePlaySessionAnimalFootprint(
        Farmer player,
        Farm farm,
        Building building,
        Vector2 startTile,
        Vector2? mustRemainReachable)
    {
        building.daysOfConstructionLeft.Value = 0;
        farm.buildings.Add(building);
        int fieldComponent = WalkableComponentSize(farm, startTile);
        string? rejection = fieldComponent >= PlaySessionMinimumComponentTiles
            ? RejectsThePlaySessionAnimalBuilding(player, farm, building, startTile, mustRemainReachable)
            : $"{PlaySessionAnimalFieldComponentRefusal}:{fieldComponent}";
        farm.buildings.Remove(building);
        return rejection;
    }

    /// <summary>The refusal a site gets when its door has no approach the session's start can walk to.</summary>
    private const string PlaySessionAnimalNoApproachRefusal = "no_approach";

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
    /// A tile the search TRIED to clear and did not come free of. Its own name rather than the occupant that is left
    /// behind, because "the clearing failed" and "nothing can clear this" are two different reports.
    /// </summary>
    internal const string PlaySessionAnimalClearingFailedRefusal = "clearing_failed";

    /// <summary>
    /// What stands on one footprint tile, as the SEARCH sees it: the wall rule that refuses the tile, or null with the
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
    /// (`<occupant>@x,y:-><what is left>`). The caller refuses that candidate and moves on - the alternative was to
    /// place the house on whatever the removal missed.
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

    /// <summary>The refusal a site gets when standing on it cuts the session's own ground below the minimum.</summary>
    private const string PlaySessionAnimalFieldComponentRefusal = "field_component_too_small";

    /// <summary>
    /// How far a refused footprint got, so a map-level refusal names the LEAST-BAD one rather than the first met: a
    /// house whose door has an approach and only its road home is broken is one repair away from a usable world, a
    /// house with no approach at all is another, and a footprint that shrank the session's own ground is the worst of
    /// the three. Ties go to the candidate met first, which is the one nearest the crossroads.
    /// </summary>
    private static int PlaySessionAnimalRefusalProgress(string rule) => rule switch
    {
        PlaySessionAnimalArmRefusedRefusal => 3,
        PlaySessionAnimalNoApproachRefusal => 2,
        PlaySessionAnimalFieldComponentRefusal => 1,
        _ => 0,
    };

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

    private static void CountPlaySessionAnimalRefusal(Dictionary<string, int> eliminated, string rule) =>
        eliminated[rule] = eliminated.TryGetValue(rule, out int seen) ? seen + 1 : 1;

    /// <summary>The rule name inside a rejection reading (`no_approach:door=..` -> `no_approach`).</summary>
    private static string PlaySessionAnimalRule(string rejection)
    {
        int separator = rejection.IndexOf(':');
        return separator > 0 ? rejection[..separator] : rejection;
    }
}
