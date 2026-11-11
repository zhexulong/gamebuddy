using System;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

// Opening one geode at the blacksmith for the `open_geode` action.
//
// THE MENU LIFECYCLE, read line by line from the target version rather than assumed
// (Menus/GeodeMenu.cs). There is no world object and no world tile: the "geode spot" is a
// ClickableComponent inside a menu (`geodeSpot`, myID 998, :46-50), and the four steps are:
//
//   OPEN   the counter is a TILE: `case "Blacksmith": if (who.TilePoint.Y > tileLocation.Y) return
//          blacksmith(tileLocation);` (GameLocation.cs:9873-9878). `blacksmith()` finds Clint in the
//          room's own character list by NAME (:10950-10955 - it compares no tile; the comparison at
//          :10956-10959 has its result discarded), offers a question dialogue whose responses include
//          `Process` only when the pack holds something `Utility.IsGeode` accepts (:10992-11009), and
//          answering it runs `case "Blacksmith_Process":
//          Game1.activeClickableMenu = new GeodeMenu();` (:12345-12346) - the parameterless
//          constructor, NOT a `GeodeMenu(GeodeSpot)` overload as the lane brief assumed (:38). The menu
//          holds no geode in a slot: the geode is the CURSOR item (`MenuWithInventory.heldItem`,
//          MenuWithInventory.cs:44-55), and the result slot the brief mentioned does not
//          exist - `geodeTreasure` (:30) is a field, drawn at :504-507.
//   LOAD   an inventory click puts the geode on the cursor. GeodeMenu's own click path is
//          `base.receiveLeftClick` -> `heldItem = inventory.leftClick(x, y, heldItem)`
//          (MenuWithInventory.cs:180-182), and `InventoryMenu.rightClick` with no held item
//          takes exactly ONE from the stack (`item.getOne()`, `actualInventory[num] =
//          item.ConsumeStack(1)`, InventoryMenu.cs:405-424). One unit in hand is what makes
//          `readyToClose` reachable afterwards (:84-91 requires `heldItem == null`).
//   SMASH  `receiveLeftClick` on the spot (:122-169) requires a held geode
//          (`Utility.IsGeode`, Utility.cs:6509), money >= 25 and `geodeAnimationTimer <= 0`,
//          then calls `startGeodeCrack` (:102-119): the spot takes a COPY of the held geode,
//          the held stack is consumed, `geodeAnimationTimer = 2700`, and the fee is taken
//          (`Game1.player.Money -= 25`, :107).
//   RESULT the treasure does not exist at click time. It is minted inside the menu's own
//          `update` when Clint's animation reaches frame 11 (`geodeTreasure =
//          Utility.getTreasureFromGeode(geodeSpot.item)`, :373-385) and it is DELIVERED when
//          the timer expires (`Game1.player.addItemToInventoryBool(geodeTreasure)`,
//          :222-236, which also clears `geodeSpot.item` and `geodeTreasure`).
//   CLOSE  `Game1.exitActiveMenu()` - what the menu's own okButton/trashCan path calls
//          (MenuWithInventory.cs:180-190) and what `dismiss_modal` uses for the same class of
//          operation menu (farmhandexecutioncontroller.modalactions.cs:250).
//
// WHAT "CLOSE ENOUGH" MEANS IS THE ENGINE'S ANSWER, NOT A NUMBER WRITTEN HERE. The counter is opened by
// clicking its tile, and the engine gates that click on the TILE - `Utility.tileWithinRadiusOfPlayer(
// grabTile, 1, player)` (Game1.cs:11509) - never on the distance to the blacksmith running it; the
// counter case adds only `who.TilePoint.Y > tileLocation.Y` (:9874), i.e. the actor stands below the
// counter. So the reach here is those two engine statements, asked through the tree's one
// `IsWithinRangeOfRequest` (farmhandexecutioncontroller.movementactions.cs:43-44), and the counter tile
// is read out of the MAP (its Buildings `Action`), which is where the engine reads it too (:7868-7888).
// `GeodeCounterInteractionRadius = 2` is gone: it was a number no engine member states, applied to
// Clint's tile rather than to the counter, and it made a player who could open the menu in the game be
// refused as if the world had refused (the same defect `shop_purchase` paid for in round 42 -
// farmhandexecutioncontroller.shopactions.cs:30-42).
//
// ONE ACTION, and it is one native menu driven to its own terminal: this body opens the menu,
// loads the geode through the menu's own inventory, clicks the spot through the menu's own
// handler, and advances the menu by its OWN `update` at frame-sized steps until the timer the
// menu set is spent. Nothing here re-implements the drop table, the fee, the animation or the
// delivery - the engine's own state machine performs all four. That is the same "drive the
// native seam" shape `shop_purchase` uses for ShopMenu
// (farmhandexecutioncontroller.shopactions.cs:517-717).
//
// The step size is a correctness requirement, not a tuning knob: `AnimatedSprite.animateOnce`
// advances Clint's frame from the elapsed time it is given, and the treasure exists only once
// frame 11 is passed (:239-387). A single large step would expire the timer on an animation
// that never reached frame 11, the engine would deliver `null`, and the geode would be
// consumed with nothing produced - an artefact of how this body pumps time, not a game outcome.
//
// BOTH ENGINE OUTCOMES are reported, and the empty one is never success-with-empty:
//   * `geode_opened` - a treasure was minted AND the pack count of that exact id rose by the
//     delivered stack AND the geode count fell AND the menu is closed.
//   * `geode_result_not_observed` - the crack ran and consumed the geode, but no treasure was
//     ever minted by the menu, or the delivery was refused by the pack. The receipt names
//     `treasure=none` / the delivered-vs-expected counts, so "consumed with nothing to show"
//     is its own visible terminal instead of a success with an empty result.
// `geode_result_partially_delivered` is the third, honest middle: the pack took part of the
// result stack. The engine's own pre-check at :135-137 (free spots) is what normally prevents
// it, so it is reported rather than assumed away.
//
// MODAL OWNERSHIP. The menu is opened by THIS execution, so it is registered through the one
// owner lease before it exists and released after it is gone
// (farmhandexecutioncontroller.cs:332-358, the same lease `use_mine_ladder` takes at
// farmhandexecutioncontroller.transportactions.cs:418). Without the lease a menu seen by the
// world-change arbitration would be read as an external interruption of the action that opened
// it (farmhandexecutioncontroller.cs:1956-1970).
//
// FAILURE CODES, each naming its own live fact:
//   * `geode_not_owned` - the named slot is empty, holds something `Utility.IsGeode` refuses, or
//     holds an id other than the one the request named; also the native pick-up failing.
//   * `geode_spot_not_reached` - this room's map carries no blacksmith counter tile, Clint is not in
//     the room, or the actor does not stand where the engine's counter case admits: below the counter
//     tile and inside the native click radius of it. The evidence names the counter tile(s), the actor's
//     tile and which of those two engine conditions failed.
//   * `geode_menu_not_opened` - the menu statement ran and no GeodeMenu was on screen.
//   * `geode_smash_not_started` - the native click ran and did NOT start the crack. The reason is
//     read from the menu's own refusal state (`alertTimer` = pack cannot take the result, :157-162;
//     `Game1.dayTimeMoneyBox.moneyShakeTimer` = the 25g fee, :164-168) instead of re-deriving
//     either rule here.
//   * `geode_result_not_observed` - the crack started and no result was observed.
//   * `geode_result_partially_delivered` - part of the result reached the pack.
//   * `menu_left_open` - the result was observed (or not) and a menu is still on screen.
//   * `open_geode_native_exception` - a native call threw; the effect is unknown.
internal sealed partial class ExecutionManager
{
    /// <summary>The vanilla location whose map carries the blacksmith counter (the `open_geode` fixture warps into
    /// it); the action itself reads the counter out of whatever map the actor is standing on.</summary>
    internal const string GeodeCounterLocationName = "Blacksmith";

