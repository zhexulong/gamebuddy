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

    /// <summary>
    /// The hour the shared-world Given is armed at: 13:00.
    ///
    /// WHY THE CLOCK IS PART OF THE GIVEN
    /// ----------------------------------
    /// The Saloon is not open around the clock. Its entrance is a <c>LockedDoorWarp</c>
    /// whose own gate is the one <c>EnterExitDoorGateTests</c> pins on the game assembly
    /// (<c>Game1.timeOfDay &gt;= openTime &amp;&amp; Game1.timeOfDay &lt; closeTime</c>), and the
    /// navigation graph keeps an edge only toward a location the game itself currently
    /// calls accessible: <c>game1navigationworldsource.cs:135</c> filters every warp leg by
    /// <c>IsLocationAccessible</c>, which is <c>Game1.isLocationAccessible</c> wrapped
    /// fail-closed (<c>:266-276</c>) — the same authority the outcome decider reads at
    /// <c>navigationoutcomedecider.cs:137</c>. So a destination the game reports as not
    /// accessible has NO incoming edge at all, and the route search answers
    /// <c>Terminal("destination_unreachable")</c> (<c>navigationrouteplanner.cs:207</c>),
    /// which surfaces as <c>blocked / destination_unreachable</c>
    /// (<c>acceptednavigationexecution.cs:158-160</c>).
    ///
    /// That is exactly what the first live shared-world attempt measured: the actor walked
    /// itself out of its Cabin to the Farm, and from there the product determined the Saloon
    /// unreachable — a save template loads at 06:00, hours before the Saloon opens, so the
    /// Given was armed at a time the declared destination is shut. 13:00 is inside the
    /// Saloon's trading window, so the same clock satisfies both halves of this fixture: the
    /// destination's door is open, and the hour is one at which its keeper is on duty (the
    /// placement is pinned anyway — see the villager block below).
    ///
    /// This is the same lever, for the same reason, as the shop-purchase fixture
    /// (<c>ModEntry.Fixtures.ShopPurchase.cs:41-46</c>): the fixture moves the clock rather
    /// than guessing what the content's hour gate says, and asserts the effect through the
    /// game's own value instead of trusting the write.
    /// </summary>
    private const int SharedWorldTalkToNpcFixtureTimeOfDay = 1300;

    /// <summary>Once-only latch for the post-join Given verification.</summary>
    private bool sharedWorldTalkToNpcJoinVerified;

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> HOST-side Given of the formal LAN
    /// topology: one named ordinary villager stands in the Saloon on a tile whose
    /// Chebyshev-1 neighbour is a tile the actor can stand on, and that villager has a
    /// dialogue for the SALOON key, which is the only key the native talk branch can
    /// reach (it builds its keys from <c>Game1.currentLocation.name.Value</c>).
    ///
    /// WHAT THE HOST OWNS, AND WHAT IT DOES NOT
    /// ---------------------------------------
    /// The Host owns the VILLAGER's placement, and nothing about the actor's location.
    /// The bound actor's location is the AI client's own Given: in that process the
    /// Farmhand IS the local player, so its own <c>warpFarmer</c> is what moves it — the
    /// same call the native-local lane uses — and a host can neither move nor observe a
    /// remote farmer's location.
    ///
    /// Writing the OFFLINE actor's saved location from here was tried and did NOT move
    /// the joined Farmhand: the join's own <c>NetWorldState.ResetFarmhandState</c>
    /// returns it to its Cabin bed, and the live run's first client snapshot reported
    /// the cabin interior while the Saloon is the only location whose villager dialogue
    /// tables carry a plain location key. That write is gone rather than kept as a
    /// second writer of a fact this process cannot establish.
    ///
    /// <see cref="VerifySharedWorldTalkToNpcJoin"/> therefore re-reads only the
    /// villager, on the first tick the bound Farmhand is online, and fails BY NAME if
    /// the placement did not survive the join.
    ///
    /// This fixture emits no receipt and invokes no action: production alone calls
    /// <c>NPC.checkAction</c> and emits <c>talk_to_npc_talked</c>.
    /// </summary>
    private void InstallSharedWorldTalkToNpcFixture(Farm farm)
    {
        Farmer farmhand = this.ResolveHostAutomationFarmhand(farm);

        // Trading hours, first, so every check below is evaluated at the hour the Given
        // claims: the clock is the Host's (this process is the LAN master), and a joining
        // client inherits it through the join, which is the process whose navigation reads it.
        // The write is not trusted on its own — the game's own <c>Game1.timeOfDay</c> is read
        // back, and so is the game's own accessibility verdict for the destination, which is
        // the very predicate the navigation graph filters its edges with.
        Game1.timeOfDay = SharedWorldTalkToNpcFixtureTimeOfDay;
        if (Game1.timeOfDay != SharedWorldTalkToNpcFixtureTimeOfDay)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_clock_not_set:time_of_day={Game1.timeOfDay};expected={SharedWorldTalkToNpcFixtureTimeOfDay}");
        if (!Game1.isLocationAccessible(SharedWorldTalkToNpcFixtureLocation))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_not_accessible:location={SharedWorldTalkToNpcFixtureLocation};time_of_day={Game1.timeOfDay}");

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
        // own walkability predicate to both tiles, so the returned pair is walkable by
        // construction, and the chosen pair is asserted before the villager is placed.
        // `standingTile` is the tile the AI client's own warp must land on.
        if (!TryFindNativeLocalTalkToNpcTiles(saloon, farmhand, out Vector2 standingTile, out Vector2 villagerTile))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_tiles_missing:location={saloon.NameOrUniqueName};villager={villager.Name}");
        if (ChebyshevTileDistance(standingTile, villagerTile) != 1f)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_tiles_not_adjacent:standing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y}");

        // No actor mutation: the AI client warps its own Farmhand onto `standingTile`
        // and the runner reads back where it landed. The pair named below is the
        // contract between the two processes, not something this one can establish.

        // The villager is placed AFTER the walkability test (a standing villager
        // counts as a collision), exactly as the local fixture does.
        villager.Position = new Vector2(villagerTile.X * 64f, villagerTile.Y * 64f);
        if (!saloon.characters.Contains(villager))
            saloon.characters.Add(villager);
        // Pin the placed tile for the run: a scheduled villager would otherwise
        // walk away within the first in-game minutes. This is also what keeps the placement
        // consistent with the hour set above rather than at the mercy of it: a pinned villager
        // ignores the schedule, so 13:00 cannot move him off the armed tile.
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
        // publishes with), so another recorded villager in reach of the standing tile
        // the client's actor lands on would silently replace the person this fixture
        // armed.
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
                + $"actor={farmhand.UniqueMultiplayerID};villager_location={saloon.NameOrUniqueName};"
                + $"standing_tile={(int)standingTile.X},{(int)standingTile.Y};villager={villager.Name};"
                + $"villager_tile={(int)villagerTile.X},{(int)villagerTile.Y};hands_empty=true;friendship_points=0;"
                + $"talked_to_today=false;dialogue_key={saloon.Name};villager_schedule_pinned=true;"
                + $"time_of_day={Game1.timeOfDay};destination_accessible=true;"
                + "the clock is set so the destination's own hour gate is open and the AI client inherits it through the join;"
                + "the AI client warps its own Farmhand onto the standing tile and observes it there;"
                + "the Host verifies only this process's villager placement;"
                + "production alone calls NPC.checkAction and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> post-join Given verification for the one
    /// fact this process owns: on the first tick the bound Farmhand is online, re-read
    /// the Host's own world copy and prove the villager is still placed in the Saloon
    /// with its schedule pinned.
    ///
    /// The bound Farmhand is read ONLY as the signal that the client has arrived; its
    /// location is deliberately not read or judged here. A host cannot observe a remote
    /// farmer's location, and in this topology that location is established and read on
    /// the client (see the class notes above), so a host-side claim about it could only
    /// be wrong in one direction: reporting a Given failure the Host has no standing to
    /// see.
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
        if (Game1.GetPlayer(farmhandId, onlyOnline: true) is null)
            return;
        this.sharedWorldTalkToNpcJoinVerified = true;

        GameLocation? saloon = Game1.getLocationFromName(SharedWorldTalkToNpcFixtureLocation);
        NPC? villager = saloon is null
            ? null
            : saloon.characters
                .OfType<NPC>()
                .FirstOrDefault(candidate => candidate.IsVillager
                    && string.Equals(candidate.Name, SharedWorldTalkToNpcFixtureVillager, StringComparison.Ordinal));
        bool placementHeld = villager is not null && !villager.followSchedule && villager.ignoreScheduleToday;
        if (placementHeld)
        {
            this.Monitor.Log(
                "GameBuddy shared-world talk-to-npc villager Given survived the join: "
                    + $"actor_online={farmhandId};villager={villager!.Name};"
                    + $"villager_location={saloon!.NameOrUniqueName};villager_tile={(int)villager.Tile.X},{(int)villager.Tile.Y};"
                    + "villager_schedule_pinned=true;the bound actor's own location is the AI client's Given and is read there;"
                    + "production alone performs the talk.",
                LogLevel.Info);
            return;
        }
        this.Monitor.Log(
            "GameBuddy shared-world talk-to-npc villager Given NOT established after join: "
                + "reason=fixture_shared_world_talk_to_npc_villager_placement_lost;"
                + $"actor_online={farmhandId};"
                + $"fixture_location={saloon?.NameOrUniqueName ?? "none"};"
                + $"villager_present={((villager is null) ? "false" : "true")};"
                + $"villager_schedule_pinned={((villager is null) ? "false" : (!villager.followSchedule && villager.ignoreScheduleToday).ToString().ToLowerInvariant())};"
                + "a talk in the Saloon cannot select the native branch without this villager, so a refusal downstream is this Given's failure and not a product defect.",
            LogLevel.Error);
    }
}
