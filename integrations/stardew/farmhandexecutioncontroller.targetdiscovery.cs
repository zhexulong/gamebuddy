using System.Globalization;
using GameBuddy.Stardew.Core;
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

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The rows one radius-window family publishes: the fence and crab-pot lists.
    ///
    /// <para>
    /// THIS IS THE HOST'S NUMBER, NOT THE FARM'S. The Host declares <c>maxItems</c> per snapshot family in
    /// <c>SNAPSHOT_FAMILY_RULES</c> and REFUSES THE WHOLE SNAPSHOT past it rather than trimming, so this is a bound on
    /// what one observation can carry - published by the Mod only because the wire cannot carry more. It is not a
    /// statement about how much the world offers: the crab-pot shore under one actor is routinely larger than this, and
    /// the fence list can never reach it at all, because <c>Utility.playerCanPlaceItemHere</c> admits the radius-1 ring
    /// only (<c>TargetDiscoveryOrderTests</c> pins both).
    /// </para>
    /// </summary>
    /// <remarks>
    /// Not hand-picked: <c>EveryRadiusWindowCapIsTheHostsDeclaredMaxItemsForItsFamily</c> reads the number back out of
    /// <c>SNAPSHOT_FAMILY_RULES</c> for each family that spends it, so the two layers cannot drift apart silently.
    /// </remarks>
    internal const int RadiusWindowRowBudget = 16;

    /// <summary>
    /// The same bound for the fertilizer list, which the Host declares at four times as many rows because one tile can
    /// carry far more fertilizer candidates than it can hold a fence.
    /// </summary>
    internal const int FertilizerRowBudget = 64;

    /// <summary>
    /// WHETHER A TILE IS A PLACE a published target row may name - the one admission every family's tile passes
    /// before it becomes a row.
    ///
    /// <para>
    /// Measured `round77` (2026-11-19): twelve `move_to_tile` attempts, seven distinct receipts, every one
    /// `no_native_path` with `native=not_attempted`, on coordinates the Mod had named. Two of those coordinates do not
    /// exist on the map the body was standing on at all - `79,16` and `80,16` read in `Backwoods`, whose east exit the
    /// Farm publishes at `x = width` - and the FarmHouse's `45,22` is the same shape: a cell an interior of that size
    /// does not contain. A third (`80,0` in `Mountain`) is a Buildings-layer wall. The probe refused them all before the
    /// engine was asked, and each refusal cost a turn: a row naming a cell no body can ever occupy is not a target, it
    /// is a coordinate.
    /// </para>
    ///
    /// <para>
    /// THE RULE, and it is deliberately the MAP's answer rather than this frame's: the tile is on the map, and at least
    /// one cardinal neighbour is a cell <c>GameLocation.isTilePassable</c> admits (GameLocation.cs:3192, the Back and
    /// Buildings layers - the engine's own reading of the map's ground). The body stands BESIDE a target, not on it
    /// (a tree, a chest, a weed and a trellis crop are all cells the planner refuses), so a tile with no admissible
    /// neighbour is a cell nothing can be done at, however interesting the entity on it looks.
    /// </para>
    ///
    /// <para>
    /// The two things this is NOT: the reachability flood's verdict, and the occupancy list. A target that vanished
    /// because a chicken stood beside it would be a radar that changes between two snapshots of the same world, and the
    /// flood answers a question about where the body IS rather than about where a tile is - a target inside a sealed
    /// pocket is a place the receipt can name (`target_enclosed=true`), and it becomes usable the moment the pocket opens.
    /// `DiscoverArtifactSpotTargets` asks the stricter planner question on top of this, because an artifact spot is only
    /// worth a row when a body can dig THIS frame; that is a second question and it keeps its own spelling.
    /// </para>
    /// </summary>
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

    /// <summary>The four cells a body can stand on beside one tile, in the planner's own cardinal step set.</summary>
    private static (int X, int Y)[] CardinalNeighbours(int x, int y) => new[]
    {
        (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1),
    };

    /// <summary>
    /// The discovery radius AND <see cref="IsTargetTileAddressable"/>, as one question: the bound every family's
    /// candidate tile is admitted through. Kept beside the radius test it composes so a family cannot pick up the
    /// distance and forget the place.
    /// </summary>
    private static bool IsPublishedTargetTileInRadius(Farmer player, int x, int y, int radius) =>
        IsTileWithinChebyshevRadius(player, x, y, radius) && IsTargetTileAddressable(player.currentLocation, x, y);

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
    private static IReadOnlyList<T> NearestFirstRadiusWindowRows<T>(
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
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
            {
                if (!IsPublishedTargetTileInRadius(player, x, y, TargetDiscoveryRadius)) continue;
                if (buildRow(source, slot, x, y) is not { } row) continue;
                candidates.Add(row);
            }
        }

        return TargetOrdering.NearestFirstByChebyshev(candidates, (int)player.Tile.X, (int)player.Tile.Y, identify)
            .Take(rowBudget).ToArray();
    }

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
    /// <para>
    /// THE SAME TABLES ANSWER FOR A MAP SHE IS NOT ON. <see cref="DiscoverDoorTargets(GameLocation, Farmer)"/> takes the location
    /// rather than the actor for exactly one reason: a coordinate a request names may be a door of ANOTHER map (round82), and
    /// the only honest way to say which map it belongs to is to ask that map the same question this one is asked here.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player) =>
        player.currentLocation is { } location ? DiscoverDoorTargets(location, player) : Array.Empty<BridgeDoor>();

    /// <summary>The same three tables, asked of <paramref name="location"/> - the map whose doors these rows are.</summary>
    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(StardewValley.GameLocation location, Farmer actor)
    {
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            if (DescribeDoor(point.X, point.Y, location.getWarpFromDoor(point, actor)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            if (DescribeDoor(point.X, point.Y, ResolveDoorWarp(location, point)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
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
    /// <para>
    /// <see cref="BridgeNpcRelationshipTarget.Marker"/> is the second half of the row: the relationship is what the pair
    /// have, and the marker is what the world is SHOWING over the villager - see <see cref="DescribeNpcMarker"/>. It is
    /// published on every row, `none` included, so a reader can tell "nothing is over their head" from "this row does not
    /// say".
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeNpcRelationshipTarget> DiscoverNpcRelationshipTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeNpcRelationshipTarget>();
        List<string> questTargets = QuestTargetNpcNames(player);
        List<string> orderRequesters = LiveSpecialOrderRequesters(player);
        return location.characters
            .OfType<StardewValley.NPC>()
            .Where(npc => npc.IsVillager
                && !string.IsNullOrWhiteSpace(npc.Name)
                && IsPublishedTargetTileInRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, TargetDiscoveryRadius))
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
                    friendship.GiftsThisWeek,
                    DescribeNpcMarker(npc, questTargets, orderRequesters));
            })
            .ToArray();
    }

    /// <summary>
    /// The <c>marker</c> values this row publishes, as a closed set. The four words are the four answers the world's own
    /// predicates give; see <see cref="BridgeNpcRelationshipTarget"/> for which seam each one is read from, and
    /// <see cref="DescribeNpcMarker"/> for the precedence between them.
    /// </summary>
    internal const string NpcMarkerQuest = "quest";

    internal const string NpcMarkerSpecialOrder = "special_order";

    internal const string NpcMarkerDialogue = "dialogue";

    internal const string NpcMarkerNone = "none";

    /// <summary>
    /// What the world is showing over one villager's head, in the strongest of the three states the engine keeps: a
    /// quest in the player's log that names them, a live special order they are the requester of, or a temporary message
    /// the engine has for them.
    ///
    /// <para>
    /// THE THREE ARE READ FROM THREE PLACES, which is why this is a function and not a field lookup: `Quest.target` on
    /// the two billboard quest types that name an NPC, `SpecialOrder.requester`, and `NPC.hasTemporaryMessageAvailable`
    /// / `NPC.TemporaryDialogue`. The order is the order a reader needs: a quest to hand in is an action she can take, a
    /// special order is one she is partway through, and a queued line is something the villager will say. Every earlier
    /// state is the stronger one, and a villager in none of them answers `none` - a measured absence, never silence.
    /// </para>
    /// <para>
    /// `NPC.CurrentDialogue` is deliberately NOT one of them. Its getter computes and caches the day's dialogue when the
    /// NPC has not been talked to yet (`loadCurrentDialogue`, NPC.cs:3608), so asking it here would make observation WRITE
    /// engine state - the one thing the rest of this file's read-only discovery avoids.
    /// </para>
    /// </summary>
    internal static string DescribeNpcMarker(StardewValley.NPC npc, IReadOnlyList<string> questTargets, IReadOnlyList<string> specialOrderRequesters)
    {
        string name = npc.Name;
        if (questTargets.Any(target => string.Equals(target, name, StringComparison.Ordinal)))
            return NpcMarkerQuest;
        if (specialOrderRequesters.Any(requester => string.Equals(requester, name, StringComparison.Ordinal)))
            return NpcMarkerSpecialOrder;
        if (npc.hasTemporaryMessageAvailable() || npc.TemporaryDialogue is { Count: > 0 })
            return NpcMarkerDialogue;
        return NpcMarkerNone;
    }

    /// <summary>
    /// The NPCs the player's own quest log is waiting on: `ItemDeliveryQuest.target` and `ResourceCollectionQuest.target`,
    /// read off the two engine quest types that name a villager, and only while the quest is not complete.
    /// </summary>
    private static List<string> QuestTargetNpcNames(Farmer player)
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

    /// <summary>The requester of every order the team is currently carrying - `SpecialOrder.requester`, the NPC the board credited it to.</summary>
    private static List<string> LiveSpecialOrderRequesters(Farmer player)
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
                if (dirt.crop.dead.Value)
                {
                    exclusions.Record("wateringWhereabouts", DiscoveryExclusionReasons.Dead);
                    continue;
                }
                if (!CropNeedsWater(dirt))
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

    private static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        List<BridgePetTarget> result = new();
        foreach (Pet pet in location.characters.OfType<Pet>()
            .Where(pet => IsPublishedTargetTileInRadius(player, (int)pet.Tile.X, (int)pet.Tile.Y, TargetDiscoveryRadius))
            .Take(16))
        {
            BridgePetTarget target = new(
                BuildPetTargetId(location, (int)pet.Tile.X, (int)pet.Tile.Y, pet),
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
            .Where(animal => IsPublishedTargetTileInRadius(player, (int)animal.Tile.X, (int)animal.Tile.Y, TargetDiscoveryRadius))
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
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
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
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
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
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
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
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
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
            int stackRows = TargetRowBudget.RowsOneKeyCanSpend(rowLimit, sapling.Stack);
            if (stackRows < 1)
                continue;
            List<BridgeTreeSaplingTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsPublishedTargetTileInRadius(player, x, y, TargetDiscoveryRadius) || !CanPlantWildTreeSeedAt(location, sapling.QualifiedItemId, x, y))
                        continue;
                    rowsForThisStack.Add(new BridgeTreeSaplingTarget(BuildTreeSaplingTargetId(location, x, y, sapling.QualifiedItemId), slot, x, y, sapling.QualifiedItemId, RequireDisplayName(sapling.QualifiedItemId)));
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

    private static IReadOnlyList<BridgeWeedTarget> DiscoverWeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWeedTarget>();
        return NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null
                && pair.Value.IsWeeds()
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
            .Take(16)
            .Select(pair => new BridgeWeedTarget(
                BuildWeedTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.MinutesUntilReady, pair.Value.IsWeeds()))
            .ToArray();
    }

    private static IReadOnlyList<BridgeCaskTarget> DiscoverCaskTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCaskTarget>();
        List<BridgeCaskTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is not StardewValley.Objects.Cask cask
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCaskTarget(BuildCaskTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, cask), location.NameOrUniqueName,
                (int)pair.Key.X, (int)pair.Key.Y, cask.heldObject.Value is not null, cask.heldObject.Value?.QualifiedItemId));
            if (result.Count >= 16) break;
        }
        return result;
    }

    /// <summary>
    /// The mannequins this observation publishes: the room the actor stands in, the discovery radius, and a tile a body
    /// can stand beside. Internal because a fixture that places a mannequin must ask THIS answer rather than a second
    /// copy of the two rules - a display target the wire does not carry is a target the day cannot name.
    /// </summary>
    internal static IReadOnlyList<BridgeMannequinTarget> DiscoverMannequinTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Mannequin && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
            .Select(pair => new BridgeMannequinTarget(BuildMannequinTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y)).ToArray() ?? Array.Empty<BridgeMannequinTarget>();
    }

    /// <summary>The signs this observation publishes, by the same rules as <see cref="DiscoverMannequinTargets"/>.</summary>
    internal static IReadOnlyList<BridgeSignTarget> DiscoverSignTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Sign && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
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
            if (!IsPublishedTargetTileInRadius(player, door.X, door.Y, TargetDiscoveryRadius)) continue;
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
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
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
                || !IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
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
        return NearestFirst(location.terrainFeatures.Pairs.Where(pair => IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)
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
                && location.isTileOnMap(pair.Key)
                && !location.terrainFeatures.ContainsKey(pair.Key)
                && location.GetHoeDirtAtTile(pair.Key) is null
                && pair.Value is not StardewValley.Objects.IndoorPot
                && new[] { pair.Key + new Vector2(-1f, 0f), pair.Key + new Vector2(1f, 0f), pair.Key + new Vector2(0f, -1f), pair.Key + new Vector2(0f, 1f) }
                    .Any(standing => StardewBodyController.IsStandableTile(location, player, standing)))
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
            .Where(pair => IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius) && NativeItemPredicates.IsBreakableStone(pair.Value)), player)
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
            result.Add(new BridgeDebrisTarget(BuildDebrisTargetId(location, index, clump), usableSlot, x, y, clump.parentSheetIndex.Value, toolKind, requiredUpgrade, (int)clump.health.Value, Math.Max(1, clump.width.Value), Math.Max(1, clump.height.Value)));
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

    private static IReadOnlyList<BridgePetBowlTarget> DiscoverPetBowlTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
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
            foreach (Vector2 tile in PetBowlWaterableTiles(bowl))
            {
                if (!IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                result.Add(new BridgePetBowlTarget(BuildPetBowlTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y));
            }
            if (result.Count >= 8) break;
        }
        return result;
    }

    private static IReadOnlyList<BridgeSlimeHutchTroughTarget> DiscoverSlimeHutchTroughTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        if (player.currentLocation is not StardewValley.SlimeHutch hutch)
            return Array.Empty<BridgeSlimeHutchTroughTarget>();
        List<BridgeSlimeHutchTroughTarget> result = new();
        for (int y = SlimeHutchTroughFirstRow; y <= SlimeHutchTroughLastRow; y++)
        {
            if (!IsSlimeHutchTroughTile(SlimeHutchTroughColumn, y)) continue;
            if (hutch.waterSpots[y - SlimeHutchTroughFirstRow])
            {
                exclusions.Record("slimeHutchTroughTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            if (!IsPublishedTargetTileInRadius(player, SlimeHutchTroughColumn, y, TargetDiscoveryRadius)) continue;
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

    /// <summary>
    /// Every EMPTY trough of the animal house the actor stands in, paired with the pack stack of Hay that can fill it.
    ///
    /// <para>
    /// TWO FACTS, AND EACH IS NAMED FOR ITS OWNER. The trough's fact is its emptiness, and it is carried by membership:
    /// a tile that already holds an object is skipped, so no row is published about a trough that has hay in it. The
    /// actor's fact is the stack in the slot - the count the row publishes as `bagHay`, and the count
    /// `BuildFeedTroughTargetId` binds the request's `expectedTargetId` to. It is NOT the trough's count: nothing on this
    /// row states that the trough holds hay, because nothing in this family does.
    /// </para>
    /// </summary>
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
                    if (!IsPublishedTargetTileInRadius(player, x, y, TargetDiscoveryRadius) || location.doesTileHaveProperty(x, y, "Trough", "Back") is null || location.objects.ContainsKey(tile))
                        continue;
                    result.Add(new BridgeFeedTroughTarget(BuildFeedTroughTargetId(location, slot, x, y, hay.Stack), slot, x, y, hay.Stack));
                }
            }
        }
        return result;
    }

    private static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestState>();
        List<BridgeChestState> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in OrderedStorageContainers(player, location))
        {
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
                DescribeContainerName(chest),
                isFridge,
                items));
        }
        return result;
    }

    /// <summary>
    /// Every eligible storage container in discovery range: the location's own containers
    /// (<see cref="LocationStorageContainers"/>) that <see cref="IsStorageContainer"/> admits, which is
    /// the same predicate the chest summary counts - so no container this family offers is one the count
    /// skipped, and none the count includes is one the family cannot offer.
    ///
    /// The built-in fridge deserves the same player intent as any chest - store or
    /// take one adjacent item - because it literally IS a Chest
    /// (`FarmHouse.fridge`/`IslandFarmHouse.fridge` are `NetRef&lt;Chest&gt;` built with
    /// `playerChest: true`), and the production transaction is the same
    /// `Chest.addItem` / `GetItemsForPlayer().Remove` pair. The only difference is
    /// resolution: the fridge never enters `location.objects`, so it can only be
    /// reached through `GameLocation.GetFridge()` and its map tile.
    /// </summary>
    private static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> DiscoverStorageContainers(
        Farmer player, StardewValley.GameLocation location) =>
        LocationStorageContainers(location)
            .Where(container => IsStorageContainer(container.Chest) && IsChestTargetInRange(player, container.X, container.Y));

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
                if (!IsPublishedTargetTileInRadius(player, x, y, TargetDiscoveryRadius) || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool)) continue;
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
            .Where(pair => pair.Value is not null && pair.Value.isForage() && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
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
                if (IsPublishedTargetTileInRadius(player, tile.X, tile.Y, discoveryRadius))
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
            int stackRows = TargetRowBudget.RowsOneKeyCanSpend(rowLimit, seed.Stack);
            if (stackRows < 1)
                continue;
            List<BridgeSeedTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsPublishedTargetTileInRadius(player, x, y, TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    bool canPlantThisSeedHere = dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false);
                    if (dirt.crop is not null || !canPlantThisSeedHere)
                        continue;
                    rowsForThisStack.Add(new BridgeSeedTarget(BuildSeedTargetId(location, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId, RequireDisplayName(seed.QualifiedItemId), canPlantThisSeedHere, dirt.crop is not null));
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

    private static IReadOnlyList<BridgeWoodFenceTarget> DiscoverWoodFenceTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeWoodFenceTarget>();
        return NearestFirstRadiusWindowRows<BridgeWoodFenceTarget>(
            player,
            source => source.QualifiedItemId == "(O)322" && source.Stack > 0,
            RadiusWindowRowBudget,
            (source, slot, x, y) => IsLegalEmptyFarmFenceTile(farm, new Vector2(x, y), source)
                ? new BridgeWoodFenceTarget(BuildWoodFenceTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)322", RequireDisplayName("(O)322"))
                : null,
            row => new TargetCandidate(row.X, row.Y, row.Slot));
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
                if (placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || !IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
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
                || !IsPublishedTargetTileInRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
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
        return NearestFirstRadiusWindowRows<BridgeCrabPotTarget>(
            player,
            source => source.QualifiedItemId == "(O)710" && source.Stack > 0,
            RadiusWindowRowBudget,
            (_, slot, x, y) => StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, x, y)
                ? new BridgeCrabPotTarget(BuildCrabPotTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)710", RequireDisplayName("(O)710"))
                : null,
            row => new TargetCandidate(row.X, row.Y, row.Slot));
    }

    private static IReadOnlyList<BridgeFertilizerTarget> DiscoverFertilizerTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFertilizerTarget>();
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
                return new BridgeFertilizerTarget(BuildFertilizerTargetId(location, slot, x, y, source.QualifiedItemId), slot, x, y, source.QualifiedItemId, RequireDisplayName(source.QualifiedItemId), canApplyFertilizer);
            },
            row => new TargetCandidate(row.X, row.Y, row.Slot));
    }

    private static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        List<BridgeHarvestTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
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
        List<BridgeCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null }
                && IsPublishedTargetTileInRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
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
        FarmableBlocks blocks = new(location);
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
                if (!hoeDirt && !IsTillableTile(location, x, y))
                    continue;
                (int BlockX, int BlockY, int BlockW, int BlockH) block = blocks.Of(x, y);
                candidates.Add((Math.Max(Math.Abs(x - originX), Math.Abs(y - originY)), new BridgeSoilTile(x, y, hoeDirt, block.BlockX, block.BlockY, block.BlockW, block.BlockH)));
            }
        }
        BridgeSoilTile[] ordered = candidates
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Tile.Y)
            .ThenBy(candidate => candidate.Tile.X)
            .Select(candidate => candidate.Tile)
            .ToArray();
        int published = Math.Min(ordered.Length, MaximumDiscoveredSoilTiles);
        omitted = ordered.Length - published;
        return ordered[..published];
    }

    /// <summary>
    /// The connected strips of ground a patch can be opened in, measured lazily and once per region.
    ///
    /// <para>
    /// A STRIP IS A SET OF TILES, so it can only be answered by a walk: two tiles are in the same strip when a cardinal
    /// step reaches from one to the other through tiles that can become soil (see <see cref="IsFarmable"/>: ground the
    /// Hoe admits for ever, under nothing or under an occupant some published action clears). The walk itself has no
    /// radius, because the answer it exists for - "how wide and how long is this strip" - is exactly the fact a six-tile
    /// window cannot state: a 3x20 patch is 20 long and only 13 of it is ever inside the window.
    /// </para>
    /// <para>
    /// NOTHING IS TRUNCATED AND NOTHING IS THEREFORE WITHHELD: the walk stops at the map's own edge or at ground that is
    /// not farmable, so a published box is the whole strip. The only bound this family still has is the ROW cap, and that
    /// one states its own omission (`soilTilesOmitted`) rather than leaving a reader to guess which strip the budget left.
    /// A walk per region, memoised by tile, keeps the cost proportional to the ground actually measured instead of to the
    /// map: regions are visited once each, tiles outside every published row are visited at most once.
    /// </para>
    /// </summary>
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
}
