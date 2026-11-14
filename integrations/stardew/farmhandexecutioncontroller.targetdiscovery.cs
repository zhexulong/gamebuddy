using System.Globalization;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

// TARGET DISCOVERY — the perception half of the execution controller. Every `Discover*`
// member reads the actor's neighbourhood and turns it into the rows a snapshot publishes;
// none of them executes anything, and none is read by an execution precondition. They live
// apart from the dispatcher (`farmhandexecutioncontroller.cs`) because that file is the
// receipt ledger and the frame update, not a scan of the world.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Every tile this location offers as a way out, asked of the two tables the ENGINE keeps, in the order the game
    /// itself resolves them: the door table <c>updateDoors</c> builds, the human door of each building standing here, and
    /// the location's own warp list.
    ///
    /// <para>
    /// The third source is what this family was missing. <c>location.doors</c> only ever holds a Buildings-layer tile
    /// whose <c>Action</c> property contains "Warp" (<c>GameLocation.updateDoors</c>, GameLocation.cs:17586-17641), and a
    /// farm building's INTERIOR carries its exit in <c>warps</c> instead: <c>Building.updateInteriorWarps</c> rewrites the
    /// interior warp whose target is the parent location (Building.cs:1799-1816), and the engine reads
    /// <c>indoors.warps[0]</c> as the tile a building's entrance puts the player on (GameLocation.cs:2203). Switching on
    /// <c>FarmHouse</c>/<c>Cabin</c> therefore published the farmhouse's own exit and NOTHING for a shed, barn, coop or
    /// greenhouse: inside every one of those a companion was told <c>doorTargets: []</c> by a location whose warp list
    /// held the way out one tile away.
    /// </para>
    ///
    /// <para>
    /// A row carries no source field - <c>BridgeDoor</c> is the five warp coordinates and the wire's <c>hasOnlyKeys</c>
    /// would refuse a sixth - so the source is read off the tile: the door table names tiles the map declared with an
    /// <c>Action</c>, the warps list names every tile the map's own <c>Warp</c> property declared, and the one tile of a
    /// building that appears in NEITHER is its human door (the tile a player clicks). Dedup is by SOURCE TILE with the
    /// earliest table owning the row, because one tile can be both a gated door and a plain warp and the gated one is the
    /// tile the native click entry knows.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            if (DescribeDoor(point.X, point.Y, location.getWarpFromDoor(point, player)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            if (DescribeDoor(point.X, point.Y, ResolveDoorWarp(location, point)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        // The location's own warp list, with the `warps` family's predicate: a transition that moves a PLAYER, with a
        // publishable source and destination. An edge exit's source is -1 on one axis, which is the engine's own
        // encoding and not a defect, so the range is the ONE declaration of it (`FarmhandWarpCoordinateRange`).
        foreach (StardewValley.Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName)) continue;
            if (!FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                continue;
            result.TryAdd((warp.X, warp.Y), new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY));
        }

        return result.Values.Take(64).ToArray();
    }

    /// <summary>
    /// The villagers a plan can name on this map, each with the relationship the engine holds for them.
    ///
    /// <para>
    /// A villager the player has never met has NO `friendshipData` entry, so a filter on that key published every
    /// villager EXCEPT the ones an introduction is for - the game's own Introductions quest and any first meeting were
    /// impossible, because the companion could not talk to anyone it did not already know. The native entry creates the
    /// record on that first conversation (`NPC.checkAction`, `friendshipData.Add(name, new Friendship(0))`), so the
    /// zeroed relationship below is the state the engine is about to write, not an invention. A MET villager's own
    /// record is published untouched.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeNpcRelationshipTarget> DiscoverNpcRelationshipTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeNpcRelationshipTarget>();
        return location.characters
            .OfType<StardewValley.NPC>()
            .Where(npc => npc.IsVillager
                && !string.IsNullOrWhiteSpace(npc.Name)
                // Read-only inspection targets may be published inside the same bounded
                // local discovery envelope used by this native-local fixture.
                // Execution still independently enforces its one-tile native
                // interaction radius after a separately receipted move.
                && IsTileWithinChebyshevRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, TargetDiscoveryRadius))
            .Take(64)
            .Select(npc =>
            {
                Friendship friendship = player.friendshipData.TryGetValue(npc.Name, out Friendship? record)
                    ? record
                    : new Friendship();
                return new BridgeNpcRelationshipTarget(
                    BuildNpcRelationshipTargetId(location, npc.Name),
                    (int)npc.Tile.X,
                    (int)npc.Tile.Y,
                    npc.Name,
                    friendship.Points,
                    friendship.Status.ToString(),
                    friendship.TalkedToToday,
                    friendship.GiftsToday,
                    friendship.GiftsThisWeek);
            })
            .ToArray();
    }

    /// <summary>
    /// Where every instantiated villager currently is, across the loaded world.
    ///
    /// <para>
    /// The `Discover*` helpers above only describe the player's current map, so
    /// an Agent told to find a villager cannot learn that she is elsewhere -
    /// one live run searched three maps by trial and never found her. This is
    /// the missing fact, and the master process holds it: `Game1.addMinute`
    /// drives `checkSchedule` for every entry in `Game1.locations`, and
    /// `warpCharacter` keeps each character's `currentLocation` current. The
    /// production topology is the single-player master, so this loop is the
    /// authoritative in-process answer.
    /// </para>
    /// <para>
    /// Read-only and bounded. Only instantiated, non-event villagers appear;
    /// generated levels (mine/volcano) are outside `ForEachLocation`'s default
    /// range, so such a villager is absent rather than guessed.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeVillagerWhereabouts> DiscoverVillagerWhereabouts()
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
                BuildNpcRelationshipTargetId(location, villager.Name),
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

    /// <summary>
    /// How many crops need water on each map, and the nearest one.
    ///
    /// <para>
    /// Whole-map, unlike `DiscoverCropTargets`, which is bounded by `TargetDiscoveryRadius` because a target outside reach
    /// is not actionable. A COUNT is a different question from a list of targets: the prompt asks "is anything thirsty", and
    /// answering it from the radius-limited list produced a false zero (measured 2026-10-31).
    /// </para>
    /// <para>
    /// "Needs water" is <see cref="CropNeedsWater"/> - the crop's own need predicate AND the tile's live watered state,
    /// the same pair `DiscoverCropTargets` and `water_crop` read, so the count cannot advertise a tile the action refuses.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeWateringWhereabouts> DiscoverWateringWhereabouts(DiscoveryExclusionRecorder exclusions)
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
                // A dead crop is a subject this COUNT can see and will never count as thirsty, so it says so rather than
                // leaving the reader to read its absence as "no crop here".
                if (dirt.crop.dead.Value)
                {
                    exclusions.Record("wateringWhereabouts", DiscoveryExclusionReasons.Dead);
                    continue;
                }
                if (!CropNeedsWater(dirt))
                    continue;
                needsWaterCount++;
                // A DISTANCE ACROSS MAPS IS NOT A DISTANCE. The loop walks every loaded location, and this used to subtract
                // an off-map tile from the player's own tile - so Desert (10,10) and Farm (10,10) came out as distance 0
                // and an off-map row could claim the nearest tile. The coordinate of a crop on another map is not an
                // address the companion can walk to, so only the player's own map computes one.
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            // The row is published for its COUNT, which every loaded map can answer. The coordinate is a separate fact that
            // only the player's own map has, so an absent one is left ABSENT rather than this row being dropped with it.
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

    /// <summary>
    /// Summarize every loaded location's ready-for-harvest crops.
    ///
    /// <para>
    /// Per-location HarvestTargets are Chebyshev-bounded, so this is the only
    /// planning fact that tells the companion a ripe crop exists elsewhere —
    /// same role as VillagerWhereabouts. Countable crops only (the same predicate
    /// the bounded discovery uses), nearest tile is the one closest to the
    /// player's current tile, and the result is bounded like the other snapshot
    /// lists (Host accepts up to 64).
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeHarvestWhereabouts> DiscoverHarvestWhereabouts(DiscoveryExclusionRecorder exclusions)
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
                // The count is derived from the SAME pair of engine predicates the bounded `harvestTargets` list uses, so
                // each one it drops is recorded here rather than leaving an empty list to answer two questions at once.
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
                // A DISTANCE ACROSS MAPS IS NOT A DISTANCE. The loop walks every loaded location, and this used to subtract
                // an off-map tile from the player's own tile - so Desert (10,10) and Farm (10,10) came out as distance 0
                // and an off-map row could claim the nearest tile. The coordinate of a crop on another map is not an
                // address the companion can walk to, so only the player's own map computes one.
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            // The row is published for its COUNT, which every loaded map can answer. The coordinate is a separate fact that
            // only the player's own map has, so an absent one is left ABSENT rather than this row being dropped with it.
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

    private static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        List<BridgePetTarget> result = new();
        // The window is taken over the pets in RANGE and the day filter runs after it, which is the order this family
        // has always published in; moving the cap after the filter would change which pets the list can hold.
        foreach (Pet pet in location.characters.OfType<Pet>()
            .Where(pet => Utility.tileWithinRadiusOfPlayer((int)pet.Tile.X, (int)pet.Tile.Y, TargetDiscoveryRadius, player))
            .Take(16))
        {
            BridgePetTarget target = new(
                BuildPetTargetId(location, (int)pet.Tile.X, (int)pet.Tile.Y, pet),
                (int)pet.Tile.X,
                (int)pet.Tile.Y,
                pet.petType.Value,
                pet.friendshipTowardFarmer.Value,
                pet.lastPetDay.TryGetValue(player.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays,
                // Project the native fact, do not invent a taxonomy. A Pet moves
                // according to PetData.Behaviors, and the field that decides that
                // is `WalkInDirection` (Data/Pets): Walk/Sprint/LeapJump set it,
                // SitDown/SitSide/Flop do not. The game already answers "is this
                // pet moving right now"; naming it `Stationary` and nothing more
                // avoids collapsing several native behaviours into phases the Mod
                // would then own and have to keep in sync.
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

    /// <summary>
    /// Farm animals the actor can still pet today, nearest first.
    ///
    /// <para>
    /// The day filter is `wasPet`, the engine's own marker, NOT a re-derivation: `FarmAnimal.pet` sets it on the first
    /// manual pet (FarmAnimal.cs:749) and the save clears it overnight, so an animal that is absent from this list has
    /// already been petted by this farmer today. It is filtered rather than published-and-refused for the same reason
    /// `petTargets` filters `PettedToday`: there is nothing left to do with it, and the second pet would open
    /// `AnimalQueryMenu` instead of petting.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeFarmAnimalPetTarget> DiscoverFarmAnimalPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFarmAnimalPetTarget>();
        List<BridgeFarmAnimalPetTarget> result = new();
        foreach (FarmAnimal animal in location.animals.Values
            .Where(animal => IsTileWithinChebyshevRadius(player, (int)animal.Tile.X, (int)animal.Tile.Y, TargetDiscoveryRadius))
            .OrderBy(animal => ChebyshevDistance(player, (int)animal.Tile.X, (int)animal.Tile.Y))
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
                BuildFarmAnimalPetTargetId(location, animal),
                (int)animal.Tile.X,
                (int)animal.Tile.Y,
                animal.type.Value,
                animal.friendshipTowardFarmer.Value));
        }
        return result;
    }

    private static IReadOnlyList<BridgeMachineTarget> DiscoverMachineTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeMachineTarget>();
        return location.objects.Pairs
            .Where(pair => pair.Value.GetMachineData() is not null
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.Object machine = pair.Value;
                string? held = machine.heldObject.Value?.QualifiedItemId;
                string? input = machine.lastInputItem.Value?.QualifiedItemId;
                BridgeMachineTarget target = new(
                    BuildMachineTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, machine.QualifiedItemId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    machine.QualifiedItemId,
                    RequireDisplayName(machine.QualifiedItemId),
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
                    // What THIS machine takes, from its own Data/Machines rows - the same derivation the load refusal
                    // names. Every object with machine data used to be published as a load target with no statement of
                    // its inputs, so a furnace reached the model looking like it took coffee beans (measured 2026-10-31).
                    // null here means the machine's data could not answer, which is not the same fact as "takes nothing".
                    Accepts: ReadMachineInputAcceptance(machine));
                if (machine.heldObject.Value is null && !machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0 && IsMachineInteractionObject(machine))
                {
                    for (int slot = 0; slot < player.Items.Count; slot++)
                    {
                        // The row publishes the input the ACTION will accept: the machine's own admission decides whether
                        // it takes this stack (Object.performObjectDropInAction, probe: true - the call GameLocation.checkAction
                        // makes at GameLocation.cs:7768-7772), and the machine's own rows decide how many it consumes. Discovery
                        // and the action therefore publish and enforce the same fact instead of two guesses at it.
                        if (player.Items[slot] is not StardewValley.Object carried
                            || !machine.performObjectDropInAction(carried, probe: true, player)
                            || !TryReadMachineLoadRequirement(machine, carried, player, location, out MachineLoadRequirement requirement))
                            continue;
                        target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = carried.QualifiedItemId, LoadInputStack = requirement.ConsumedCount };
                        break;
                    }
                }
                return target;
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopSourceTarget>();

        List<BridgeTreeChopSourceTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
            string? exclusion = TreeChopSourceExclusion(tree);
            if (exclusion is not null)
            {
                exclusions.Record("treeChopSourceTargets", exclusion);
                continue;
            }
            int x = (int)pair.Key.X;
            int y = (int)pair.Key.Y;
            result.Add(new BridgeTreeChopSourceTarget(
                BuildTreeChopSourceTargetId(location, x, y, tree),
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

    private static IReadOnlyList<BridgeTreeChopResultTarget> DiscoverTreeChopResultTargets(Farmer player)
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
                && pair.Key.X >= 0 && pair.Key.X <= 1000 && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeChopResultTarget(
                    BuildTreeChopResultTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value,
                    tree.health.Value, tree.stump.Value, tree.hasMoss.Value, tree.tapped.Value);
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeTreeStumpTarget> DiscoverTreeStumpTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeStumpTarget>();

        return NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player)
            .Take(16)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeStumpTarget(BuildTreeStumpTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value, tree.health.Value);
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeTreeSaplingTarget> DiscoverTreeSaplingTargets(Farmer player)
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
            // This stack's OWN window, and a stack's rows are its NEAREST: the scan below walks x then y from the far
            // corner, so ordering happens before the window trims, which is what makes the window mean "nearest"
            // rather than "whichever tiles the loops reached first".
            List<BridgeTreeSaplingTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || !CanPlantWildTreeSeedAt(location, sapling.QualifiedItemId, x, y))
                        continue;
                    rowsForThisStack.Add(new BridgeTreeSaplingTarget(BuildTreeSaplingTargetId(location, slot, x, y, sapling.QualifiedItemId), slot, x, y, sapling.QualifiedItemId, RequireDisplayName(sapling.QualifiedItemId)));
                }
            }
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(rowLimit));
        }
        // A stack is independent of every other stack - a row in slot A can never address slot B's item - so ordering
        // each stack's own window IS the whole list's order, and the stacks stay in inventory order. The reason the
        // order matters at all: `TARGETS_NAMED_PER_PLAN` is 16, so one script uses at most sixteen rows, and Chebyshev is the
        // metric the range gate will apply (a tile nearer by Manhattan can still be further from being in range).
        // Measured 2026-10-29, `round7`: 7.2 KB of these rows per observation, in scan order, so the sixteen a script
        // could reach soonest were scattered.
        return result;
    }

    private static IReadOnlyList<BridgeWeedTarget> DiscoverWeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWeedTarget>();
        return NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null
                && pair.Value.IsWeeds()
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
            .Take(16)
            .Select(pair => new BridgeWeedTarget(
                BuildWeedTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.MinutesUntilReady, pair.Value.IsWeeds()))
            .ToArray();
    }

    /// <summary>
    /// Live grass tufts on the current map (the TerrainFeature `Grass`, not the
    /// Object-layer weeds `cut_weeds` targets). Swinging a scythe at one deducts
    /// its <c>numberOfWeeds</c> to zero and, when it dies, feeds Hay into a silo
    /// (grassType 1/7) or drops rare items (grassType 6) via the native
    /// <c>Grass.performToolAction</c> → <c>TryDropItemsOnCut</c> chain.
    /// </summary>
    private static IReadOnlyList<BridgeCaskTarget> DiscoverCaskTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCaskTarget>();
        List<BridgeCaskTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is not StardewValley.Objects.Cask cask
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCaskTarget(BuildCaskTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, cask), location.NameOrUniqueName,
                (int)pair.Key.X, (int)pair.Key.Y, cask.heldObject.Value is not null, cask.heldObject.Value?.QualifiedItemId));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static IReadOnlyList<BridgeMannequinTarget> DiscoverMannequinTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Mannequin && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
            .Select(pair => new BridgeMannequinTarget(BuildMannequinTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y)).ToArray() ?? Array.Empty<BridgeMannequinTarget>();
    }

    private static IReadOnlyList<BridgeSignTarget> DiscoverSignTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Sign && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
            .Select(pair => { StardewValley.Objects.Sign sign = (StardewValley.Objects.Sign)pair.Value; return new BridgeSignTarget(BuildSignTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, sign), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, sign.displayItem.Value is not null, sign.displayItem.Value?.QualifiedItemId); }).ToArray() ?? Array.Empty<BridgeSignTarget>();
    }

    private static IReadOnlyList<BridgeSiloTarget> DiscoverSiloTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSiloTarget>();
        List<BridgeSiloTarget> result = new();
        foreach (StardewValley.Buildings.Building building in location.buildings.Where(building => building.buildingType.Value == "Silo").Take(16))
        {
            Vector2 tile = new(building.tileX.Value, building.tileY.Value);
            Point door = building.getPointForHumanDoor();
            if (!IsTileWithinChebyshevRadius(player, door.X, door.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSiloTarget(BuildSiloTargetId(location, building), location.NameOrUniqueName, door.X, door.Y, location.piecesOfHay.Value));
        }
        return result;
    }

    private static IReadOnlyList<BridgeLanternSlot> DiscoverLanternSlots(Farmer player) => player.Items.Select((item, slot) => (item, slot)).Where(pair => pair.item is StardewValley.Tools.Lantern).Take(16)
        .Select(pair => { StardewValley.Tools.Lantern lantern = (StardewValley.Tools.Lantern)pair.item!; return new BridgeLanternSlot(pair.slot, lantern.on, lantern.fuelLeft); }).ToArray();

    private static IReadOnlyList<BridgeGrassTarget> DiscoverGrassTargets(Farmer player)
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
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeGrassTarget(
                BuildGrassTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, grass),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                grass.grassType.Value, grass.numberOfWeeds.Value));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static IReadOnlyList<BridgeScytheCropTarget> DiscoverScytheCropTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeScytheCropTarget>();
        List<BridgeScytheCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is null
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            // ONE decision, shared with the execution admission below, so a published row can never be a row the
            // action refuses - and a dead crop, which no readiness or water radar can see, is published here or it
            // is lost. See ExecutionManager.ScytheCropTarget. Every input is read ONCE and published: the same four
            // engine answers decide the row's admission and state the row's own facts.
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
                ? DeadCropHarvestItemId
                : StardewValley.ItemRegistry.Create(harvestId, 1).QualifiedItemId;
            result.Add(new BridgeScytheCropTarget(
                BuildScytheCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                cropSeedId,
                qualifiedHarvestItemId,
                RequireDisplayName(cropSeedId),
                readyForHarvest,
                dead,
                forageCrop,
                ExecutionManager.HarvestMethodName(harvestMethod)));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static IReadOnlyList<BridgeClearHoeDirtTarget> DiscoverClearHoeDirtTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeClearHoeDirtTarget>();
        return NearestFirst(location.terrainFeatures.Pairs.Where(pair => Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)
            && pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt && dirt.crop is null
            && !(location.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)), player)
            .Take(8).Select(pair => new BridgeClearHoeDirtTarget(BuildClearHoeDirtTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, Crop: false, Ground: true)).ToArray();
    }

    private static IReadOnlyList<BridgeArtifactSpotTarget> DiscoverArtifactSpotTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeArtifactSpotTarget>();
        return location.objects.Pairs
            .Where(pair => (int)pair.Key.X is >= 0 and <= 1000 && (int)pair.Key.Y is >= 0 and <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)
                && NativeItemPredicates.IsArtifactSpot(pair.Value)
                // Artifact spots themselves are object-occupied source tiles;
                // the legal native interaction position is an adjacent
                // passable standing tile (checked below), not a passability
                // predicate on the source tile.
                && location.isTileOnMap(pair.Key)
                && !location.terrainFeatures.ContainsKey(pair.Key)
                && location.GetHoeDirtAtTile(pair.Key) is null
                && pair.Value is not StardewValley.Objects.IndoorPot
                && new[] { pair.Key + new Vector2(-1f, 0f), pair.Key + new Vector2(1f, 0f), pair.Key + new Vector2(0f, -1f), pair.Key + new Vector2(0f, 1f) }
                    // `IsStandableTile` is the one rule for "may the body stop here", and it admits the actor's OWN
                    // tile without asking the collision test: a live target is not hidden because she already stands
                    // on its only action tile. A neighbour the map calls open while a bush or a trellis crop holds it
                    // is refused, which the map-only reading could not see.
                    .Any(standing => StardewBodyController.IsStandableTile(location, player, standing)))
            // Keep the published list bounded, but make its cap deterministic
            // so a fixture-selected source is always discoverable when it is
            // within the existing eight-target publication boundary.
            .OrderBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .Take(8)
            .Select(pair => new BridgeArtifactSpotTarget(BuildArtifactSpotTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId)))
            .ToArray();
    }

    private IReadOnlyList<BridgeWoodFenceResultTarget> DiscoverWoodFenceResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeWoodFenceResultTarget? target = this.woodFenceResultTarget;
        if (target is not null
            && (this.woodFenceResultExecutionId is null || this.woodFenceResultRequestId is null
                || this.woodFenceResultRevision != this.revision
                || this.woodFenceResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.woodFenceResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.woodFenceResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "wood_fence_placed"))
        {
            this.InvalidateWoodFenceResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed)
            || placed is not StardewValley.Fence fence
            || fence.QualifiedItemId != target.QualifiedItemId
            || fence.isGate.Value != target.IsGate
            || fence.health.Value != target.Health
            || fence.maxHealth.Value != target.MaxHealth)
            return Array.Empty<BridgeWoodFenceResultTarget>();
        return new[] { target };
    }

    private IReadOnlyList<BridgeCrabPotResultTarget> DiscoverCrabPotResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeCrabPotResultTarget? target = this.crabPotResultTarget;
        if (target is not null
            && (this.crabPotResultExecutionId is null || this.crabPotResultRequestId is null
                || this.crabPotResultRevision != this.revision
                || this.crabPotResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.crabPotResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.crabPotResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "crab_pot_placed"))
        {
            this.InvalidateCrabPotResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed)
            || placed is not StardewValley.Objects.CrabPot crabPot
            || crabPot.QualifiedItemId != target.QualifiedItemId
            || crabPot.owner.Value != target.OwnerId
            || crabPot.directionOffset.Value.X != target.OffsetX
            || crabPot.directionOffset.Value.Y != target.OffsetY)
            return Array.Empty<BridgeCrabPotResultTarget>();
        return new[] { target with { OverlayTiles = BuildCrabPotOverlayFacts(crabPot) } };
    }

    private IReadOnlyList<BridgeBaitCrabPotResultTarget> DiscoverBaitCrabPotResultTargets(Farmer player)
    {
        BridgeBaitCrabPotResultTarget? target = this.baitCrabPotResultTarget;
        GameLocation? location = player.currentLocation;
        if (target is not null && (this.baitCrabPotResultExecutionId is null || this.baitCrabPotResultRequestId is null || this.baitCrabPotResultRevision != this.revision || this.baitCrabPotResultDay != Game1.Date.TotalDays || !this.receiptsByRequestId.TryGetValue(this.baitCrabPotResultRequestId, out LocalExecutionReceipt? receipt) || receipt.ExecutionId != this.baitCrabPotResultExecutionId || receipt.State != ExecutionState.Succeeded || receipt.ReasonCode != "crab_pot_baited")) { this.InvalidateBaitCrabPotResult(); target = null; }
        if (target is null || location is null || !string.Equals(location.NameOrUniqueName, target.Location, StringComparison.Ordinal) || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player) || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed) || placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != target.QualifiedItemId || !string.Equals(crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), target.OwnerId, StringComparison.Ordinal) || crabPot.bait.Value?.QualifiedItemId != target.BaitQualifiedItemId) return Array.Empty<BridgeBaitCrabPotResultTarget>();
        return new[] { target };
    }

    private IReadOnlyList<BridgeArtifactSpotResultTarget> DiscoverArtifactSpotResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeArtifactSpotResultTarget? target = this.artifactSpotResultTarget;
        if (target is not null
            && (this.artifactSpotResultExecutionId is null || this.artifactSpotResultRequestId is null
                || this.artifactSpotResultRevision != this.revision
                || this.artifactSpotResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.artifactSpotResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.artifactSpotResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "artifact_spot_dug"))
        {
            this.InvalidateArtifactSpotResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.terrainFeatures.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is not null
            || (location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
            return Array.Empty<BridgeArtifactSpotResultTarget>();
        return new[] { target };
    }

    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
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
        return NearestFirst(location.objects.Pairs
            .Where(pair => Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player) && NativeItemPredicates.IsBreakableStone(pair.Value)), player)
            .Take(8).Select(pair => new BridgeRockSourceTarget(BuildRockSourceTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.MinutesUntilReady)).ToArray();
    }

    private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(Farmer player, DiscoveryExclusionRecorder? exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDebrisTarget>();
        List<BridgeDebrisTarget> result = new();
        for (int index = 0; index < location.resourceClumps.Count && result.Count < 64; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            int x = (int)clump.Tile.X;
            int y = (int)clump.Tile.Y;
            if (!IsDebrisTargetWithinPlayerRadius(clump, player)) continue;
            // The native requirement table lives in ONE place now
            // (TryGetDebrisToolRequirement, mirroring ResourceClump.performToolAction), so
            // discovery and admission cannot drift apart.
            if (!TryGetDebrisToolRequirement(clump, out string toolKind, out int requiredUpgrade))
                continue;
            int usableSlot = -1;
            for (int slot = 0; slot < player.Items.Count; slot++)
            {
                if (player.Items[slot] is Tool candidate && IsValidDebrisTool(clump, candidate, out _, out _))
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
            result.Add(new BridgeDebrisTarget(BuildDebrisTargetId(location, index, clump), usableSlot, x, y, clump.parentSheetIndex.Value, toolKind, requiredUpgrade, (int)clump.health.Value));
        }
        return result;
    }

    private static IReadOnlyList<BridgeWateringCanFact> DiscoverWateringCanFacts(Farmer player) => player.Items
        .Select((item, slot) => (item, slot))
        .Where(entry => entry.item is WateringCan)
        .Take(36)
        .Select(entry =>
        {
            WateringCan can = (WateringCan)entry.item!;
            return new BridgeWateringCanFact(entry.slot, can.QualifiedItemId, DescribeTool(can) ?? "watering_can", can.WaterLeft, can.waterCanMax);
        })
        .ToArray();

    /// <summary>
    /// The tiles a watering can can be refilled at, WHOLE MAP, nearest first.
    ///
    /// <para>
    /// The scan used to stop at <see cref="TargetDiscoveryRadius"/>, which is right for an entity and wrong
    /// for water: a pond is a map feature, and on a farm the nearest water is routinely ten to twenty tiles
    /// away. Measured 2026-11-04: the family published ZERO refill targets on a farm whose pond sat outside
    /// the six-tile ring, so a watering plan dead-ended on an empty can while the map had water the actor
    /// could walk to. Reachability is decided by the WALK, never by this list - the radius only ever decided
    /// which water a snapshot mentioned.
    /// </para>
    ///
    /// <para>
    /// Nearest first, then X, then Y, and the cap keeps the nearest: every dropped row is therefore strictly
    /// farther than every published one, which is the one truncation a refill plan cannot be misled by - it
    /// walks to the closest water and refills there. The predicate is the engine's own
    /// <c>GameLocation.CanRefillWateringCanOnTile</c> (<c>GameLocation.cs:2293</c>), so a water tile, a
    /// <c>WaterSource</c> property and an indoor kitchen all arrive through the same authority the tool itself
    /// uses rather than through a second reading of the map data.
    /// </para>
    /// </summary>
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
            .OrderBy(tile => ChebyshevDistance(player, tile.X, tile.Y))
            .ThenBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .Take(MaximumRefillWateringCanTargets)
            .Select(tile => new BridgeRefillWateringCanTarget(BuildRefillWateringCanTargetId(location, tile.X, tile.Y), tile.X, tile.Y))
            .ToArray();
    }

    /// <summary>
    /// The current location's completed Pet Bowl, advertised at each tile the
    /// native watering gate accepts so the actor plans a walk to an adjacent
    /// tile. The handler revalidates the exact tile identity and never trusts
    /// this coordinate as the target of the native call.
    /// </summary>
    private static IReadOnlyList<BridgePetBowlTarget> DiscoverPetBowlTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetBowlTarget>();
        List<BridgePetBowlTarget> result = new();
        foreach (StardewValley.Buildings.PetBowl bowl in location.buildings.OfType<StardewValley.Buildings.PetBowl>())
        {
            // A bowl still being built exists on the map but is not yet a target; the engine's own countdown says so.
            if (bowl.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            // A watered bowl admits no further watering, so it is not a target.
            if (bowl.watered.Value)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            // Advertise only the tiles the native watering gate accepts, derived
            // from the building's own tile-property data rather than assumed to be
            // the footprint origin.
            foreach (Vector2 tile in PetBowlWaterableTiles(bowl))
            {
                if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                result.Add(new BridgePetBowlTarget(BuildPetBowlTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y));
            }
            if (result.Count >= 8) break;
        }
        return result;
    }

    /// <summary>
    /// The current Slime Hutch's unwatered trough tiles. `SlimeHutch.
    /// performToolAction` accepts the literal interior tiles x == 16, y in 6..9,
    /// so discovery advertises exactly those coordinates (and only the ones the
    /// actor can legally stand beside / walk to) rather than asking the building
    /// for tile properties; the handler revalidates the coordinate and the
    /// location identity and never trusts this list.
    /// </summary>
    private static IReadOnlyList<BridgeSlimeHutchTroughTarget> DiscoverSlimeHutchTroughTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        if (player.currentLocation is not StardewValley.SlimeHutch hutch)
            return Array.Empty<BridgeSlimeHutchTroughTarget>();
        List<BridgeSlimeHutchTroughTarget> result = new();
        for (int y = SlimeHutchTroughFirstRow; y <= SlimeHutchTroughLastRow; y++)
        {
            if (!IsSlimeHutchTroughTile(SlimeHutchTroughColumn, y)) continue;
            // A watered spot admits no further watering, so it is not a target.
            if (hutch.waterSpots[y - SlimeHutchTroughFirstRow])
            {
                exclusions.Record("slimeHutchTroughTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            if (!IsTileWithinChebyshevRadius(player, SlimeHutchTroughColumn, y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSlimeHutchTroughTarget(BuildSlimeHutchTroughTargetId(hutch, SlimeHutchTroughColumn, y), SlimeHutchTroughColumn, y));
        }
        return result;
    }

    /// <summary>
    /// Every tool in the pack, with an upgrade level ONLY for the tools that upgrade.
    ///
    /// <para>
    /// `Tool.UpgradeLevel` is `-1` by CONSTRUCTION for a tool that cannot be upgraded — measured on Stardew Valley
    /// 1.6.15 (build 24356): `new MilkPail().UpgradeLevel == -1` and `new Shears().UpgradeLevel == -1`, while Axe, Hoe,
    /// Pickaxe and WateringCan are `0`. The wire contract's own rule (`host/src/protocol-target-facts.ts`,
    /// `isToolSlotFact`) reads a level as an upgrade tier, refuses a negative one and closes the bridge with
    /// `invalid_snapshot:toolSlots`, and states that an ABSENT level means "this tool does not upgrade". So the
    /// producer speaks that form rather than sending the engine's sentinel: measured 2026-11-09, `collect_animal_product`
    /// could not read a single snapshot because its fixture stocks the pack with a Milk Pail.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeToolSlot> DiscoverToolSlots(IList<Item?> items)
    {
        List<BridgeToolSlot> slots = new();
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool) continue;
            slots.Add(new BridgeToolSlot(
                slot,
                DescribeTool(tool) ?? "tool",
                tool.UpgradeLevel >= 0 ? tool.UpgradeLevel : null,
                ToolCategory(tool) ?? "unknown"));
        }

        return slots;
    }

    private IReadOnlyList<BridgeFeedTroughTarget> DiscoverFeedTroughTargets(Farmer player)
    {
        if (player.currentLocation is not AnimalHouse location) return Array.Empty<BridgeFeedTroughTarget>();
        List<BridgeFeedTroughTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object hay || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 32; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 32; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || location.doesTileHaveProperty(x, y, "Trough", "Back") is null || location.objects.ContainsKey(tile))
                        continue;
                    result.Add(new BridgeFeedTroughTarget(BuildFeedTroughTargetId(location, slot, x, y, hay.Stack), slot, x, y, hay.Stack));
                }
            }
        }
        return result;
    }

    /// <summary>
    /// Every eligible storage container as a SENSED ENTITY: one row per container, carrying the container's own
    /// identity and the contents of EVERY occupied slot in that container's slot order.
    ///
    /// <para>
    /// This is the perception half of a split the two row-per-pair families never made. `chest_store` and
    /// `chest_retrieve` need an ADDRESS - a container and an item - so discovering them as `containers x items`
    /// multiplied two independently-sized sets together. That is why every previous fix was a budget tweak rather
    /// than a correct answer: a budget is what you add when you cannot say why the set is that large. Measured
    /// 2026-10-31 on the real projection: a 36-item chest reached the model as 16 rows, and four chests of 16
    /// items saturated the whole 64-row family limit.
    /// </para>
    /// <para>
    /// So the two facts are published separately. Perception is the complete mirror: a container's contents are a
    /// fact about that container, and a companion told about 16 of its 36 items cannot plan the other 20. Execution
    /// is the safe slice the handler revalidates. The CONTAINER list is still distance-bounded like every other
    /// radar family - bounding how many containers are in view is legitimate, truncating one container's contents
    /// is not.
    /// </para>
    /// <para>
    /// `ChestId` is `BuildContainerTargetId`, the identity an execution already echoes as `expectedTargetId`, so
    /// the container an observation names and the container a handler revalidates are one spelling rather than a
    /// second id minted for this family.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestState>();
        List<BridgeChestState> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in OrderedStorageContainers(player, location))
        {
            // No cap on the contents and no admission filtering: this is what the container HOLDS, not what this
            // actor's pack could currently accept. Only an empty slot is skipped, because an empty slot is not an
            // item the container holds.
            IList<StardewValley.Item> inventory = chest.GetItemsForPlayer();
            List<BridgeChestItem> items = new();
            for (int slot = 0; slot < inventory.Count; slot++)
            {
                StardewValley.Item? item = inventory[slot];
                if (item is null || item.Stack <= 0) continue;
                items.Add(new BridgeChestItem(slot, item.QualifiedItemId, RequireDisplayName(item.QualifiedItemId), item.Stack));
            }
            result.Add(new BridgeChestState(
                BuildContainerTargetId(location, x, y, chest, isFridge),
                x,
                y,
                RequireDisplayName(chest.QualifiedItemId),
                isFridge,
                items));
        }
        return result;
    }

    /// <summary>
    /// Every eligible storage container in discovery range: player-owned ordinary
    /// Chests placed in the location's object layer, plus the location's built-in
    /// kitchen fridge.
    ///
    /// The built-in fridge deserves the same player intent as any chest — store or
    /// take one adjacent item — because it literally IS a Chest
    /// (`FarmHouse.fridge`/`IslandFarmHouse.fridge` are `NetRef&lt;Chest&gt;` built with
    /// `playerChest: true`), and the production transaction is the same
    /// `Chest.addItem` / `GetItemsForPlayer().Remove` pair. The only difference is
    /// resolution: the fridge never enters `location.objects`, so it can only be
    /// reached through `GameLocation.GetFridge()` and its map tile.
    /// </summary>
    private static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> DiscoverStorageContainers(
        Farmer player, StardewValley.GameLocation location) =>
        LocationStorageContainers(location)
            .Where(container => IsOwnedOrdinaryChest(container.Chest) && IsChestTargetInRange(player, container.X, container.Y));

    private IReadOnlyList<BridgeAnimalProductTarget> DiscoverAnimalProductTargets(Farmer player)
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
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool)) continue;
                StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
                if (!player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack)) continue;
                result.Add(new BridgeAnimalProductTarget(BuildAnimalProductTargetId(location, slot, animal, tool), slot, x, y, animal.type.Value, produce.QualifiedItemId, RequireDisplayName(produce.QualifiedItemId), tool is MilkPail ? "milk_pail" : "shears", produceStack));
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
                    return $"{animal.type.Value}@{x},{y}:produce={produce.QualifiedItemId}:in_range={IsAnimalProductTargetInRange(player, x, y)}:shears={animal.CanGetProduceWithTool(new Shears())}:milk={animal.CanGetProduceWithTool(new MilkPail())}:inventory={player.couldInventoryAcceptThisItem(produce.QualifiedItemId, animal.hasEatenAnimalCracker.Value ? 2 : 1)}";
                }));
            this.monitor.Log($"GameBuddy animal-product discovery fail-closed: location={location.NameOrUniqueName}; player={(int)player.Tile.X},{(int)player.Tile.Y}; candidates={candidates}", LogLevel.Trace);
        }
        return result;
    }

    private static IReadOnlyList<BridgeInventoryItemFact> DiscoverInventoryItemFacts(Farmer player)
    {
        List<BridgeInventoryItemFact> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            // Hat / Clothing / Boots are Item subclasses, not Object; the
            // mannequin lane needs their slots surfaced to the Agent.
            if (player.Items[slot] is not Item item || string.IsNullOrWhiteSpace(item.QualifiedItemId))
                continue;
            int stack = item is StardewValley.Object obj ? obj.Stack : 1;
            if (stack < 1) continue;
            result.Add(new BridgeInventoryItemFact(slot, item.QualifiedItemId, RequireDisplayName(item.QualifiedItemId), stack));
        }
        return result;
    }

    private static IReadOnlyList<BridgeFoodTarget> DiscoverFoodTargets(Farmer player)
    {
        List<BridgeFoodTarget> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object food)
                continue;
            bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
            if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
                continue;
            result.Add(new BridgeFoodTarget(slot, food.QualifiedItemId, RequireDisplayName(food.QualifiedItemId), food.Stack, food.Edibility, isDrink));
        }
        return result;
    }

    private static IReadOnlyList<BridgeForageTarget> DiscoverForageTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeForageTarget>();
        return NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null && pair.Value.isForage() && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player)
            .Take(64)
            .Select(pair => new BridgeForageTarget(BuildForageTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.Stack, pair.Value.isForage()))
            .ToArray();
    }

    private IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(Farmer player)
    {
        const int discoveryRadius = TargetDiscoveryRadius;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeItemTarget>();
        List<BridgeItemTarget> result = new();
        // The actor's count of an item is measured ONCE per publication, at the moment the chunks below are still
        // on the ground - that is the only moment at which the number can be evidence of anything. Reading it after
        // the drop was delivered would make the check it feeds a tautology.
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
                Point tile = GetChunkTile(chunk);
                if (IsTileWithinChebyshevRadius(player, tile.X, tile.Y, discoveryRadius))
                {
                    string targetId = BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                    int stack = Math.Max(1, debris.item?.Stack ?? 1);
                    if (!inventoryAtPublicationByItemId.TryGetValue(qualifiedItemId, out int inventoryAtPublication))
                        inventoryAtPublicationByItemId[qualifiedItemId] = inventoryAtPublication = CountQualifiedItem(player, qualifiedItemId);
                    this.groundItemTargets.Record(new GroundItemPublication(
                        targetId,
                        location.NameOrUniqueName,
                        tile.X,
                        tile.Y,
                        qualifiedItemId,
                        stack,
                        inventoryAtPublication,
                        this.tick));
                    result.Add(new BridgeItemTarget(targetId, tile.X, tile.Y, qualifiedItemId, RequireDisplayName(qualifiedItemId), stack));
                    if (result.Count >= 64) break;
                }
                chunkIndex++;
            }
        }
        return result;
    }

    private static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSeedTarget>();
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => item.Category == StardewValley.Object.SeedsCategory);
        int rowLimit = TargetRowBudget.PerKeyRowLimit(heldStacks, TargetRowBudget.PlanNodes);
        List<BridgeSeedTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
                continue;
            // THIS STACK'S OWN WINDOW. The guard used to be one family-wide `result.Count < 64`, tested on both loops,
            // which the first held stack spent in full: 169 candidate tiles against a 64-row budget meant every later
            // seed slot published nothing at all, so `plant_seed` had no address for the second crop the companion was
            // carrying. Measured 2026-10-29 (`round7`): 64 rows, all from one stack, on 14 of 33 observations.
            List<BridgeSeedTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    // Both published facts are the engine's own answers on this tile, read once: the season/raised-crop
                    // admission `plant_seed` re-checks, and the crop occupancy that makes the tile unusable for a seed.
                    bool canPlantThisSeedHere = dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false);
                    if (dirt.crop is not null || !canPlantThisSeedHere)
                        continue;
                    rowsForThisStack.Add(new BridgeSeedTarget(BuildSeedTargetId(location, slot, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId, RequireDisplayName(seed.QualifiedItemId), canPlantThisSeedHere, dirt.crop is not null));
                }
            }
            // Nearest first, THEN the window: the scan walks x then y from the far corner, so trimming first would keep
            // whichever tiles the loops reached first. Chebyshev, through `TargetOrdering`, because that is the metric
            // the range gate applies - a tile nearer by Manhattan can still be further from being in range.
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(rowLimit));
        }
        // A stack is independent of every other stack - a row in slot A can never address slot B's item, and
        // `ExecutePlantSeed` recomputes `BuildSeedTargetId` from slot AND tile and refuses on a mismatch - so ordering
        // within each stack's window IS the whole list's order, and the stacks stay in inventory order. Nothing is
        // renumbered: every id here is exactly the one the action will recompute.
        return result;
    }

    private static IReadOnlyList<BridgeWoodFenceTarget> DiscoverWoodFenceTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeWoodFenceTarget>();
        List<BridgeWoodFenceTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object source || source.QualifiedItemId != "(O)322" || source.Stack <= 0)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 16; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 16; y++)
            {
                Vector2 tile = new(x, y);
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || !IsLegalEmptyFarmFenceTile(farm, tile, source))
                    continue;
                result.Add(new BridgeWoodFenceTarget(BuildWoodFenceTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)322", RequireDisplayName("(O)322")));
            }
        }
        return result;
    }

    private static IReadOnlyList<BridgeBaitCrabPotTarget> DiscoverBaitCrabPotTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
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
                if (placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                // `CrabPot.NeedsBait` is false for a pot that already carries bait (CrabPot.cs:64-71), and the drop-in
                // that fills one is gated on that same predicate (:239). The pot exists and is not a bait target.
                if (crabPot.bait.Value is not null)
                {
                    exclusions.Record("baitCrabPotTargets", DiscoveryExclusionReasons.AlreadyBaited);
                    continue;
                }
                result.Add(new BridgeBaitCrabPotTarget(BuildBaitCrabPotTargetId(location, slot, (int)tile.X, (int)tile.Y), location.NameOrUniqueName, slot, (int)tile.X, (int)tile.Y, "(O)710", RequireDisplayName("(O)710"), "(O)685", crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), 1));
            }
        }
        return result;
    }

    /// <summary>
    /// Publishes the live mature crab pots the collect action may settle from.
    /// collect_crab_pot_output is an advertised capability, but without this
    /// channel it could never be reached: no other snapshot field carries the
    /// mature target identity, so the Agent had no way to name a pot. It only
    /// reads the already-mature 714 state; production alone performs the single
    /// native collection and owns the receipt/postcondition.
    /// </summary>
    private static IReadOnlyList<BridgeCrabPotCollectTarget> DiscoverCrabPotCollectTargets(Farmer player)
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
                || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCrabPotCollectTarget(
                BuildCollectCrabPotTargetId(location, (int)tile.X, (int)tile.Y),
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                "(O)710",
                RequireDisplayName("(O)710"),
                crabPot.heldObject.Value.QualifiedItemId,
                Math.Max(1, crabPot.heldObject.Value.Stack)));
        }
        return result;
    }

    private static IReadOnlyList<BridgeCrabPotTarget> DiscoverCrabPotTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeCrabPotTarget>();
        List<BridgeCrabPotTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object source || source.QualifiedItemId != "(O)710" || source.Stack <= 0)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 16; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 16; y++)
            {
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                    || !StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, x, y))
                    continue;
                result.Add(new BridgeCrabPotTarget(BuildCrabPotTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)710", RequireDisplayName("(O)710")));
            }
        }
        return result;
    }

    private static IReadOnlyList<BridgeFertilizerTarget> DiscoverFertilizerTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFertilizerTarget>();
        List<BridgeFertilizerTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object fertilizer || fertilizer.Category != StardewValley.Object.fertilizerCategory)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 64; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 64; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    // The engine's own admission answer on this tile, published beside the tile instead of implied by the
                    // filter: `fertilize_tile` refuses a row whose `CanApplyFertilizer` no longer holds.
                    bool canApplyFertilizer = dirt.CanApplyFertilizer(fertilizer.QualifiedItemId);
                    if (!canApplyFertilizer)
                        continue;
                    result.Add(new BridgeFertilizerTarget(BuildFertilizerTargetId(location, slot, x, y, fertilizer.QualifiedItemId), slot, x, y, fertilizer.QualifiedItemId, RequireDisplayName(fertilizer.QualifiedItemId), canApplyFertilizer));
                }
            }
        }
        return result;
    }

    private static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        List<BridgeHarvestTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                // A forage crop in the dirt is `pickup_forage`'s subject rather than a `harvest_crop` row; the kind test
                // stays in the filter because it is a KIND, not a state the engine refuses.
                && !dirt.crop.forageCrop.Value
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
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
            result.Add(new BridgeHarvestTarget(
                BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, harvestId),
                (int)pair.Key.X,
                (int)pair.Key.Y,
                crop.netSeedIndex.Value ?? harvestId,
                harvestItem.QualifiedItemId,
                harvestItem.DisplayName,
                crop.RegrowsAfterHarvest(),
                dirt.readyForHarvest(),
                crop.forageCrop.Value,
                ExecutionManager.HarvestMethodName(crop.GetHarvestMethod())));
        }
        return result;
    }

    private static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCropTarget>();
        // `water_crop` refuses a row that is watered and `harvest_crop` needs the ready flag, so the row states both
        // from the engine's own predicates on this dirt instead of leaving the reader to infer them from the filter.
        List<BridgeCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null }
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
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
            // The other half of `CropNeedsWater`, still read through that ONE spelling so this family and the whole-map
            // count cannot disagree: the crop itself needs no water (`HoeDirt.needsWatering`, HoeDirt.cs:380).
            if (!CropNeedsWater(dirt)) continue;
            StardewValley.Crop crop = dirt.crop!;
            string cropId = crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown";
            // `Crop.GetData()` is the engine's own `Data/Crops` lookup for THIS crop (Crop.cs:330 -> Game1.cropData), the
            // same row `look_up({table:"Crops"})` answers with. Null is a fact - a content pack can add a seed whose
            // data row the engine cannot resolve - so the five data fields stay null and `CropFactsUnknown` says why.
            StardewValley.GameData.Crops.CropData? data = crop.GetData();
            result.Add(new BridgeCropTarget(
                TargetId: BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, crop.indexOfHarvest.Value),
                X: (int)pair.Key.X,
                Y: (int)pair.Key.Y,
                CropId: cropId,
                DisplayName: RequireDisplayName(crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown"),
                Watered: dirt.isWatered(),
                Harvestable: dirt.readyForHarvest(),
                DaysToHarvest: data is null ? null : data.DaysInPhase.Sum(),
                RegrowDays: data?.RegrowDays,
                HarvestMethod: data is null ? null : HarvestMethodName(data.HarvestMethod),
                IsRaised: data?.IsRaised,
                Seasons: data?.Seasons is null
                    ? null
                    : data.Seasons.Select(static season => Utility.getSeasonKey(season)).Distinct().ToArray(),
                FullyGrown: crop.fullyGrown.Value,
                TileBlockedNow: IsTileBlockedForFarmer(location, player, (int)pair.Key.X, (int)pair.Key.Y),
                CropFactsUnknown: data is null ? CropFactsUnknownToken : null));
        }
        return result;
    }

    internal static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player, out int omitted)
    {
        omitted = 0;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSoilTile>();
        List<(int Distance, BridgeSoilTile Tile)> candidates = new();
        int originX = player.TilePoint.X;
        int originY = player.TilePoint.Y;
        for (int x = originX - SoilTileDiscoveryRadius; x <= originX + SoilTileDiscoveryRadius; x++)
        {
            if (x < 0) continue;
            for (int y = originY - SoilTileDiscoveryRadius; y <= originY + SoilTileDiscoveryRadius; y++)
            {
                if (y < 0) continue;
                Vector2 tile = new(x, y);
                // The engine's own occupancy read: `terrainFeatures[tile] as HoeDirt`, which is what `till_soil`
                // refuses on and what `plant_seed` requires. Read once, so the row's state and the branch below
                // cannot disagree.
                bool hoeDirt = location.GetHoeDirtAtTile(tile) is not null;
                // A hoed tile is published whatever else occupies it. A TILLABLE one must also be free and
                // reachable, which is the set `till_soil` admits once the actor walks up to it.
                if (!hoeDirt && !IsTillableTile(location, x, y))
                    continue;
                candidates.Add((Math.Max(Math.Abs(x - originX), Math.Abs(y - originY)), new BridgeSoilTile(x, y, hoeDirt)));
            }
        }
        // Nearest first, then a stable coordinate order so repeated observations
        // of an unchanged world produce the same bounded list.
        BridgeSoilTile[] ordered = candidates
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Tile.Y)
            .ThenBy(candidate => candidate.Tile.X)
            .Select(candidate => candidate.Tile)
            .ToArray();
        // Nearest-first truncation, STATED: every dropped tile is farther than every kept one, and the count is
        // the one number that separates a bounded slice from a complete patch.
        int published = Math.Min(ordered.Length, MaximumDiscoveredSoilTiles);
        omitted = ordered.Length - published;
        return ordered[..published];
    }
}
