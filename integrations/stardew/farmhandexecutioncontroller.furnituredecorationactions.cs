using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Objects;
using StardewValley.Tools;
using GameBuddy.Stardew.Core;

namespace GameBuddy.Stardew;

// The furniture-and-decoration lane: what an actor can do to a piece that is ALREADY PART OF THE ROOM.
//
//   rotate_furniture   Furniture.rotate (Furniture.cs:1153-1162) -> updateRotation (:1164-1242),
//                      admitted by Furniture.canBePlacedHere (:1331-1406).
//
// WHY ROTATION IS A DIFFERENT ACTION FROM PLACEMENT. `place_owned_object` addresses a placement
// CANDIDATE - a tile plus a backpack slot for an object that does not exist yet - and its write is
// `Object.placementAction`. This lane addresses a piece that already stands in `location.furniture`, and
// its write is the piece's own `rotate()`. The two share nothing but the tile.
//
// THE NATIVE SEAM, READ IN FULL. `Furniture.rotate()` is four lines and does exactly this:
//
//     if (rotations.Value >= 2) {
//         int num = (rotations.Value == 4) ? 1 : 2;
//         currentRotation.Value += num;
//         currentRotation.Value %= 4;
//         updateRotation();
//     }
//
// So the CYCLES are the piece's own data: a two-rotation piece alternates 0 <-> 2, a four-rotation piece
// steps 0 -> 1 -> 2 -> 3 -> 0, and anything with fewer than two rotations does NOTHING AT ALL. That last
// case is why `furniture_rotation_unsupported` exists as a refusal instead of a receipt that reports a
// turn the engine never performed.
//
// `updateRotation()` (:1164-1242) is the bookkeeping half, and it is the half that makes the occupancy
// question real: it DERIVES `boundingBox` from `defaultBoundingBox` and the new `currentRotation`
// (:1182-1198 - a non-square piece swaps its width and height on the odd rotations), derives
// `sourceRect`/`flipped` (:1200-1234) and refreshes `drawPosition` (:1408-1411). A rotated piece therefore
// occupies DIFFERENT TILES than it did a moment ago, which is the whole reason a turn can be blocked.
// No second writer is needed for any of it: the method is public and idempotent - it recomputes every
// derived field from `currentRotation` and the `default*` values - so reverting a refused turn is exactly
// `currentRotation = before; updateRotation();`.
//
// WHICH NATIVE PATH ACTUALLY TURNS A PLACED PIECE. None does. The game calls `rotate()` on the FURNITURE
// THE ACTOR IS CARRYING (`Game1.cs:11401-11409`, `11423-11431`, `11437-11445`: `if (!eventUp &&
// player.ActiveObject is Furniture furniture) furniture.rotate();`), i.e. on the placement PREVIEW, and
// `Furniture.SetPlacement`/`GetOneCopyFrom` (:268-285, :2001-2013) call it while a piece is being
// constructed. Placed furniture is rotated by the player only by lifting it
// (`move_placed_furniture`), turning it in the hand and putting it down again. This action performs the
// same `rotate()` on the piece in place, which is the only write the engine offers for it.
//
// THE OCCUPANCY QUESTION IS THE ENGINE'S. `Furniture.canBePlacedHere(l, tile)` (:1331-1406) is the
// predicate `Utility.playerCanPlaceItemHere` (:5727-5750) gates every placement on, and it is the only
// thing that knows what a furniture footprint may overlap: `isTilePlaceable` per tile (:1356), every
// other piece in `location.furniture` whose bounding box covers the tile (:1360-1370), an object on the
// tile that either side cannot pass (:1371-1374), the location's blocking layer (:1391-1394), a HoeDirt
// carrying a crop (:1395-1398) and `GetAdditionalFurniturePlacementStatus` (:1401, :1470-1529) for the
// wall/NoFurniture/Buildings rules. This file does NOT restate any of it.
//
// It is, however, written for a piece that is NOT YET IN THE COLLECTION, and that is the one adjustment
// the caller must make: the loop at :1360 checks `!item.AllowPlacementOnThisTile(...)` for every piece it
// finds, and `Furniture.AllowPlacementOnThisTile` (:1545-1548) returns false, so a piece asked about its
// OWN tile refuses ITSELF. The probe therefore takes the piece out of `location.furniture` for exactly the
// duration of the read and puts it back, which is the same collection write `RestoreFurniturePiece` already
// makes. `GetAdditionalFurniturePlacementStatus` also WRITES `tileLocation` (:1475) while it answers, so
// the tile is re-asserted afterwards: a predicate that was asked a question must not have moved the piece.
//
// REFUSALS name the fact they read: nothing at the tile (`furniture_rotation_target_not_found`), a different
// piece (`furniture_rotation_target_changed`), a piece the engine will not turn
// (`furniture_rotation_unsupported`), out of the game's own furniture reach
// (`furniture_rotation_out_of_range`), a footprint that would land on a neighbour
// (`furniture_rotation_blocked_by_occupant`), a footprint the location will not accept for a reason that is
// not an occupant (`furniture_rotation_not_placeable_here`), a native call that threw
// (`furniture_rotation_native_exception`). The shared admission supplies `native_local_player_required` /
// `player_not_actionable` / `invalid_deadline` / `body_owned_*`.
//
// POSTCONDITION is a fresh read of the piece AFTER the call: `currentRotation` differs from the value read
// before it, equals the value the native call produced, and the piece is still in `location.furniture` on
// the tile it was named on. A piece that turned but whose fresh read disagrees is `Uncertain`
// (`furniture_rotation_postcondition_not_observed`), never a success.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Turns one already-placed piece of furniture through the native <c>Furniture.rotate</c>. See the file
    /// header for the seam, the occupancy probe and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalRotateFurniture(
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
        // General, not Physical: no tool is swung and no DoFunction runs. The piece is turned by its own
        // native method, the same profile `place_owned_object` and `move_placed_furniture` admit under.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        // THE PIECE IS RE-RESOLVED FROM THE COLLECTION, not from the id - the same discipline
        // `move_placed_furniture` uses, because `location.furniture` is a collection with no key and a tile is
        // what selects a piece. The id is what proves it is still the piece the caller saw.
        Furniture? piece = FindPlacedFurniture(location, targetX, targetY);
        if (piece is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "furniture_rotation_target_not_found",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};furniture_in_location={location.furniture.Count};blocked_by={RefusalLayerToken.None.Format()}");
        if (!string.Equals(BuildPlacedFurnitureTargetId(location, targetX, targetY, piece), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "furniture_rotation_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPlacedFurnitureTargetId(location, targetX, targetY, piece)};item={piece.QualifiedItemId};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        // The engine's own guard, read from the piece: `rotate()` is a no-op below two rotations (Furniture.cs:1155),
        // so a request for one would otherwise be a silent nothing that the postcondition could only report as
        // uncertain. Naming it here is what lets the companion tell "this piece cannot turn" from "the turn failed".
        if (piece.rotations.Value < 2)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "furniture_rotation_unsupported",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={piece.QualifiedItemId};rotations={piece.rotations.Value};rotation={piece.currentRotation.Value};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        // The game's own furniture reach - `Furniture.IsCloseEnoughToFarmer` (Furniture.cs:1295-1308), the same
        // predicate the pickup is gated on. No approach leg and no tile distance: the reach is the piece's own
        // footprint inflated by 96 px, so a tile ring would be a second, invented spelling of it and a
        // whole-room piece is reachable from a tile that ring does not contain.
        if (!piece.IsCloseEnoughToFarmer(Game1.player))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "furniture_rotation_out_of_range",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};furniture_tile={FormatTile(piece.TileLocation)};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, "furniture_reach").Format()}");

        string itemId = piece.QualifiedItemId;
        Vector2 placedTile = piece.TileLocation;
        int rotationBefore = piece.currentRotation.Value;
        int rotations = piece.rotations.Value;
        bool flippedBefore = piece.Flipped;
        Rectangle footprintBefore = piece.GetBoundingBox();
        try
        {
            // The write: one step of the piece's own rotation cycle, with all of its bookkeeping.
            piece.rotate();
        }
        catch (Exception nativeException)
        {
            // `updateRotation` runs after the value is already changed, so a throw can leave the piece carrying a
            // rotation its sprite and bounding box do not describe. Restore the value and re-derive from it, which
            // is exact because `updateRotation` recomputes every derived field (Furniture.cs:1166-1241).
            RestoreFurnitureRotation(piece, rotationBefore);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "furniture_rotation_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};rotation_before={rotationBefore};native_exception={nativeException.GetType().Name};restored={(piece.currentRotation.Value == rotationBefore).ToString().ToLowerInvariant()};native_call_ran_unknown=true");
        }

        int rotationAfter = piece.currentRotation.Value;
        bool flippedAfter = piece.Flipped;
        Rectangle footprintAfter = piece.GetBoundingBox();
        bool fits = true;
        bool restoredCollection = false;
        try
        {
            // THE PROBE, and the reason it needs the piece out of the collection is in the file header: the
            // predicate refuses a piece that is looking at its own footprint.
            location.furniture.Remove(piece);
            fits = piece.canBePlacedHere(location, placedTile);
        }
        finally
        {
            // A predicate that was asked a question must not have moved or removed the piece: put it back in the
            // collection and back on the tile it stood on.
            if (!location.furniture.Contains(piece)) location.furniture.Add(piece);
            restoredCollection = location.furniture.Contains(piece) && piece.TileLocation == placedTile;
            if (piece.TileLocation != placedTile) piece.TileLocation = placedTile;
        }

        if (!fits)
        {
            // THE TURN IS UNDONE. A piece whose new footprint lands on a neighbour is not a piece that turned: it is
            // a piece that is still where it was. The revert is the exact inverse (`updateRotation` re-derives from
            // the value), and the receipt is a REFUSAL because the world shows no change.
            bool reverted = RestoreFurnitureRotation(piece, rotationBefore);
            // The diagnosis reads the footprint the turn PRODUCED, captured before the revert: asking the piece now would
            // describe the box it was put back into, which is exactly the box nothing objected to.
            string occupants = DescribeRotationOccupants(location, piece, footprintAfter);
            bool blockedByOccupant = occupants.Length > 0;
            string evidence =
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};"
                + $"rotation_before={rotationBefore};rotation_attempted={rotationAfter};rotation_after={piece.currentRotation.Value};rotations={rotations};"
                + $"flipped_before={flippedBefore.ToString().ToLowerInvariant()};flipped_attempted={flippedAfter.ToString().ToLowerInvariant()};"
                + $"footprint_before={FormatFootprint(footprintBefore)};footprint_attempted={FormatFootprint(footprintAfter)};"
                + $"placeable=false;occupants={(occupants.Length == 0 ? "none" : occupants)};reverted={reverted.ToString().ToLowerInvariant()};"
                + $"collection_restored={restoredCollection.ToString().ToLowerInvariant()}";
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                blockedByOccupant ? "furniture_rotation_blocked_by_occupant" : "furniture_rotation_not_placeable_here",
                $"{evidence};blocked_by={DescribeRotationBlockingLayer(location, footprintAfter, blockedByOccupant)}");
        }

        // Re-read AFTER the probe as well: a successful probe still ran a predicate that writes `tileLocation`.
        bool turned = piece.currentRotation.Value != rotationBefore;
        bool standing = location.furniture.Contains(piece) && piece.TileLocation == placedTile;
        bool holdsTheTurn = piece.currentRotation.Value == rotationAfter;
        string succeededEvidence =
            $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};"
            + $"rotation_before={rotationBefore};rotation_after={piece.currentRotation.Value};rotation_expected={rotationAfter};rotations={rotations};"
            + $"flipped_before={flippedBefore.ToString().ToLowerInvariant()};flipped_after={piece.Flipped.ToString().ToLowerInvariant()};"
            + $"footprint_before={FormatFootprint(footprintBefore)};footprint_after={FormatFootprint(piece.GetBoundingBox())};"
            + $"placeable=true;turned={turned.ToString().ToLowerInvariant()};standing={standing.ToString().ToLowerInvariant()};"
            + $"furniture_in_location={location.furniture.Count}";
        return turned && standing && holdsTheTurn
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "furniture_rotated", succeededEvidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "furniture_rotation_postcondition_not_observed", succeededEvidence);
    }

    /// <summary>
    /// The one place that answers "which piece of furniture stands on this tile", shared by the request body and
    /// its post-approach sibling so the two cannot disagree. Furniture is addressed by its own tile because
    /// <c>location.furniture</c> is a collection with no key.
    /// </summary>
    private static Furniture? FindPlacedFurniture(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        foreach (Furniture candidate in location.furniture)
        {
            if (candidate is null) continue;
            if (candidate.TileLocation == tile) return candidate;
        }
        return null;
    }

    /// <summary>
    /// Puts a piece's rotation back to a value it really carried, and re-derives everything the engine derives
    /// from it. Answers whether the piece now reports that value, because a rollback nobody checked is a claim
    /// rather than a fact.
    /// </summary>
    private static bool RestoreFurnitureRotation(Furniture piece, int rotation)
    {
        piece.currentRotation.Value = rotation;
        piece.updateRotation();
        return piece.currentRotation.Value == rotation;
    }

    /// <summary>
    /// WHO is standing where the rotated piece would land, in the two categories the engine's own placement loop
    /// distinguishes (Furniture.cs:1360-1374): another piece whose bounding box covers the footprint, and an
    /// impassable object on it.
    ///
    /// This is a DIAGNOSIS, not the decision. Whether the piece fits is answered by the engine's
    /// <c>canBePlacedHere</c>; this only says which fact to name when the answer is no, so the companion is not
    /// told "not placeable here" when the truth is "the chair you put there is in the way".
    /// </summary>
    private static string DescribeRotationOccupants(GameLocation location, Furniture piece, Rectangle footprint)
    {
        List<string> occupants = new();
        foreach (Furniture other in location.furniture)
        {
            if (other is null || ReferenceEquals(other, piece)) continue;
            if (other.GetBoundingBox().Intersects(footprint))
                occupants.Add($"furniture:{other.QualifiedItemId}@{FormatTile(other.TileLocation)}");
        }
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is null || pair.Value.isPassable()) continue;
            if (!footprint.Contains((int)(pair.Key.X * 64f + 32f), (int)(pair.Key.Y * 64f + 32f))) continue;
            occupants.Add($"object:{pair.Value.QualifiedItemId}@{FormatTile(pair.Key)}");
        }
        return string.Join("|", occupants);
    }

    /// <summary>
    /// The layer a refused turn blames, in the closed vocabulary every refusal shares. When an occupant was named the
    /// layer is that occupant; otherwise the LOCATION refused a footprint nothing is standing on (a wall, a
    /// `NoFurniture` tile, a crop on the ground), and the location's own constraint is the honest answer.
    /// </summary>
    private static string DescribeRotationBlockingLayer(GameLocation location, Rectangle footprint, bool blockedByOccupant)
    {
        if (blockedByOccupant)
        {
            foreach (Furniture other in location.furniture)
            {
                if (other is null) continue;
                if (!other.GetBoundingBox().Intersects(footprint)) continue;
                return RefusalProbe.ObjectOn(location, other.TileLocation).Format();
            }
        }
        return new RefusalLayerToken(RefusalLayerKind.LocationConstraint, "furniture_placement").Format();
    }

    /// <summary>
    /// One footprint as the evidence spells it: the covered tile rectangle, so two receipts can be compared
    /// without re-deriving the geometry from the sprite.
    /// </summary>
    private static string FormatFootprint(Rectangle box) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{box.X / 64},{box.Y / 64}:{box.Width / 64}x{box.Height / 64}");

    // ---------------------------------------------------------------------------------------------------------
    // remove_fence
    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Takes down one standing fence through the fence's own <c>Fence.performToolAction</c>. See
    /// <c>remove_fence</c>'s section of the file header below.
    /// </summary>
    public LocalExecutionReceipt RequestLocalRemoveFence(
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
        // Physical: this arm swings a real tool through the native DoFunction path, so it pays the swing's stamina.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribeFence(location, targetX, targetY, expectedTargetId, out StardewValley.Fence? fence, out string fenceRefusal, out RefusalLayerToken fenceLayer, out string fenceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, fenceRefusal, $"{fenceEvidence};{DescribeRefusalLayer(fenceLayer)}");
        if (!TryDescribeFenceTool(slot, fence!, out Tool? tool, out string toolRefusal, out RefusalLayerToken toolLayer, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"{toolEvidence};{DescribeRefusalLayer(toolLayer)}");
        // 5.2: out of the native tool reach, walk in rather than refuse. Every position-independent check above is
        // re-run in the shared execution body after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "remove_fence",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteRemoveFence(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteRemoveFence(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes remove_fence against the current world, re-validating the fence and the named tool because an approach
    /// leg may have taken several ticks. Shared by the in-range path and the post-approach path so they cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteRemoveFence(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribeFence(location, targetX, targetY, expectedTargetId, out StardewValley.Fence? fence, out string fenceRefusal, out RefusalLayerToken fenceLayer, out string fenceEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, fenceRefusal, $"{fenceEvidence};{DescribeRefusalLayer(fenceLayer)}");
        if (!TryDescribeFenceTool(slot, fence!, out Tool? tool, out string toolRefusal, out RefusalLayerToken toolLayer, out string toolEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"{toolEvidence};{DescribeRefusalLayer(toolLayer)}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "remove_fence_out_of_range",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, "tool_reach").Format()}");

        string itemId = fence!.QualifiedItemId;
        bool isGate = fence.isGate.Value;
        float healthBefore = fence.health.Value;
        float maxHealth = fence.maxHealth.Value;
        bool heldObjectBefore = fence.heldObject.Value is not null;
        int debrisBefore = ItemDropDebrisCount(location);
        float staminaBefore = Game1.player.Stamina;
        // TWO SWINGS, because a fence that carries something takes two. `Fence.performToolAction` (Fence.cs:436-474) is
        // an if/else-if chain: a held object is dropped and the fence STAYS (:439-446), and only the next swing reaches
        // the removal branches. The loop is bounded and stops the moment the fence is gone, so a request never reports a
        // half-removed fence as a success.
        const int maximumSwingCount = 2;
        ToolStaminaVerdict stamina = ToolStaminaGuard.Check(
            Game1.player.Stamina,
            ToolStaminaGuard.PerSwingCharge(Game1.player.ForagingLevel, tool!.IsEfficient) * maximumSwingCount);
        if (!stamina.Allowed)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                stamina.ReasonCode,
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};{stamina.Evidence};swings_worst_case={maximumSwingCount};blocked_by={new RefusalLayerToken(RefusalLayerKind.Tool, DescribeToolCategory(tool)).Format()}");
        Vector2 tile = new(targetX, targetY);
        int swingCount = 0;
        try
        {
            while (swingCount < maximumSwingCount
                && location.objects.TryGetValue(tile, out StardewValley.Object? still)
                && ReferenceEquals(still, fence))
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
                "remove_fence_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={slot};swings={swingCount};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        float staminaAfter = Game1.player.Stamina;
        IReadOnlyList<string> drops = ItemDropDebrisSince(location, debrisBefore);
        // THE NATIVE RETURN PROVES NOTHING: `Fence.performToolAction` returns false on every branch, including the one
        // that destroyed the fence (Fence.cs:473). The postcondition is therefore the world: the fence is GONE from the
        // collection the engine keeps it in, and the drops it produced are named.
        bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? after) || after is null;
        // `drops=none` rather than an EMPTY value: `;`-separated evidence with a `key=` and nothing after it splits into a
        // field the Host's parser must refuse, so a fence that dropped nothing would be a removal the Host cannot read -
        // the same producer bug `shop_purchase` carried when a tile-opened shop wrote an empty `owner=`.
        string dropsEvidence = drops.Count == 0 ? "none" : string.Join("|", drops);
        string evidence =
            $"target={expectedTargetId};location={location.NameOrUniqueName};tile={targetX},{targetY};item={itemId};is_gate={isGate.ToString().ToLowerInvariant()};"
            + $"tool={DescribeTool(tool) ?? "none"};slot={slot};swings={swingCount};held_object_before={heldObjectBefore.ToString().ToLowerInvariant()};"
            + $"health_before={healthBefore.ToString("0.####", CultureInfo.InvariantCulture)};max_health={maxHealth.ToString("0.####", CultureInfo.InvariantCulture)};"
            + $"removed={removed.ToString().ToLowerInvariant()};tile_object_after={(removed ? "none" : after!.QualifiedItemId)};"
            + $"drops={dropsEvidence};drop_count={drops.Count};"
            + $"stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)}";
        return removed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "fence_removed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "remove_fence_postcondition_not_observed", evidence);
    }

    /// <summary>
    /// The shared <c>blocked_by</c> field for this lane's refusals: one spelling for one fact, so a caller can read the
    /// layer without knowing which branch wrote the rest of the evidence.
    /// </summary>
    internal static string DescribeRefusalLayer(RefusalLayerToken layer)
    {
        return $"blocked_by={new RefusalLayerToken(layer.Layer, layer.Detail).Format()}";
    }

    /// <summary>
    /// Re-derives the named fence on the game thread. A tile that holds something else is a NAMED refusal, never a
    /// silent re-target, and the target id is the object identity `remove_placed_item` already publishes for the same
    /// fence - one fence, one id, whichever action takes it down.
    /// </summary>
    private static bool TryDescribeFence(
        GameLocation location,
        int x,
        int y,
        string expectedTargetId,
        out StardewValley.Fence? fence,
        out string reasonCode,
        out RefusalLayerToken blockedBy,
        out string evidence)
    {
        fence = null;
        reasonCode = "accepted";
        blockedBy = RefusalLayerToken.None;
        evidence = string.Empty;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is null)
        {
            reasonCode = "remove_fence_target_not_found";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object=none";
            return false;
        }
        if (placed is not StardewValley.Fence candidate)
        {
            reasonCode = "remove_fence_target_is_not_a_fence";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object={placed.QualifiedItemId};object_type={placed.GetType().Name}";
            blockedBy = RefusalProbe.ObjectOn(location, tile);
            return false;
        }
        if (!string.Equals(BuildPlacedItemTargetId(location, x, y, candidate), expectedTargetId, StringComparison.Ordinal))
        {
            reasonCode = "remove_fence_target_changed";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPlacedItemTargetId(location, x, y, candidate)};item={candidate.QualifiedItemId}";
            blockedBy = RefusalProbe.ObjectOn(location, tile);
            return false;
        }
        fence = candidate;
        return true;
    }

    /// <summary>
    /// The named slot's tool, when the FENCE's own predicate accepts it: <c>Fence.IsValidRemovalTool</c>
    /// (Fence.cs:478-513) reads <c>Data/Fences</c>'s <c>RemovalToolIds</c>/<c>RemovalToolTypes</c>, so a modded fence
    /// that only a specific tool breaks is refused by name rather than swung at twelve times.
    ///
    /// <para>
    /// The slot is read out of the PACK, not out of the actor's hand: <c>Fence.performToolAction</c> is reached through
    /// <c>Tool.DoFunction</c>, which this handler calls with the tool itself (<see cref="UseNativeToolOnTile"/>), so the
    /// selection the actor happens to hold is not an input - exactly the shape <c>clear_debris</c> takes its tool in.
    /// </para>
    ///
    /// <para>
    /// A GATE is its own native branch: <c>Fence.performToolAction</c> removes one only for an <c>Axe</c> or a
    /// <c>Pickaxe</c> (Fence.cs:447-454), while <c>IsValidRemovalTool</c> is data-driven and answers true for a scythe
    /// when the fence declares no tool lists. Both halves are asked, so the refusal matches what the swing would do.
    /// </para>
    /// </summary>
    private static bool TryDescribeFenceTool(int slot, StardewValley.Fence fence, out Tool? tool, out string reasonCode, out RefusalLayerToken blockedBy, out string evidence)
    {
        tool = null;
        reasonCode = "accepted";
        blockedBy = RefusalLayerToken.None;
        evidence = string.Empty;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool candidate)
        {
            reasonCode = "remove_fence_tool_not_owned_in_slot";
            evidence = $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")}";
            blockedBy = new RefusalLayerToken(RefusalLayerKind.Tool, "none");
            return false;
        }
        bool gateNeedsAxeOrPickaxe = fence.isGate.Value && candidate is not Axe && candidate is not Pickaxe;
        if (gateNeedsAxeOrPickaxe || !fence.IsValidRemovalTool(candidate))
        {
            reasonCode = "remove_fence_tool_cannot_remove_target";
            evidence = $"slot={slot};tool={DescribeTool(candidate) ?? "none"};tool_kind={candidate.GetType().Name};is_gate={fence.isGate.Value.ToString().ToLowerInvariant()};item={fence.QualifiedItemId}";
            blockedBy = new RefusalLayerToken(RefusalLayerKind.Tool, DescribeToolCategory(candidate));
            return false;
        }
        tool = candidate;
        return true;
    }

    // ---------------------------------------------------------------------------------------------------------
    // put_item_in_fish_tank
    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Puts one carried item into a placed fish tank, through the tank's own
    /// <c>FishTankFurniture.checkForAction</c> (FishTankFurniture.cs:220-268). See the section of the file header
    /// below for the seam, what it writes, and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPutItemInFishTank(
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
        // General, not Physical: the seam drives no tool and starts no swing. It is one native interaction method on
        // the tank, the same profile `place_owned_object` and `color_placed_object` admit under.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        // THE TANK IS RE-RESOLVED FROM THE COLLECTION, not from the id: a fish tank is `Furniture` and therefore lives
        // in `location.furniture`, never in `location.objects` (GameLocation.cs:452). The id is what proves it is still
        // the piece the caller saw.
        FishTankFurniture? tank = FindPlacedFurniture(location, targetX, targetY) as FishTankFurniture;
        if (tank is null)
        {
            Furniture? other = FindPlacedFurniture(location, targetX, targetY);
            return other is null
                ? this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "fish_tank_target_not_found",
                    $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};furniture_in_location={location.furniture.Count};blocked_by={RefusalLayerToken.None.Format()}")
                : this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "fish_tank_target_is_not_a_tank",
                    $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};item={other.QualifiedItemId};furniture_type={other.GetType().Name};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        }
        if (!string.Equals(BuildPlacedFurnitureTargetId(location, targetX, targetY, tank), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "fish_tank_target_changed",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPlacedFurnitureTargetId(location, targetX, targetY, tank)};item={tank.QualifiedItemId};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Item carried
            || !string.Equals(carried.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || carried.Stack <= 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "fish_tank_item_not_owned_in_slot",
                $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")};expected={expectedQualifiedItemId};target={expectedTargetId};blocked_by={RefusalLayerToken.None.Format()}");
        // The game's own furniture reach, the same predicate the pickup and the rotation are gated on
        // (Furniture.IsCloseEnoughToFarmer, Furniture.cs:1295-1308): the tank's footprint inflated by 96 px.
        if (!tank.IsCloseEnoughToFarmer(Game1.player))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "fish_tank_out_of_range",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};furniture_tile={FormatTile(tank.TileLocation)};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, "furniture_reach").Format()}");
        // The tank's own mutex, read before anything is written. The native method answers TRUE doing nothing while the
        // lock is held (:231-234), which would be a silent no-op; naming it lets the companion retry or walk away.
        if (tank.mutex.IsLocked())
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "fish_tank_busy",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={carried.QualifiedItemId};held_items={tank.heldItems.Count};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");

        string itemId = carried.QualifiedItemId;
        int carriedBefore = CountQualifiedItem(Game1.player, itemId);
        int heldBefore = tank.heldItems.Count;
        int previousSlot = Game1.player.CurrentToolIndex;
        bool depositStarted;
        try
        {
            // THE ENGINE'S TWO ANSWERS, ASKED BEFORE ANY WRITE. `CanBeDeposited` is the tank's own acceptance rule
            // (:270-309: the FrogEgg trinket, the listed vanilla fish/decor ids, a hat for a hat-wearing fish, then
            // `Data/Aquarium`), and `HasRoomForThisItem` (:168-207) is its own per-category capacity. Asking them here
            // is what lets a refusal name the real reason: the native method's full-tank branch shows a red message and
            // answers true (:237-241) without depositing anything.
            if (!tank.CanBeDeposited(carried))
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "fish_tank_rejects_item",
                    $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};held_items={heldBefore};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
            if (!tank.HasRoomForThisItem(carried))
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "fish_tank_full",
                    $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};grade={tank.GetCategoryFromItem(carried)};capacity={tank.GetCapacityForCategory(tank.GetCategoryFromItem(carried))};held_items={heldBefore};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");

            // `checkForAction` reads the HELD item (`who.ActiveObject` / `who.CurrentItem`, :235), so the named slot is
            // made current for exactly the duration of the call and put back in the `finally` - the same discipline
            // `place_owned_object` follows, and the one piece of state this action writes around the engine.
            Game1.player.CurrentToolIndex = slot;
            try
            {
                depositStarted = tank.checkForAction(Game1.player);
            }
            finally
            {
                Game1.player.CurrentToolIndex = previousSlot;
            }
            // THE DEPOSIT COMPLETES ON A LATER ENGINE TICK. `checkForAction` parks the copy in `localDepositedItem` and
            // asks the tank's `NetMutex` for the lock (:242-263); `NetMutex.RequestLock` only RECORDS the request -
            // the acquired callback runs from `NetMutex.Update`, which the engine calls once per tick from
            // `StorageFurniture.updateWhenCurrentLocation` (:226-234). Driving that same public method once is how this
            // action settles the deposit inside one receipt instead of leaving the tank mid-interaction with the item
            // already taken out of the pack.
            if (tank.localDepositedItem is not null)
                tank.mutex.Update(location);
        }
        catch (Exception nativeException)
        {
            // Anything thrown here ran AFTER at most the item's removal from the pack, so the outcome is unknown - never
            // a success, and never a claim that nothing happened.
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "fish_tank_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};held_items_before={heldBefore};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // A DEPOSIT THAT DID NOT SETTLE GOES BACK. `localDepositedItem` is the engine's own hand-off slot, and the native
        // failure callback (:255-263) is exactly "give it back, then drop it on the floor if the pack is full". This
        // performs the first half of that callback and clears the slot, so a request can never leave the tank holding an
        // item that is in neither place.
        if (tank.localDepositedItem is Item pending)
        {
            bool restored = Game1.player.addItemToInventoryBool(pending);
            tank.localDepositedItem = null!;
            tank.mutex.ReleaseLock();
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "fish_tank_deposit_not_observed",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};native_answered={depositStarted.ToString().ToLowerInvariant()};held_items_before={heldBefore};held_items_after={tank.heldItems.Count};restored={restored.ToString().ToLowerInvariant()};mutex_locked_after={tank.mutex.IsLocked().ToString().ToLowerInvariant()}");
        }

        // Re-read AFTER the call. The tank's own `heldItems` is the authority on whether the item went in, and the pack is
        // the authority on whether it left.
        int heldAfter = tank.heldItems.Count;
        int carriedAfter = CountQualifiedItem(Game1.player, itemId);
        string lastHeld = "none";
        for (int index = heldAfter - 1; index >= 0; index--)
        {
            if (tank.heldItems[index] is Item held)
            {
                lastHeld = held.QualifiedItemId;
                break;
            }
        }
        bool deposited = heldAfter == heldBefore + 1 && string.Equals(lastHeld, itemId, StringComparison.Ordinal);
        bool leftThePack = carriedAfter == carriedBefore - 1;
        string evidence =
            $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={slot};"
            + $"native_answered={depositStarted.ToString().ToLowerInvariant()};held_items_before={heldBefore};held_items_after={heldAfter};"
            + $"last_held={lastHeld};carried_before={carriedBefore};carried_after={carriedAfter};"
            + $"mutex_locked_after={tank.mutex.IsLocked().ToString().ToLowerInvariant()}";
        return deposited && leftThePack
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "fish_tank_item_deposited", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "fish_tank_postcondition_not_observed", evidence);
    }

    // ---------------------------------------------------------------------------------------------------------
    // place_item_on_pedestal
    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Puts one carried item onto a placed item pedestal, through the pedestal's own
    /// <c>ItemPedestal.performObjectDropInAction</c> (ItemPedestal.cs:82-124). See the section of the file header below
    /// for the seam, the one branch that must never be reached, and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPlaceItemOnPedestal(
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
        // General, not Physical: no tool is swung. The pedestal's own interaction method is the whole write.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePedestal(location, targetX, targetY, expectedTargetId, out ItemPedestal? pedestal, out string pedestalRefusal, out RefusalLayerToken pedestalLayer, out string pedestalEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, pedestalRefusal, $"{pedestalEvidence};{DescribeRefusalLayer(pedestalLayer)}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Item carried
            || !string.Equals(carried.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || carried.Stack <= 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_item_not_owned_in_slot",
                $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")};expected={expectedQualifiedItemId};target={expectedTargetId};blocked_by={RefusalLayerToken.None.Format()}");
        // 5.2: out of the interaction radius, walk in rather than refuse - the same policy `remove_placed_item` follows,
        // and every position-independent check above is re-run in the shared body after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "place_item_on_pedestal",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecutePlaceItemOnPedestal(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecutePlaceItemOnPedestal(executionId, requestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    /// <summary>
    /// Executes place_item_on_pedestal against the current world, re-validating the pedestal and the item because an
    /// approach leg may have taken several ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecutePlaceItemOnPedestal(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryDescribePedestal(location, targetX, targetY, expectedTargetId, out ItemPedestal? pedestal, out string pedestalRefusal, out RefusalLayerToken pedestalLayer, out string pedestalEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, pedestalRefusal, $"{pedestalEvidence};{DescribeRefusalLayer(pedestalLayer)}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Item carried
            || !string.Equals(carried.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || carried.Stack <= 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_item_not_owned_in_slot",
                $"slot={slot};slot_item={(slot >= 0 && slot < Game1.player.Items.Count ? Game1.player.Items[slot]?.QualifiedItemId ?? "empty" : "out_of_range")};expected={expectedQualifiedItemId};target={expectedTargetId};blocked_by={RefusalLayerToken.None.Format()}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_out_of_range",
                $"target={targetX},{targetY};location={location.NameOrUniqueName};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, "pedestal_reach").Format()}");

        // A PEDESTAL THAT ALREADY HOLDS SOMETHING IS REFUSED, NEVER DRIVEN. The native occupied branch is
        // `if (heldObject.Value != null && !probe) { DropObject(who); return false; }` (:97-101) - it KNOCKS THE
        // EXISTING ITEM OFF and then answers false, so a caller that reached it would trade one item for no deposit. The
        // engine's own ingress clears `heldObject` around its probe call for exactly this reason (:7768-7771); this action
        // does not need to, because the probe below runs while the pedestal is provably empty.
        if (pedestal!.heldObject.Value is not null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_occupied",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};held={pedestal.heldObject.Value.QualifiedItemId};item={carried.QualifiedItemId};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        // The pedestal's own lock. `locked` is set by `UpdateItemMatch` (:126-141) when the item it wants has been
        // placed and `lockOnSuccess` is set, and the native method refuses outright while it is true (:89-92).
        if (pedestal.locked.Value)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_locked",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={carried.QualifiedItemId};match={(pedestal.match.Value.ToString().ToLowerInvariant())};lock_on_success={(pedestal.lockOnSuccess.Value.ToString().ToLowerInvariant())};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");
        // The pedestal's own mutex, read before anything is written: while it is held the native method parks the write in
        // `RequestLock`, and its FAILURE callback would drop the item on the floor (:113-119) rather than refuse.
        if (pedestal.itemModifyMutex.IsLocked())
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "pedestal_busy",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={carried.QualifiedItemId};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");

        string itemId = carried.QualifiedItemId;
        int carriedBefore = CountQualifiedItem(Game1.player, itemId);
        bool droppedIn;
        try
        {
            // THE PEDESTAL'S OWN VERDICT, ASKED BEFORE THE WRITE. `probe: true` runs the two acceptance guards - the item must
            // be trashable (:93-96) and must be EXACTLY a plain `Object` (:102), so a hat, a piece of clothing or a piece of
            // furniture is not this pedestal's subject - and performs no write at all.
            if (!pedestal.performObjectDropInAction(carried, probe: true, Game1.player))
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "pedestal_rejects_item",
                    $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};item_type={carried.GetType().Name};can_be_trashed={(carried.canBeTrashed().ToString().ToLowerInvariant())};blocked_by={RefusalProbe.ObjectOn(location, new Vector2(targetX, targetY)).Format()}");

            // The write. The item is handed to the method directly - it takes the drop item as an argument, so unlike the
            // fish tank there is no held-slot state to swap around the call.
            droppedIn = pedestal.performObjectDropInAction(carried, probe: false, Game1.player);
            // THE DEPOSIT SETTLES ON A LATER TICK. The write lives in `itemModifyMutex.RequestLock`'s acquired callback
            // (:107-113), and `RequestLock` only records the request; the callback runs from `NetMutex.Update`, which the
            // engine calls once per tick from `ItemPedestal.updateWhenCurrentLocation` (:195-201). Driving that same public
            // method once settles it inside one receipt.
            if (droppedIn)
                pedestal.itemModifyMutex.Update(location);
            // The engine's own ingress consumes the stack AFTER a handled drop (GameLocation.cs:7781-7784), and the item
            // it spends is the one it HANDED to the pedestal - `who.CurrentItem`, the held one (:7772). This action hands
            // the item out of the slot the caller named, so that slot is what the deposit comes out of;
            // `Farmer.reduceActiveItemByOne` (Farmer.cs:5083) spends whatever the actor happens to be HOLDING instead,
            // which is a different item, or a tool, or nothing at all.
            if (droppedIn)
                ConsumeOneFromSlot(slot);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "pedestal_native_exception",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        int carriedAfter = CountQualifiedItem(Game1.player, itemId);
        bool holdsIt = pedestal.heldObject.Value is StardewValley.Object placed
            && string.Equals(placed.QualifiedItemId, itemId, StringComparison.Ordinal);
        if (!holdsIt)
        {
            // THE ITEM DID NOT LAND, SO IT GOES BACK. The stack was already reduced above, and the pedestal's own failure
            // callback would have dropped the copy as debris (:113-119) - the second half of that callback is "put it in the
            // pack", which is what this performs before answering.
            bool restored = false;
            if (carriedAfter < carriedBefore)
                restored = Game1.player.addItemToInventoryBool(carried.getOne());
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "pedestal_deposit_not_observed",
                $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};native_answered={droppedIn.ToString().ToLowerInvariant()};carried_before={carriedBefore};carried_after={CountQualifiedItem(Game1.player, itemId)};held={(pedestal.heldObject.Value?.QualifiedItemId ?? "none")};restored={restored.ToString().ToLowerInvariant()};mutex_locked_after={pedestal.itemModifyMutex.IsLocked().ToString().ToLowerInvariant()}");
        }

        string evidence =
            $"target={expectedTargetId};tile={targetX},{targetY};location={location.NameOrUniqueName};item={itemId};slot={slot};"
            + $"native_answered={droppedIn.ToString().ToLowerInvariant()};held={(pedestal.heldObject.Value?.QualifiedItemId ?? "none")};"
            + $"match={(pedestal.match.Value.ToString().ToLowerInvariant())};locked={(pedestal.locked.Value.ToString().ToLowerInvariant())};"
            + $"lock_on_success={(pedestal.lockOnSuccess.Value.ToString().ToLowerInvariant())};"
            + $"carried_before={carriedBefore};carried_after={CountQualifiedItem(Game1.player, itemId)}";
        bool leftThePack = CountQualifiedItem(Game1.player, itemId) == carriedBefore - 1;
        return droppedIn && leftThePack
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "pedestal_item_placed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "pedestal_postcondition_not_observed", evidence);
    }

    /// <summary>
    /// Takes one unit out of a NAMED pack slot, with the engine's own bookkeeping for an emptied stack
    /// (<c>Farmer.removeItemFromInventory</c>, Farmer.cs:5105-5116: the item's <c>actionWhenStopBeingHeld</c> runs and the
    /// slot is cleared). The engine's counterpart, <c>Farmer.reduceActiveItemByOne</c> (Farmer.cs:5083), is this same
    /// fact read from the HAND; the two agree only when the item being spent is the held one.
    /// </summary>
    private static void ConsumeOneFromSlot(int slot)
    {
        if (slot < 0 || slot >= Game1.player.Items.Count) return;
        if (Game1.player.Items[slot] is not Item item) return;
        item.Stack--;
        if (item.Stack <= 0) Game1.player.removeItemFromInventory(item);
    }

    /// <summary>
    /// Re-derives the named pedestal on the game thread. A tile holding something else is a NAMED refusal, and the target id
    /// is this action's own: an EMPTY pedestal carries no held item, so it cannot be named through the `pedestalTargets`
    /// identity the take action uses (that one binds the item and its stack and is published only while the pedestal holds
    /// something).
    /// </summary>
    private static bool TryDescribePedestal(
        GameLocation location,
        int x,
        int y,
        string expectedTargetId,
        out ItemPedestal? pedestal,
        out string reasonCode,
        out RefusalLayerToken blockedBy,
        out string evidence)
    {
        pedestal = null;
        reasonCode = "accepted";
        blockedBy = RefusalLayerToken.None;
        evidence = string.Empty;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is null)
        {
            reasonCode = "pedestal_target_not_found";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object=none";
            return false;
        }
        if (placed is not ItemPedestal candidate)
        {
            reasonCode = "pedestal_target_is_not_a_pedestal";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object={placed.QualifiedItemId};object_type={placed.GetType().Name}";
            blockedBy = RefusalProbe.ObjectOn(location, tile);
            return false;
        }
        if (!string.Equals(BuildPedestalDepositTargetId(location, x, y, candidate), expectedTargetId, StringComparison.Ordinal))
        {
            reasonCode = "pedestal_target_changed";
            evidence = $"target={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};live={BuildPedestalDepositTargetId(location, x, y, candidate)};item={candidate.QualifiedItemId}";
            blockedBy = RefusalProbe.ObjectOn(location, tile);
            return false;
        }
        pedestal = candidate;
        return true;
    }

    /// <summary>
    /// The identity one EMPTY pedestal is published and addressed under: the location, the tile and the pedestal's own item
    /// id. It deliberately binds nothing the deposit changes, so the id a caller reads from the observation is still the id
    /// the action re-derives a moment later.
    /// </summary>
    internal static string BuildPedestalDepositTargetId(GameLocation location, int x, int y, ItemPedestal pedestal)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{pedestal.QualifiedItemId}:pedestal-deposit";
        return $"pedestal_deposit_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
