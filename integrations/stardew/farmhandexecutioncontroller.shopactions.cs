using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.Internal;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// shop_purchase: buy from a shop the player is ALREADY standing next to.
///
/// Scope, deliberately narrow (owner decision): this action does not walk. Walking is
/// <c>move_to_tile</c>'s job, exactly as it is for every other action. If the owner is
/// outside the native interaction radius the action refuses with
/// <c>shop_counter_out_of_reach</c> and the Agent walks and retries. That keeps this
/// action's receipt about the TRANSACTION, and keeps a walk failure from being reported
/// as a trade failure.
///
/// Authority: every fact comes from the game.
///
/// <list type="bullet">
/// <item>Which shops exist and what they sell: <c>DataLoader.Shops</c> / <c>ShopBuilder.GetShopStock</c>.</item>
/// <item>Whether an owner entry is currently eligible: <c>ShopBuilder.GetCurrentOwners</c>,
/// which is where <c>ShopOwnerData.Condition</c> (a game-state query) is evaluated. The Mod
/// does not model opening hours; it asks the game.</item>
/// <item>Why a shop is closed: <c>ShopOwnerData.ClosedMessage</c>, the game's own text.</item>
/// <item>The interaction radius: <c>Utility.tileWithinRadiusOfPlayer</c> (Chebyshev-1),
/// the same predicate the native cursor uses.</item>
/// <item>The transaction: <c>Utility.TryOpenShopMenu</c> opens the game's own
/// <c>ShopMenu</c>, and the purchase is dispatched through <c>ShopMenu.receiveLeftClick</c>
/// over the menu's public <c>forSaleButtons</c>. The Mod does not re-implement
/// <c>tryToPurchaseItem</c> (it is private and its logic is the game's).</item>
/// </list>
///
/// Discovery reports targets for the CURRENT location only, because the owner's presence is
/// what makes a shop usable — so the Agent can tell "this shop is not on the map I am on"
/// from "this shop is here but closed", which are different problems with different fixes.
/// A shop whose native counter is a TILE rather than an NPC (the tile-opened stalls) is
/// discovered from that tile for the same reason: the counter's presence is what makes it
/// usable, and the tile is where the actor has to stand.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// <summary>The native interaction radius for a shop owner (Chebyshev, Utility.cs:4100).</summary>
    private const int ShopOwnerInteractionRadius = 1;
    /// <summary>The Host's published cap on <c>shopTargets</c> (host/src/protocol.ts), which the
    /// one snapshot contract enforces; exceeding it invalidates the WHOLE snapshot.</summary>
    private const int MaxShopTargets = 32;
    /// <summary>How many tile-opened shops one location may contribute.</summary>
    private const int MaxTileShopTargets = 8;

    internal static string ShopTargetId(string shopId, string ownerName) =>
        $"shop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(shopId + "\u0000" + ownerName))).ToLowerInvariant()[..16]}";

    /// <summary>
    /// Every shop whose owner is eligible AND physically present in the actor's current
    /// location. Empty is the honest answer everywhere else.
    /// </summary>
    private IReadOnlyList<BridgeShopTarget> DiscoverShopTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgeShopTarget>();

        List<BridgeShopTarget> targets = new();
        foreach ((string shopId, ShopData shopData) in DataLoader.Shops(Game1.content))
        {
            ShopOwnerData[] owners;
            try
            {
                owners = ShopBuilder.GetCurrentOwners(shopData).ToArray();
            }
            catch (Exception)
            {
                // A malformed content pack must not take the whole snapshot down; the shop
                // is simply not advertised.
                continue;
            }

            foreach (ShopOwnerData owner in owners)
            {
                // Only a named NPC is a physical owner we can stand next to.
                if (owner.Type != ShopOwnerType.NamedNpc || string.IsNullOrWhiteSpace(owner.Name))
                    continue;

                NPC? npc = location.characters.FirstOrDefault(c =>
                    c is not null && string.Equals(c.Name, owner.Name, StringComparison.Ordinal));
                if (npc is null)
                    continue;

                bool inReach = Utility.tileWithinRadiusOfPlayer(
                    npc.TilePoint.X, npc.TilePoint.Y, ShopOwnerInteractionRadius, player);

                ReadShopStock(shopId, shopData, out int stockCount, out List<string> stockItemIds);

                targets.Add(new BridgeShopTarget(
                    ShopTargetId(shopId, owner.Name),
                    shopId,
                    owner.Name,
                    location.NameOrUniqueName,
                    npc.TilePoint.X,
                    npc.TilePoint.Y,
                    inReach,
                    stockCount,
                    stockItemIds));
            }
        }

        // A shop whose owner entry is NOT a named NPC standing in the room (AnyOrNone /
        // None, which is what the tile-opened stalls use) is reachable only through the
        // tile that opens it, so that is where it is discovered. The reachable set is the
        // tile set, not every non-NamedNpc owner entry: an owner entry nothing in the
        // world opens has no counter to walk up to and must not be advertised.
        targets.AddRange(DiscoverTileShopTargets(location, player));
        return targets.Take(MaxShopTargets).ToArray();
    }

    /// <summary>
    /// What a shop can actually sell right now, so a caller does not have to guess an item
    /// id. Same call the purchase itself uses, so discovery and execution cannot disagree
    /// about what is on offer.
    /// </summary>
    private static void ReadShopStock(string shopId, ShopData shopData, out int stockCount, out List<string> stockItemIds)
    {
        stockCount = 0;
        stockItemIds = new List<string>();
        try
        {
            Dictionary<ISalable, ItemStockInformation>? here = ShopBuilder.GetShopStock(shopId, shopData);
            if (here is null)
                return;
            stockCount = here.Count;
            foreach (ISalable item in here.Keys)
            {
                if (!string.IsNullOrEmpty(item.QualifiedItemId) && stockItemIds.Count < 16)
                    stockItemIds.Add(item.QualifiedItemId);
            }
        }
        catch (Exception)
        {
            stockCount = 0;
        }
    }

    /// <summary>
    /// Shops opened by a Buildings-layer Action tile instead of by an NPC the actor stands
    /// next to. Their execution seam is exactly the one this action already dispatches
    /// (<c>Utility.TryOpenShopMenu</c>), but their owner entry is not a named NPC in the
    /// room, so the owner scan above can never see them.
    ///
    /// The tile IS the counter: <c>ownerTileX/Y</c> is the tile the actor has to stand
    /// within the native click radius of, and <c>ownerName</c> is empty because no NPC owns
    /// the stall. That empty name is not a missing fact -- every one of these native cases
    /// opens the shop with a null owner, which the game documents as "no NPC
    /// portrait/dialogue" (Utility.cs:4174).
    /// </summary>
    private static IEnumerable<BridgeShopTarget> DiscoverTileShopTargets(GameLocation location, Farmer player)
    {
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            yield break;

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            yield break;
        }

        HashSet<string> seen = new(StringComparer.Ordinal);
        int found = 0;
        for (int y = 0; y < buildings.LayerHeight && found < MaxTileShopTargets; y++)
        {
            for (int x = 0; x < buildings.LayerWidth && found < MaxTileShopTargets; x++)
            {
                var tile = buildings.Tiles[x, y];
                if (tile is null || !tile.Properties.TryGetValue("Action", out var actionValue))
                    continue;
                string action = actionValue.ToString();
                // One target per shop: two tiles of the same stall would mint the same
                // target id twice and make the request ambiguous.
                if (!TryResolveTileShop(action, out string shopId)
                    || !shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null
                    || !seen.Add(shopId))
                    continue;

                ReadShopStock(shopId, shopData, out int stockCount, out List<string> stockItemIds);
                found++;
                yield return new BridgeShopTarget(
                    ShopTargetId(shopId, string.Empty),
                    shopId,
                    string.Empty,
                    location.NameOrUniqueName,
                    x,
                    y,
                    Utility.tileWithinRadiusOfPlayer(x, y, ShopOwnerInteractionRadius, player),
                    stockCount,
                    stockItemIds);
            }
        }
    }

    /// <summary>
    /// The shop a Buildings-layer Action tile opens, resolved through the selectors whose
    /// native case dispatches the SAME <c>Utility.TryOpenShopMenu(shopId, null, ...)</c>
    /// overload this action dispatches (GameLocation.performAction). A selector that opens
    /// no shop at all is left out rather than forced:
    ///
    /// <list type="bullet">
    /// <item><c>ColaMachine</c> (GameLocation.cs:9231) buys one Joja Cola inside its own
    /// answer handler -- no shop menu is ever built.</item>
    /// <item><c>QiCoins</c> (:9932) and <c>ClubSeller</c> (:9946) are question dialogues
    /// whose answers exchange money for club coins or an item; neither opens a shop.</item>
    /// <item><c>IceCreamStand</c> (:9234) and every <c>OpenShop</c> form carrying a
    /// direction, an opening window or an owner area (:9061-9110) run the LOCATION overload with
    /// those gates, which this action does not reproduce -- opening anyway would be a gate
    /// bypass of the same kind backlog item "enter_exit could pass through a native door gate"
    /// is. The GATE-FREE two-token <c>OpenShop &lt;shopId&gt;</c> IS included, and the handler
    /// dispatches it through that same location overload (no owner area, forceOpen), so even
    /// its closed-message refusal stays native.</item>
    /// </list>
    ///
    /// <c>Bookseller</c> (:8727) is the one included selector with a gate of its own; the
    /// handler re-reads that gate and refuses rather than opening a shop a real click would
    /// not have opened.
    /// </summary>
    internal static bool TryResolveTileShop(string? action, out string shopId)
    {
        shopId = string.Empty;
        if (string.IsNullOrWhiteSpace(action))
            return false;

        string[] tokens = ArgUtility.SplitBySpace(action);
        switch (tokens[0])
        {
            case "JojaShop":
                shopId = "Joja";
                return true;
            case "ClubShop":
                shopId = "Casino";
                return true;
            case "QiGemShop":
                shopId = "QiGemShop";
                return true;
            case "Bookseller":
                shopId = "Bookseller";
                return true;
            case "OpenShop":
                // Only the gate-free two-token form. The native case parses a direction, an
                // opening window and an owner area out of the remaining arguments and
                // returns without opening on each of them.
                if (tokens.Length != 2)
                    return false;
                shopId = tokens[1];
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// The game's own "this shop is closed" text, read at refusal time rather than carried on
    /// the discovered target. Carrying it meant the snapshot had a nullable field the Mod's
    /// serializer omitted when null, which the Host's exact-key check then rejected — the
    /// message belongs in the refusal evidence, not in a snapshot contract.
    /// </summary>
    private static string? GameStateQueryClosedMessageFor(string shopId, string ownerName)
    {
        try
        {
            if (!DataLoader.Shops(Game1.content).TryGetValue(shopId, out ShopData? shopData) || shopData is null)
                return null;
            foreach (ShopOwnerData owner in ShopBuilder.GetCurrentOwners(shopData))
            {
                if (owner.Type == ShopOwnerType.NamedNpc &&
                    string.Equals(owner.Name, ownerName, StringComparison.Ordinal))
                    return owner.ClosedMessage;
            }
        }
        catch (Exception)
        {
            // A refusal must not fail because the message could not be read.
        }
        return null;
    }

    public LocalExecutionReceipt RequestLocalShopPurchase(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            // The guard reason NAMES the failure (no bound actor / wrong scope / world not ready). This body used
            // to discard it with `out _` and report player_not_actionable for every identity failure, which is
            // the failure-mode collapse the review flagged.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        // One body at a time, like every other action.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null
            || this.activeToolApproach is not null
            || this.activeMountTransport is not null || this.activeBusRide is not null
            || this.activeDayAdvance is not null)
        {
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "body_owned", null);
        }

        // A menu is already up: this action would be driving the game's own UI, so it
        // cannot proceed without stepping on whatever opened it.
        if (Game1.activeClickableMenu is not null || Game1.dialogueUp)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_open",
                $"modal={Game1.activeClickableMenu?.GetType().Name ?? "dialogue"}");
        }

        string? targetId = request.Args.ExpectedTargetId;
        if (string.IsNullOrWhiteSpace(targetId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_target_id", null);

        if (string.IsNullOrWhiteSpace(request.Args.ExpectedQualifiedItemId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_item", null);
        string expectedItemId = request.Args.ExpectedQualifiedItemId!;

        int quantity = request.Args.Quantity ?? 1;
        if (quantity < 1)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_quantity", $"quantity={quantity}");

        // Re-resolve the target from live state: the client's opaque id is only matched
        // against a set derived here, never parsed.
        GameLocation? location = actor.currentLocation;
        if (location is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        IReadOnlyList<BridgeShopTarget> targets = this.DiscoverShopTargets(actor);
        BridgeShopTarget? target = targets.FirstOrDefault(t => string.Equals(t.TargetId, targetId, StringComparison.Ordinal));
        if (target is null)
        {
            // Distinguish "the shop exists but its owner is not here / not eligible" from
            // "this is not a shop at all", because they need different Agent responses.
            string knownHere = string.Join(",", targets.Select(t => t.ShopId).Distinct().Take(8));
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "shop_target_unavailable",
                $"target={targetId};location={location.NameOrUniqueName};available_here={knownHere}");
        }

        if (!target.OwnerInReach)
        {
            // The deliberate scope boundary: walking is move_to_tile's job.
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "shop_counter_out_of_reach",
                $"owner={target.OwnerName};owner_tile={target.OwnerTileX},{target.OwnerTileY};"
                    + $"actor_tile={actor.TilePoint.X},{actor.TilePoint.Y};radius={ShopOwnerInteractionRadius}"
                    + (string.IsNullOrWhiteSpace(GameStateQueryClosedMessageFor(target.ShopId, target.OwnerName)) ? string.Empty : $";closed_message={GameStateQueryClosedMessageFor(target.ShopId, target.OwnerName)}"));
        }

        // A tile-opened shop's counter is the tile. The counter's own Action, re-read on the
        // game thread, decides which native call this target's case makes: the fixed
        // selectors all dispatch the STRING overload with a null owner (listed in
        // TryResolveTileShop), while `OpenShop` without arguments dispatches the LOCATION
        // overload with no owner area and forceOpen -- and only that form reproduces the
        // case's own closed-message refusal (Utility.cs:4305-4317). Opening a gated stall
        // anyway would be a gate bypass.
        bool tileOpened = target.OwnerName.Length == 0;
        string? counterAction = tileOpened
            ? ReadBuildingsLayerAction(location, new Microsoft.Xna.Framework.Point(target.OwnerTileX, target.OwnerTileY))
            : null;
        bool counterIsOpenShop = counterAction is not null
            && string.Equals(
                ArgUtility.SplitBySpace(counterAction).FirstOrDefault(),
                "OpenShop",
                StringComparison.Ordinal);

        if (tileOpened && string.Equals(target.ShopId, "Bookseller", StringComparison.Ordinal))
        {
            // Bookseller is the only advertised tile selector whose native case has a gate
            // of its own (GameLocation.cs:8727-8744): it opens only on the season's
            // bookseller days, and otherwise asks a Buy/Trade/Leave question instead. This
            // seam reproduces neither, so it refuses rather than opening a shop a real
            // click would not have opened.
            if (!Utility.getDaysOfBooksellerThisSeason().Contains(Game1.dayOfMonth))
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_tile_gate_refused",
                    $"shop={target.ShopId};counter={target.OwnerTileX},{target.OwnerTileY};day={Game1.dayOfMonth};gate=bookseller_day");
            if (Game1.player.mailReceived.Contains("read_a_book"))
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_tile_requires_dialogue",
                    $"shop={target.ShopId};counter={target.OwnerTileX},{target.OwnerTileY};gate=bookseller_choice");
        }

        // The stock the game would actually offer right now.
        // Filled by the click loop below and reported in the receipt, so a swallowed click
        // is diagnosable from the evidence instead of requiring another live round.
        List<string> clickDiagnostics = new();
        List<string> dropDiagnostics = new();

        Dictionary<ISalable, ItemStockInformation> stock;
        try
        {
            stock = ShopBuilder.GetShopStock(target.ShopId) ?? new Dictionary<ISalable, ItemStockInformation>();
        }
        catch (Exception stockException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "shop_stock_unreadable",
                $"shop={target.ShopId};native_exception={stockException.GetType().Name}");
        }

        ISalable? offer = stock.Keys.FirstOrDefault(item =>
            string.Equals(item.QualifiedItemId, expectedItemId, StringComparison.Ordinal));
        if (offer is null)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "item_not_sold_here",
                $"shop={target.ShopId};item={expectedItemId};stock={stock.Count}");
        }

        int unitPrice = offer.salePrice();
        long affordable = actor.Money / Math.Max(1, unitPrice);
        int purchasable = (int)Math.Min(Math.Min(quantity, stock[offer].Stock), affordable);
        if (affordable < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "insufficient_money",
                $"shop={target.ShopId};item={expectedItemId};price={unitPrice};money={actor.Money}");
        }
        if (purchasable < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "out_of_stock",
                $"shop={target.ShopId};item={expectedItemId};stock={stock[offer].Stock}");
        }

        long moneyBefore = actor.Money;
        int ownedBefore = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);
        int stockBefore = stock[offer].Stock;

        // The transaction is the game's. TryOpenShopMenu builds the real ShopMenu from the
        // same content data; the purchase is then dispatched through the menu's own click
        // handler over its public forSaleButtons, so pricing, currency, stock decrement and
        // inventory insertion all run inside native code.
        ShopMenu? menu = null;
        try
        {
            // A tile-opened shop needs no owner name: the game documents a null owner as
            // "open the shop with no NPC portrait/dialogue" (Utility.cs:4174) and each fixed
            // selector's native case calls it that way. The suppression states the game's
            // own contract, and naming the argument also selects the string overload.
            bool shopOpened = !tileOpened
                ? Utility.TryOpenShopMenu(target.ShopId, target.OwnerName)
                : counterIsOpenShop
                    ? Utility.TryOpenShopMenu(target.ShopId, location, ownerArea: null, maxOwnerY: null, forceOpen: true)
                    : Utility.TryOpenShopMenu(shopId: target.ShopId, ownerName: null!);
            if (!shopOpened)
            {
                // The location overload's closed-message path mounts the game's own
                // DialogueBox before returning false. Leaving it mounted would make every
                // later action reject as modal_open, so it is closed with the public step
                // the native input paths use and its text goes into the refusal instead.
                string tileClosedMessage = Game1.activeClickableMenu is DialogueBox closedBox
                    ? string.Join(" | ", closedBox.dialogues)
                    : string.Empty;
                if (Game1.activeClickableMenu is DialogueBox)
                    ((DialogueBox)Game1.activeClickableMenu).closeDialogue();
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_open_refused",
                    $"shop={target.ShopId};owner={target.OwnerName};counter={target.OwnerTileX},{target.OwnerTileY}"
                        + (string.IsNullOrEmpty(tileClosedMessage) ? string.Empty : $";closed_message={tileClosedMessage}")
                        + (string.IsNullOrWhiteSpace(GameStateQueryClosedMessageFor(target.ShopId, target.OwnerName)) ? string.Empty : $";closed_message={GameStateQueryClosedMessageFor(target.ShopId, target.OwnerName)}"));
            }

            if (Game1.activeClickableMenu is not ShopMenu opened)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Uncertain,
                    "shop_menu_unavailable",
                    $"shop={target.ShopId};menu={Game1.activeClickableMenu?.GetType().Name ?? "none"}");
            }
            menu = opened;

            // Match by wire identity, NOT by object reference: GetShopStock builds its own
            // items, so the instance that was priced is never the instance the menu holds.
            // IndexOf would therefore always miss (measured live: shop_offer_not_purchasable).
            //
            // The result is a BUTTON index, not a sale index. The game resolves a clicked
            // button k as forSale[currentItemIndex + k] (ShopMenu.cs:1096-1102), so returning
            // the raw sale index happens to work only while the view is scrolled to the top.
            // Translating here keeps the coordinate and the item in agreement at any scroll.
            int FindOfferIndex(ShopMenu shop)
            {
                int saleIndex = shop.forSale.FindIndex(candidate => string.Equals(
                    candidate?.QualifiedItemId, expectedItemId, StringComparison.Ordinal));
                if (saleIndex < 0)
                    return -1;
                int buttonIndex = saleIndex - shop.currentItemIndex;
                // Scrolled past it: the native click handler cannot reach an off-screen row.
                return buttonIndex >= 0 && buttonIndex < shop.forSaleButtons.Count ? buttonIndex : -1;
            }

            int buttonIndex = FindOfferIndex(menu);
            if (buttonIndex < 0 || buttonIndex >= menu.forSaleButtons.Count)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_offer_not_purchasable",
                    $"shop={target.ShopId};item={expectedItemId};button={buttonIndex};offers={menu.forSale.Count}");
            }

            // One native click per unit; the game decrements stock and moves money itself.
            // The menu's own anti-misclick delay must not swallow a programmatic click.
            //
            // ShopMenu.receiveLeftClick only reaches its purchase branch when
            // `safetyTimer <= 0` (ShopMenu.cs:1022); the field STARTS at 250
            // (ShopMenu.cs:264) and is decremented by the menu's own update
            // (ShopMenu.cs:1751). A click issued in the same frame the menu opened is
            // therefore silently ignored — measured live: money unchanged and inventory
            // unchanged (purchase_not_effective) despite a perfectly valid offer.
            //
            // 250 ms guards against a human double-tapping the mouse. Waiting it out would
            // only make a scripted purchase slower without changing any outcome, so the
            // guard is cleared explicitly instead of simulated. It is a UI flap counter,
            // not world state: no game fact depends on it.
            menu.safetyTimer = 0;

            for (int bought = 0; bought < purchasable; bought++)
            {
                if (Game1.activeClickableMenu is not ShopMenu stillOpen || !ReferenceEquals(stillOpen, menu))
                    break;

                int index = FindOfferIndex(menu);
                if (index < 0 || index >= menu.forSaleButtons.Count)
                    break;

                ClickableComponent button = menu.forSaleButtons[index];
                // Record the state the native handler will read, and what it did, instead of
                // guessing which gate refused. These are all public members.
                long moneyBeforeClick = actor.Money;
                int stockBeforeClick = stock.TryGetValue(offer, out ItemStockInformation? s0) && s0 is not null ? s0.Stock : -1;
                int safetyBefore = menu.safetyTimer;
                bool heldNull = menu.heldItem is null;
                int clickX = button.bounds.Center.X;
                int clickY = button.bounds.Center.Y;
                bool addressedToButton = button.containsPoint(clickX, clickY);

                // The native click handler, at the native click coordinates.
                menu.receiveLeftClick(clickX, clickY, playSound: true);

                // The purchase leaves the item ON THE CURSOR, not in the inventory:
                // tryToPurchaseItem assigns heldItem = item.GetSalableInstance()
                // (ShopMenu.cs:1352) and only clears it for items with
                // actionWhenPurchased (:1369-1378). A real player then clicks an empty
                // inventory slot to put it away; a scripted purchase must do the same or
                // the money moves and the goods never arrive. Measured live: money 500->480
                // with owned_before = owned_after = 0, i.e. purchase_partial.
                //
                // receiveLeftClick routes coordinates inside the inventory to
                // inventory.leftClick (ShopMenu.cs:1094), which is the native drop.
                string heldBeforeDrop = menu.heldItem?.QualifiedItemId ?? "none";
                int emptySlotIndex = -1;
                string dropAt = "none";
                if (menu.heldItem is not null)
                {
                    List<ClickableComponent>? slots = menu.inventory?.inventory;
                    IList<Item>? actual = menu.inventory?.actualInventory;
                    if (slots is not null && actual is not null)
                    {
                        for (int slotIndex = 0; slotIndex < slots.Count && slotIndex < actual.Count; slotIndex++)
                        {
                            // Read the ITEM LIST, not ClickableComponent.item. The menu builds its
                            // slots as `new ClickableComponent(bounds, j.ToString())`
                            // (InventoryMenu.cs:103) — the string overload — and never assigns
                            // `.item`, so `slot.item` is ALWAYS null. Selecting on it picked slot 0
                            // every time; when slot 0 holds a tool, InventoryMenu.leftClick refuses
                            // (InventoryMenu.cs:318 `actualInventory[num] != null && !canStackWith`)
                            // and returns the held item unchanged. Measured live:
                            // `drops=1[drop0:empty_slot=0;at=412,544;held=(O)472->(O)472]`.
                            if (actual[slotIndex] is null && slots[slotIndex] is { bounds.Width: > 0 })
                            {
                                emptySlotIndex = slotIndex;
                                dropAt = $"{slots[slotIndex].bounds.Center.X},{slots[slotIndex].bounds.Center.Y}";
                                break;
                            }
                        }
                    }
                    if (emptySlotIndex >= 0)
                    {
                        // The native drop: ShopMenu.receiveLeftClick routes coordinates that
                        // land in the inventory to inventory.leftClick with the held item
                        // (ShopMenu.cs:1094), which is the game's own placement step.
                        menu.receiveLeftClick(
                            slots![emptySlotIndex].bounds.Center.X,
                            slots![emptySlotIndex].bounds.Center.Y,
                            playSound: true);
                    }
                }
                string heldAfterDrop = menu.heldItem?.QualifiedItemId ?? "none";
                dropDiagnostics.Add(
                    $"drop{bought}:empty_slot={emptySlotIndex};at={dropAt};held={heldBeforeDrop}->{heldAfterDrop}");

                long moneyAfterClick = actor.Money;
                int stockAfterClick = stock.TryGetValue(offer, out ItemStockInformation? s1) && s1 is not null ? s1.Stock : -1;
                clickDiagnostics.Add(
                    $"click{bought}:button={index};at={clickX},{clickY};addressed={addressedToButton};"
                    + $"safety_before={safetyBefore};held_null={heldNull};"
                    + $"money={moneyBeforeClick}->{moneyAfterClick};stock={stockBeforeClick}->{stockAfterClick};"
                    + $"held_after={menu.heldItem?.QualifiedItemId ?? "none"}");
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "shop_purchase_native_exception",
                $"shop={target.ShopId};item={expectedItemId};native_exception={nativeException.GetType().Name}");
        }

        // Close whatever is still open, using the native step (Game1.exitActiveMenu is what
        // ShopMenu's own exit path calls), so the body is free for the next action.
        if (Game1.activeClickableMenu is ShopMenu)
        {
            try
            {
                Game1.exitActiveMenu();
            }
            catch (Exception)
            {
                // Reported as part of the receipt below via the leftover-menu fact.
            }
        }

        long moneyAfter = actor.Money;
        int ownedAfter = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);
        int gained = ownedAfter - ownedBefore;
        bool menuClosed = Game1.activeClickableMenu is not ShopMenu;

        string entryKind = tileOpened ? "tile_action" : "npc_owner";
        string evidence =
            $"shop={target.ShopId};owner={target.OwnerName};entry={entryKind};item={expectedItemId};"
            + $"requested={quantity};purchased={purchasable};unit_price={unitPrice};"
            + $"money_before={moneyBefore};money_after={moneyAfter};"
            + $"owned_before={ownedBefore};owned_after={ownedAfter};gained={gained};"
            + $"stock_before={stockBefore};stock_after={(menu is not null && stock.TryGetValue(offer, out ItemStockInformation? after) && after is not null ? after.Stock : -1)};"
            + $"owner_tile={target.OwnerTileX},{target.OwnerTileY};menu_closed={menuClosed.ToString().ToLowerInvariant()};"
            + $"clicks={clickDiagnostics.Count}[{string.Join("|", clickDiagnostics)}];"
            + $"drops={dropDiagnostics.Count}[{string.Join("|", dropDiagnostics)}]";

        // Success is the world fact: money left the purse AND the item entered the inventory.
        // A receipt that spent nothing and gained nothing is not a purchase.
        if (moneyAfter < moneyBefore && gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "item_purchased", evidence, this.TryCreateLocalObservation(actor));

        if (moneyAfter < moneyBefore || gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Uncertain, "purchase_partial", evidence);

        return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Failed, "purchase_not_effective", evidence);
    }
}
