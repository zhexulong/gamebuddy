using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

// Lane E: ship_item over the native shipping-bin seam.
//
// Seam decision (Step 1, recorded in
// design/tasks/active/loop-closure-lane-e-ship-item-seam-decision.md):
//
// - Candidate: `Farm.shipItem(Item i, Farmer who)` (Farm.cs:1034). It is the
//   native wrapped entry and the exact delegate the game itself hands to
//   ItemGrabMenu (`ShippingBin.doAction` -> `shipItem`, ShippingBin.cs:256;
//   `IslandWest.checkAction` -> `Game1.getFarm().shipItem`, IslandWest.cs:295):
//   it performs `who.removeItemFromInventory(i)` -> `getShippingBin(who).Add(i)`
//   -> `showShipment(obj, playThrowSound: false)` -> `lastItemShipped = i`, and
//   `getShippingBin` itself picks the personal vs shared bin from the live
//   `useSeparateWallets` flag (Farm.cs:1025-1051).
//   It differs from `ShippingBin.shipItem` (ShippingBin.cs:157, private,
//   building-level): that one needs a cached `farm` field, silently skips the
//   bin write when `farm` is null, and never calls `showNotCarrying`/`Halt`.
//
// - Night settlement is native, not Mod-authored. The shipped item only ever
//   enters the native shipping-bin inventory; the authoritative settlement is
//   Game1's new-day sequence: `Game1._newDayAfterFade` (Game1.cs:7320) reads
//   `getFarm().getShippingBin(player)` (Game1.cs:7601), calls
//   `obj.sellToStorePrice(-1L) * obj.Stack` and `player.Money += total`
//   (Game1.cs:7609-7627), then clears the bin through
//   `getFarm().lastItemShipped = null; getFarm().getShippingBin(player).Clear()`
//   (Game1.cs:7752-7753). `Farm.DayUpdate` (Farm.cs:340) resets
//   `lastItemShipped` for the location day update (Farm.cs:351) but does no
//   money math. The Mod writes no money, no bin contents and no settlement
//   state.
//
// - Mandatory fail-closed admission: `Farm.shipItem` does NOT validate
//   shippability. Handing it a Tool ships the tool, settles for 0g at the next
//   new day and clears the bin (Game1.cs:7609-7627 only prices `Object`s), so
//   the tool is destroyed permanently. The body therefore asserts
//   `item is StardewValley.Object obj && obj.canBeShipped()`
//   (Object.cs:1566-1573) before the single native call.
//
// - Falsified candidates: `DropBox` tile action (GameLocation.cs:9492 is
//   SpecialOrders plus an ItemGrabMenu), `ShippingBin.leftClicked`
//   (Building.cs:894 base returns false; the only caller is the pixel-input
//   path GameLocation.cs:7894), `ShippingBin.doAction` (requires
//   `Game1.didPlayerJustRightClick` and mounts ItemGrabMenu, ShippingBin.cs:248-261).
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalShipItem(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is not Farm farm)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (FindShippingBinBuilding(farm) is not StardewValley.Buildings.ShippingBin bin || bin.daysOfConstructionLeft.Value > 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_unavailable", $"location={farm.NameOrUniqueName}");
        if (!string.Equals(BuildShippingBinTargetId(farm, bin), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_target_changed", $"target={targetX},{targetY};expected={expectedTargetId}");
        // W-rule: the actor must stand next to the bin's actual footprint; the
        // client-supplied tile is only a stale-planning hint and never the
        // authority for the native call.
        if (ShippingBinChebyshevDistance(Game1.player, bin) > 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"bin={bin.tileX.Value},{bin.tileY.Value};player={FormatTile(Game1.player.Tile)}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Item slotItem || slotItem.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(slotItem.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");
        // Closed admission guard against permanent item destruction: the native
        // seam accepts any Item, but only shipped Objects are priced at the next
        // new day; a Tool would settle for 0g and be cleared with the bin.
        if (slotItem is not StardewValley.Object shippable || !shippable.canBeShipped())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_shippable", $"item={expectedQualifiedItemId};slot={slot}");

        StardewValley.Inventories.IInventory binInventory = farm.getShippingBin(Game1.player);
        int stackShipped = shippable.Stack;
        int binCountBefore = ShippingBinItemCount(binInventory, expectedQualifiedItemId);
        int inventoryCountBefore = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        // The one native call: Farm.shipItem performs the inventory release, the
        // shipping-bin write, the native shipment animation and
        // lastItemShipped in the same order the game's own UI callback does.
        farm.shipItem(shippable, Game1.player);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int binCountAfter = ShippingBinItemCount(binInventory, expectedQualifiedItemId);
        int inventoryCountAfter = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool sourceReleased = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], shippable);
        bool lastItemShippedMatches = ReferenceEquals(farm.lastItemShipped, shippable);
        bool succeeded = sourceReleased
            && inventoryCountAfter == inventoryCountBefore - stackShipped
            && binCountAfter == binCountBefore + stackShipped
            && lastItemShippedMatches;
        string evidence = $"location={farm.NameOrUniqueName};target={expectedTargetId};bin={bin.tileX.Value},{bin.tileY.Value};tile={targetX},{targetY};item={expectedQualifiedItemId};slot={slot};stack={stackShipped};inventory_before={inventoryCountBefore};inventory_after={inventoryCountAfter};bin_before={binCountBefore};bin_after={binCountAfter};last_item_shipped_matched={lastItemShippedMatches.ToString().ToLowerInvariant()};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "item_shipped" : "item_shipped_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Planning-visible native shipping bin of the current Farm. Exactly one
    /// "Shipping Bin" building exists per farm (Farm.cs:173 AddDefaultBuilding);
    /// MiniShippingBin is a Chest, not a building, so it can never be selected
    /// here.
    /// </summary>
    private static StardewValley.Buildings.ShippingBin? FindShippingBinBuilding(Farm farm) =>
        farm.buildings.OfType<StardewValley.Buildings.ShippingBin>().FirstOrDefault();

    private static string BuildShippingBinTargetId(Farm farm, StardewValley.Buildings.ShippingBin bin)
    {
        string raw = $"{farm.NameOrUniqueName}:{bin.tileX.Value},{bin.tileY.Value}:shipping_bin:{bin.tilesWide.Value}x{bin.tilesHigh.Value}";
        return $"shipping_bin_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static int ShippingBinChebyshevDistance(Farmer player, StardewValley.Buildings.ShippingBin bin)
    {
        int best = int.MaxValue;
        for (int offsetX = 0; offsetX < Math.Max(1, bin.tilesWide.Value); offsetX++)
        {
            for (int offsetY = 0; offsetY < Math.Max(1, bin.tilesHigh.Value); offsetY++)
                best = Math.Min(best, ChebyshevDistance(player, bin.tileX.Value + offsetX, bin.tileY.Value + offsetY));
        }
        return best;
    }

    private static int ShippingBinItemCount(StardewValley.Inventories.IInventory binInventory, string qualifiedItemId) =>
        binInventory.Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);

    /// <summary>
    /// Advertise one shippable backpack slot per shipping bin. The slot identifies
    /// the exact item the actor would hand to <c>Farm.shipItem</c>; the bin tile
    /// is where the actor must stand next to. Only items that pass the same
    /// <c>canBeShipped</c> admission the execution redeems are advertised.
    /// </summary>
    private IReadOnlyList<BridgeShippingBinTarget> DiscoverShippingBinTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeShippingBinTarget>();
        if (FindShippingBinBuilding(farm) is not StardewValley.Buildings.ShippingBin bin || bin.daysOfConstructionLeft.Value > 0)
            return Array.Empty<BridgeShippingBinTarget>();
        int slot = -1;
        for (int candidate = 0; candidate < player.Items.Count; candidate++)
        {
            if (player.Items[candidate] is StardewValley.Object item && item.Stack > 0 && item.canBeShipped())
            {
                slot = candidate;
                break;
            }
        }
        if (slot < 0) return Array.Empty<BridgeShippingBinTarget>();
        StardewValley.Object shippable = (StardewValley.Object)player.Items[slot]!;
        return new[]
        {
            new BridgeShippingBinTarget(
                BuildShippingBinTargetId(farm, bin),
                bin.tileX.Value,
                bin.tileY.Value,
                slot,
                shippable.QualifiedItemId,
                RequireDisplayName(shippable.QualifiedItemId),
                shippable.Stack),
        };
    }
}
