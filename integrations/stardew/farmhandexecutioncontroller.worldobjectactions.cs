using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;
using StardewValley.Tools;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// The world-object lane: three actions that all act on an OBJECT occupying a
// WORLD TILE and all take that tile plus the backpack slot that acts on it.
//
//   place_owned_object      Object.placementAction, the bigCraftable/Furniture
//                           branch, for ANY owned placeable object. This absorbs
//                           the proposed `place_tapper`: a tapper is placed on a
//                           tree, which is the same intent with a different
//                           CONSTRAINT, and the constraint is already carried by
//                           the item's own data (Object.canBePlacedHere's tapper
//                           branch), not by a second action.
//   remove_placed_item      Axe/Pickaxe DoFunction plus Object.performRemoveAction.
//   break_container_source  BreakableContainer.performToolAction.
//
// Every native line reference below is the target version's own decompiled source
// (same ilspycmd layout the multiplayer-sensitivity register uses).
//
// THE PLACEMENT SEAM. `Utility.tryToPlaceItem` (Utility.cs:6940-7014) is the native
// ingress a player's placement goes through: it requires
// `Utility.playerCanPlaceItemHere(...)` (:6947), calls
// `item.placementAction(location, x, y, Game1.player)` (:6953) and then
// `Game1.player.reduceActiveItemByOne()` (:6955). `Utility.playerCanPlaceItemHere`
// (Utility.cs:5727-5750) is exactly `isWithinTileWithLeeway` (:5737, the reach
// requirement) && `item.canBePlacedHere(location, tile, CollisionMask.All)` (:5744)
// && `item.isPlaceable()` (:5746). Both halves are reused here rather than
// re-invented, so the action admits exactly what the game would place.
//
// The WRITE is `Object.placementAction` (Object.cs:6194-7065). Its first branch is
// `if (!bigCraftable.Value && !(this is Furniture))` (:6201) — everything else,
// including the whole tapper/seed/floor/torch family, is either that first branch or
// a caller-side special case. The bigCraftable/Furniture branch is :6999-7051: it
// builds a COPY of the placed object (`obj4 = getOne()` :7001), and then either
// replaces a DIFFERENT object already on the tile (`:7025-7032`, dropping the old one
// as debris), appends to `location.furniture` for furniture (:7033-7043), or does
// `location.objects.Add(vector, obj4)` (:7046). Two consequences decide this action's
// contract:
//   * the placed instance is NOT the inventory instance, so the postcondition can never
//     be a ReferenceEquals — it is "an object with the expected qualified item id now
//     occupies that tile", re-read from the world;
//   * the same-item-id-on-the-same-tile case adds NOTHING and still returns true
//     (:7025-7031 `if (value10.QualifiedItemId != base.QualifiedItemId)`), so an
//     occupied tile is refused by name (`place_owned_object_tile_occupied`) instead of
//     being able to report a success the native call never produced.
//
// Tapppers take the SAME branch (a tapper is a bigCraftable): the tapper write is
// :6566-6584 — `IsTapper()` -> `location.objects.Add(vector, obj)` (:6576),
// `tree3.tapped.Value = true` (:6577), `tree3.UpdateTapperProduct(obj)` (:6578). The
// tapper's placement CONSTRAINT is read from the game's own data too: the placement
// target's tile must satisfy `Object.canBePlacedHere` (Object.cs:5737-5750), whose
// tapper branch (:5747) requires a live Tree whose `GetData().CanBeTapped()` is true
// and an empty object slot. Nothing in this file enumerates item ids: whatever
// `Data/BigCraftables` (or a mod) declares as a placeable object works.
//
// THE REMOVAL SEAM. `Axe.DoFunction` (Axe.cs:63-97) reaches the object removal at
// :87-95 — `location.Objects.TryGetValue(key, out value2) && value2.Type != null &&
// value2.performToolAction(this)` then `value2.performRemoveAction()` (:93) and
// `location.Objects.Remove(key)` (:94). `Pickaxe.DoFunction` (Pickaxe.cs:82-260)
// reaches it at :236-244 — `value.performToolAction(this)` then
// `value.performRemoveAction()` (:238) and `Game1.currentLocation.Objects.Remove(vector)`
// (:243). The swing itself is the same one native ingress every tool action uses
// (`Game1.cs:11691-11695` calls `player.CurrentTool.DoFunction(...)`), which
// `UseNativeToolOnTile` already mirrors for this Mod.
//
// The question "does THIS tool remove THIS object" is answered by
// `Object.performToolAction(Tool t)` (Object.cs:1092-1443), and the answer is
// deliberately NOT guessed here: its guards are `if (fragility.Value == 2) return false`
// (:1346-1349), `Type == "Crafting" && !(t is MeleeWeapon) && t.isHeavyHitter()`
// (:1350-1352, the ordinary crafted-object case), `IsTwig() && t is Axe` (:1182-1191),
// `name.Contains("SupplyCrate") && t.isHeavyHitter()` (:1192) and the unregistered
// bigCraftable case `bigCraftable && !(t is MeleeWeapon) && t.isHeavyHitter() &&
// ...IsErrorItem` (:1339-1345). `Tool.isHeavyHitter()` (Tool.cs:427-434) is
// MeleeWeapon || Hoe || Axe || Pickaxe. `TryDescribePlacementObjectRemoval` mirrors
// those guards so a request can be refused BY NAME instead of silently no-opping,
// which is the whole point of the three separated refusals below: the object is not
// removable by any tool, the named tool cannot remove it, or the named slot does not
// hold one of this action's two native seams.
//
// THE BREAK-CONTAINER SEAM. `BreakableContainer.performToolAction(Tool t)`
// (BreakableContainer.cs:111-153) is reached from the same two DoFunction bodies
// (Axe.cs:87, Pickaxe.cs:236). It requires only `t.isHeavyHitter()` (:118), decrements
// its own health once per swing (:120, twice for a type-2 melee weapon :121-124), and
// on `health.Value <= 0` plays its break sound, calls `releaseContents(t.getLastFarmerToUse())`
// (:131) and removes itself from the location (:132) — then returns FALSE (:152). The
// return value therefore proves nothing, exactly as the boundary says: the observable
// postcondition is the container GONE plus the drops it produced, and the drops are
// observed where the game really puts them (`Game1.createObjectDebris` ->
// `location.debris.Add(new Debris(id, ...))`, Game1.cs:10888-10892, whose
// `Debris.itemId` is non-empty for item drops and empty for cosmetic chunks).
//
// POSTCONDITIONS, all OBSERVED after the call and none taken from a native return:
//   place_owned_object      an object with the expected qualified item id occupies the
//                           tile (and the inventory count dropped by exactly one).
//   remove_placed_item      the object is GONE from the tile, and the removed object's
//                           own identity is reported as debris when the native path
//                           dropped it (Axe.cs:89-92, Pickaxe.cs:239-242).
//   break_container_source  the container is GONE from the tile, and the drops added
//                           during the swing window are reported.
//
// LIFECYCLE. All three are registered as `FarmhandActionLifecycle.Experimental`
// (families `buildings_farm_management` / `buildings_farm_management` /
// `resource_gathering`), so they stay off the Agent surface until each passes its own
// native-local live gate; promotion is a separate catalog edit owned by the parent.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Places one owned placeable object (any bigCraftable, including a tapper, or a
    /// piece of furniture) on a published world tile through the native
    /// <c>Object.placementAction</c> branch. See the file header for the seam, the
    /// argument shape and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPlaceOwnedObject(
        string requestId,
        int slot,
        int targetX,
        int targetY,
        string expectedQualifiedItemId,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: placement calls no tool and starts no swing, the same
        // profile `place_wood_fence`'s sibling actions admit under.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePlacementSource(slot, expectedQualifiedItemId, out StardewValley.Object? source, out string sourceRefusal, out string sourceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, sourceRefusal, sourceEvidence);

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildOwnedObjectPlacementTargetId(location, slot, targetX, targetY, source!.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};published={expectedTargetId}");
        if (location.objects.ContainsKey(tile))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_tile_occupied",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};occupant={location.objects[tile]?.QualifiedItemId ?? "unknown"}");
        // 5.2: out of the native placement reach, walk in rather than refuse. The
        // reach here is the game's own (`Utility.isWithinTileWithLeeway`,
        // Utility.cs:5737), not an invented one; every position-independent check above
        // is re-run in the shared execution body after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "place_owned_object",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecutePlaceOwnedObject(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecutePlaceOwnedObject(executionId, requestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    /// <summary>
    /// Executes place_owned_object against the current world, re-validating the slot,
    /// the item and the tile because an approach leg may have taken several ticks.
    /// Shared by the in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecutePlaceOwnedObject(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePlacementSource(slot, expectedQualifiedItemId, out StardewValley.Object? source, out string sourceRefusal, out string sourceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, sourceRefusal, sourceEvidence);

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildOwnedObjectPlacementTargetId(location, slot, targetX, targetY, source!.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};published={expectedTargetId}");
        if (location.objects.ContainsKey(tile))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_tile_occupied",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};occupant={location.objects[tile]?.QualifiedItemId ?? "unknown"}");
        // The game's own admission predicate, in the order its ingress applies it
        // (Utility.cs:6947 -> :5744 -> :5746). A tile that fails it is a named refusal:
        // no native placement would have happened there.
        bool tilePlaceable = Utility.playerCanPlaceItemHere(location, source, targetX * 64 + 32, targetY * 64 + 32, Game1.player)
            && source.canBePlacedHere(location, tile);
        if (!tilePlaceable)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_tile_not_placeable",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};tile_index={location.getTileIndexAt(targetX, targetY, "Back")};passable={location.isTilePassable(tile).ToString().ToLowerInvariant()}");

        int beforeCount = CountQualifiedItem(Game1.player, source.QualifiedItemId);
        // The tile's own terrain feature is read before the call so the receipt can name the
        // ground an object was placed on, and re-read after it: the tapper branch
        // (Object.cs:6566-6584) is the only branch that flips a Tree's `tapped` flag, so that
        // flip is the observed proof that a tapper really absorbed into THIS action.
        string terrainFeature = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? featureAtTile) && featureAtTile is not null
            ? featureAtTile.GetType().Name
            : "none";
        int previousSlot = Game1.player.CurrentToolIndex;
        bool placementHandled;
        try
        {
            // Both halves of the native ingress are reproduced (Utility.cs:6947 sets the
            // held item, :6953 the call, :6955 the decrement): the ActiveObject is not
            // touched, because this action addresses the slot directly rather than through
            // a held-item UI state.
            Game1.player.CurrentToolIndex = slot;
            placementHandled = source.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "place_owned_object_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        // Re-read the world AFTER the call. The placed instance is a native COPY
        // (Object.cs:7001), so identity is the qualified item id plus the tile, never a
        // reference.
        bool objectPresent = location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            && placed is not null
            && string.Equals(placed.QualifiedItemId, source.QualifiedItemId, StringComparison.Ordinal);
        int afterCount = CountQualifiedItem(Game1.player, source.QualifiedItemId);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        string terrainFeatureTapped = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? tappedFeature)
            && tappedFeature is StardewValley.TerrainFeatures.Tree tappedTree
            ? tappedTree.tapped.Value.ToString().ToLowerInvariant()
            : "none";
        bool succeeded = placementHandled && objectPresent && inventoryDecremented;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};slot={slot};item={source.QualifiedItemId};"
            + $"terrain_feature={terrainFeature};terrain_feature_tapped={terrainFeatureTapped};"
            + $"native_placement={placementHandled.ToString().ToLowerInvariant()};object_present={objectPresent.ToString().ToLowerInvariant()};"
            + $"placed_qualified_item_id={(objectPresent ? placed!.QualifiedItemId : "none")};placed_type={(objectPresent ? placed!.Type ?? "none" : "none")};"
            + $"inventory_before={beforeCount};inventory_after={afterCount}";
        return succeeded
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "owned_object_placed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "place_owned_object_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Removes one object occupying a world tile with the named axe/pickaxe through the
    /// native DoFunction -> Object.performToolAction -> Object.performRemoveAction path.
    /// See the file header for the seam and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalRemovePlacedItem(
        string requestId,
        int slot,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Physical: this arm swings a real tool through the native DoFunction path.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? target) || target is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};slot={slot}");
        if (!string.Equals(BuildPlacedItemTargetId(location, targetX, targetY, target), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPlacedItemTargetId(location, targetX, targetY, target)};item={target.QualifiedItemId}");
        // Removability is asked first and in the native predicate's own order
        // (Object.cs:1346 fragility, :1350 Type == "Crafting", :1182 twig, :1192
        // SupplyCrate, :1339 the unregistered bigCraftable). An object no axe or
        // pickaxe removes is not this action's subject, whatever slot is named.
        if (!IsRemovableByAnyLaneTool(target))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_not_removable",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={target.QualifiedItemId};type={target.Type ?? "none"};fragility={target.Fragility};big_craftable={target.bigCraftable.Value.ToString().ToLowerInvariant()};slot={slot}");
        if (!TryDescribeLaneRemovalTool(slot, out Tool? tool, out string toolRefusal, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, toolEvidence);
        if (!RemovesThisObject(tool!, target))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_tool_cannot_remove_target",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={target.QualifiedItemId};type={target.Type ?? "none"};fragility={target.Fragility};tool={DescribeTool(tool) ?? "none"};tool_kind={LaneRemovalToolKind(tool!)};slot={slot}");
        // 5.2: out of the native tool reach, walk in rather than refuse. Every
        // position-independent check above is re-run after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "remove_placed_item",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteRemovePlacedItem(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteRemovePlacedItem(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes remove_placed_item against the current world, re-validating the object,
    /// its removability and the named tool because an approach leg may have taken
    /// several ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteRemovePlacedItem(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? target) || target is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};slot={slot}");
        if (!string.Equals(BuildPlacedItemTargetId(location, targetX, targetY, target), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPlacedItemTargetId(location, targetX, targetY, target)};item={target.QualifiedItemId}");
        if (!IsRemovableByAnyLaneTool(target))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_not_removable",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={target.QualifiedItemId};type={target.Type ?? "none"};fragility={target.Fragility};big_craftable={target.bigCraftable.Value.ToString().ToLowerInvariant()};slot={slot}");
        if (!TryDescribeLaneRemovalTool(slot, out Tool? tool, out string toolRefusal, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, toolEvidence);
        if (!RemovesThisObject(tool!, target))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_tool_cannot_remove_target",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={target.QualifiedItemId};type={target.Type ?? "none"};fragility={target.Fragility};tool={DescribeTool(tool) ?? "none"};tool_kind={LaneRemovalToolKind(tool!)};slot={slot}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_out_of_range",
                $"target={targetX},{targetY};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        string itemId = target.QualifiedItemId;
        int debrisBefore = ItemDropDebrisCount(location);
        float staminaBefore = Game1.player.Stamina;
        // One native swing settles an ordinary crafted object (Axe.cs:87-95 /
        // Pickaxe.cs:236-244 run performRemoveAction and remove it in the same call), but
        // a SupplyCrate carries its own hit budget (Object.cs:1192-1304). The loop is
        // bounded and stops the moment the object is gone, so a request never leaves a
        // half-removed object behind as a claimed success.
        const int maximumSwingCount = 12;
        int swingCount = 0;
        try
        {
            while (swingCount < maximumSwingCount
                && location.objects.TryGetValue(tile, out StardewValley.Object? still)
                && ReferenceEquals(still, target))
            {
                UseNativeToolOnTile(tool!, location, targetX, targetY, Game1.player, staminaBefore);
                swingCount++;
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "remove_placed_item_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={slot};swings={swingCount};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        float staminaAfter = Game1.player.Stamina;
        IReadOnlyList<string> drops = ItemDropDebrisSince(location, debrisBefore);
        bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? after) || after is null;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};type={target.Type ?? "none"};"
            + $"tool={DescribeTool(tool) ?? "none"};tool_kind={LaneRemovalToolKind(tool!)};slot={slot};swings={swingCount};"
            + $"removed={removed.ToString().ToLowerInvariant()};tile_object_after={(removed ? "none" : after!.QualifiedItemId)};"
            + $"drops={string.Join("|", drops)};drop_count={drops.Count};"
            + $"stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)}";
        return removed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "placed_item_removed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "remove_placed_item_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Breaks one breakable container (a mine barrel/crate) with the named heavy hitter
    /// through the native <c>BreakableContainer.performToolAction</c>. The native call
    /// returns <c>false</c> even when it destroys the container, so the postcondition is
    /// the container being GONE plus the drops the game produced. See the file header.
    /// </summary>
    public LocalExecutionReceipt RequestLocalBreakContainerSource(
        string requestId,
        int slot,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Physical: this arm swings a real tool through the native DoFunction path.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? probe) || probe is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};slot={slot}");
        if (probe is not BreakableContainer)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_not_a_container",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={probe.QualifiedItemId};type={probe.GetType().Name};slot={slot}");
        if (!string.Equals(BuildBreakableContainerTargetId(location, targetX, targetY, probe), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildBreakableContainerTargetId(location, targetX, targetY, probe)};item={probe.QualifiedItemId}");
        if (!TryDescribeHeavyHitterSlot(slot, out Tool? tool, out string toolRefusal, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, toolEvidence);
        // 5.2: out of the native tool reach, walk in rather than refuse.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "break_container_source",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteBreakContainerSource(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteBreakContainerSource(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes break_container_source against the current world, re-validating the
    /// container, its state identity and the named tool because an approach leg may have
    /// taken several ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteBreakContainerSource(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? probe) || probe is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};slot={slot}");
        if (probe is not BreakableContainer container)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_not_a_container",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={probe.QualifiedItemId};type={probe.GetType().Name};slot={slot}");
        if (!string.Equals(BuildBreakableContainerTargetId(location, targetX, targetY, container), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildBreakableContainerTargetId(location, targetX, targetY, container)};item={container.QualifiedItemId}");
        if (!TryDescribeHeavyHitterSlot(slot, out Tool? tool, out string toolRefusal, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, toolEvidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "break_container_source_out_of_range",
                $"target={targetX},{targetY};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        string itemId = container.QualifiedItemId;
        int debrisBefore = ItemDropDebrisCount(location);
        float staminaBefore = Game1.player.Stamina;
        // A container carries its own hit budget (3 for a mine barrel, 4 for a volcano
        // barrel) and loses one per swing (BreakableContainer.cs:120), so one request
        // keeps swinging until the container is gone — the postcondition this action
        // reports, never the seam's own `false`.
        const int maximumSwingCount = 12;
        int swingCount = 0;
        try
        {
            while (swingCount < maximumSwingCount
                && location.objects.TryGetValue(tile, out StardewValley.Object? still)
                && ReferenceEquals(still, container))
            {
                UseNativeToolOnTile(tool!, location, targetX, targetY, Game1.player, staminaBefore);
                swingCount++;
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "break_container_source_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={slot};swings={swingCount};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        float staminaAfter = Game1.player.Stamina;
        IReadOnlyList<string> drops = ItemDropDebrisSince(location, debrisBefore);
        bool gone = !location.objects.TryGetValue(tile, out StardewValley.Object? after) || after is null;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};type={container.GetType().Name};"
            + $"tool={DescribeTool(tool) ?? "none"};slot={slot};swings={swingCount};container_gone={gone.ToString().ToLowerInvariant()};"
            + $"tile_object_after={(gone ? "none" : after!.QualifiedItemId)};drops={string.Join("|", drops)};drop_count={drops.Count};"
            + $"stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)}";
        return gone
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "container_source_broken", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "break_container_source_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one place that answers "is this an object this action's placement shape can
    /// place?", i.e. an object whose <c>placementAction</c> takes the
    /// bigCraftable/Furniture branch (<c>Object.cs:6201</c> is
    /// <c>!bigCraftable.Value &amp;&amp; !(this is Furniture)</c>, so that branch is exactly
    /// bigCraftables, furniture, and mod subclasses of the two). The named slot must
    /// really hold it and the wire identity must match, so a request can never place a
    /// different item than the one it named.
    /// </summary>
    private static bool TryDescribePlacementSource(int slot, string expectedQualifiedItemId, out StardewValley.Object? source, out string reasonCode, out string evidence)
    {
        source = null;
        reasonCode = "accepted";
        evidence = string.Empty;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object candidate || candidate.Stack <= 0)
        {
            reasonCode = "place_owned_object_not_owned_in_slot";
            evidence = $"slot={slot};expected_item={expectedQualifiedItemId};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")}";
            return false;
        }
        if (!string.Equals(candidate.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
        {
            reasonCode = "place_owned_object_not_owned_in_slot";
            evidence = $"slot={slot};expected_item={expectedQualifiedItemId};slot_item={candidate.QualifiedItemId}";
            return false;
        }
        if (!candidate.bigCraftable.Value && candidate is not Furniture)
        {
            reasonCode = "place_owned_object_unsupported_item";
            evidence = $"slot={slot};item={candidate.QualifiedItemId};type={candidate.Type ?? "none"};big_craftable=false;furniture=false";
            return false;
        }
        source = candidate;
        return true;
    }

    /// <summary>
    /// The named slot's tool, or the named reason it is not one of this action's two
    /// native seams. `Axe.DoFunction` and `Pickaxe.DoFunction` are the only two bodies
    /// that reach an object's <c>performToolAction</c> + <c>performRemoveAction</c> pair
    /// for this action's purposes, so a hoe, a weapon or an empty slot is refused by
    /// name instead of being left to no-op natively.
    /// </summary>
    private static bool TryDescribeLaneRemovalTool(int slot, out Tool? tool, out string reasonCode, out string evidence)
    {
        tool = null;
        reasonCode = "accepted";
        evidence = string.Empty;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Tool candidate || !ReferenceEquals(Game1.player.CurrentTool, candidate))
        {
            reasonCode = "remove_placed_item_tool_not_equipped_in_requested_slot";
            evidence = $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")};current_slot={Game1.player.CurrentToolIndex};current_tool={DescribeTool(Game1.player.CurrentTool) ?? "none"}";
            return false;
        }
        if (candidate is not Axe && candidate is not Pickaxe)
        {
            reasonCode = "remove_placed_item_tool_not_axe_or_pickaxe";
            evidence = $"slot={slot};tool={DescribeTool(candidate) ?? "none"};tool_kind={LaneRemovalToolKind(candidate)}";
            return false;
        }
        tool = candidate;
        return true;
    }

    /// <summary>
    /// The named slot's tool when it satisfies the container seam's own precondition
    /// (<c>BreakableContainer.cs:118</c> <c>t.isHeavyHitter()</c>). The predicate is the
    /// game's, not a Mod list: whatever Tool subclass answers true natively is admitted,
    /// and a scythe or a club is admitted exactly as the native branch admits it.
    /// </summary>
    private static bool TryDescribeHeavyHitterSlot(int slot, out Tool? tool, out string reasonCode, out string evidence)
    {
        tool = null;
        reasonCode = "accepted";
        evidence = string.Empty;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Tool candidate || !ReferenceEquals(Game1.player.CurrentTool, candidate))
        {
            reasonCode = "break_container_source_tool_not_equipped_in_requested_slot";
            evidence = $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")};current_slot={Game1.player.CurrentToolIndex};current_tool={DescribeTool(Game1.player.CurrentTool) ?? "none"}";
            return false;
        }
        if (!candidate.isHeavyHitter())
        {
            reasonCode = "break_container_source_tool_not_heavy_hitter";
            evidence = $"slot={slot};tool={DescribeTool(candidate) ?? "none"};tool_kind={candidate.GetType().Name}";
            return false;
        }
        tool = candidate;
        return true;
    }

    /// <summary>Whether some axe or pickaxe removes this object, in the native guards' own terms (Object.cs:1092-1443).</summary>
    private static bool IsRemovableByAnyLaneTool(StardewValley.Object target) =>
        RemovesThisObject(new Axe(), target) || RemovesThisObject(new Pickaxe(), target);

    /// <summary>
    /// Mirrors the native removal guards of <c>Object.performToolAction</c> for the two
    /// seams this action owns, so a request that the native branch would answer with a
    /// silent <c>false</c> is refused by name instead.
    /// </summary>
    private static bool RemovesThisObject(Tool tool, StardewValley.Object target)
    {
        if (tool is not Axe && tool is not Pickaxe)
            return false;
        // `fragility == 2` is refused by the native code, and the POSITION of that test matters:
        // Object.performToolAction checks it at :1346-1349, AFTER the twig branch (:1182) and after the
        // error-bigCraftable branch (:1339-1345), and BEFORE the `Type == "Crafting"` branch (:1350).
        // So it is applied below, not at the top: an earlier version of this mirror placed it first,
        // which would have refused objects the native path removes. (An intermediate version removed it
        // entirely, reasoning from a partial read of the method - that mis-classified every
        // `Type == "Crafting" && Fragility == 2` object as removable, so the action swung twelve times
        // and reported an uncertain postcondition instead of a named refusal.)
        if (target.Fragility == 2)
            return false;

        if (target.Type == "Crafting" && !(tool is MeleeWeapon) && tool.isHeavyHitter())
            return true;
        if (target.IsTwig() && tool is Axe)
            return true;
        if (target.name is not null && target.name.Contains("SupplyCrate", StringComparison.Ordinal) && tool.isHeavyHitter())
            return true;
        if (target.bigCraftable.Value && tool.isHeavyHitter() && ItemRegistry.GetDataOrErrorItem(target.QualifiedItemId).IsErrorItem)
            return true;
        return false;
    }

    private static string LaneRemovalToolKind(Tool tool) => tool switch
    {
        Axe => "axe",
        Pickaxe => "pickaxe",
        _ => tool.GetType().Name,
    };

    /// <summary>
    /// The item drops the game added to this location's debris since the observed
    /// baseline. `Debris.itemId` is non-empty for item drops and empty for the cosmetic
    /// chunks `Game1.createRadialDebris` adds, so the two never blur together.
    /// </summary>
    private static int ItemDropDebrisCount(GameLocation location) =>
        location.debris.Count(debris => !string.IsNullOrEmpty(debris?.itemId.Value));

    private static IReadOnlyList<string> ItemDropDebrisSince(GameLocation location, int baselineCount)
    {
        List<string> drops = new();
        int seen = 0;
        foreach (Debris debris in location.debris)
        {
            if (string.IsNullOrEmpty(debris?.itemId.Value))
                continue;
            seen++;
            if (seen > baselineCount)
                drops.Add(debris.itemId.Value);
        }
        return drops;
    }

    /// <summary>
    /// Opaque identity of one placement candidate: the location, the backpack slot, the
    /// tile and the item that would be placed. The slot is part of the identity the same
    /// way the wood-fence identity carries it, because the item is what would be placed.
    /// </summary>
    private static string BuildOwnedObjectPlacementTargetId(GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}:owned-object";
        return $"place_owned_object_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Opaque identity of one object occupying a world tile. It binds the object's own
    /// removal-relevant facts — qualified item id, type and fragility — so a replaced or
    /// mutated object is a different target, and deliberately does NOT bind the tool
    /// slot: the same object can be named with either seam tool, and which tool really
    /// removes it is decided on the game thread, not by the identity.
    /// </summary>
    private static string BuildPlacedItemTargetId(GameLocation location, int x, int y, StardewValley.Object target)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{target.QualifiedItemId}:{target.Type ?? "none"}:{target.Fragility.ToString(CultureInfo.InvariantCulture)}:placed-item";
        return $"placed_item_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Opaque identity of one breakable container: the location, the tile and the
    /// container's own qualified item id plus its runtime type, so a barrel that was
    /// replaced by a different object is a different target. The container's hit budget
    /// is deliberately NOT part of the identity — the native health field is private to
    /// `BreakableContainer` and this Mod cannot observe it, so pretending to bind it
    /// would be a state the request never really names.
    /// </summary>
    private static string BuildBreakableContainerTargetId(GameLocation location, int x, int y, StardewValley.Object container)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{container.QualifiedItemId}:{container.GetType().Name}:breakable-container";
        return $"breakable_container_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The world-object targets the actor can name right now, projected read-only from
    /// live state:
    ///   * one <c>placement_candidate</c> per (owned placeable item slot, nearby tile) the
    ///     game's own placement admission accepts — the item comes from the backpack and
    ///     the tile from the live world, so a furniture or a mod-provided object works
    ///     without any content list in this Mod;
    ///   * one <c>removable_object</c> per nearby object an owned axe or pickaxe removes,
    ///     <c>non_removable_object</c> for one nothing in this lane removes, and
    ///     <c>breakable_container</c> for a nearby breakable container whenever a heavy
    ///     hitter is owned. `Slot` is the backpack slot the named action needs, and -1
    ///     when no owned tool acts on that object — the Mod never publishes a slot the
    ///     actor does not have.
    /// Nothing is synthesized: a tile that cannot be placed on, or an object that is not
    /// there, is not advertised.
    /// </summary>
    internal static IReadOnlyList<BridgeWorldObjectTarget> DiscoverWorldObjectTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWorldObjectTarget>();
        List<BridgeWorldObjectTarget> result = new();
        // The same object is reachable from every owned lane tool, so it is published
        // once: the first owned slot that can act on it wins, which is deterministic
        // (backpack order) and never advertises two slots for one target.
        HashSet<string> publishedTargetIds = new(StringComparer.Ordinal);
        int placementCount = 0;
        int objectCount = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (placementCount >= WorldObjectTargetLimit && objectCount >= WorldObjectTargetLimit)
                break;
            if (placementCount < WorldObjectTargetLimit
                && player.Items[slot] is StardewValley.Object owned
                && owned.Stack > 0
                && (owned.bigCraftable.Value || owned is Furniture))
            {
                for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && placementCount < WorldObjectTargetLimit; x++)
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && placementCount < WorldObjectTargetLimit; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)) continue;
                    if (!location.isTileOnMap(tile) || location.objects.ContainsKey(tile)) continue;
                    if (!Utility.playerCanPlaceItemHere(location, owned, x * 64 + 32, y * 64 + 32, player) || !owned.canBePlacedHere(location, tile)) continue;
                    string placementTargetId = BuildOwnedObjectPlacementTargetId(location, slot, x, y, owned.QualifiedItemId);
                    if (!publishedTargetIds.Add(placementTargetId)) continue;
                    result.Add(new BridgeWorldObjectTarget(
                        placementTargetId,
                        "placement_candidate",
                        location.NameOrUniqueName,
                        x,
                        y,
                        slot,
                        owned.QualifiedItemId,
                        RequireDisplayName(owned.QualifiedItemId)));
                    placementCount++;
                }
            }
            // A heavy-hitter TOOL publishes the removable/breakable objects. This must be its own
            // branch: `Tool` is NOT a `StardewValley.Object` (both derive from `Item`), so an earlier
            // version of this loop - which tested `is not StardewValley.Object` and `continue`d - made
            // the whole scan below unreachable, and three live gates reported a missing object Given
            // while only placement candidates were ever published.
            Tool? ownedTool = player.Items[slot] as Tool;
            if (objectCount >= WorldObjectTargetLimit || !(ownedTool?.isHeavyHitter() ?? false))
                continue;
            foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
            {
                if (objectCount >= WorldObjectTargetLimit)
                    break;
                Vector2 tile = pair.Key;
                StardewValley.Object placed = pair.Value;
                if (placed is null || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                    continue;
                bool container = placed is BreakableContainer;
                bool removable = !container && RemovesThisObject(ownedTool!, placed);
                if (!container && !removable && !IsRemovableByAnyLaneTool(placed))
                    continue;
                // A container is this lane's subject whenever a heavy hitter is owned
                // (BreakableContainer.cs:118), and it is published with the slot that
                // tool occupies. Everything else is either removable by the owned
                // axe/pickaxe or removable by neither: the second case is published too,
                // because the alternative is an Agent that cannot tell "the Mod never
                // advertised it" from "the Mod refuses it by name".
                bool actionable = container || removable;
                string targetId = container
                    ? BuildBreakableContainerTargetId(location, (int)tile.X, (int)tile.Y, placed)
                    : BuildPlacedItemTargetId(location, (int)tile.X, (int)tile.Y, placed);
                if (!publishedTargetIds.Add(targetId)) continue;
                result.Add(new BridgeWorldObjectTarget(
                    targetId,
                    container ? "breakable_container" : removable ? "removable_object" : "non_removable_object",
                    location.NameOrUniqueName,
                    (int)tile.X,
                    (int)tile.Y,
                    actionable ? slot : -1,
                    placed.QualifiedItemId,
                    string.IsNullOrEmpty(placed.DisplayName) ? placed.QualifiedItemId : placed.DisplayName));
                objectCount++;
            }
        }
        return result;
    }

    /// <summary>Per-kind cap on published world-object targets, matching the sibling families' bounded discovery.</summary>
    private const int WorldObjectTargetLimit = 16;
}
