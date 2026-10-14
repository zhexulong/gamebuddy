using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The one location this shared-world fixture uses. The choice is
    /// CONTENT-constrained, not stylistic: the native talk branch's own dialogue
    /// lookup builds its keys from <c>Game1.currentLocation.name.Value</c>
    /// (NPC.cs:3938-3948), so a talk anywhere else cannot select the branch.
    /// Decoding all 52 shipped villager dialogue tables with the game's own
    /// content reader shows the Saloon is the only location with plain
    /// location keys for more than one villager (<c>Saloon</c> for Gus, Lewis,
    /// Marnie and Pam), and that NO table carries a key reachable from the Farm,
    /// the Cabin, the FarmHouse, the Cellar or the Greenhouse — which is exactly
    /// why the attached Farmhand cannot talk where it lands.
    /// </summary>
    private const string SharedWorldTalkToNpcFixtureLocation = "Saloon";

    /// <summary>
    /// The one villager this fixture places: the Saloon's own keeper, whose
    /// dialogue asset carries the plain <c>Saloon</c> key. Same person, same key
    /// and same acceptance call as <c>native_talk_to_npc_v1</c> on the local lane.
    /// </summary>
    private const string SharedWorldTalkToNpcFixtureVillager = "Gus";

    /// <summary>Once-only latch for the post-join Given verification.</summary>
    private bool sharedWorldTalkToNpcJoinVerified;

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> pre-attachment Given, on the HOST side
    /// of the formal LAN topology: the BOUND FARMHAND stands one Chebyshev step from
    /// a named ordinary villager that has a dialogue for the actor's OWN location
    /// and a friendship record.
    ///
    /// WHY THE ACTOR IS MOVED AT ALL
    /// -----------------------------
    /// The attached Farmhand lands on the Farm (<c>ResolveHostAutomationFarmArrival</c>,
    /// which the passing shared-world <c>native_pet_animal_v1</c> fixture also treats
    /// as "the arrival the attached Farmhand lands on"), and no shipped villager
    /// dialogue table has a Farm-reachable key. The native-local lane solves the same
    /// problem by warping its actor to the Saloon; a shared-world actor cannot be
    /// warped the same way — every <c>warpFarmer</c> in this partial class targets
    /// <c>Game1.player</c> (the local Host player), and this fixture arms BEFORE the
    /// LAN server exists, so there is no connected Farmhand to warp at that point.
    ///
    /// So the actor is placed through the SAME pre-attachment mutation of the OFFLINE
    /// bound Farmhand that the other HostAutomation fixtures already perform on that
    /// exact object (<c>addItemToInventory</c>, <c>Items[slot] = null</c>,
    /// <c>increaseBackpackSize</c>): its saved location and tile are written, and
    /// <c>lastSleepLocation</c> is set to the new location so the join path's own
    /// <c>NetWorldState.ResetFarmhandState</c> guard (NetWorldState.cs:756-767, which
    /// resets a Farmhand to its Cabin bed only when <c>lastSleepLocation</c> is null
    /// or its home) does not undo it. That premise is UNVERIFIED offline, so
    /// <see cref="VerifySharedWorldTalkToNpcJoin"/> re-reads the joined actor on the
    /// first tick it is online and fails BY NAME if the premise did not hold.
    ///
    /// This fixture emits no receipt and invokes no action: production alone calls
    /// <c>NPC.checkAction</c> and emits <c>talk_to_npc_talked</c>.
    /// </summary>
    private void InstallSharedWorldTalkToNpcFixture(Farm farm)
    {
        Farmer farmhand = this.ResolveHostAutomationFarmhand(farm);
        if (Game1.getLocationFromName(SharedWorldTalkToNpcFixtureLocation) is not GameLocation saloon)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_missing:{SharedWorldTalkToNpcFixtureLocation}");
        NPC? villager = Utility.getAllCharacters().FirstOrDefault(candidate => candidate.IsVillager
            && string.Equals(candidate.Name, SharedWorldTalkToNpcFixtureVillager, StringComparison.Ordinal));
        if (villager is null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_missing:{SharedWorldTalkToNpcFixtureVillager}");
        // checkAction refuses an invisible or sleeping villager before any dialogue
        // logic (:2466-2478), so a run against one could never reach the branch.
        if (villager.IsInvisible || villager.isSleeping.Value)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_unavailable:invisible={villager.IsInvisible.ToString().ToLowerInvariant()};sleeping={villager.isSleeping.Value.ToString().ToLowerInvariant()}");

        // The talk branch's own precondition (NPC.cs:2760 takes the gift path
        // instead when an object is held), established on the offline actor the
        // same way native_pet_animal_v1 clears its selected slot.
        if (farmhand.CurrentToolIndex >= 0 && farmhand.CurrentToolIndex < farmhand.Items.Count)
            farmhand.Items[farmhand.CurrentToolIndex] = null;
        if (farmhand.CurrentItem is not null || farmhand.ActiveObject is not null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_hands_not_empty:item={farmhand.ActiveObject?.QualifiedItemId ?? farmhand.CurrentItem?.QualifiedItemId ?? "unknown"}");

        // The same declared pair the local lane uses: the scan applies the product's
        // own walkability predicate to both tiles, so the returned pair is walkable
        // by construction, and the chosen pair is asserted before any mutation.
        if (!TryFindNativeLocalTalkToNpcTiles(saloon, farmhand, out Vector2 standingTile, out Vector2 villagerTile))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_tiles_missing:location={saloon.NameOrUniqueName};villager={villager.Name}");
        if (ChebyshevTileDistance(standingTile, villagerTile) != 1f)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_tiles_not_adjacent:standing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y}");

        // The Route-A lever: the offline actor's saved location, tile and
        // last-sleep marker, asserted on this process's own copy immediately.
        farmhand.currentLocation = saloon;
        farmhand.Position = new Vector2(standingTile.X * 64f, standingTile.Y * 64f);
        farmhand.lastSleepLocation.Value = saloon.NameOrUniqueName;
        if (!ReferenceEquals(farmhand.currentLocation, saloon) || farmhand.Tile != standingTile)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_actor_placement_failed:location={farmhand.currentLocation?.NameOrUniqueName ?? "none"};tile={(int)farmhand.Tile.X},{(int)farmhand.Tile.Y};expected={(int)standingTile.X},{(int)standingTile.Y}");

        // The villager is placed AFTER the walkability test (a standing villager
        // counts as a collision), exactly as the local fixture does.
        villager.Position = new Vector2(villagerTile.X * 64f, villagerTile.Y * 64f);
        if (!saloon.characters.Contains(villager))
            saloon.characters.Add(villager);
        // Pin the placed tile for the run: a scheduled villager would otherwise
        // walk away within the first in-game minutes.
        villager.followSchedule = false;
        villager.ignoreScheduleToday = true;
        if (!saloon.characters.Contains(villager)
            || villager.Tile != villagerTile
            || villager.followSchedule
            || !villager.ignoreScheduleToday)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_placement_not_durable:listed={saloon.characters.Contains(villager).ToString().ToLowerInvariant()};tile={(int)villager.Tile.X},{(int)villager.Tile.Y};expected={(int)villagerTile.X},{(int)villagerTile.Y};follows_schedule={villager.followSchedule.ToString().ToLowerInvariant()}");

        // The native talk branch's own entry precondition (:2748 `value != null`)
        // and the discovery projection's own predicate
        // (farmhandexecutioncontroller.cs:2213 `friendshipData.ContainsKey`).
        if (!farmhand.friendshipData.TryGetValue(villager.Name, out Friendship? friendship))
            farmhand.friendshipData[villager.Name] = friendship = new Friendship();
        friendship.Clear();
        if (friendship.Points != 0
            || friendship.TalkedToToday
            || friendship.GiftsToday != 0
            || friendship.GiftsThisWeek != 0
            || !farmhand.friendshipData.ContainsKey(villager.Name))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_friendship_invalid:points={friendship.Points};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}");

        // The runner never picks the villager: it takes the first PUBLISHED target
        // inside Chebyshev-1 of the actor (the same discovery predicate the Mod
        // publishes with), so another recorded villager in reach would silently
        // replace the person this fixture armed.
        NPC? other = saloon.characters.FirstOrDefault(candidate => !ReferenceEquals(candidate, villager)
            && candidate.IsVillager
            && !string.IsNullOrWhiteSpace(candidate.Name)
            && farmhand.friendshipData.ContainsKey(candidate.Name)
            && ChebyshevTileDistance(candidate.Tile, standingTile) <= 1f);
        if (other is not null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_other_target_in_reach:{other.Name};tile={(int)other.Tile.X},{(int)other.Tile.Y}");

        // The branch-selection fact itself, asked through the game's own dialogue
        // table with the key the native lookup builds from the actor's location
        // (NPC.cs:3948). If the content ever loses it, this fails here instead of
        // surfacing as a native `talk_to_npc_not_handled` that looks like a bug.
        if (villager.TryGetDialogue(saloon.Name) is null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_dialogue_missing:villager={villager.Name};dialogue_key={saloon.Name}");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy HostAutomation initialized native shared-world talk-to-npc Given before attachment: "
                + $"actor={farmhand.UniqueMultiplayerID};actor_saved_location={saloon.NameOrUniqueName};"
                + $"standing_tile={(int)standingTile.X},{(int)standingTile.Y};villager={villager.Name};"
                + $"villager_tile={(int)villagerTile.X},{(int)villagerTile.Y};hands_empty=true;friendship_points=0;"
                + $"talked_to_today=false;dialogue_key={saloon.Name};villager_schedule_pinned=true;"
                + "the Host self-verifies the joined actor's location and fails by name otherwise;"
                + "production alone calls NPC.checkAction and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> post-join Given verification: on the
    /// first tick the bound Farmhand is online, re-read the actor the Host actually
    /// has and prove the pre-attachment placement survived the join. The premise
    /// (writing the offline actor's saved location instead of warping a connected
    /// one) is unverified outside a live run, so it is checked here and reported by
    /// name rather than left to surface as a native refusal in a later run.
    ///
    /// The check is the fixture's own declared Given, not a success claim: the
    /// product's location-scoped target identity and the dialogue itself are what
    /// the runner and the receipt prove afterwards.
    /// </summary>
    private void VerifySharedWorldTalkToNpcJoin()
    {
        if (this.sharedWorldTalkToNpcJoinVerified
            || this.config.HostAutomation is not { Enable: true } automation
            || !string.Equals(automation.FixtureScenario, "native_farmhand_talk_to_npc_v1", StringComparison.Ordinal)
            || !Context.IsWorldReady
            || !Game1.IsMasterGame
            || !long.TryParse(this.config.PlayerId, out long farmhandId))
            return;
        Farmer? joined = Game1.GetPlayer(farmhandId, onlyOnline: true);
        if (joined?.currentLocation is null)
            return;
        this.sharedWorldTalkToNpcJoinVerified = true;

        GameLocation? saloon = Game1.getLocationFromName(SharedWorldTalkToNpcFixtureLocation);
        bool atFixtureLocation = saloon is not null && ReferenceEquals(joined.currentLocation, saloon);
        NPC? villager = joined.currentLocation.characters
            .OfType<NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && string.Equals(candidate.Name, SharedWorldTalkToNpcFixtureVillager, StringComparison.Ordinal));
        bool villagerInReach = atFixtureLocation
            && villager is not null
            && ChebyshevTileDistance(joined.Tile, villager.Tile) <= 1f;
        if (atFixtureLocation && villagerInReach)
        {
            this.Monitor.Log(
                "GameBuddy shared-world talk-to-npc Given survived the join: "
                    + $"actor={farmhandId};actor_location={joined.currentLocation.NameOrUniqueName};"
                    + $"actor_tile={(int)joined.Tile.X},{(int)joined.Tile.Y};villager={villager!.Name};"
                    + $"villager_tile={(int)villager.Tile.X},{(int)villager.Tile.Y};production alone performs the talk.",
                LogLevel.Info);
            return;
        }
        this.Monitor.Log(
            "GameBuddy shared-world talk-to-npc Given NOT established after join: "
                + "reason=fixture_shared_world_talk_to_npc_join_location_lost;"
                + $"actor={farmhandId};actor_location={joined.currentLocation.NameOrUniqueName};"
                + $"actor_tile={(int)joined.Tile.X},{(int)joined.Tile.Y};"
                + $"fixture_location={saloon?.NameOrUniqueName ?? "none"};"
                + $"villager_present={((villager is null) ? "false" : "true")};villager_in_reach={villagerInReach.ToString().ToLowerInvariant()};"
                + "the run cannot select the native talk branch from here, so a refusal downstream is this Given's failure and not a product defect.",
            LogLevel.Error);
    }
}
