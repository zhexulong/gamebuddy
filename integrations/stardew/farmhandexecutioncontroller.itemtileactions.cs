using System;
using System.Collections.Generic;
using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

// The item/tile lane: `use_warp_item`, `pan_ore`, `claim_mail_attachment`.
//
// ---------------------------------------------------------------------------------
// `use_warp_item` -- an OWNED OBJECT that does something when activated.
//
// THE SEAM. `Object.performUseAction(GameLocation location)` (Object.cs:3464), in its
// `name.Contains("Totem")` branch (:3476-3577). The branch is what the boundary names
// and what this action calls: `(O)681` is the Rain Totem (:3490-3492) and
// `(O)TreasureTotem` the Treasure Totem (:3482-3489), so "a totem" is NOT the same
// question as "a warp totem" and the two are separate terminal codes here. The warp
// family is exactly `(O)261`, `(O)688`, `(O)689`, `(O)690`, `(O)886` (:3493-3498), and
// each one's destination is read out of `totemWarpForReal`'s switch (:3168-3204) rather
// than guessed.
//
// The map-Action route is NOT this action's entry point: the only caller of the branch
// is `Game1`'s action-button dispatch (`Game1.cs:11349-11358`), which calls
// `player.ActiveObject.performUseAction(currentLocation)` and, ONLY when that returns
// true, consumes a unit with `player.reduceActiveItemByOne()` (:11353). A caller that
// only called the object and skipped the consumption would not be player-equivalent, and
// a caller that consumed without the native call would be inventing a warp. This action
// therefore does both, in the native order, with the named slot selected around the pair
// so both halves act on the SAME item -- exactly the shape `use_item` established for
// the same `{ slot, expectedQualifiedItemId }` contract
// (farmhandexecutioncontroller.machinesanimalsitemsactions.cs `RequestLocalUseItem`).
//
// ASYNC TERMINAL. The native branch does not warp: it plays the totem animation
// (`FarmerSprite.animateOnce`, :3517-3522), freezes the actor, and hands `totemWarp`
// -> `DelayedAction.fadeAfterDelay(totemWarpForReal, 1000)` the warp. The dispatch
// return value and the stack decrement are therefore NOT the terminal. This action
// records the destination in the shared `activeTravel` slot and lets
// `CompleteTravelAfterWarp` mint the single terminal once the Warped edge arrives --
// the same one-terminal ledger path `travel`, `ride_minecart`, `enter_mine`,
// `select_mine_elevator_floor` and `use_obelisk` use.
//
// POSTCONDITION. Location equality with the destination is the legal postcondition and
// the arrival TILE is not: `Game1.warpFarmer` may land the actor on a passable neighbour
// of the requested tile, and `(O)688`'s tile is chosen inside the game's own delayed
// callback (the Farm's `WarpTotemEntry` map property, else the `whichFarm` fallback at
// :3174-3182) -- the same rule `use_obelisk` already records.
//
// FAILURE MODES, each with its own terminal so one story can never stand in for another:
// the named slot holds nothing (`item_not_owned_in_slot`), it holds a different item
// (`item_slot_changed`), it holds an object that is not a warp totem
// (`item_not_a_warp_totem` -- the rain totem and the treasure totem land here), a warp
// is already pending so two would stack (`warp_item_warp_already_pending`), the mapped
// destination does not exist (`warp_item_destination_unavailable`), the actor is already
// there so the native warp would be a no-op (`warp_item_already_at_destination`), the
// native branch refused in its own terms (`warp_item_not_usable_here`), it returned true
// without arming the routine (`warp_item_not_started`), it threw
// (`warp_item_native_exception`), the arrival was a different location
// (`warp_item_arrival_mismatch`), and success (`warp_item_arrived`).
//
// ---------------------------------------------------------------------------------
// `pan_ore` -- the bounded one-use panning lifecycle.
//
// THE SEAM. `Pan.DoFunction(GameLocation location, int x, int y, int power, Farmer who)`
// (Pan.cs:97-120). Its `x,y` PARAMETERS ARE INERT: the method immediately overwrites them
// from `who.GetToolLocation()` (:100-102), so the tile the pan actually acts on is the
// location's own `orePanPoint` -- `who.addItemsByMenuIfNecessary(getPanItems(...))`
// (:106) and `location.orePanPoint.Value = Point.Zero` (:107). This action therefore
// declares `{ slot, x, y }` where `x,y` is the site the caller names, and RE-RESOLVES it
// against that live state: the game's own predicate for "this tile can be panned" is
// `GameLocation.orePanPoint` (`performOrePanTenMinuteUpdate`, GameLocation.cs:13743-13766,
// is the only creator, and it only ever writes a point that `isOpenWater` accepts with
// land within one). A named tile that is not the live point is a refusal, never a pan of
// a neighbouring site.
//
// The tool half is verified as EQUIPPED before the call, the same shape `use_raft`
// admits against (`raft_not_equipped_in_requested_slot`,
// farmhandexecutioncontroller.transportactions.cs): a pan in the slot that is not the
// held tool cannot be driven by the native tool ingress, so "not owned" and "not
// equipped" are two different refusals rather than one.
//
// POSTCONDITION. The seam is `void` and its generated result list is a local, so the
// decision is the pair of world facts the seam itself writes, re-read after the call:
// the location's pan site is no longer the point that was panned, and the actor's own
// `TimesPanned` stat advanced by exactly one (`getPanItems` increments it, Pan.cs:145).
// The result list's delivery is reported as evidence -- `pan_output_overflow` names the
// `ItemGrabMenu` overflow the native `addItemsByMenuIfNecessary` opens when the pack
// cannot take everything -- and is deliberately not decided on: a higher-tier pan may
// end with a NEW site (Pan.cs:108-118), so "the site is Point.Zero" is not a legal
// postcondition and only "it is not the site that was panned" is.
//
// FAILURE MODES: no pan in the named slot (`pan_not_owned_in_slot`), a pan that is not
// the held tool (`pan_not_equipped_in_requested_slot`), no panning site here at all --
// which is also the state left behind by a pan (`pan_site_not_available`), the named
// tile is not the live site (`pan_site_changed`), it is not water
// (`pan_site_not_water`), the actor is too far from it (`pan_site_out_of_range`), the
// native call threw (`pan_native_exception`), it ran without the two observed facts
// (`pan_postcondition_unavailable`), and success (`ore_panned`).
//
// ---------------------------------------------------------------------------------
// `claim_mail_attachment` -- the TALK/claim verb on a mailbox.
//
// THE SEAM. `GameLocation.mailbox()` (GameLocation.cs:10547-10593), which the map
// Action selector `Mailbox` reaches from `performAction` (:9953-9962). The CLAIM is the
// world write inside it: the first pending letter leaves `Game1.mailbox`
// (`RemoveAt(0)`, :10556) and, unless it is a `passedOut`/`Cooking` entry, lands in the
// actor's `mailReceived` (:10552-10555). That is what this action's postcondition reads,
// re-read from the world -- the seam is `void` and has no return value to trust.
//
// WHAT THE ATTACHMENT NEEDS, AND WHY IT IS STILL THIS SEAM. `mailbox()` also opens the
// letter it claimed (`Game1.activeClickableMenu = new LetterViewerMenu(text2, text)`,
// :10586). A letter's `%item` commands are declared content (they are parsed by the
// letter, not by the mailbox), and the letter hands them to the player inside
// `LetterViewerMenu.cleanupBeforeExit()` -- `Game1.player.addItemsByMenuIfNecessary`
// for every uncollected `itemsToGrab` entry (LetterViewerMenu.cs:1010-1041). So claiming
// the letter and then letting the letter finish the way its own exit path does
// (`IClickableMenu.exitThisMenu` -> `cleanupBeforeExit`, IClickableMenu.cs:866-884) is
// the whole claim: the letter is consumed, the mail id is recorded, the attachment is
// delivered, and the body is not left holding a modal. `Game1.exitActiveMenu()` is NOT
// the step here: it only nulls `activeClickableMenu` (Game1.cs:6128-6131) and would
// discard the attachment, which is exactly the difference this action's evidence names.
//
// DISCOVERY does not hardcode a coordinate. The mailbox is a Buildings-layer Action
// tile; this action walks the location's own map layer and reads the tile's own `Action`
// property with the same reader `enter_exit` uses (`ReadBuildingsLayerAction`), matching
// the selector the native case switches on. The published identity binds the location,
// the tile, the pending count AND the head letter id, so "the mailbox whose next letter
// is X" is the identity a request names and a request that has already been served is
// refused (`mail_target_changed`) instead of silently claiming the NEXT letter. The head
// letter id is hashed INTO the id and is not itself published: the opaque id is what a
// consumer echoes, exactly as `BuildAnimalDoorTargetId` binds the door state.
//
// FAILURE MODES: no mailbox selector on that tile (`mailbox_not_found`), the published
// identity no longer describes the live mailbox (`mail_target_changed`), the actor never
// reached it (`mail_claim_out_of_range`), there is nothing left to claim
// (`mailbox_empty`), the native call threw (`mail_claim_native_exception`), it ran
// without the observed claim (`mail_claim_not_observed`), and success (`mail_claimed`).
internal sealed partial class ExecutionManager
{
    /// <summary>The `(O)688` Warp Totem: Farm destination map, read from
    /// `totemWarpForReal` (Object.cs:3172-3184).</summary>
    internal const string WarpTotemFarmDestination = "Farm";