    /// <summary>The blacksmith who owns that counter; his own dialogue case opens the menu.</summary>
    internal const string GeodeCounterOwnerName = "Clint";

    /// <summary>The Buildings-layer `Action` the blacksmith counter carries: the engine's own case
    /// (GameLocation.cs:9873-9878), whose "Process Geodes" response is what opens the menu (:12345-12346).</summary>
    internal const string GeodeCounterTileAction = "Blacksmith";

    /// <summary>The fee the native crack takes (`Game1.player.Money -= 25`, GeodeMenu.cs:107).</summary>
    internal const int GeodeProcessingFee = 25;

    /// <summary>One frame at the engine's own 60 Hz step, so the menu's animation advances as it would live.</summary>
    internal const int GeodeAnimationStepMs = 16;

    /// <summary>A bound on driving the menu's own 2700ms timer; exceeding it is a suspension, not a result.</summary>
    internal const int GeodeAnimationPumpCeilingMs = 15000;

    /// <summary>
    /// Opens one geode at the blacksmith's counter, end to end, through the game's own menu.
    /// </summary>
    public LocalExecutionReceipt RequestLocalOpenGeode(
        string requestId,
        int slot,
        string expectedQualifiedItemId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // One synchronous store with no await, so there is no cancel window inside it: the seam drives
        // no tool lifecycle and starts no swing.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        return this.ExecuteOpenGeode(executionId, requestId, slot, expectedQualifiedItemId ?? string.Empty);
    }

