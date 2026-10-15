using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The warp-totem routes this fixture can arm, in preference order, from the measured
    /// CONTENT facts. The native talk branch builds its dialogue keys from
    /// <c>Game1.currentLocation.name.Value</c>, so the destination must be a location whose
    /// own villager carries a LOCATION-keyed line. Decoding all 52 shipped villager dialogue
    /// tables shows exactly five such locations — Saloon (25 keys), Beach
    /// (<c>Leah:Beach</c>), Town (<c>Lewis:Town_57_40</c>), Mountain
    /// (<c>Sebastian:Mountain_47_23</c>) and IslandSouth (<c>Gus:IslandSouth_14_21</c>) — and
    /// NONE of them is reachable by walking from where a joining Farmhand lands: the Farm's
    /// exits to BusStop and Forest are published on the map's impassable outer ring
    /// (measured: <c>no_native_path</c> for x=79..80 and y=64..65), and the navigation graph
    /// cannot route either because the intermediate locations are not loaded in the client.
    ///
    /// A warp totem is the one lever that crosses maps in a single action: the product routes
    /// exactly the ids <c>Object.totemWarpForReal</c> switches on, read here from the
    /// product's own mapping (<c>farmhandexecutioncontroller.itemtileactions.cs:175-213</c>):
    /// <c>(O)688</c> Farm, <c>(O)689</c> Mountain, <c>(O)690</c> Beach, <c>(O)261</c> Desert,
    /// <c>(O)886</c> IslandSouth. Farm and Desert are excluded because neither has a
    /// location-keyed villager line; Beach is preferred because its measured key
    /// (<c>Leah:Beach</c>) is a plain location key, while the Mountain one is tile-qualified —
    /// the fixture asserts whichever it picks through the game's own <c>TryGetDialogue</c>, so
    /// a route that does not actually resolve is refused by name rather than talked past.
    /// </summary>
    private static readonly IReadOnlyList<(string TotemId, string Destination, string Villager)> SharedWorldTalkToNpcWarpRoutes = new[]
    {
        ("(O)690", "Beach", "Leah"),
        ("(O)689", "Mountain", "Sebastian"),
        ("(O)886", "IslandSouth", "Gus"),
    };

    private bool sharedWorldTalkToNpcJoinVerified;

    /// <summary>
    /// The route the Given armed, so the post-join verification re-reads the SAME facts the
    /// install established rather than re-deriving them from a constant.
    /// </summary>
    private string sharedWorldTalkToNpcRouteDestination = string.Empty;
    private string sharedWorldTalkToNpcRouteVillager = string.Empty;
    private string sharedWorldTalkToNpcRouteTotemId = string.Empty;

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

    /// <summary>
    /// The first route in <see cref="SharedWorldTalkToNpcWarpRoutes"/> that the product and the
    /// content both accept, with the reason each rejected candidate gave when none does.
    /// <c>evidence</c> is a <c>;</c>-separated report of the candidates that were tried, so a
    /// failure names what was missing rather than only that nothing matched.
    /// </summary>
    private static bool TryResolveSharedWorldTalkToNpcWarpRoute(
        out string totemId,
        out string destination,
        out string villager,
        out int destinationX,
        out int destinationY,
        out string evidence)
    {
        totemId = string.Empty;
        destination = string.Empty;
        villager = string.Empty;
        destinationX = 0;
        destinationY = 0;
        List<string> rejected = new();
        foreach ((string candidateTotem, string candidateDestination, string candidateVillager) in SharedWorldTalkToNpcWarpRoutes)
        {
            // The product's own mapping is the authority for what the item does, so the
            // fixture and the action cannot disagree about the destination - or about where it
            // lands, which is what the villager is placed beside.
            if (!ExecutionManager.TryGetWarpTotemDestination(candidateTotem, out string mapped, out int mappedX, out int mappedY)
                || !string.Equals(mapped, candidateDestination, StringComparison.Ordinal))
            {
                rejected.Add($"{candidateTotem}=not_a_warp_route_to_{candidateDestination}");
                continue;
            }
            if (Game1.getLocationFromName(candidateDestination) is not GameLocation place)
            {
                rejected.Add($"{candidateDestination}=destination_not_loaded");
                continue;
            }
            NPC? person = Utility.getAllCharacters().FirstOrDefault(candidate => candidate.IsVillager
                && string.Equals(candidate.Name, candidateVillager, StringComparison.Ordinal));
            if (person is null || person.IsInvisible || person.isSleeping.Value)
            {
                rejected.Add($"{candidateVillager}=villager_unavailable");
                continue;
            }
            // THE CONTENT FACT the whole route rests on: the native branch's location-keyed
            // lookup (NPC.cs:2748, keyed by NPC.cs:3948) must find a line for THIS location.
            if (person.TryGetDialogue(place.Name) is null)
            {
                rejected.Add($"{candidateVillager}:{place.Name}=no_location_dialogue");
                continue;
            }
            totemId = candidateTotem;
            destination = candidateDestination;
            villager = candidateVillager;
            destinationX = mappedX;
            destinationY = mappedY;
            evidence = $"matched={candidateTotem}->{candidateDestination}";
            return true;
        }
        // The runner's own reason-code convention is one `;`-separated key=value list, so the
        // reports are joined with `|` rather than `;`.
        evidence = rejected.Count == 0 ? "routes=none" : $"tried={string.Join("|", rejected)}";
        return false;
    }

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> HOST-side Given of the formal LAN
    /// topology: one named ordinary villager stands at the location a WARP TOTEM reaches, on a
    /// tile whose Chebyshev-1 neighbour is a tile the actor can stand on, and that villager has a
    /// dialogue for the DESTINATION's own key — which is the only key the native talk branch can
    /// reach (it builds its keys from <c>Game1.currentLocation.name.Value</c>).
    ///
    /// WHY A WARP ITEM AND NOT A WALK: measured live, the attached Farmhand cannot be walked off
    /// this Farm. Its exits to BusStop and Forest are published on the map's impassable outer ring
    /// (<c>no_native_path</c> for every tile at x=79..80 and y=64..65), and the navigation graph
    /// cannot route either — the intermediate locations are not loaded in the client's process, so
    /// a far destination answers <c>destination_unreachable</c>. A warp totem crosses maps in one
    /// action and touches neither, so the Host arms one and the client activates it.
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
    /// the cabin interior — a location whose villager dialogue tables carry no plain
    /// location key at all. That write is gone rather than kept as a
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
        // THE ROUTE. A warp totem is the only lever that crosses maps in one action, and the
        // destination has to be a location whose own villager carries a location-keyed line.
        // Both halves are asked of the product: the table above is validated through
        // ExecutionManager.TryGetWarpTotemDestination (the same mapping the action executes
        // with) and through the villager's own TryGetDialogue.
        if (!TryResolveSharedWorldTalkToNpcWarpRoute(out string totemId, out string destination, out string villagerName, out int destinationX, out int destinationY, out string routeEvidence))
            throw new InvalidOperationException($"fixture_shared_world_talk_to_npc_warp_route_missing:{routeEvidence}");
        this.sharedWorldTalkToNpcRouteDestination = destination;
        this.sharedWorldTalkToNpcRouteVillager = villagerName;
        this.sharedWorldTalkToNpcRouteTotemId = totemId;

        if (!Game1.isLocationAccessible(destination))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_not_accessible:location={destination};time_of_day={Game1.timeOfDay}");
        if (Game1.getLocationFromName(destination) is not GameLocation destinationPlace)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_missing:{destination}");
        NPC? villager = Utility.getAllCharacters().FirstOrDefault(candidate => candidate.IsVillager
            && string.Equals(candidate.Name, villagerName, StringComparison.Ordinal));
        if (villager is null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_missing:{villagerName};location={destination}");
        // checkAction refuses an invisible or sleeping villager before any dialogue
        // logic (:2466-2478), so a run against one could never reach the branch.
        if (villager.IsInvisible || villager.isSleeping.Value)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_unavailable:invisible={villager.IsInvisible.ToString().ToLowerInvariant()};sleeping={villager.isSleeping.Value.ToString().ToLowerInvariant()}");


        // THE PLACEMENT IS BESIDE THE TOTEM'S OWN LANDING TILE, and that is the whole point of
        // the route: measured live, the actor arrives on the Beach pier and the native pathfinder
        // refuses `move_to_tile` for the long walk across it (`no_native_path`, the same class the
        // Farm's ring showed), so a villager anywhere else on the map is unreachable. The landing
        // is the tile the product's OWN mapping names, and the villager goes Chebyshev-1 from it -
        // the pair is what the native talk branch needs (`checkAction` faces a villager within 1),
        // so no cross-map pathing is required at all.
        Point landing = new(destinationX, destinationY);
        Vector2? adjacent = FindNativeLocalItemTileStandingTile(destinationPlace, landing, 1);
        if (adjacent is null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_tile_missing:landing={landing.X},{landing.Y};location={destinationPlace.NameOrUniqueName}");
        Vector2 standingTile = new(landing.X, landing.Y);
        Vector2 villagerTile = adjacent.Value;
        if (ChebyshevTileDistance(standingTile, villagerTile) != 1f)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_tiles_not_adjacent:landing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y}");
        if (!IsFixtureWalkableFarmTile(destinationPlace, villagerTile))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_villager_tile_not_walkable:landing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y};location={destinationPlace.NameOrUniqueName}");

        // No actor mutation: the AI client activates the totem itself, and that is what
        // moves it. The pair named below is the contract between the two processes, not
        // something this one can establish.

        // The villager is placed AFTER the walkability test (a standing villager
        // counts as a collision), exactly as the local fixture does.
        villager.Position = new Vector2(villagerTile.X * 64f, villagerTile.Y * 64f);
        if (!destinationPlace.characters.Contains(villager))
            destinationPlace.characters.Add(villager);
        // Pin the placed tile for the run: a scheduled villager would otherwise
        // walk away within the first in-game minutes. This is also what keeps the placement
        // consistent with the hour set above rather than at the mercy of it: a pinned villager
        // ignores the schedule, so the clock cannot move him off the armed tile.
        villager.followSchedule = false;
        villager.ignoreScheduleToday = true;
        if (!destinationPlace.characters.Contains(villager)
            || villager.Tile != villagerTile
            || villager.followSchedule
            || !villager.ignoreScheduleToday)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_placement_not_durable:listed={destinationPlace.characters.Contains(villager).ToString().ToLowerInvariant()};tile={(int)villager.Tile.X},{(int)villager.Tile.Y};expected={(int)villagerTile.X},{(int)villagerTile.Y};follows_schedule={villager.followSchedule.ToString().ToLowerInvariant()}");

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
        NPC? other = destinationPlace.characters.FirstOrDefault(candidate => !ReferenceEquals(candidate, villager)
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
        if (villager.TryGetDialogue(destinationPlace.Name) is null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_location_dialogue_missing:villager={villager.Name};dialogue_key={destinationPlace.Name}");

        // THE ITEM. The Host owns the bound farmhand's inventory, and the route above is
        // worthless unless the totem is actually there with the context gate true. The
        // native branch's own gate (Object.cs:3470) is a set of REAL world facts: the
        // transients (a fade, a freeze) cannot be produced away here and the branch refuses
        // while they last, so this re-checks them and names whichever is false; the caller's
        // tick loop is what waits a fade out (the same shape
        // ModEntry.Fixtures.ItemTile.cs:73-85 uses).
        if (Game1.eventUp || Game1.isFestival() || farmhand.swimming.Value || farmhand.bathingClothes.Value
            || farmhand.onBridge.Value)
            throw new InvalidOperationException(
                "fixture_shared_world_talk_to_npc_warp_context_missing:"
                    + $"event_up={Game1.eventUp};festival={Game1.isFestival()};swimming={farmhand.swimming.Value};"
                    + $"bathing_clothes={farmhand.bathingClothes.Value};on_bridge={farmhand.onBridge.Value}");
        if (farmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(totemId, 1)) is not null)
            throw new InvalidOperationException("fixture_shared_world_talk_to_npc_totem_inventory_full");
        int totemSlot = farmhand.Items.IndexOf(farmhand.Items.OfType<StardewValley.Object>()
            .FirstOrDefault(item => item.QualifiedItemId == totemId));
        if (totemSlot < 0)
            throw new InvalidOperationException($"fixture_shared_world_talk_to_npc_totem_not_owned:item={totemId}");

        // The talk branch's own precondition (NPC.cs:2760 takes the gift path instead when an
        // object is held), established AFTER the totem is placed so a totem that landed in the
        // held slot cannot leave the actor holding something.
        if (farmhand.CurrentToolIndex == totemSlot)
        {
            int freeSlot = -1;
            for (int index = 0; index < farmhand.Items.Count; index++)
            {
                if (index != totemSlot && farmhand.Items[index] is null)
                {
                    freeSlot = index;
                    break;
                }
            }
            if (freeSlot < 0)
                throw new InvalidOperationException("fixture_shared_world_talk_to_npc_no_free_held_slot");
            farmhand.CurrentToolIndex = freeSlot;
        }
        if (farmhand.CurrentToolIndex >= 0 && farmhand.CurrentToolIndex < farmhand.Items.Count)
            farmhand.Items[farmhand.CurrentToolIndex] = null;
        if (farmhand.CurrentItem is not null || farmhand.ActiveObject is not null)
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_hands_not_empty:item={farmhand.ActiveObject?.QualifiedItemId ?? farmhand.CurrentItem?.QualifiedItemId ?? "unknown"}");

        // The runner never picks an inventory slot: it reads the slot the Mod itself
        // publishes for a routable totem, so the projection and the Given must agree here or
        // the runner would name a slot that holds something else.
        BridgeWarpItemTarget? published = ExecutionManager.DiscoverWarpItemTargets(farmhand)
            .FirstOrDefault(candidate => candidate.QualifiedItemId == totemId);
        if (published is null
            || published.Slot != totemSlot
            || !string.Equals(published.Destination, destination, StringComparison.Ordinal))
            throw new InvalidOperationException(
                $"fixture_shared_world_talk_to_npc_totem_not_published:item={totemId};slot={totemSlot};destination={destination};"
                    + $"published_slot={published?.Slot.ToString(CultureInfo.InvariantCulture) ?? "none"};published_destination={published?.Destination ?? "none"}");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy HostAutomation initialized native shared-world talk-to-npc Given before attachment: "
                + $"actor={farmhand.UniqueMultiplayerID};villager_location={destinationPlace.NameOrUniqueName};"
                + $"standing_tile={(int)standingTile.X},{(int)standingTile.Y};villager={villager.Name};"
                + $"villager_tile={(int)villagerTile.X},{(int)villagerTile.Y};hands_empty=true;friendship_points=0;"
                + $"talked_to_today=false;dialogue_key={destinationPlace.Name};villager_schedule_pinned=true;"
                + $"time_of_day={Game1.timeOfDay};destination_accessible=true;"
                + $"warp_item={totemId};warp_item_slot={totemSlot};warp_destination={destination};warp_item_round_trip=published;"
                + "the clock is set so the destination's own hour gate is open and the AI client inherits it through the join;"
                + "the AI client activates the totem itself and observes the arrival it produced;"
                + "the AI client warps its own Farmhand onto the standing tile and observes it there;"
                + "the Host verifies only this process's villager placement;"
                + "production alone calls NPC.checkAction and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// <c>native_farmhand_talk_to_npc_v1</c> post-join Given verification for the one
    /// fact this process owns: on the first tick the bound Farmhand is online, re-read
    /// the Host's own world copy and prove the villager is still placed at the destination
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

        GameLocation? destinationPlace = Game1.getLocationFromName(this.sharedWorldTalkToNpcRouteDestination);
        string villagerName = this.sharedWorldTalkToNpcRouteVillager;
        NPC? villager = destinationPlace is null
            ? null
            : destinationPlace.characters
                .OfType<NPC>()
                .FirstOrDefault(candidate => candidate.IsVillager
                    && string.Equals(candidate.Name, villagerName, StringComparison.Ordinal));
        bool placementHeld = villager is not null && !villager.followSchedule && villager.ignoreScheduleToday;
        if (placementHeld)
        {
            this.Monitor.Log(
                "GameBuddy shared-world talk-to-npc villager Given survived the join: "
                    + $"actor_online={farmhandId};villager={villager!.Name};"
                    + $"villager_location={destinationPlace!.NameOrUniqueName};villager_tile={(int)villager.Tile.X},{(int)villager.Tile.Y};"
                    + "villager_schedule_pinned=true;the bound actor's own location is the AI client's Given and is read there;"
                    + "production alone performs the talk.",
                LogLevel.Info);
            return;
        }
        this.Monitor.Log(
            "GameBuddy shared-world talk-to-npc villager Given NOT established after join: "
                + "reason=fixture_shared_world_talk_to_npc_villager_placement_lost;"
                + $"actor_online={farmhandId};"
                + $"fixture_location={destinationPlace?.NameOrUniqueName ?? "none"};"
                + $"villager_present={((villager is null) ? "false" : "true")};"
                + $"villager_schedule_pinned={((villager is null) ? "false" : (!villager.followSchedule && villager.ignoreScheduleToday).ToString().ToLowerInvariant())};"
                + "a talk here cannot select the native branch without this villager, so a refusal downstream is this Given's failure and not a product defect.",
            LogLevel.Error);
    }
}