    /// <summary>
    /// How far the actor may stand from the pan site and still be inside the native pan
    /// accept window. `Pan.beginUsing` (Pan.cs:55-79) accepts when the actor's bounding
    /// box intersects the 4x4-tile rectangle centred on `orePanPoint`, so the legal actor
    /// tiles are the two-tile Chebyshev neighbourhood of the site -- and the site is water,
    /// so the actor always stands beside it rather than on it.
    /// </summary>
    internal const int PanNativeReachTiles = 2;

    /// <summary>
    /// The warp-totem id -> destination mapping, read out of `Object.totemWarpForReal`'s
    /// switch (Object.cs:3168-3204). It is owned here rather than delegated to the native
    /// callback because the destination is part of this action's receipt, its admission
    /// (the destination must resolve, and the actor must not already be there) and its
    /// postcondition -- all of which would otherwise be unverifiable.
    ///
    /// `(O)681` (Rain Totem) and `(O)TreasureTotem` are deliberately absent: both live in
    /// the same `name.Contains("Totem")` branch but neither warps, so they are not this
    /// action's subject and `TryGetWarpTotemDestination` returning false is what separates
    /// them from a warp totem whose destination happens to be unavailable.
    /// </summary>
    internal static bool TryGetWarpTotemDestination(
        string qualifiedItemId,
        out string destination,
        out int destinationX,
        out int destinationY)
    {
        switch (qualifiedItemId)
        {
            case "(O)688":
                destination = WarpTotemFarmDestination;
                ResolveWarpTotemFarmEntry(out destinationX, out destinationY);
                return true;
            case "(O)689":
                destination = "Mountain";
                destinationX = 31;
                destinationY = 20;
                return true;
            case "(O)690":
                destination = "Beach";
                destinationX = 20;
                destinationY = 4;
                return true;
            case "(O)261":
                destination = "Desert";
                destinationX = 35;
                destinationY = 43;
                return true;
            case "(O)886":
                destination = "IslandSouth";
                destinationX = 11;
                destinationY = 11;
                return true;
            default:
                destination = string.Empty;
                destinationX = 0;
                destinationY = 0;
                return false;
        }
    }