    /// <summary>
    /// The one execution body: it re-reads every precondition against the live world, because
    /// admission and the body are two separate game-thread reads.
    /// </summary>
    private LocalExecutionReceipt ExecuteOpenGeode(string executionId, string requestId, int slot, string expectedQualifiedItemId)
    {
        // Identity and scope admission are `AdmitExecution`'s ruling; the body re-reads the WORLD. The actor is
        // `Game1.player` because the menu itself acts on that farmer (`GeodeMenu` reads `Game1.player.Money` and
        // delivers through `Game1.player.addItemToInventoryBool`, :107/:230), so indexing any other actor's pack
        // would name a slot in a list the menu never shows.
        Farmer player = Game1.player;
        GameLocation? location = player.currentLocation;
        string locationName = location?.NameOrUniqueName ?? "none";
        string slotIdentity = $"slot={slot.ToString(CultureInfo.InvariantCulture)};inventory_slots={player.Items.Count.ToString(CultureInfo.InvariantCulture)};location={locationName}";

        Item? geode = slot >= 0 && slot < player.Items.Count ? player.Items[slot] : null;
        if (geode is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "geode_not_owned", $"{slotIdentity};item=none;{GeodeRefusal(RefusalLayerKind.Item, $"slot{slot}:empty")}");
        if (!Utility.IsGeode(geode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "geode_not_owned", $"{slotIdentity};item={geode.QualifiedItemId};is_geode=false;{GeodeRefusal(RefusalLayerKind.Item, $"slot{slot}:{geode.QualifiedItemId}:not_geode")}");
        if (expectedQualifiedItemId.Length > 0 && !string.Equals(geode.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "geode_not_owned", $"{slotIdentity};item={geode.QualifiedItemId};expected={expectedQualifiedItemId};{GeodeRefusal(RefusalLayerKind.Item, $"slot{slot}:{geode.QualifiedItemId}")}");

        if (!TryLocateGeodeCounter(player, location, out RefusalLayerToken counterLayer, out string counterEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "geode_spot_not_reached", $"{slotIdentity};item={geode.QualifiedItemId};{counterEvidence};{GeodeRefusal(counterLayer.Layer, counterLayer.Detail)}");

        string geodeItemId = geode.QualifiedItemId;
        int geodeStack = geode.Stack;
        int geodeOwnedBefore = player.Items.CountId(geodeItemId);
        int moneyBefore = player.Money;

        this.RegisterModalOwner(executionId);
        try
        {
            GeodeMenu? menu = null;
            try
            {
                // The engine's own counter answer (`case "Blacksmith_Process"`, GameLocation.cs:12345-12347): the
                // location constructs the menu, so this body never spells the constructor. `questionParams` is unused
                // by that case. A statement that does not leave a GeodeMenu on screen leaves an UNKNOWN world rather
                // than a refusal: something else may now be mounted, and that is not a precondition this action can name.
                location!.answerDialogueAction("Blacksmith_Process", Array.Empty<string>());
                if (Game1.activeClickableMenu is not GeodeMenu opened)
                {
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Uncertain,
                        "geode_menu_not_opened",
                        $"{slotIdentity};modal_type={(Game1.activeClickableMenu?.GetType().Name ?? "none")}");
                }

                menu = opened;
                int slotIndex = GeodeInventorySlotIndex(menu, slot);
                if (slotIndex < 0)
                {
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "geode_menu_not_opened",
                        $"{slotIdentity};menu_slots={menu.inventory?.inventory?.Count ?? 0};slot_component=absent;{GeodeRefusal(RefusalLayerKind.Item, $"slot{slot}:not_drawn")}");
                }

                // The native pick-up: one unit onto the cursor, taken out of the named slot by the
                // menu's own inventory (InventoryMenu.cs:405-424).
                ClickableComponent slotComponent = menu.inventory!.inventory![slotIndex];
                menu.receiveRightClick(slotComponent.bounds.Center.X, slotComponent.bounds.Center.Y);
                if (menu.heldItem is null || !string.Equals(menu.heldItem.QualifiedItemId, geodeItemId, StringComparison.Ordinal))
                {
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "geode_not_owned",
                        $"{slotIdentity};held={(menu.heldItem?.QualifiedItemId ?? "none")};pickup=refused;{GeodeRefusal(RefusalLayerKind.Item, $"slot{slot}:pickup_refused")}");
                }

                return this.ExecuteCrackGeode(menu, player, executionId, requestId, slotIdentity, geodeItemId, geodeStack, geodeOwnedBefore, moneyBefore);
            }
            finally
            {
                // The menu this execution opened never outlives it: the native close, then the lease.
                if (menu is not null && Game1.activeClickableMenu is GeodeMenu)
                {
                    try
                    {
                        Game1.exitActiveMenu();
                    }
                    catch (Exception)
                    {
                        // Named in the receipt by its own postcondition read below, not swallowed silently.
                    }
                }
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "open_geode_native_exception",
                $"{slotIdentity};item={geodeItemId};native_exception={nativeException.GetType().Name};geode_owned_before={geodeOwnedBefore.ToString(CultureInfo.InvariantCulture)};money_before={moneyBefore.ToString(CultureInfo.InvariantCulture)}");
        }
        finally
        {
            this.ReleaseModalOwner(executionId);
        }
    }

