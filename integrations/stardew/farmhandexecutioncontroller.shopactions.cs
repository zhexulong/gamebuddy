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
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// <summary>The native interaction radius for a shop owner (Chebyshev, Utility.cs:4100).</summary>
    private const int ShopOwnerInteractionRadius = 1;

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

                int stockCount = 0;
                try
                {
                    stockCount = ShopBuilder.GetShopStock(shopId, shopData)?.Count ?? 0;
                }
                catch (Exception)
                {
                    stockCount = 0;
                }

                targets.Add(new BridgeShopTarget(
                    ShopTargetId(shopId, owner.Name),
                    shopId,
                    owner.Name,
                    location.NameOrUniqueName,
                    npc.TilePoint.X,
                    npc.TilePoint.Y,
                    inReach,
                    owner.ClosedMessage,
                    stockCount));
            }
        }
        return targets;
    }

    public LocalExecutionReceipt RequestLocalShopPurchase(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out _) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

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
                    + (string.IsNullOrWhiteSpace(target.ClosedMessage) ? string.Empty : $";closed_message={target.ClosedMessage}"));
        }

        // The stock the game would actually offer right now.
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
            if (!Utility.TryOpenShopMenu(target.ShopId, target.OwnerName))
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_open_refused",
                    $"shop={target.ShopId};owner={target.OwnerName}"
                        + (string.IsNullOrWhiteSpace(target.ClosedMessage) ? string.Empty : $";closed_message={target.ClosedMessage}"));
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

            int buttonIndex = menu.forSale.IndexOf(offer);
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
            for (int bought = 0; bought < purchasable; bought++)
            {
                if (Game1.activeClickableMenu is not ShopMenu stillOpen || !ReferenceEquals(stillOpen, menu))
                    break;

                int index = menu.forSale.IndexOf(offer);
                if (index < 0 || index >= menu.forSaleButtons.Count)
                    break;

                ClickableComponent button = menu.forSaleButtons[index];
                // The native click handler; playSound defaults to true as it does for a real click.
                menu.receiveLeftClick(button.bounds.Center.X, button.bounds.Center.Y, playSound: true);
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

        string evidence =
            $"shop={target.ShopId};owner={target.OwnerName};item={expectedItemId};"
            + $"requested={quantity};purchased={purchasable};unit_price={unitPrice};"
            + $"money_before={moneyBefore};money_after={moneyAfter};"
            + $"owned_before={ownedBefore};owned_after={ownedAfter};gained={gained};"
            + $"stock_before={stockBefore};stock_after={(menu is not null && stock.TryGetValue(offer, out ItemStockInformation? after) && after is not null ? after.Stock : -1)};"
            + $"owner_tile={target.OwnerTileX},{target.OwnerTileY};menu_closed={menuClosed.ToString().ToLowerInvariant()}";

        // Success is the world fact: money left the purse AND the item entered the inventory.
        // A receipt that spent nothing and gained nothing is not a purchase.
        if (moneyAfter < moneyBefore && gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "item_purchased", evidence, this.TryCreateLocalObservation(actor));

        if (moneyAfter < moneyBefore || gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Uncertain, "purchase_partial", evidence);

        return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Failed, "purchase_not_effective", evidence);
    }
}
