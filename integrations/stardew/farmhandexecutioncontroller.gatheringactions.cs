using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private const int ItemPickupMagnetClaimTicks = 60 * 60 * 5;

    /// <summary>
    /// How many of this Mod's own updates the engine's magnet may have to deliver a ground chunk before the wait is
    /// settled. Not the catalogue's watchdog, which bounds liveness for every action and stays where it is.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Reading the engine's own path rather than guessing: a chunk may not move until <c>timeSinceDoneBouncing</c>
    /// reaches 600 ms (Debris.cs:636-637), it then travels at most 0.8 px per axis per update with the ramp capped at 8
    /// (Debris.cs:760-778), and it is collected only once its centre is inside 64 px per axis of the body's standing
    /// pixel (Debris.cs:779-783, then <c>farmer.addItemToInventoryBool(item)</c> at :485 and the chunk leaving
    /// <c>Chunks</c> at :793). So the worst case is the 600 ms of settling - 36 updates at the game's 60 per second -
    /// plus the 13 the ramp needs to close the last 64 px of a 128 px reach: about 50 updates. 120 is that budget with
    /// the same kind of margin the pedestal's mutex window gives its own hand-over, and because it counts UPDATES a
    /// slower machine only lengthens it in seconds, never shortens it in fairness.
    /// </para>
    /// <para>
    /// The silence it replaces was measured across one receipt channel (269 <c>pickup_item</c> executions): p50 0 ms,
    /// p95 3.3 s, and nine at 59.8-60.0 s - those nine were waiting for the watchdog, not for the magnet.
    /// </para>
    /// </remarks>
    internal const int ItemPickupMagnetWindowTicks = 120;

    private string? itemPickupMagnetExecutionId;
    private long itemPickupMagnetStartedTick;

    private int ItemPickupMagnetTicks(string executionId)
    {
        if (!string.Equals(this.itemPickupMagnetExecutionId, executionId, StringComparison.Ordinal))
        {
            this.itemPickupMagnetExecutionId = executionId;
            this.itemPickupMagnetStartedTick = this.tick;
        }

        return (int)(this.tick - this.itemPickupMagnetStartedTick);
    }

    /// <summary>
    /// Published native forage pickup. The native location action owns inventory and object removal.
    ///
    /// <para>
    /// OUT OF THE NATIVE RANGE THE ACTOR WALKS IN. <c>Utility.tileWithinRadiusOfPlayer(tile, 1)</c> is not this action's
    /// rule - it is the engine's own guard on the click path (<c>Game1.cs:11509</c> requires it before
    /// <c>checkAction</c>, which is what <c>Game1.tryToCheckAt</c> runs), so a player picking up a daffodil walks to it
    /// first and clicks. The request path used to answer that distance with <c>forage_target_out_of_range</c> instead,
    /// which is the refusal a walk belongs in: measured `round65`, the only failure class in the whole run was four of
    /// them, and one lily was never picked. The walk is the one every other gathering action already takes
    /// (<see cref="TryBeginToolApproach"/>), so the radius now decides WHETHER TO WALK, never whether to answer.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "pickup_forage",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecutePickupForage(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs);

        return this.ExecutePickupForage(executionId, requestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs);
    }

    /// <summary>
    /// The terminal half of <c>pickup_forage</c>: the same body, run either in place or on arrival from the approach leg,
    /// so the two paths cannot drift apart.
    ///
    /// <para>
    /// THE ITEM BEING GONE IS ITS OWN ENDING. A walk takes ticks, and a forageable can leave the tile in that time - a
    /// hoed-up daffodil, a second actor, a season change. `target_not_found` says the published target no longer exists,
    /// which a caller answers by observing again; `forage_target_unavailable` says the tile holds something that answers
    /// neither its published item nor its published id, which is a different correction. Collapsing them into one code
    /// was invisible while nothing walked: the same tick that read the target also picked it up.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt ExecutePickupForage(string executionId, string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        StardewValley.GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_not_found",
                $"target={targetX},{targetY};expected={expectedQualifiedItemId};actual=none");
        if (!forage.isForage()
            || !string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(BuildForageTargetId(location, targetX, targetY, forage), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_unavailable",
                $"target={targetX},{targetY};expected={expectedQualifiedItemId};actual={forage.QualifiedItemId};is_forage={(forage.isForage() ? "true" : "false")};blocked_by={new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, "different_object").Format()}");
        if (!Game1.player.couldInventoryAcceptThisItem(forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetX},{targetY};item={forage.QualifiedItemId}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        LocalForagePickupSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool actionHandled = Game1.tryToCheckAt(tile, Game1.player);
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool removed = !location.objects.ContainsKey(tile);
        bool inventoryChangedExactlyOnce = afterCount == beforeCount + 1;
        ExecutionState state = actionHandled && removed && inventoryChangedExactlyOnce ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "forage_picked_up" : "forage_postcondition_unavailable";
        string evidence = $"location={specification.Location};targetIdentity={specification.TargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};removed={removed};inventory_before={beforeCount};inventory_after={afterCount}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    private const int ChunkDriftTolerance = 3;

    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        StardewValley.GameLocation location = Game1.player.currentLocation;
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target =
            FindItemTarget(location, expectedTargetId, expectedQualifiedItemId);
        if (target is null)
        {
            if (FindChunkOnTile(location, targetX, targetY, expectedQualifiedItemId) is { } changed)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"expected={expectedTargetId};actual={changed.TargetId};tile={targetX},{targetY}");
            if (this.TrySettleMagnetCollectedItem(requestId, executionId, boundActor, location, expectedTargetId, expectedQualifiedItemId, targetX, targetY) is LocalExecutionReceipt collected)
                return collected;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"expected={expectedTargetId};actual=none;tile={targetX},{targetY}");
        }
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (liveTargetTile.X != targetX || liveTargetTile.Y != targetY)
        {
            int driftX = Math.Abs(liveTargetTile.X - targetX);
            int driftY = Math.Abs(liveTargetTile.Y - targetY);
            if (Math.Max(driftX, driftY) > ChunkDriftTolerance)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTargetTile.X},{liveTargetTile.Y}");
        }
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        int magnetRadius = MagneticPickupReach.ReachPixels(Game1.player);
        Vector2 magnetSubject = MagneticPickupReach.Subject(target.Value.Debris);
        (int X, int Y) actorTile = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        (int X, int Y)? standTile = MagneticPickupReach.WithinMagnet(magnetSubject, Game1.player.StandingPixel, magnetRadius)
            ? actorTile
            : MagneticPickupReach.SelectStandTile(
                magnetSubject,
                (liveTargetTile.X, liveTargetTile.Y),
                actorTile,
                Game1.player.StandingPixel,
                magnetRadius,
                tile => StardewBodyController.IsStandableTile(location, Game1.player, new Vector2(tile.X, tile.Y))
                    && !IsWarpBufferTile(location, tile),
                StardewBodyController.BuildWalkableComponent(location, Game1.player) is { } walkable
                    ? tile => walkable(new Vector2(tile.X, tile.Y))
                    : _ => true);
        if (standTile is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_out_of_reach",
                $"tile={liveTargetTile.X},{liveTargetTile.Y};actor={actorTile.X},{actorTile.Y};radius={magnetRadius};stand_at=none"
                    + DescribeApproachRange(liveTargetTile.X, liveTargetTile.Y, standingTileAsked: true));

        int beforeCount = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        string magnetFacts = $"within_magnet=true;radius={magnetRadius};stand_at={standTile.Value.X},{standTile.Value.Y}";
        this.slots.ItemPickup.Assign(new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs));
        if (standTile.Value != actorTile)
        {
            LocalMoveSpec approach = new(executionId, requestId, new Vector2(standTile.Value.X, standTile.Value.Y), false, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
            this.slots.Active.Assign(approach);
            if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
            {
                this.slots.Active.Clear();
                this.slots.ItemPickup.Clear();
                string magnetRefusal = $"target={expectedTargetId};{magnetFacts}";
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode,
                    approachEvidence is null ? magnetRefusal : $"{approachEvidence};{magnetRefusal}");
            }
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted",
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={liveTargetTile.X},{liveTargetTile.Y};item={expectedQualifiedItemId};stack={target.Value.Stack};inventory_before={beforeCount};native_auto_collect=true;{magnetFacts}");
    }

    /// <summary>
    /// Which of the engine's own pickup preconditions this body no longer satisfies, or <see langword="null"/> when
    /// the wait it is in still has a way to end.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>Debris.updateChunks</c> re-asks two things about a waiting chunk on EVERY game update: whether the body is
    /// still inside the pixel rectangle <c>playerInRange</c> reads (Debris.cs:582-595, re-asked at :678) and whether
    /// this farmer's pack will take the item (:732-744). The bridge asked the first of those once, when the request
    /// arrived - so a chunk that slid while she walked, or a body that finished its walk a pixel outside the rectangle,
    /// was never re-tested and the action waited out its whole deadline with nothing left that could happen.
    /// </para>
    /// <para>
    /// The engine's other two guards - <c>shouldControlThis</c> (Debris.cs:621-628) and <c>IsLocalPlayer</c> (:758) -
    /// are topology rather than a condition that can change while one request is being served, so they are answered at
    /// admission and not re-asked here. The bounce timer (:636-637) is a wait, not a refusal: it is what
    /// <c>ItemPickupMagnetWindowTicks</c> bounds.
    /// </para>
    /// </remarks>
    private static string? BrokenItemPickupPrecondition(Farmer actor, Debris debris)
    {
        if (!MagneticPickupReach.WithinMagnet(MagneticPickupReach.Subject(debris), actor.StandingPixel, MagneticPickupReach.ReachPixels(actor)))
            return "player_in_range";
        bool acceptsTheDrop = debris.item is { } held
            ? actor.couldInventoryAcceptThisItem(held)
            : actor.couldInventoryAcceptThisItem(debris.itemId.Value, 1, debris.itemQuality);
        return acceptsTheDrop ? null : "inventory_full";
    }

    private static string DescribeItemPickupReach(Farmer actor, Point chunkTile, Vector2 subject)
    {
        Point standing = actor.StandingPixel;
        float distanceX = subject.X + MagneticPickupReach.ChunkCentreOffset - standing.X;
        float distanceY = subject.Y + MagneticPickupReach.ChunkCentreOffset - standing.Y;
        return $"actor_tile={(int)actor.Tile.X},{(int)actor.Tile.Y};chunk_tile={chunkTile.X},{chunkTile.Y};"
            + $"axis_distance_px={distanceX.ToString("0.#", CultureInfo.InvariantCulture)},{distanceY.ToString("0.#", CultureInfo.InvariantCulture)};radius={MagneticPickupReach.ReachPixels(actor)}";
    }

    private LocalExecutionReceipt? TrySettleMagnetCollectedItem(
        string requestId,
        string executionId,
        Farmer boundActor,
        StardewValley.GameLocation location,
        string expectedTargetId,
        string expectedQualifiedItemId,
        int targetX,
        int targetY)
    {
        GroundItemPublication? publication = this.groundItemTargets.Recall(expectedTargetId);
        if (publication is null
            || publication.TileX != targetX
            || publication.TileY != targetY
            || !string.Equals(publication.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !string.Equals(publication.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return null;
        int ageTicks = this.tick - publication.PublishedTick;
        if (ageTicks < 0 || ageTicks > ItemPickupMagnetClaimTicks)
            return null;

        int inventoryNow = CountQualifiedItem(boundActor, expectedQualifiedItemId);
        if (!publication.MagnetDeliveredIt(inventoryNow))
            return null;

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "item_picked_up",
            $"location={publication.Location};target={expectedTargetId};tile={publication.TileX},{publication.TileY};item={expectedQualifiedItemId};stack={publication.Stack};native_auto_collect=true;chunk_removed=true;inventory_before={publication.InventoryAtPublication};inventory_after={inventoryNow}");
    }

}