    /// <summary>
    /// The smash and its result, driven through the menu's own handler and update. The fee, the drop
    /// table, the animation and the delivery are all the engine's; this body only supplies the click
    /// and the elapsed time, then reads the outcome back from the pack.
    ///
    /// <para>
    /// Named <c>Execute*</c> because that is the unit <c>tools/check-stardew-postcondition-delta.mjs</c> reads: it takes
    /// the dispatch entry plus every <c>Execute*</c> body it delegates to, and the <c>geode_owned_before</c>/
    /// <c>geode_owned_after</c> pair that witnesses <c>geode_opened</c> lives HERE, not in the opening body. A plain
    /// <c>CrackGeode</c> name left the delta invisible and the action's declared postcondition unmeasured.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt ExecuteCrackGeode(
        GeodeMenu menu,
        Farmer player,
        string executionId,
        string requestId,
        string slotIdentity,
        string geodeItemId,
        int geodeStack,
        int geodeOwnedBefore,
        int moneyBefore)
    {
        // The native smash at the spot's own coordinates (GeodeMenu.cs:122-169).
        Point spotCenter = menu.geodeSpot.bounds.Center;
        menu.receiveLeftClick(spotCenter.X, spotCenter.Y, playSound: true);

        if (menu.geodeAnimationTimer <= 0)
        {
            // The click ran and did NOT start the crack. The menu states why in its own refusal UI
            // fields (:157-168); this body reads them instead of re-deriving either rule.
            string refusal = menu.alertTimer > 0
                ? "inventory_full"
                : (Game1.dayTimeMoneyBox?.moneyShakeTimer ?? 0) > 0 ? "fee_unavailable" : "not_eligible";
            bool closed = CloseGeodeMenu(menu);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "geode_smash_not_started",
                $"{slotIdentity};item={geodeItemId};refusal={refusal};"
                    + $"money={moneyBefore.ToString(CultureInfo.InvariantCulture)};fee={GeodeProcessingFee.ToString(CultureInfo.InvariantCulture)};"
                    + $"alert_timer={menu.alertTimer.ToString(CultureInfo.InvariantCulture)};held={(menu.heldItem?.QualifiedItemId ?? "none")};"
                    + $"menu_closed={closed.ToString().ToLowerInvariant()};{GeodeRefusal(RefusalLayerKind.Item, refusal)}");
        }

        // Drive the menu's OWN update until the timer IT set is spent, one frame step at a time so the
        // animation the treasure depends on advances exactly as it would live.
        string? treasureItemId = null;
        int treasureStack = 0;
        int treasureOwnedBeforeDelivery = 0;
        int pumpedMs = 0;
        while (menu.geodeAnimationTimer > 0 && pumpedMs < GeodeAnimationPumpCeilingMs)
        {
            if (treasureItemId is null && menu.geodeTreasure is { } minted)
            {
                treasureItemId = minted.QualifiedItemId;
                treasureStack = minted.Stack;
                // Read BEFORE the delivery update: the mint and the delivery are separate steps of the
                // menu's own update, and this snapshot is the "before" half of the delivery count.
                treasureOwnedBeforeDelivery = player.Items.CountId(treasureItemId);
            }

            menu.update(new GameTime(TimeSpan.Zero, TimeSpan.FromMilliseconds(GeodeAnimationStepMs)));
            pumpedMs += GeodeAnimationStepMs;
        }

        bool crackSettled = menu.geodeAnimationTimer <= 0;
        // "no menu open" is half the postcondition, so the close happens BEFORE the read that reports it.
        bool menuClosed = CloseGeodeMenu(menu);

        int geodeOwnedAfter = player.Items.CountId(geodeItemId);
        int treasureOwnedAfter = treasureItemId is null ? 0 : player.Items.CountId(treasureItemId);
        int delivered = treasureItemId is null ? 0 : treasureOwnedAfter - treasureOwnedBeforeDelivery;
        int moneyAfter = player.Money;
        int feeTaken = moneyBefore - moneyAfter;

        string evidence =
            $"{slotIdentity};item={geodeItemId};geode_stack={geodeStack.ToString(CultureInfo.InvariantCulture)};"
            + $"geode_owned_before={geodeOwnedBefore.ToString(CultureInfo.InvariantCulture)};geode_owned_after={geodeOwnedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"geode_consumed={(geodeOwnedBefore - geodeOwnedAfter).ToString(CultureInfo.InvariantCulture)};"
            + $"money_before={moneyBefore.ToString(CultureInfo.InvariantCulture)};money_after={moneyAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"fee={GeodeProcessingFee.ToString(CultureInfo.InvariantCulture)};fee_taken={feeTaken.ToString(CultureInfo.InvariantCulture)};"
            + $"pumped_ms={pumpedMs.ToString(CultureInfo.InvariantCulture)};crack_settled={crackSettled.ToString().ToLowerInvariant()};"
            + $"treasure={(treasureItemId ?? "none")};treasure_stack={treasureStack.ToString(CultureInfo.InvariantCulture)};"
            + $"treasure_before={treasureOwnedBeforeDelivery.ToString(CultureInfo.InvariantCulture)};treasure_after={treasureOwnedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"delivered={delivered.ToString(CultureInfo.InvariantCulture)};menu_closed={menuClosed.ToString().ToLowerInvariant()}";

        if (!crackSettled)
        {
            // The menu's own 2700ms timer did not expire inside the ceiling: the crack is suspended, so
            // the outcome is unknown rather than empty.
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "geode_result_not_observed", $"{evidence};reason=timer_not_settled");
        }

        if (treasureItemId is null)
        {
            // The engine's second outcome, reported as what it is: the geode was consumed and the menu
            // minted nothing to show for it.
            return this.RememberTerminal(requestId, executionId, ExecutionState.Failed, "geode_result_not_observed", $"{evidence};reason=treasure_not_minted");
        }

        if (delivered <= 0)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Failed, "geode_result_not_observed", $"{evidence};reason=result_not_delivered");
        }

        if (!menuClosed)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "menu_left_open", $"{evidence};expected_closed=true");
        }

        if (delivered < treasureStack)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.PartiallySucceeded, "geode_result_partially_delivered", evidence);
        }

        if (geodeOwnedAfter == geodeOwnedBefore - 1 && feeTaken == GeodeProcessingFee)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "geode_opened", evidence, this.TryCreateLocalObservation(player));

        // A delivered treasure with a geode that did not leave the pack (or a fee that did not move) is
        // not something to claim: the two halves disagree.
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "geode_result_not_observed", $"{evidence};reason=world_disagrees_with_menu");
    }

    /// <summary>
    /// The declared layer a geode refusal names, in the one <c>blocked_by=</c> token the refusal vocabulary
    /// publishes (<see cref="RefusalLayerToken"/>). A refusal that cannot say which of the action's own
    /// requirements refused leaves the caller re-aiming instead of adapting, which is why every Rejected
    /// terminal of this action carries this field.
    /// </summary>
    private static string GeodeRefusal(RefusalLayerKind layer, string? detail)
    {
        // One token, one field: the layer that refused and the bounded detail that makes it specific.
        return $"blocked_by={new RefusalLayerToken(layer, detail).Format()}";
    }

    /// <summary>
    /// Closes the menu this execution opened with the native close step, and answers whether it is gone.
    /// </summary>
    private static bool CloseGeodeMenu(GeodeMenu menu)
    {
        if (Game1.activeClickableMenu is GeodeMenu)
        {
            try
            {
                Game1.exitActiveMenu();
            }
            catch (Exception)
            {
                // The caller reads and reports the live state right after this, so a throwing close is
                // visible as menu_left_open instead of being swallowed here.
            }
        }

        return Game1.activeClickableMenu is not GeodeMenu;
    }

    /// <summary>
    /// The menu's own component index for a backpack slot. The menu builds its slots as
    /// <c>new ClickableComponent(bounds, j.ToString())</c> over <c>Game1.player.Items</c>
    /// (InventoryMenu.cs:78-116), so the name IS the slot; matching on it keeps this from assuming the
    /// drawn order and the backpack index are the same list.
    /// </summary>
    private static int GeodeInventorySlotIndex(GeodeMenu menu, int slot)
    {
        List<ClickableComponent>? slots = menu.inventory?.inventory;
        if (slots is null)
            return -1;
        for (int index = 0; index < slots.Count; index++)
        {
            if (int.TryParse(slots[index]?.name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int named) && named == slot)
                return index;
        }
        return -1;
    }

    /// <summary>
    /// Every tile in this location whose Buildings <c>Action</c> is the blacksmith counter (GameLocation.cs:9873-9878),
    /// read from the raw map layer the way the engine's own click reads it (GameLocation.cs:7868-7888) and parsed the
    /// way <c>performAction</c> parses it (<c>ArgUtility.SplitBySpace</c>, :8611).
    /// </summary>
    internal static List<Point> FindGeodeCounterTiles(GameLocation location)
    {
        var counters = new List<Point>();
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return counters;

        for (int x = 0; x < buildings.LayerWidth; x++)
        {
            for (int y = 0; y < buildings.LayerHeight; y++)
            {
                string? action = ReadBuildingsLayerAction(buildings, x, y);
                if (action is null)
                    continue;
                string[] parsed = ArgUtility.SplitBySpace(action);
                if (parsed.Length > 0 && string.Equals(parsed[0], GeodeCounterTileAction, StringComparison.Ordinal))
                    counters.Add(new Point(x, y));
            }
        }

        return counters;
    }

    /// <summary>
    /// Whether the actor may open the blacksmith's geode counter from where they stand: this room's map carries the
    /// counter tile, Clint is in the room, and the two spatial conditions the engine's counter case applies both hold.
    /// The refusal names which of those facts was missing, so a caller can act on it (walk to the counter, come back
    /// while he is in) instead of guessing from a distance.
    /// </summary>
    internal static bool TryLocateGeodeCounter(
        Farmer player,
        GameLocation? location,
        out RefusalLayerToken blocked,
        out string evidence)
    {
        List<Point> counters = location is null ? new List<Point>() : FindGeodeCounterTiles(location);
        if (counters.Count == 0)
        {
            // No tile carries the action, so `performAction` never reaches `blacksmith()` and no "Process Geodes"
            // response exists in this room at all (GameLocation.cs:9873-9878).
            blocked = new RefusalLayerToken(
                RefusalLayerKind.Range,
                $"absent@{RefusalProbe.WithoutSpaces(location?.NameOrUniqueName ?? "none")}");
            evidence = $"counter_action={GeodeCounterTileAction};counter_tiles=0";
            return false;
        }

        string counterTiles = string.Join(
            "|",
            counters.Select(counter => $"{counter.X.ToString(CultureInfo.InvariantCulture)},{counter.Y.ToString(CultureInfo.InvariantCulture)}"));

        NPC? owner = location!.characters?.FirstOrDefault(character =>
            character is not null && string.Equals(character.Name, GeodeCounterOwnerName, StringComparison.Ordinal));
        if (owner is null)
        {
            blocked = new RefusalLayerToken(RefusalLayerKind.Character, $"{GeodeCounterOwnerName}@absent");
            evidence = $"counter_action={GeodeCounterTileAction};counter_tiles={counterTiles};"
                + $"owner={GeodeCounterOwnerName};owner_present=false";
            return false;
        }

        // The engine's own admission for this counter, as two statements rather than a number of ours: the counter case
        // runs only for an actor standing BELOW the tile (`who.TilePoint.Y > tileLocation.Y`, GameLocation.cs:9874), and
        // the click that reaches it is gated on the native radius around the TILE (Game1.cs:11509). Clint's tile is not
        // part of it - `blacksmith()` finds him by name in the room's character list (:10950-10955).
        bool Admits(Point counter) =>
            player.TilePoint.Y > counter.Y && IsWithinRangeOfRequest((counter.X, counter.Y), player);

        foreach (Point counter in counters)
        {
            if (!Admits(counter))
                continue;
            evidence = $"counter_action={GeodeCounterTileAction};counter_tiles={counterTiles};"
                + $"counter={CounterPoint(counter)};owner={GeodeCounterOwnerName};owner_present=true";
            blocked = RefusalLayerToken.None;
            return true;
        }

        Point named = counters[0];
        evidence = $"counter_action={GeodeCounterTileAction};counter_tiles={counterTiles};"
            + $"counter={CounterPoint(named)};owner={GeodeCounterOwnerName};owner_present=true;"
            + $"actor_tile={player.TilePoint.X.ToString(CultureInfo.InvariantCulture)},{player.TilePoint.Y.ToString(CultureInfo.InvariantCulture)};"
            + $"actor_below_counter={(player.TilePoint.Y > named.Y ? "true" : "false")};"
            + $"within_range_of_request={(IsWithinRangeOfRequest((named.X, named.Y), player) ? "true" : "false")};"
            + $"radius={NativeInteractionRadius.ToString(CultureInfo.InvariantCulture)}";
        blocked = new RefusalLayerToken(RefusalLayerKind.Range, $"counter@{CounterPoint(named)}");
        return false;
    }

    /// <summary>One counter tile as the evidence spells it: `x,y`.</summary>
    private static string CounterPoint(Point counter) =>
        $"{counter.X.ToString(CultureInfo.InvariantCulture)},{counter.Y.ToString(CultureInfo.InvariantCulture)}";
}
