using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;
using StardewValley.Tools;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// The world-object lane: four actions that all act on a PLACED THING occupying a
// WORLD TILE and all take that tile plus the opaque target id discovery published.
//
//   place_owned_object      Object.placementAction, the bigCraftable/Furniture
//                           branch, for ANY owned placeable object. This absorbs
//                           the proposed `place_tapper`: a tapper is placed on a
//                           tree, which is the same intent with a different
//                           CONSTRAINT, and the constraint is already carried by
//                           the item's own data (Object.canBePlacedHere's tapper
//                           branch), not by a second action.
//   remove_placed_item      Axe/Pickaxe DoFunction plus Object.performRemoveAction.
//   move_placed_furniture   GameLocation.removeQueuedFurniture: performRemoveAction,
//                           removal from `location.furniture`, then addItemToInventoryBool.
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
//   * the two branches file the placed thing in DIFFERENT collections: furniture goes to
//     `location.furniture` (:7041, the location's own NetCollection<Furniture>, GameLocation.cs:452) and
//     everything else is keyed by tile in `location.objects` (:7046). A postcondition that names one of
//     them is blind to the other, which is exactly what every furniture placement reported until the
//     read moved into `FindPlacedThing`; and the object branch adds a COPY (:7001) while the furniture
//     branch appends the source instance itself, so identity is the qualified item id plus the tile and
//     never a ReferenceEquals;
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
// THE FURNITURE-MOVE SEAM. Furniture does NOT live in `location.objects`: a house's bed,
// sofa and rug are `Furniture` in `location.furniture`, a `NetCollection<Furniture>` on
// the location (GameLocation.cs:452), and each piece carries its own `TileLocation`. That
// is why the axe/pickaxe path above cannot reach one: `Axe.DoFunction`/`Pickaxe.DoFunction`
// look up `location.Objects`, and `Furniture.performRemoveAction` (Furniture.cs:1129-1151)
// does NOT take the piece out of any collection and does NOT put it in the backpack - it
// only tears down the lights, the fireplace's on-state, the light glow and the sitting
// farmers. The caller owns both of those steps.
//
// The caller is `GameLocation.removeQueuedFurniture` (GameLocation.cs:8074-8101), the game's
// own furniture pickup, reached from `LowPriorityLeftClick` (:7999-8059) through the
// `furnitureToRemove` NetMutexQueue. Its sequence is the seam this action reproduces, in its
// own order: `furniture.TryGetValue(guid, out value)`, then `value.performRemoveAction()`
// (:8081), then `furniture.Remove(guid)` (:8082), then the backpack. `removeQueuedFurniture`
// is `protected` and the queue is driven by the click path, so the Mod cannot call it; it
// calls the same three public steps on the same piece instead of inventing a new one.
//
// WHAT THE NATIVE METHOD DOES NOT DO, AND THIS ACTION DOES. `removeQueuedFurniture` refuses
// up front (`!player.couldInventoryAcceptThisItem(value)` :8077) because it cannot undo the
// two steps it has already taken - it writes the piece into the first null slot (:8084-8093)
// and would otherwise drop it on the floor of a full pack. This action instead OBSERVES the
// delivery and puts the piece back when it did not happen: `addItemToInventoryBool`
// (Farmer.cs:4389-4421) answers false when nothing fit, and a piece silently lost is worse
// than a refusal. The rollback is exact - the SAME instance, its own tile and its own
// rotation, appended back to `location.furniture` - and the receipt is a REFUSAL, never a
// success (see `move_placed_furniture_inventory_full`).
//
// WHERE THE PIECE REALLY IS decides whether there is anything to put back. The delivery writes
// the slot FIRST and reports the gain afterwards (`Farmer.cs:4313-4328`), so a frame that
// throws while reporting leaves the piece in the pack; restoring it as well would hold one
// piece in two places, which is an item duplication rather than the loss the rollback exists
// to prevent. `SlotHoldingPiece` is therefore what both branches ask: a piece the pack holds
// is not restored, and its slot is what the receipt names.
//
// THE IDENTITY SEAM, AND WHAT A RECEIPT OWES THE CALLER. An opaque target id is a handle a caller can only echo
// back: it cannot compute one. So every receipt must name the identity its own write left behind, or the next request
// has nothing to name but the id of a target that no longer exists. Measured 2026-11-19 (Turn 130-138): she picked a
// house plant up with `move_placed_furniture`, kept the pre-pickup `placed_furniture_*` id, and `place_owned_object`
// refused `place_owned_object_target_changed` four times over 66 seconds - the pickup had said neither which slot the
// game chose nor which identity replaced the one it invalidated. Three facts follow, and this file states all three:
//   * the placement identity names the SOURCE (location, bag slot, qualified item id) and NOT the destination tile
//     (`BuildOwnedObjectPlacementTargetId`). The tile is already the request's own argument and is decided on the game
//     thread by `Utility.playerCanPlaceItemHere` (:6947 -> :5744 -> :5746), so binding it here as well was a second
//     spelling of one precondition - and the one spelling a pickup CANNOT produce, because the tile does not exist yet.
//     The identity is still recomputed from the world (`TryDescribePlacementSource` proves the slot holds that item), so
//     it is verified rather than trusted;
//   * `move_placed_furniture` names `carried_slot` and `carried_target` - the slot the game chose and the placement
//     identity that now exists for it - so the piece it lifted can be put down in the very next request;
//   * `place_owned_object` names `placed_target`, the identity the placement created (`placed_furniture_*` for a piece,
//     `placed_item_*` for an object), which is what `move_placed_furniture`/`rotate_furniture` accept. `remove_placed_item`
//     and `put_item_in_fish_tank` name the same field for the piece they left behind, so no action in this cycle can
//     invalidate an identity in silence (gate: `FurnitureIdentityGateTests`).
//
// POSTCONDITIONS, all OBSERVED after the call and none taken from a native return:
//   place_owned_object      the placed thing, read from the collection its own kind lands in
//                           (furniture from `location.furniture`, an object from
//                           `location.objects`), is the expected item at the tile it came to
//                           rest on, and the inventory count dropped by exactly one.
//   remove_placed_item      the object is GONE from the tile, and the removed object's
//                           own identity is reported as debris when the native path
//                           dropped it (Axe.cs:89-92, Pickaxe.cs:239-242).
//   move_placed_furniture   the piece is no longer in `location.furniture` and the actor's
//                           pack now holds one more of its qualified item id - in the slot the
//                           receipt names, under the placement identity it names.
//   break_container_source  the container is GONE from the tile, and the drops added
//                           during the swing window are reported.
//
// LIFECYCLE. All four are registered as `FarmhandActionLifecycle.Experimental`
// (families `buildings_farm_management` / `buildings_farm_management` /
// `buildings_farm_management` / `resource_gathering`), so they stay off the Agent surface
// until each passes its own native-local live gate; promotion is a separate catalog edit
// owned by the parent.
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
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePlacementSource(slot, expectedQualifiedItemId, out StardewValley.Object? source, out string sourceRefusal, out string sourceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, sourceRefusal, sourceEvidence);

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildOwnedObjectPlacementTargetId(location, slot, source!.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};published={expectedTargetId};live={BuildOwnedObjectPlacementTargetId(location, slot, source.QualifiedItemId)}");
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

    private LocalExecutionReceipt ExecutePlaceOwnedObject(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePlacementSource(slot, expectedQualifiedItemId, out StardewValley.Object? source, out string sourceRefusal, out string sourceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, sourceRefusal, sourceEvidence);

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildOwnedObjectPlacementTargetId(location, slot, source!.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "place_owned_object_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};published={expectedTargetId};live={BuildOwnedObjectPlacementTargetId(location, slot, source.QualifiedItemId)}");
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
                $"target={targetX},{targetY};location={location.NameOrUniqueName};slot={slot};item={source.QualifiedItemId};tile_index={location.getTileIndexAt(targetX, targetY, "Back")};map_passable={location.isTilePassable(tile).ToString().ToLowerInvariant()};body_standable={StardewBodyController.IsStandableTile(location, Game1.player, tile).ToString().ToLowerInvariant()}");

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

        // Re-read the world AFTER the call, IN THE COLLECTION THE PLACED THING'S OWN KIND LANDS IN. The
        // native branch here appends furniture to `location.furniture` (`Object.cs:7041`) and keys
        // everything else by tile in `location.objects` (`:7046`), so a postcondition that names one of the
        // two is blind to the other - which is what every furniture placement reported as
        // `place_owned_object_postcondition_unavailable` until this read moved to `FindPlacedThing`.
        // Identity is the qualified item id plus the tile, never a reference: the object branch adds a
        // native COPY (`Object.cs:7001`) while the furniture branch appends the source instance itself.
        // THE TILE IT CAME TO REST ON comes back with the thing, because that is the fact the criterion asked
        // for and no receipt stated: an object is keyed by the tile it was asked for, a piece carries its own
        // `TileLocation` (which the native wall branch may put on the row above, `Furniture.cs:1428-1437`), and
        // a piece handed to a table rests on the table's tile.
        (StardewValley.Object? placed, Vector2 restingTile) = FindPlacedThing(location, tile, source);
        bool placedPresent = placed is not null
            && string.Equals(placed.QualifiedItemId, source.QualifiedItemId, StringComparison.Ordinal);
        int afterCount = CountQualifiedItem(Game1.player, source.QualifiedItemId);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        string terrainFeatureTapped = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? tappedFeature)
            && tappedFeature is StardewValley.TerrainFeatures.Tree tappedTree
            ? tappedTree.tapped.Value.ToString().ToLowerInvariant()
            : "none";
        (ExecutionState state, string reasonCode) = PlacementVerdict(placementHandled, placedPresent, inventoryDecremented);
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={FormatTile(restingTile)};slot={slot};item={source.QualifiedItemId};"
            + $"{NamePlacedPieceAfterWrite(location, restingTile, placedPresent ? placed : null)};"
            + $"terrain_feature={terrainFeature};terrain_feature_tapped={terrainFeatureTapped};"
            + $"native_placement={placementHandled.ToString().ToLowerInvariant()};object_present={placedPresent.ToString().ToLowerInvariant()};"
            + $"placed_qualified_item_id={(placedPresent ? placed!.QualifiedItemId : "none")};placed_type={(placedPresent ? placed!.Type ?? "none" : "none")};"
            + $"inventory_before={beforeCount};inventory_after={afterCount}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
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
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? target) || target is null)
        {
            Furniture? piece = location.furniture.FirstOrDefault(candidate => candidate is not null && candidate.TileLocation == tile);
            if (piece is not null)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "remove_placed_item_furniture_move_unsupported",
                    $"target={targetX},{targetY};location={location.NameOrUniqueName};item={piece.QualifiedItemId};published={expectedTargetId};live={BuildPlacedFurnitureTargetId(location, targetX, targetY, piece)}");
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};slot={slot}");
        }
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
        if (ResolveDeclaredTool(Game1.player.Items, "remove_placed_item").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
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
        // The tool is not the caller's to name. The claim says "an Axe OR a Pickaxe"; which of the two THIS action needs is
        // the object's own answer (`RemovesThisObject` mirrors Object.performToolAction's guards), so the narrowing is a
        // fact about the target while the selection still runs through the one declared-tool path.
        if (ResolveDeclaredTool(Game1.player.Items, "remove_placed_item").RefusalCode is { } ownedRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, ownedRefusal, $"slot={slot}");
        if (!TrySelectDeclaredTool(Game1.player, "remove_placed_item", candidate => RemovesThisObject(candidate, target), out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_placed_item_tool_cannot_remove_target",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};item={target.QualifiedItemId};type={target.Type ?? "none"};fragility={target.Fragility};tool_refusal={toolRefusalCode};slot={slot}");
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
        Tool tool = selection.Tool;
        // One native swing settles an ordinary crafted object (Axe.cs:87-95 /
        // Pickaxe.cs:236-244 run performRemoveAction and remove it in the same call), but
        // a SupplyCrate carries its own hit budget (Object.cs:1192-1304). The loop is
        // bounded and stops the moment the object is gone, so a request never leaves a
        // half-removed object behind as a claimed success.
        const int maximumSwingCount = 12;
        // The stamina floor, before the first swing. A SupplyCrate carries its own hit budget
        // (`Object.cs:1192-1304`), so the loop cannot know how many swings it will take and prices its own cap.
        ToolStaminaVerdict stamina = ToolStaminaGuard.Check(
            Game1.player.Stamina,
            ToolStaminaGuard.PerSwingCharge(Game1.player.ForagingLevel, tool.IsEfficient) * maximumSwingCount);
        if (!stamina.Allowed)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                stamina.ReasonCode,
                $"target={targetX},{targetY};item={itemId};{stamina.Evidence};swings_worst_case={maximumSwingCount}");
        int swingCount = 0;
        try
        {
            while (swingCount < maximumSwingCount
                && location.objects.TryGetValue(tile, out StardewValley.Object? still)
                && ReferenceEquals(still, target))
            {
                UseNativeToolOnTile(tool, location, targetX, targetY, Game1.player, staminaBefore);
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
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={selection.Slot};swings={swingCount};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }

        float staminaAfter = Game1.player.Stamina;
        IReadOnlyList<string> drops = ItemDropDebrisSince(location, debrisBefore);
        bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? after) || after is null;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};type={target.Type ?? "none"};"
            + $"tool={DescribeTool(tool) ?? "none"};tool_kind={LaneRemovalToolKind(tool)};slot={selection.Slot};swings={swingCount};"
            + $"removed={removed.ToString().ToLowerInvariant()};tile_object_after={(removed ? "none" : after!.QualifiedItemId)};"
            + $"{NamePlacedPieceAfterWrite(location, tile, null)};"
            + $"drops={string.Join("|", drops)};drop_count={drops.Count};"
            + $"stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)}";
        return removed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "placed_item_removed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "remove_placed_item_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Picks up one ALREADY-PLACED piece of furniture from a world tile, through the game's own
    /// furniture pickup sequence (<c>GameLocation.removeQueuedFurniture</c>). See the file header
    /// for the seam, the delivery check and the rollback.
    /// </summary>
    public LocalExecutionReceipt RequestLocalMovePlacedFurniture(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        // THE REACH IS THE PIECE'S OWN AND THE WALK IS HOW THE BODY GETS INSIDE IT. `Furniture.IsCloseEnoughToFarmer`
        // (Furniture.cs:1295-1308) - the footprint inflated by 96 px - is what `LowPriorityLeftClick` gates the pickup on
        // (GameLocation.cs:8002), so a tile distance would be a second, invented spelling of it. What changed is what the
        // action does with a NO: `RequestLocalTileTarget` is handed the piece's footprint and walks to a tile BESIDE it,
        // which is also the only way a whole-room decoration becomes reachable at all.
        Furniture? piece = null;
        return this.RequestLocalTileTarget(
            "move_placed_furniture",
            requestId,
            expectedTargetId,
            requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            gate: location =>
            {
                if (!TryDescribePlacedFurniture(location, targetX, targetY, expectedTargetId, out Furniture? resolved, out string refusalCode, out string refusalEvidence))
                    return TileTargetGate.Refused(new TileTargetRefusal(refusalCode, refusalEvidence));
                piece = resolved;
                return TileTargetGate.Resolved(targetX, targetY, FurnitureFootprint(resolved!));
            },
            execute: (executionId, admittedRequestId) => this.ExecuteMovePlacedFurniture(executionId, admittedRequestId, targetX, targetY, expectedTargetId),
            authorize: this.AuthorizeActorOnReadyWorld,
            inReach: (actor, _, _) => piece?.IsCloseEnoughToFarmer(actor) == true);
    }

    private LocalExecutionReceipt ExecuteMovePlacedFurniture(
        string executionId,
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        // THE WALK CAN TAKE SEVERAL TICKS, so the piece is proved again from the collection: the id is what says it is
        // still the piece the caller saw.
        if (!TryDescribePlacedFurniture(location, targetX, targetY, expectedTargetId, out Furniture? resolved, out string refusalCode, out string refusalEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusalCode, refusalEvidence);
        Furniture piece = resolved!;
        // The pickup's own guard, re-asked at the moment of the write: a body that is entered with the piece still outside
        // this box has walked and not arrived. A walk that merely fell short is the shared leg's `target_out_of_reach`.
        if (!piece.IsCloseEnoughToFarmer(Game1.player))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "move_placed_furniture_out_of_range",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};furniture_tile={FormatTile(tile)};{DescribeFurnitureReach(piece)};approach=arrived");

        string itemId = piece.QualifiedItemId;
        Vector2 placedTile = piece.TileLocation;
        int placedRotation = piece.currentRotation.Value;
        bool placedFlipped = piece.Flipped;
        int carriedBefore = CountQualifiedItem(Game1.player, itemId);
        bool stored;
        try
        {
            // The native sequence, in the native order (GameLocation.cs:8081-8093).
            piece.performRemoveAction();
            location.furniture.Remove(piece);
            stored = Game1.player.addItemToInventoryBool(piece);
        }
        catch (Exception nativeException)
        {
            // A throw can land AFTER the delivery: `addItemToInventoryBool` writes the piece into the first null slot and
            // only then reports the gain (`Farmer.cs:4313-4328`), so a frame that throws while reporting it leaves the
            // piece in the pack. Putting it back as well would hold one piece in two places - an item duplication, which
            // is worse than the loss this rollback exists for - so the rollback is taken only when the pack does not
            // already hold it, and the receipt says which slot it really went to.
            int carriedSlot = SlotHoldingPiece(Game1.player, piece);
            bool restored = carriedSlot < 0 && RestoreFurniturePiece(location, piece, placedTile, placedRotation, placedFlipped);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "move_placed_furniture_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};native_exception={nativeException.GetType().Name};{NameCarriedPieceAfterWrite(location, carriedSlot, itemId)};restored={restored.ToString().ToLowerInvariant()};native_call_ran_unknown=true");
        }

        int carriedAfter = CountQualifiedItem(Game1.player, itemId);
        if (!stored)
        {
            bool restored = RestoreFurniturePiece(location, piece, placedTile, placedRotation, placedFlipped);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "move_placed_furniture_inventory_full",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};stored=false;{NameCarriedPieceAfterWrite(location, SlotHoldingPiece(Game1.player, piece), itemId)};restored={restored.ToString().ToLowerInvariant()};restored_tile={FormatTile(piece.TileLocation)};restored_rotation={piece.currentRotation.Value};inventory_carried={carriedAfter};inventory_slots={Game1.player.Items.Count}");
        }

        int carriedSlotAfter = SlotHoldingPiece(Game1.player, piece);
        bool gone = !location.furniture.Contains(piece);
        bool carried = carriedAfter == carriedBefore + 1 && carriedSlotAfter >= 0;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};"
            + $"native_stored={stored.ToString().ToLowerInvariant()};removed_from_furniture={gone.ToString().ToLowerInvariant()};"
            + $"carried={carried.ToString().ToLowerInvariant()};{NameCarriedPieceAfterWrite(location, carriedSlotAfter, itemId)};inventory_before={carriedBefore};inventory_after={carriedAfter};"
            + $"carried_tile={FormatTile(placedTile)};carried_rotation={placedRotation};carried_flipped={placedFlipped.ToString().ToLowerInvariant()};"
            + $"furniture_in_location={location.furniture.Count}";
        return gone && carried
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "placed_furniture_picked_up", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "move_placed_furniture_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The piece standing on the named tile, when it is still the one the caller saw. One reading for the request and for
    /// the body that runs after the walk, so the pairing no walk is started for and the pairing an arrival re-proves cannot
    /// name different facts.
    /// </summary>
    private static bool TryDescribePlacedFurniture(
        GameLocation location,
        int x,
        int y,
        string expectedTargetId,
        out Furniture? piece,
        out string reasonCode,
        out string evidence)
    {
        piece = null;
        reasonCode = "accepted";
        evidence = string.Empty;
        Furniture? candidate = FindPlacedFurniture(location, x, y);
        if (candidate is null)
        {
            reasonCode = "move_placed_furniture_target_not_found";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};furniture_in_location={location.furniture.Count}";
            return false;
        }
        string liveTargetId = BuildPlacedFurnitureTargetId(location, x, y, candidate);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
        {
            reasonCode = "move_placed_furniture_target_changed";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};live={liveTargetId};item={candidate.QualifiedItemId}";
            return false;
        }
        piece = candidate;
        return true;
    }

    private static bool RestoreFurniturePiece(GameLocation location, Furniture piece, Vector2 tile, int rotation, bool flipped)
    {
        if (!location.furniture.Contains(piece))
            location.furniture.Add(piece);
        piece.TileLocation = tile;
        piece.currentRotation.Value = rotation;
        piece.Flipped = flipped;
        return location.furniture.Contains(piece);
    }

    /// <summary>
    /// The slot this actor's pack holds this exact instance in, or -1. The native delivery stores the piece itself
    /// (`Items[i] = item`, Farmer.cs:4318), so identity is the reference, not a second derived id - and the SLOT is the
    /// fact the caller needs to place the piece again: nothing else in the receipt said which slot the game chose, which
    /// is why the 2026-11-19 run guessed the axe's slot 0 first.
    /// </summary>
    internal static int SlotHoldingPiece(Farmer player, Item piece)
    {
        for (int slot = 0; slot < player.Items.Count; slot++)
            if (ReferenceEquals(player.Items[slot], piece)) return slot;
        return -1;
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
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
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
        if (ResolveDeclaredTool(Game1.player.Items, "break_container").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "break_container",
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
        // The tool is not the caller's to name: this action's row claims `tool:heavy_hitter`, so the handler takes the best
        // owned tool the container's own seam accepts (`BreakableContainer.cs:118` asks the game's predicate) and puts the
        // actor's own selection back in the `finally` below.
        if (!TrySelectDeclaredTool(Game1.player, "break_container", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Tool tool = selection.Tool;
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
        // Same floor as remove_placed_item: a container carries its own hit budget (`BreakableContainer.cs:120`),
        // so the loop prices its cap rather than guessing the real count.
        ToolStaminaVerdict containerStamina = ToolStaminaGuard.Check(
            Game1.player.Stamina,
            ToolStaminaGuard.PerSwingCharge(Game1.player.MiningLevel, tool.IsEfficient) * maximumSwingCount);
        if (!containerStamina.Allowed)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                containerStamina.ReasonCode,
                $"target={targetX},{targetY};item={itemId};{containerStamina.Evidence};swings_worst_case={maximumSwingCount}");
        int swingCount = 0;
        try
        {
            while (swingCount < maximumSwingCount
                && location.objects.TryGetValue(tile, out StardewValley.Object? still)
                && ReferenceEquals(still, container))
            {
                UseNativeToolOnTile(tool, location, targetX, targetY, Game1.player, staminaBefore);
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
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={selection.Slot};swings={swingCount};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }

        float staminaAfter = Game1.player.Stamina;
        IReadOnlyList<string> drops = ItemDropDebrisSince(location, debrisBefore);
        bool gone = !location.objects.TryGetValue(tile, out StardewValley.Object? after) || after is null;
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};type={container.GetType().Name};"
            + $"tool={DescribeTool(tool) ?? "none"};slot={selection.Slot};swings={swingCount};container_gone={gone.ToString().ToLowerInvariant()};"
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
    /// WHERE A PLACED THING COMES TO REST, read from the thing itself: furniture is a <see cref="Furniture"/> in the
    /// location's own <c>NetCollection&lt;Furniture&gt;</c> (GameLocation.cs:452), and every other placeable this
    /// action admits is an object keyed by tile in <c>location.objects</c>.
    ///
    /// <para>
    /// The native branch this action drives splits on exactly this fact - <c>location.furniture.Add(...)</c>
    /// (Object.cs:7041) against <c>location.objects.Add(vector, obj4)</c> (:7046) - so the postcondition cannot name
    /// one of the two collections: ONE decision, stated here, and both containers are read through it.
    /// </para>
    /// </summary>
    internal static bool LandsInFurniture(Item placed) => placed is Furniture;

    /// <summary>
    /// Reads the placed thing back from the container its own kind lands in (see <see cref="LandsInFurniture"/>), with
    /// the tile it came to rest on - which is the piece's own <c>TileLocation</c>, and for a thing the engine put on a
    /// table, the table's.
    ///
    /// <para>
    /// The furniture read covers the third place a furniture placement can end: <c>Furniture.placementAction</c> hands
    /// the piece to a <c>furniture_type</c> 11 table standing on the tile instead of adding it to the room
    /// (Furniture.cs:1443-1449), so the piece is found in that table's <c>heldObject</c> and nowhere else. A piece that
    /// is standing there but is a different item is returned too, so the receipt can say what it found instead of
    /// reporting an absence the caller cannot act on.
    /// </para>
    /// </summary>
    internal static (StardewValley.Object? Found, Vector2 Tile) FindPlacedThing(GameLocation location, Vector2 tile, Item source)
    {
        if (!LandsInFurniture(source))
        {
            if (!location.objects.TryGetValue(tile, out StardewValley.Object? objectOnTile) || objectOnTile is null)
                return (null, tile);
            return (objectOnTile, tile);
        }

        Furniture? onTheTile = null;
        foreach (Furniture piece in location.furniture)
        {
            if (piece is null || piece.TileLocation != tile) continue;
            if (string.Equals(piece.QualifiedItemId, source.QualifiedItemId, StringComparison.Ordinal))
                return (piece, piece.TileLocation);
            if (piece.heldObject.Value is StardewValley.Object held
                && string.Equals(held.QualifiedItemId, source.QualifiedItemId, StringComparison.Ordinal))
                return (held, piece.TileLocation);
            onTheTile ??= piece;
        }
        return (onTheTile, onTheTile?.TileLocation ?? tile);
    }

    /// <summary>
    /// The placement's verdict, from the world the native call left behind, with every failure under its own name.
    ///
    /// <para>
    /// <c>place_owned_object_postcondition_unavailable</c> used to be the only answer a placement could fail with, so
    /// it could not tell a native call that placed nothing from a furniture piece standing in a collection nobody
    /// read. The first has its own name now, a landed thing whose stack stayed in the pack has its own, and the one
    /// that keeps the old name is the placement this action genuinely cannot observe: the native call answered true
    /// and the collection that thing's kind names does not hold it.
    /// </para>
    /// </summary>
    internal static (ExecutionState State, string ReasonCode) PlacementVerdict(
        bool placementHandled,
        bool foundInItsContainer,
        bool inventoryDecremented)
    {
        // Every native branch that answers false returns before its write (Object.cs:6999-7046), so nothing was
        // placed - which is what "the action was never armed" looks like from the world.
        if (!placementHandled) return (ExecutionState.Uncertain, "place_owned_object_native_declined");
        if (!foundInItsContainer) return (ExecutionState.Uncertain, "place_owned_object_postcondition_unavailable");
        // It is there and the pack still carries it, so the native decrement did not happen.
        if (!inventoryDecremented) return (ExecutionState.Uncertain, "place_owned_object_inventory_unchanged");
        return (ExecutionState.Succeeded, "owned_object_placed");
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
        // The branch ORDER below mirrors Object.performToolAction, and the order is load-bearing: the
        // twig branch (:1182) SETS fragility to 2, so the fragility test (:1346) must come after it or a
        // twig stops being removable. The same test must come BEFORE the Crafting branch (:1350), or a
        // `Type == "Crafting" && Fragility == 2` object is offered as removable and the action swings
        // twelve times to report an uncertain postcondition instead of a named refusal.
        if (target.IsTwig() && tool is Axe)
            return true;
        if (target.bigCraftable.Value && tool.isHeavyHitter() && ItemRegistry.GetDataOrErrorItem(target.QualifiedItemId).IsErrorItem)
            return true;
        if (target.Fragility == 2)
            return false;
        if (target.Type == "Crafting" && !(tool is MeleeWeapon) && tool.isHeavyHitter())
            return true;
        if (target.name is not null && target.name.Contains("SupplyCrate", StringComparison.Ordinal) && tool.isHeavyHitter())
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
    /// The identity of a placement THIS actor can perform from one bag slot, in one location.
    ///
    /// <para>
    /// It binds the SOURCE - location, bag slot, qualified item id - and deliberately NOT the destination tile. The tile
    /// is the request's own argument (`x`/`y`) and is decided on the game thread by the game's placement predicate
    /// (`Utility.playerCanPlaceItemHere`, Utility.cs:5727-5750); binding it here as well would be a second spelling of one
    /// precondition, and the spelling a pickup cannot produce: a caller that has just lifted a piece
    /// (<c>move_placed_furniture</c>) can only be handed an identity for the piece it now carries, because the tile it will
    /// choose does not exist yet. Measured 2026-11-19 (Turn 130-138): she picked a house plant up, kept the pre-pickup
    /// <c>placed_furniture_*</c> id, and the tile-bound candidate refused her four times (`place_owned_object_target_changed`).
    /// </para>
    ///
    /// <para>
    /// The source half is not taken on trust: <see cref="TryDescribePlacementSource"/> proves the named slot holds this
    /// qualified item, so a caller can echo this id but never forge one for an item it does not own.
    /// </para>
    /// </summary>
    internal static string BuildOwnedObjectPlacementTargetId(GameLocation location, int slot, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{qualifiedItemId}:owned-object";
        return $"place_owned_object_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The identity of a thing standing on a tile, read from the thing itself: a piece of furniture is named the way
    /// <c>location.furniture</c> names it and everything else the way <c>location.objects</c> does. ONE decision
    /// (<see cref="LandsInFurniture"/>), because the native branches fill two different collections (Object.cs:7041, :7046)
    /// and a caller cannot be told which one to ask.
    /// </summary>
    internal static string BuildPlacedThingTargetId(GameLocation location, Vector2 tile, StardewValley.Object placed) =>
        placed is Furniture piece
            ? BuildPlacedFurnitureTargetId(location, (int)tile.X, (int)tile.Y, piece)
            : BuildPlacedItemTargetId(location, (int)tile.X, (int)tile.Y, placed);

    /// <summary>
    /// The two evidence fields that name the identity a write left in the actor's pack: the slot the game chose
    /// (<c>carried_slot</c>) and the placement identity that now exists for it (<c>carried_target</c>). A piece the pack does
    /// not hold has no carried identity, and says so - <c>none</c>, never an id computed for a slot that holds something else.
    /// </summary>
    internal static string NameCarriedPieceAfterWrite(GameLocation location, int slot, string qualifiedItemId) =>
        slot < 0
            ? "carried_slot=-1;carried_target=none"
            : $"carried_slot={slot};carried_target={BuildOwnedObjectPlacementTargetId(location, slot, qualifiedItemId)}";

    /// <summary>
    /// The evidence field that names the identity a write left IN THE WORLD: <c>placed_target</c> is the id the next
    /// furniture action (`move_placed_furniture`, `rotate_furniture`) and every observation will use for the thing on this
    /// tile, or <c>none</c> when the write left nothing standing there.
    /// </summary>
    internal static string NamePlacedPieceAfterWrite(GameLocation location, Vector2 tile, StardewValley.Object? placed) =>
        $"placed_target={(placed is null ? "none" : BuildPlacedThingTargetId(location, tile, placed))}";

    /// <summary>
    /// Opaque identity of one object occupying a world tile. It binds the object's own
    /// removal-relevant facts — qualified item id, type and fragility — so a replaced or
    /// mutated object is a different target, and deliberately does NOT bind the tool
    /// slot: the same object can be named with either seam tool, and which tool really
    /// removes it is decided on the game thread, not by the identity.
    /// </summary>
    internal static string BuildPlacedItemTargetId(GameLocation location, int x, int y, StardewValley.Object target)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{target.QualifiedItemId}:{target.Type ?? "none"}:{target.Fragility.ToString(CultureInfo.InvariantCulture)}:placed-item";
        return $"placed_item_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildBreakableContainerTargetId(GameLocation location, int x, int y, StardewValley.Object container)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{container.QualifiedItemId}:{container.GetType().Name}:breakable-container";
        return $"breakable_container_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    internal static IReadOnlyList<BridgeWorldObjectTarget> DiscoverWorldObjectTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWorldObjectTarget>();
        List<BridgeWorldObjectTarget> result = new();
        HashSet<string> publishedTargetIds = new(StringComparer.Ordinal);
        int actorX = (int)player.Tile.X;
        int actorY = (int)player.Tile.Y;
        List<BridgeWorldObjectTarget> placements = new();
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object owned
                || owned.Stack <= 0
                || !(owned.bigCraftable.Value || owned is Furniture))
                continue;
            for (int x = Math.Max(0, actorX - TargetDiscoveryRadius); x <= actorX + TargetDiscoveryRadius; x++)
            for (int y = Math.Max(0, actorY - TargetDiscoveryRadius); y <= actorY + TargetDiscoveryRadius; y++)
            {
                Vector2 tile = new(x, y);
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)) continue;
                if (!location.isTileOnMap(tile) || location.objects.ContainsKey(tile)) continue;
                if (!Utility.playerCanPlaceItemHere(location, owned, x * 64 + 32, y * 64 + 32, player) || !owned.canBePlacedHere(location, tile)) continue;
                // ONE IDENTITY, MANY TILES: the id names the piece in this slot (see `BuildOwnedObjectPlacementTargetId`),
                // so every tile the piece may lawfully go to is its own ROW carrying the same id. The dedupe key is
                // therefore the row - id and tile - not the id alone, or the first placeable tile would be the only one
                // ever advertised.
                string placementTargetId = BuildOwnedObjectPlacementTargetId(location, slot, owned.QualifiedItemId);
                if (!publishedTargetIds.Add($"{placementTargetId}@{x},{y}")) continue;
                placements.Add(new BridgeWorldObjectTarget(
                    placementTargetId,
                    "placement_candidate",
                    location.NameOrUniqueName,
                    x,
                    y,
                    slot,
                    owned.QualifiedItemId,
                    RequireDisplayName(owned.QualifiedItemId),
                    null,
                    null,
                    // The object does not exist yet: the row names a TILE it may be put on, so the extent is the tile.
                    1,
                    1));
            }
        }
        // ORDER FIRST, THEN TRIM. The scan above reaches tiles west-to-east from the map's own corner, so truncating while
        // it walks published whichever tiles the loops hit first: with three placeable machines over the same nine tiles -
        // the engine offers no more than the radius-1 ring (`Utility.playerCanPlaceItemHere` -> `isWithinTileWithLeeway`,
        // Utility.cs:5718-5750) - the sixteen-row budget held every tile of the first machine, six of the second and none
        // of the third. Distance from the actor decides now, and the two tie-breaks make one unchanged world publish one
        // order: the backpack slot first (the one fact that tells two machines' rows on the SAME tile apart), then the
        // tile itself. Ordering removes nothing; it decides which sixteen of the rows survive the budget.
        result.AddRange(TargetOrdering.NearestFirstByChebyshev(
            placements,
            actorX,
            actorY,
            placement => new TargetCandidate(placement.X, placement.Y, placement.Slot)).Take(WorldObjectTargetLimit));
        int objectCount = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
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
                    string.IsNullOrEmpty(placed.DisplayName) ? placed.QualifiedItemId : placed.DisplayName,
                    null,
                    null,
                    // An object in `location.objects` occupies exactly the tile it is keyed by - the engine's own
                    // container and placement predicates read one tile - so this branch states 1x1 rather than omitting
                    // the pair.
                    1,
                    1));
                objectCount++;
            }
        }
        // PLACED FURNITURE IS PART OF THE ROOM, and nothing published it.
        //
        // Furniture lives in `location.furniture`, not `location.objects`, and this Mod never read that collection - a grep
        // for it finds one comment. So a house's bed, sofa, rug and paintings were literally invisible to the companion
        // while `place_owned_object` could ADD to the same invisible collection (Game1.cs:7033-7043). Measured 2026-11-03
        // (`round30`): it crafted a stone sign and planted it in front of the farmhouse door, and the frame it was reading
        // carried one door, three placement candidates and one colour target - no furniture at all, so "there is nothing
        // here yet" was the truthful reading of its own snapshot.
        //
        // Published as `placed_furniture` with `Slot: -1`: this lane has no tool that picks furniture up, and advertising a
        // slot would promise one. The removal action refuses a furniture tile by name (see
        // `remove_placed_item_furniture_move_unsupported`) rather than `target_not_found`, so the companion learns the
        // difference between "not there" and "there, but I cannot move it".
        //
        // The piece also carries its own `currentRotation` and `rotations`, because those are the two facts an action on
        // it needs and the only place they exist: `rotations < 2` is why `rotate_furniture` refuses by name instead of
        // turning nothing, and `currentRotation` before/after is the only witness that a turn happened. A caller cannot
        // derive either - the target id deliberately excludes anything the piece's own use changes.
        int furnitureCount = 0;
        foreach (Furniture piece in location.furniture)
        {
            if (furnitureCount >= WorldObjectTargetLimit)
                break;
            if (piece is null) continue;
            Vector2 tile = piece.TileLocation;
            if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                continue;
            string targetId = BuildPlacedFurnitureTargetId(location, (int)tile.X, (int)tile.Y, piece);
            if (!publishedTargetIds.Add(targetId)) continue;
            result.Add(new BridgeWorldObjectTarget(
                targetId,
                "placed_furniture",
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                -1,
                piece.QualifiedItemId,
                string.IsNullOrEmpty(piece.DisplayName) ? piece.QualifiedItemId : piece.DisplayName,
                piece.currentRotation.Value,
                piece.rotations.Value,
                // THE FOOTPRINT THE ENGINE COMPUTES, not a table here: `getTilesWide()`/`getTilesHigh()` divide the
                // piece's own sprite-derived `boundingBox` by 64 (Furniture.cs:1413-1421), which is why a 2x3 bed and a
                // 1x1 chair arrive as different rows. `Math.Max(1, ...)` only because a piece whose bounding box this
                // process never calculated would divide to 0, and 0 tiles is not a footprint any caller can use.
                Math.Max(1, piece.getTilesWide()),
                Math.Max(1, piece.getTilesHigh())));
            furnitureCount++;
        }
        int pedestalCount = 0;
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pedestalCount >= WorldObjectTargetLimit)
                break;
            if (pair.Value is not StardewValley.Objects.ItemPedestal pedestal || pedestal.heldObject.Value is not null)
                continue;
            Vector2 tile = pair.Key;
            if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                continue;
            string targetId = BuildPedestalDepositTargetId(location, (int)tile.X, (int)tile.Y, pedestal);
            if (!publishedTargetIds.Add(targetId)) continue;
            result.Add(new BridgeWorldObjectTarget(
                targetId,
                "empty_pedestal",
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                -1,
                pedestal.QualifiedItemId,
                string.IsNullOrEmpty(pedestal.DisplayName) ? pedestal.QualifiedItemId : pedestal.DisplayName,
                null,
                null,
                1,
                1));
            pedestalCount++;
        }
        return result;
    }

    /// <summary>
    /// The identity of one placed furniture piece: where it stands and what it is.
    ///
    /// <para>
    /// Coordinates are part of it on purpose - moving a piece changes which piece is at a tile, and unlike an item stack there
    /// is no slot or count to distinguish two identical chairs. What is NOT part of it is anything the piece's own use
    /// changes (burning state, contents), so a fireplace that is lit keeps the identity it had while unlit.
    /// </para>
    /// </summary>
    internal static string BuildPlacedFurnitureTargetId(GameLocation location, int x, int y, Furniture piece)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{piece.QualifiedItemId}:placed-furniture";
        return $"placed_furniture_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private const int WorldObjectTargetLimit = 16;
}