    /// <summary>
    /// `(O)688`'s landing tile, in the native order: the Farm's own `WarpTotemEntry` map
    /// property when the map declares one, else the `whichFarm` fallback
    /// (Object.cs:3174-3182). Nothing is chosen here that the game does not choose.
    /// </summary>
    private static void ResolveWarpTotemFarmEntry(out int destinationX, out int destinationY)
    {
        try
        {
            if (Game1.getFarm() is { } farm
                && farm.TryGetMapPropertyAs("WarpTotemEntry", out Point declared, required: false))
            {
                destinationX = declared.X;
                destinationY = declared.Y;
                return;
            }
        }
        catch (Exception)
        {
            // An unreadable map property falls back to the native `whichFarm` arm below
            // rather than failing the action: that is the same arm the game takes.
        }

        int whichFarm = Game1.whichFarm;
        (destinationX, destinationY) = whichFarm switch
        {
            6 => (82, 29),
            5 => (48, 39),
            _ => (48, 7),
        };
    }

    /// <summary>
    /// The warp totems the actor owns right now, projected read-only from the live
    /// inventory: every object slot whose item the product can actually route. Only the
    /// slot and the item are published -- the destination is derived by the same helper
    /// the action executes with, so the projection and the execution cannot disagree.
    /// </summary>
    internal static IReadOnlyList<BridgeWarpItemTarget> DiscoverWarpItemTargets(Farmer player)
    {
        List<BridgeWarpItemTarget> result = new();
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object candidate)
                continue;
            if (!TryGetWarpTotemDestination(candidate.QualifiedItemId, out string destination, out int destinationX, out int destinationY))
                continue;
            result.Add(new BridgeWarpItemTarget(
                slot,
                candidate.QualifiedItemId,
                candidate.DisplayName,
                candidate.Stack,
                destination,
                destinationX,
                destinationY));
            if (result.Count >= 16)
                break;
        }
        return result;
    }

    /// <summary>
    /// Activates one owned warp totem through the native branch and hands the arrival to
    /// the shared travel completion path. Admission is instantaneous and named in the
    /// branch's own terms; the terminal is minted only by
    /// <c>CompleteTravelAfterWarp</c> once the Warped edge shows the destination.
    /// </summary>
    public LocalExecutionReceipt RequestLocalUseWarpItem(
        string requestId,
        int slot,
        string expectedQualifiedItemId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (slot < 0 || slot >= player.Items.Count || player.Items[slot] is not StardewValley.Object totem)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(totem.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "item_slot_changed",
                $"slot={slot};live={totem.QualifiedItemId};expected={expectedQualifiedItemId}");
        if (!TryGetWarpTotemDestination(totem.QualifiedItemId, out string destination, out int destinationX, out int destinationY))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "item_not_a_warp_totem",
                $"slot={slot};item={totem.QualifiedItemId};display_name={totem.DisplayName};native_branch={NativeTotemBranch(totem)}");

        // The branch's own synchronous writes arm a 2000ms animation and a 1000ms fade
        // before `Game1.warpFarmer`; dispatching inside an existing warp or freeze would
        // stack two warps (the rule `use_obelisk` already records).
        if (Game1.isWarping || player.freezePause > 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "warp_item_warp_already_pending",
                $"slot={slot};is_warping={Game1.isWarping.ToString().ToLowerInvariant()};freeze_pause={player.freezePause.ToString(CultureInfo.InvariantCulture)}");

        if (Game1.getLocationFromName(destination) is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "warp_item_destination_unavailable",
                $"slot={slot};item={totem.QualifiedItemId};destination={destination}");

        string origin = location.NameOrUniqueName;
        int originX = player.TilePoint.X;
        int originY = player.TilePoint.Y;
        if (string.Equals(origin, destination, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "warp_item_already_at_destination",
                $"slot={slot};item={totem.QualifiedItemId};origin={origin};destination={destination}");

        // The native branch's own context gate (Object.cs:3470 -> `flag`). Named here so
        // a refusal says which fact was false instead of only "it did not start".
        bool usableContext = !Game1.eventUp && !Game1.isFestival() && !Game1.fadeToBlack
            && !player.swimming.Value && !player.bathingClothes.Value && !player.onBridge.Value;

        int stackBefore = totem.Stack;
        int previousSlot = player.CurrentToolIndex;
        bool started;
        try
        {
            // THE NATIVE PAIR, in Game1's own order (Game1.cs:11351-11353): the branch,
            // then one unit consumed only when it returned true. Selecting the named slot
            // around the pair is what makes both halves act on the SAME item.
            player.CurrentToolIndex = slot;
            started = totem.performUseAction(location);
            if (started)
                player.reduceActiveItemByOne();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "warp_item_native_exception",
                $"slot={slot};item={totem.QualifiedItemId};destination={destination};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }
        finally
        {
            player.CurrentToolIndex = previousSlot;
        }

        int stackAfter = slot < player.Items.Count && player.Items[slot] is StardewValley.Object remaining ? remaining.Stack : 0;
        // The branch's own immediate writes (:3499-3506) are the observable signature that
        // the routine armed rather than merely returned true.
        bool routineArmed = !player.CanMove && player.temporarilyInvincible
            && player.temporaryInvincibilityTimer == -4000 && player.jitterStrength == 1f;
        string evidence =
            $"slot={slot};item={totem.QualifiedItemId};display_name={totem.DisplayName};origin={origin};origin_tile={originX},{originY};"
            + $"destination={destination};destination_tile={destinationX},{destinationY};"
            + $"usable_context={usableContext.ToString().ToLowerInvariant()};native_use_started={started.ToString().ToLowerInvariant()};"
            + $"stack_before={stackBefore.ToString(CultureInfo.InvariantCulture)};stack_after={stackAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"routine_armed={routineArmed.ToString().ToLowerInvariant()}";

        if (!started)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "warp_item_not_usable_here", evidence);
        if (!routineArmed)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "warp_item_not_started", evidence);

        LocalTravelSpec specification = new(
            executionId,
            requestId,
            "use_warp_item",
            origin,
            originX,
            originY,
            destination,
            destinationX,
            destinationY,
            this.revision,
            requestedDeadlineMs);
        this.activeTravel = specification;

        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            evidence);
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>Which native totem arm the owned object takes, so a refusal says what it
    /// actually holds rather than only that it is not a warp totem.</summary>
    private static string NativeTotemBranch(StardewValley.Object item) => item.QualifiedItemId switch
    {
        "(O)681" => "rain_totem",
        "(O)TreasureTotem" => "treasure_totem",
        _ => "none",
    };

    /// <summary>
    /// The live panning sites of the actor's current location. The game owns exactly one
    /// per location (`GameLocation.orePanPoint`), and `performOrePanTenMinuteUpdate` is
    /// its only creator, so this is a read of the game's own state and not a coordinate
    /// table: nothing is advertised while the point is unset.
    /// </summary>
    internal static IReadOnlyList<BridgePanSiteTarget> DiscoverPanSites(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgePanSiteTarget>();
        BridgePanSiteTarget? site = ReadLivePanSite(location);
        if (site is null)
            return Array.Empty<BridgePanSiteTarget>();
        if (!IsTileWithinChebyshevRadius(player, site.X, site.Y, TargetDiscoveryRadius))
            return Array.Empty<BridgePanSiteTarget>();
        return new[] { site };
    }

    /// <summary>
    /// Pans the one live ore-pan site, re-resolved on the game thread, and proves the
    /// postcondition from the two world facts the seam itself writes. See the file header
    /// for why `x,y` has to be re-resolved and why the site is not required to end empty.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPanOre(
        string requestId,
        int slot,
        int targetX,
        int targetY,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (slot < 0 || slot >= player.Items.Count || player.Items[slot] is not Pan pan)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pan_not_owned_in_slot", $"slot={slot}");
        // The native tool ingress drives the HELD tool, so a pan that is in the pack but
        // not equipped is a named refusal rather than a pan the native path could not
        // have produced -- the check `break_rock_source` had to restore.
        if (player.CurrentToolIndex != slot || !ReferenceEquals(player.CurrentTool, pan))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pan_not_equipped_in_requested_slot",
                $"slot={slot};current_tool_slot={player.CurrentToolIndex.ToString(CultureInfo.InvariantCulture)};current_tool={DescribeTool(player.CurrentTool) ?? "none"}");

        Point site = location.orePanPoint.Value;
        if (site.Equals(Point.Zero))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pan_site_not_available",
                $"location={location.NameOrUniqueName};ore_pan_point=0,0;tile={targetX},{targetY}");
        if (site.X != targetX || site.Y != targetY)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pan_site_changed",
                $"published={targetX},{targetY};live={site.X},{site.Y};location={location.NameOrUniqueName}");
        if (!location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pan_site_not_water",
                $"tile={targetX},{targetY};location={location.NameOrUniqueName};is_water=false");
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, PanNativeReachTiles))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pan_site_out_of_range",
                $"tile={targetX},{targetY};actor_tile={player.TilePoint.X},{player.TilePoint.Y};reach={PanNativeReachTiles.ToString(CultureInfo.InvariantCulture)}");

        int timesPannedBefore = (int)player.stats.Get("TimesPanned");
        int occupiedBefore = CountOccupiedInventorySlots(player);
        int unitsBefore = CountInventoryUnits(player);
        Point siteBefore = site;
        try
        {
            // THE SEAM. Public, synchronous, no menu and no input edge: the pan's own
            // `x,y` parameters are overwritten inside it, so the coordinates passed here
            // are the native call's own convention (`use_raft` passes the same shape) and
            // the site it acts on is the point re-resolved above.
            pan.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 1, player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "pan_native_exception",
                $"slot={slot};tile={targetX},{targetY};site={siteBefore.X},{siteBefore.Y};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        Point siteAfter = location.orePanPoint.Value;
        int timesPannedAfter = (int)player.stats.Get("TimesPanned");
        int occupiedAfter = CountOccupiedInventorySlots(player);
        int unitsAfter = CountInventoryUnits(player);
        bool siteMoved = !siteAfter.Equals(siteBefore);
        bool statAdvanced = timesPannedAfter == timesPannedBefore + 1;
        // `addItemsByMenuIfNecessary` opens an ItemGrabMenu when the pack cannot take the
        // whole result set; that overflow is the game's own disposition and is reported,
        // not collected here.
        bool overflowPending = Game1.activeClickableMenu is StardewValley.Menus.ItemGrabMenu;
        bool panned = siteMoved && statAdvanced;
        string evidence =
            $"slot={slot};tool={DescribeTool(pan) ?? "pan"};tile={targetX},{targetY};location={location.NameOrUniqueName};"
            + $"site_before={siteBefore.X},{siteBefore.Y};site_after={siteAfter.X},{siteAfter.Y};site_moved={siteMoved.ToString().ToLowerInvariant()};"
            + $"times_panned_before={timesPannedBefore.ToString(CultureInfo.InvariantCulture)};times_panned_after={timesPannedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"pan_output_overflow={overflowPending.ToString().ToLowerInvariant()};"
            + $"inventory_slots_before={occupiedBefore.ToString(CultureInfo.InvariantCulture)};inventory_slots_after={occupiedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"inventory_units_before={unitsBefore.ToString(CultureInfo.InvariantCulture)};inventory_units_after={unitsAfter.ToString(CultureInfo.InvariantCulture)}";
        return this.RememberTerminal(
            requestId,
            executionId,
            panned ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            panned ? "ore_panned" : "pan_postcondition_unavailable",
            evidence);
    }

    /// <summary>
    /// The one place that answers "is this Buildings-layer Action the mailbox selector?",
    /// matching the token the native `performAction` case switches on
    /// (GameLocation.cs:9953). Shared by discovery, admission and the fixture so the
    /// product and its declared Given cannot disagree about what the mailbox is.
    /// </summary>
    internal static bool IsMailboxActionProperty(string? actionProperty)
    {
        if (string.IsNullOrWhiteSpace(actionProperty))
            return false;
        string[] tokens = ArgUtility.SplitBySpace(actionProperty);
        return tokens.Length > 0 && string.Equals(tokens[0], "Mailbox", StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether this tile is the mailbox the game would serve. The native `checkAction`
    /// reaches a tile Action two ways (GameLocation.cs:7868-7888): the raw Buildings-layer
    /// tile first, then the virtual <c>doesTileHaveProperty</c> read, which also answers for
    /// tiles a Building or a Furniture owns. Both are accepted here so a mailbox the game
    /// serves can never be invisible to discovery, and an off-map tile answers false
    /// instead of throwing.
    /// </summary>
    internal static bool IsMailboxTile(GameLocation location, int x, int y)
    {
        // The mailbox is NOT map data. The repository's content probe over all 563 maps shows
        // \`Maps/Farm\` declares exactly one action property - \`Buildings:Message "Farm.1"\` at 8,7 - and the
        // only \`Mailbox\` actions anywhere are \`TownMailbox N\` in the Town variants. The farm mailbox is
        // per-player and computed in code: \`Farmer.getMailboxPosition()\` (Farmer.cs:2624, public) returns
        // the player's cabin mailbox when they live in a cabin, else \`Game1.getFarm().GetMainMailboxPosition()\`,
        // and \`Farm.cs:1473\` draws it there. Scanning the map for the action therefore never matched, and
        // this action could never advertise a target in production. Ask the game where the mailbox IS.
        if (location is not StardewValley.Farm)
            return false;
        try
        {
            Point mailbox = Game1.player.getMailboxPosition();
            return mailbox.X == x && mailbox.Y == y;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Opaque, stable selector for one mailbox tile. The pending count and the head
    /// letter are part of the identity on purpose: the postcondition is that the head
    /// letter is CLAIMED, so "this mailbox whose next letter is X" and "this mailbox
    /// whose next letter is Y" are two different targets, and a request naming the
    /// already-served one is refused instead of silently claiming the next letter. The
    /// head letter id is hashed INTO the id and never published, so the snapshot carries
    /// the mail count without carrying mailbox content.
    /// </summary>
    internal static string BuildMailboxTargetId(GameLocation location, int x, int y, int pendingCount, string? headMailId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:mailbox:{pendingCount.ToString(CultureInfo.InvariantCulture)}:{headMailId ?? "none"}";
        return $"mailbox_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// One mailbox the actor can name right now, projected read-only from the location's
    /// own map layer plus the actor's own pending-mail queue. A location with no mailbox
    /// tile advertises none, and the count is published even when it is zero so "there is
    /// a mailbox here and nothing to claim" stays distinguishable from "there is no
    /// mailbox here".
    /// </summary>
    internal static IReadOnlyList<BridgeMailboxTarget> DiscoverMailboxTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgeMailboxTarget>();
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return Array.Empty<BridgeMailboxTarget>();

        int pending = Game1.mailbox.Count;
        string? head = pending > 0 ? Game1.mailbox[0] : null;
        List<BridgeMailboxTarget> result = new();
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (!IsMailboxTile(location, x, y))
                    continue;
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius))
                    continue;
                result.Add(new BridgeMailboxTarget(
                    BuildMailboxTargetId(location, x, y, pending, head),
                    location.NameOrUniqueName,
                    x,
                    y,
                    pending));
                if (result.Count >= 4)
                    return result;
            }
        }
        return result;
    }

    /// <summary>
    /// One resolved mailbox, or the named reason the published target no longer matches
    /// the live world.
    /// </summary>
    internal sealed record MailboxTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        int PendingCount,
        string HeadMailId)
    {
        internal static MailboxTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, 0, string.Empty);
    }

    /// <summary>
    /// Re-derives the named mailbox on the game thread: the tile must still carry the
    /// selector the native case owns, and the published identity must still describe the
    /// live pending queue. A mismatch is a named refusal, never a silent re-target.
    /// </summary>
    internal static MailboxTargetResolution ResolveMailboxTarget(
        GameLocation location,
        int x,
        int y,
        string expectedTargetId)
    {
        string? tileAction = ReadBuildingsLayerAction(location, new Point(x, y));
        if (!IsMailboxTile(location, x, y))
            return MailboxTargetResolution.Reject(
                "mailbox_not_found",
                $"tile={x},{y};location={location.NameOrUniqueName};tile_action={tileAction ?? "none"}");

        int pending = Game1.mailbox.Count;
        string? head = pending > 0 ? Game1.mailbox[0] : null;
        string liveId = BuildMailboxTargetId(location, x, y, pending, head);
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return MailboxTargetResolution.Reject(
                "mail_target_changed",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};live={liveId};pending={pending.ToString(CultureInfo.InvariantCulture)}");

        return new MailboxTargetResolution(true, "accepted", string.Empty, pending, head ?? string.Empty);
    }

    /// <summary>
    /// Claims the mailbox's next letter through the native verb and lets the letter it
    /// opened finish the way its own exit path does, so the letter's `%item` attachment
    /// is delivered rather than discarded. See the file header for the split between the
    /// claim's world write and the attachment.
    /// </summary>
    public LocalExecutionReceipt RequestLocalClaimMailAttachment(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        MailboxTargetResolution resolution = ResolveMailboxTarget(location, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "mail_claim_out_of_range",
                $"target={expectedTargetId};tile={targetX},{targetY};actor_tile={player.TilePoint.X},{player.TilePoint.Y}");
        if (resolution.PendingCount == 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "mailbox_empty",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};pending=0");

        string mailId = resolution.HeadMailId;
        bool mailContentKnown = TryReadMailFacts(mailId, out bool hasAttachment, out int attachmentCommands);
        // The native rule that decides whether the claimed letter is recorded
        // (GameLocation.cs:10552-10555).
        bool recordedNatively = !mailId.Contains("passedOut", StringComparison.Ordinal)
            && !mailId.Contains("Cooking", StringComparison.Ordinal);
        int pendingBefore = resolution.PendingCount;
        bool recordedBefore = player.mailReceived.Contains(mailId);
        int occupiedBefore = CountOccupiedInventorySlots(player);
        int unitsBefore = CountInventoryUnits(player);

        bool letterOpened;
        try
        {
            // THE SEAM. It claims the letter (dequeue + mailReceived) and opens the
            // letter it claimed; nothing about either half is re-implemented here.
            location.mailbox();
            letterOpened = Game1.activeClickableMenu is StardewValley.Menus.LetterViewerMenu;
            if (letterOpened && Game1.activeClickableMenu is StardewValley.Menus.LetterViewerMenu openedLetter)
            {
                // The native exit step of the menu the seam just opened: it runs
                // `LetterViewerMenu.cleanupBeforeExit`, which hands the letter's
                // `itemsToGrab` to the player (LetterViewerMenu.cs:1010-1041) and closes
                // the menu, so the claim leaves neither an undelivered attachment nor an
                // open modal. The `Game1.exitActiveMenu()` shop_purchase uses for its
                // ShopMenu is NOT equivalent here: it only nulls the menu (:6128-6131)
                // and would discard the attachment.
                openedLetter.exitThisMenu();
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "mail_claim_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};mail_id={mailId};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        int pendingAfter = Game1.mailbox.Count;
        bool letterClosed = Game1.activeClickableMenu is not StardewValley.Menus.LetterViewerMenu;
        bool claimOverflowPending = Game1.activeClickableMenu is StardewValley.Menus.ItemGrabMenu;
        bool removed = pendingAfter == pendingBefore - 1 && !Game1.mailbox.Contains(mailId);
        bool recorded = !recordedNatively || recordedBefore || player.mailReceived.Contains(mailId);
        int occupiedAfter = CountOccupiedInventorySlots(player);
        int unitsAfter = CountInventoryUnits(player);
        bool claimed = removed && recorded;
        string evidence =
            $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};mail_id={mailId};"
            + $"mail_content_known={mailContentKnown.ToString().ToLowerInvariant()};mail_has_attachment={hasAttachment.ToString().ToLowerInvariant()};"
            + $"mail_attachment_commands={attachmentCommands.ToString(CultureInfo.InvariantCulture)};mail_recorded_natively={recordedNatively.ToString().ToLowerInvariant()};"
            + $"pending_before={pendingBefore.ToString(CultureInfo.InvariantCulture)};pending_after={pendingAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"mail_removed={removed.ToString().ToLowerInvariant()};mail_recorded={recorded.ToString().ToLowerInvariant()};"
            + $"letter_opened={letterOpened.ToString().ToLowerInvariant()};letter_closed={letterClosed.ToString().ToLowerInvariant()};"
            + $"collection_overflow_pending={claimOverflowPending.ToString().ToLowerInvariant()};"
            + $"inventory_slots_before={occupiedBefore.ToString(CultureInfo.InvariantCulture)};inventory_slots_after={occupiedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"inventory_units_before={unitsBefore.ToString(CultureInfo.InvariantCulture)};inventory_units_after={unitsAfter.ToString(CultureInfo.InvariantCulture)}";
        return this.RememberTerminal(
            requestId,
            executionId,
            claimed ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            claimed ? "mail_claimed" : "mail_claim_not_observed",
            evidence);
    }

    /// <summary>
    /// Whether the claimed letter declares an `%item` attachment, read from the game's
    /// own `Data/Mail` text before the claim removes it from the queue. Deliberately
    /// counts the commands rather than interpreting their grammar: the item ids the
    /// letter will hand over are the letter's own business, and the delivery is observed
    /// from the inventory instead.
    /// </summary>
    internal static bool TryReadMailFacts(string mailId, out bool hasAttachment, out int attachmentCommands)
    {
        hasAttachment = false;
        attachmentCommands = 0;
        try
        {
            if (!DataLoader.Mail(Game1.content).TryGetValue(mailId, out string? text) || string.IsNullOrEmpty(text))
                return false;
            int index = 0;
            while ((index = text.IndexOf("%item", index, StringComparison.Ordinal)) >= 0)
            {
                attachmentCommands++;
                index += "%item".Length;
            }
            hasAttachment = attachmentCommands > 0;
            return true;
        }
        catch (Exception)
        {
            // A refusal or a receipt must not fail because the letter's content could not
            // be read; the claim itself is decided from the queue, not from the text.
            return false;
        }
    }

    /// <summary>Occupied inventory slots: how many slots hold something.</summary>
    private static int CountOccupiedInventorySlots(Farmer player)
    {
        int count = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            StardewValley.Item? item = player.Items[slot];
            if (item is not null)
                count++;
        }
        return count;
    }

    /// <summary>
    /// Total units across the pack. The count of occupied slots cannot see a delivery
    /// that merged into an existing stack, so the overflow-safe fact is the unit total.
    /// </summary>
    private static int CountInventoryUnits(Farmer player)
    {
        int count = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            StardewValley.Item? item = player.Items[slot];
            if (item is not null)
                count += item.Stack;
        }
        return count;
    }

    /// <summary>
    /// The current location's live ore-pan site, or null when the location has none. Read
    /// from the game's own `orePanPoint` so discovery and the fixture share one predicate
    /// instead of a coordinate table.
    /// </summary>
    internal static BridgePanSiteTarget? ReadLivePanSite(GameLocation location)
    {
        Point site = location.orePanPoint.Value;
        if (site.Equals(Point.Zero))
            return null;
        return new BridgePanSiteTarget(site.X, site.Y);
    }
}
