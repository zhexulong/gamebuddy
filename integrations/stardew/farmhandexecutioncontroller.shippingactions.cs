using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

// Lane E: ship_item over the native shipping-bin seam.
//
// Seam decision (Step 1, recorded in
// design/tasks/active/loop-closure-lane-e-ship-item-seam-decision.md):
//
// - Candidate: `Farm.shipItem(Item i, Farmer who)` (`StardewValley/Farm.cs:1033`). It is the
//   native wrapped entry and the exact delegate the game itself hands to
//   ItemGrabMenu (`ShippingBin.doAction` -> `shipItem`, `StardewValley.Buildings/ShippingBin.cs:259`;
//   `IslandWest.checkAction` -> `Game1.getFarm().shipItem`, `StardewValley.Locations/IslandWest.cs:313`):
//   it performs `who.removeItemFromInventory(i)` -> `getShippingBin(who).Add(i)`
//   -> `showShipment(obj, playThrowSound: false)` -> `lastItemShipped = i`, and
//   `getShippingBin` itself picks the personal vs shared bin from the live
//   `useSeparateWallets` flag (`StardewValley/Farm.cs:1025-1051`).
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
    public LocalExecutionReceipt RequestLocalShipItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is not (Farm or StardewValley.Locations.IslandWest))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required",
                $"location={(Game1.player?.currentLocation?.NameOrUniqueName ?? "none")}");
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (ResolveShippingBin(Game1.player) is not ResolvedShippingBin bin)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_unavailable", $"location={Game1.player.currentLocation.NameOrUniqueName}");
        if (!string.Equals(bin.TargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_target_changed", $"target={targetX},{targetY};expected={expectedTargetId}");
        if (FindCarriedShippableSlot(expectedQualifiedItemId, out StardewValley.Object? carried) < 0 || carried is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"item={expectedQualifiedItemId};carried=none");
        if (!carried.canBeShipped())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_shippable", $"item={expectedQualifiedItemId}");
        if (ShippingBinChebyshevDistance(Game1.player, bin) > 1)
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "ship_item",
                Game1.player.currentLocation,
                (bin.TileX, bin.TileY),
                ShippingBinFootprintTiles(bin),
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteShipItem(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteShipItem(executionId, requestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteShipItem(string executionId, string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        if (Game1.player.currentLocation is not (Farm or StardewValley.Locations.IslandWest))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required",
                $"location={Game1.player.currentLocation.NameOrUniqueName}");
        if (ResolveShippingBin(Game1.player) is not ResolvedShippingBin bin)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_unavailable", $"location={Game1.player.currentLocation.NameOrUniqueName}");
        if (!string.Equals(bin.TargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shipping_bin_target_changed", $"target={targetX},{targetY};expected={expectedTargetId};actual={bin.TargetId}");
        int slot = FindCarriedShippableSlot(expectedQualifiedItemId, out StardewValley.Object? carried);
        if (slot < 0 || carried is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"item={expectedQualifiedItemId};carried=none");
        if (!carried.canBeShipped())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_shippable", $"item={expectedQualifiedItemId}");
        StardewValley.Object shippable = carried;
        if (ShippingBinChebyshevDistance(Game1.player, bin) > 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"bin={bin.TileX},{bin.TileY};footprint_tiles={ShippingBinFootprintTiles(bin).Length};player={FormatTile(Game1.player.Tile)};approach=arrived");

        StardewValley.Inventories.IInventory binInventory = Game1.getFarm().getShippingBin(Game1.player);
        int stackShipped = shippable.Stack;
        int binCountBefore = ShippingBinItemCount(binInventory, expectedQualifiedItemId);
        int inventoryCountBefore = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
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
        return this.SettlePostcondition(requestId, executionId, succeeded, "item_shipped", "item_shipped_postcondition_unavailable", evidence);
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
    internal readonly record struct ResolvedShippingBin(string TargetId, int TileX, int TileY, int TilesWide, int TilesHigh, string LocationName);

    /// <summary>
    /// Resolve the bin <paramref name="actor"/> may use, or null when this location
    /// offers none. Farm keeps its exact previous behaviour. IslandWest is admitted
    /// only after the island house upgrade, matching the native guard both of its
    /// input paths carry (IslandWest.cs:237, :311).
    /// </summary>
    internal static ResolvedShippingBin? ResolveShippingBin(Farmer actor)
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

    private static string BuildIslandShippingBinTargetId(StardewValley.Locations.IslandWest island)
    {
        Microsoft.Xna.Framework.Point position = island.shippingBinPosition;
        string raw = $"{island.NameOrUniqueName}:{position.X},{position.Y}:island_west_bin";
        return $"shipping_bin_island_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static (int X, int Y)[] ShippingBinFootprintTiles(ResolvedShippingBin bin)
    {
        return new FootprintRect(bin.TileX, bin.TileY, bin.TilesWide, bin.TilesHigh)
            .Tiles()
            .Select(tile => (tile.X, tile.Y))
            .ToArray();
    }

    private static int ShippingBinChebyshevDistance(Farmer player, ResolvedShippingBin bin)
    {
        int best = int.MaxValue;
        foreach ((int X, int Y) tile in ShippingBinFootprintTiles(bin))
            best = Math.Min(best, ChebyshevDistance(player, tile.X, tile.Y));
        return best;
    }

    private static int ShippingBinItemCount(StardewValley.Inventories.IInventory binInventory, string qualifiedItemId) =>
        binInventory.Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);

    /// <summary>
    /// The first carried stack of one item id that could actually ship, and its slot - the same rule
    /// <c>chest_store</c> uses on the pack side, asked once for both the pre-walk admission and the arrival re-read.
    ///
    /// <para>
    /// A slot is PERCEPTION, not intent. Walking to a shipping bin takes tens of ticks, and a magnet pickup or a
    /// stack merge on the way shifts every slot behind the one that changed - so a request that closed over a slot
    /// would hand the native <c>Farm.shipItem</c> whatever now sits there. The item id is the intent; the slot is
    /// re-derived from the live pack at the moment of the native call, and the receipt names which one moved.
    /// </para>
    /// <para>
    /// Only a <c>StardewValley.Object</c> can ship: the native seam accepts any <c>Item</c>, but only shipped Objects
    /// are priced at the next new day (<c>Game1._newDayAfterFade</c> prices `Object`s), so a Tool would settle for 0g
    /// and be cleared with the bin. That is why the predicate is narrower here than <c>chest_store</c>'s.
    /// </para>
    /// </summary>
    private static int FindCarriedShippableSlot(string qualifiedItemId, out StardewValley.Object? item)
    {
        for (int index = 0; index < Game1.player.Items.Count; index++)
        {
            if (Game1.player.Items[index] is not StardewValley.Object candidate || candidate.Stack <= 0)
                continue;
            if (!string.Equals(candidate.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                continue;
            item = candidate;
            return index;
        }
        item = null;
        return -1;
    }

}
