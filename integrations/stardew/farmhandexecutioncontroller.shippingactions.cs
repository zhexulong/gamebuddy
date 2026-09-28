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

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is not (Farm or StardewValley.Locations.IslandWest))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (ResolveShippingBin(Game1.player) is not ResolvedShippingBin bin)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_unavailable", $"location={Game1.player.currentLocation.NameOrUniqueName}");
        if (!string.Equals(bin.TargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_target_changed", $"target={targetX},{targetY};expected={expectedTargetId}");
        // W-rule: the actor must stand next to the bin's actual footprint; the
        // client-supplied tile is only a stale-planning hint and never the
        // authority for the native call. Farm's building and IslandWest's island
        // bin both resolve to an origin-plus-extent footprint, so one rule is
        // enough for either location.
        if (ShippingBinChebyshevDistance(Game1.player, bin) > 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"bin={bin.TileX},{bin.TileY};player={FormatTile(Game1.player.Tile)}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Item slotItem || slotItem.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(slotItem.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");
        // Closed admission guard against permanent item destruction: the native
        // seam accepts any Item, but only shipped Objects are priced at the next
        // new day; a Tool would settle for 0g and be cleared with the bin.
        if (slotItem is not StardewValley.Object shippable || !shippable.canBeShipped())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_shippable", $"item={expectedQualifiedItemId};slot={slot}");

        StardewValley.Inventories.IInventory binInventory = Game1.getFarm().getShippingBin(Game1.player);
        int stackShipped = shippable.Stack;
        int binCountBefore = ShippingBinItemCount(binInventory, expectedQualifiedItemId);
        int inventoryCountBefore = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        // The one native call: Farm.shipItem performs the inventory release, the
        // shipping-bin write, the native shipment animation and
        // lastItemShipped in the same order the game's own UI callback does.
        Game1.getFarm().shipItem(shippable, Game1.player);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int binCountAfter = ShippingBinItemCount(binInventory, expectedQualifiedItemId);
        int inventoryCountAfter = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool sourceReleased = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], shippable);
        bool lastItemShippedMatches = ReferenceEquals(Game1.getFarm().lastItemShipped, shippable);
        bool succeeded = sourceReleased
            && inventoryCountAfter == inventoryCountBefore - stackShipped
            && binCountAfter == binCountBefore + stackShipped
            && lastItemShippedMatches;
        string evidence = $"location={bin.LocationName};target={expectedTargetId};bin={bin.TileX},{bin.TileY};tile={targetX},{targetY};item={expectedQualifiedItemId};slot={slot};stack={stackShipped};inventory_before={inventoryCountBefore};inventory_after={inventoryCountAfter};bin_before={binCountBefore};bin_after={binCountAfter};last_item_shipped_matched={lastItemShippedMatches.ToString().ToLowerInvariant()};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
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

    /// <summary>
    /// A resolved shipping bin the actor may hand an item to. Farm's Shipping Bin
    /// building and IslandWest's island bin are different native entry points over
    /// the SAME <c>farm.getShippingBin(who)</c> inventory (IslandWest.cs:244 writes
    /// <c>Game1.getFarm()</c>'s bin, and IslandWest.checkAction hands
    /// <c>Game1.getFarm().shipItem</c> to ItemGrabMenu at IslandWest.cs:313), so
    /// only resolution and the opaque identity differ between them. The tile is
    /// the footprint's origin and the extent always grows +x/+y.
    /// </summary>
    private readonly record struct ResolvedShippingBin(string TargetId, int TileX, int TileY, int TilesWide, int TilesHigh, string LocationName);

    /// <summary>
    /// Resolve the bin <paramref name="actor"/> may use, or null when this location
    /// offers none. Farm keeps its exact previous behaviour. IslandWest is admitted
    /// only after the island house upgrade, matching the native guard both of its
    /// input paths carry (IslandWest.cs:237, :311).
    /// </summary>
    private static ResolvedShippingBin? ResolveShippingBin(Farmer actor)
    {
        if (actor.currentLocation is Farm farm)
        {
            if (FindShippingBinBuilding(farm) is not StardewValley.Buildings.ShippingBin farmBin || farmBin.daysOfConstructionLeft.Value > 0)
                return null;
            return new ResolvedShippingBin(
                BuildShippingBinTargetId(farm, farmBin),
                farmBin.tileX.Value,
                farmBin.tileY.Value,
                Math.Max(1, farmBin.tilesWide.Value),
                Math.Max(1, farmBin.tilesHigh.Value),
                farm.NameOrUniqueName);
        }
        if (actor.currentLocation is StardewValley.Locations.IslandWest island && island.farmhouseRestored.Value)
        {
            Microsoft.Xna.Framework.Point position = island.shippingBinPosition;
            // The native bin footprint is x in [X, X+1] and y in [Y-1, Y]
            // (IslandWest.cs:241 pixel bounds and IslandWest.cs:311 tile bounds),
            // whose origin is (X, Y-1) with a 2x2 extent.
            return new ResolvedShippingBin(
                BuildIslandShippingBinTargetId(island),
                position.X,
                position.Y - 1,
                2,
                2,
                island.NameOrUniqueName);
        }
        return null;
    }

    /// <summary>
    /// Opaque island bin identity. The published id namespace itself carries the
    /// location, so an island target and a Farm target are separated by
    /// construction rather than by the chance of two truncated hashes differing:
    /// the Farm ids are always prefixed `shipping_bin_` and these always
    /// `shipping_bin_island_`, so the two sets can never intersect even if both
    /// locations somehow produced the same coordinate string.
    /// </summary>
    private static string BuildIslandShippingBinTargetId(StardewValley.Locations.IslandWest island)
    {
        Microsoft.Xna.Framework.Point position = island.shippingBinPosition;
        string raw = $"{island.NameOrUniqueName}:{position.X},{position.Y}:island_west_bin";
        return $"shipping_bin_island_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static int ShippingBinChebyshevDistance(Farmer player, ResolvedShippingBin bin)
    {
        int best = int.MaxValue;
        for (int offsetX = 0; offsetX < bin.TilesWide; offsetX++)
        {
            for (int offsetY = 0; offsetY < bin.TilesHigh; offsetY++)
                best = Math.Min(best, ChebyshevDistance(player, bin.TileX + offsetX, bin.TileY + offsetY));
        }
        return best;
    }

    private static int ShippingBinItemCount(StardewValley.Inventories.IInventory binInventory, string qualifiedItemId) =>
        binInventory.Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);

    /// <summary>
    /// Advertise one shippable backpack slot per shipping bin. The slot identifies
    /// the exact item the actor would hand to <c>Farm.shipItem</c>; the bin tile
    /// is where the actor must stand next to. Both bins the actor can reach -- the
    /// Farm's Shipping Bin building and, after the island house upgrade,
    /// IslandWest's island bin -- go through the same resolver, so discovery can
    /// never offer a bin the execution would refuse. Only items that pass the same
    /// <c>canBeShipped</c> admission the execution redeems are advertised.
    /// </summary>
    private IReadOnlyList<BridgeShippingBinTarget> DiscoverShippingBinTargets(Farmer player)
    {
        if (player.currentLocation is not (Farm or StardewValley.Locations.IslandWest)) return Array.Empty<BridgeShippingBinTarget>();
        if (ResolveShippingBin(player) is not ResolvedShippingBin bin) return Array.Empty<BridgeShippingBinTarget>();
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
                bin.TargetId,
                bin.TileX,
                bin.TileY,
                slot,
                shippable.QualifiedItemId,
                RequireDisplayName(shippable.QualifiedItemId),
                shippable.Stack),
        };
    }
}
