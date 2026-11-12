using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// FarmhandExecutionController game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// How long after the last publication that still saw a ground chunk the actor's own inventory count may be read
    /// as proof that the chunk was delivered to them.
    /// </summary>
    /// <remarks>
    /// A sanity bound, not the evidence. Between the observation that published the target and the dispatch that acts
    /// on it there is a walk plus at least one model round-trip, so the window has to cover a whole plan node; what it
    /// stops is a target id replayed long after the drop, when "the backpack holds more of this item" could have been
    /// earned by some later collection entirely.
    /// </remarks>
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

    /// <summary>
    /// The execution whose magnet window is being measured, and the tick this Mod's update first saw the walk hand the
    /// body back with the pickup still owed. Keyed by execution identity so a later pickup cannot inherit the elapsed
    /// time of an earlier one.
    /// </summary>
    private string? itemPickupMagnetExecutionId;
    private long itemPickupMagnetStartedTick;

    /// <summary>
    /// How many of this Mod's updates the magnet phase has had, stamping its first one. Called only on a tick where the
    /// walk has released the body: a walk that spends the request's deadline is the walk's budget, not the magnet's.
    /// </summary>
    private int ItemPickupMagnetTicks(string executionId)
    {
        if (!string.Equals(this.itemPickupMagnetExecutionId, executionId, StringComparison.Ordinal))
        {
            this.itemPickupMagnetExecutionId = executionId;
            this.itemPickupMagnetStartedTick = this.tick;
        }

        return (int)(this.tick - this.itemPickupMagnetStartedTick);
    }

    /// <summary>Published native forage pickup. The native location action owns inventory and object removal.</summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        // The address IS the identity: `expectedTargetId` hashes the location, the tile, the qualified item id, the stack
        // and `IsSpawnedObject`, and the two comparisons below recompute it from the LIVE object on this thread. Nothing
        // else has to agree for the target to be the one the caller read.
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? forage)
            || !forage.isForage())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_unavailable", $"target={targetX},{targetY}");
        if (!string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(BuildForageTargetId(location, targetX, targetY, forage), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_unavailable", $"target={targetX},{targetY}");
        if (!Game1.player.couldInventoryAcceptThisItem(forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        LocalForagePickupSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        // Preserve the target-version player action ingress. tryToCheckAt owns
        // the bridge-state/radius guards and SMAPI check-action hook before it
        // reaches GameLocation.checkAction; direct checkAction would bypass
        // those native player-path constraints.
        bool actionHandled = Game1.tryToCheckAt(tile, Game1.player);
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool removed = !location.objects.ContainsKey(tile);
        bool inventoryChangedExactlyOnce = afterCount == beforeCount + 1;
        ExecutionState state = actionHandled && removed && inventoryChangedExactlyOnce ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "forage_picked_up" : "forage_postcondition_unavailable";
        string evidence = $"location={specification.Location};targetIdentity={specification.TargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};removed={removed};inventory_before={beforeCount};inventory_after={afterCount}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    /// <summary>
    /// How far a published chunk may have drifted and still be the same chunk.
    ///
    /// Three tiles: far enough for a chunk sliding down to a magnet or settling out of a dropped stack, short enough that an
    /// id which survived a `location.debris` reindex cannot quietly point at a different chunk a field away.
    /// </summary>
    private const int ChunkDriftTolerance = 3;

    /// <summary>
    /// Requests pickup through the engine's own magnet: the body is walked into the rectangle <c>Debris.playerInRange</c>
    /// reads, and <c>Debris.updateChunks</c> then does the collecting.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Ordinary debris has no click action: its own GameLocation update magnetizes it to an eligible nearby Farmer and
    /// calls <c>Debris.collect</c>. The walk therefore goes to a STAND tile inside the engine's pixel rectangle, not to
    /// the chunk's own tile - which is the fact this path had wrong, and the reason a chunk lying where no body can
    /// stand was answered `no_native_path` / `no_reachable_approach` while it was collectable from the tile beside it.
    /// The bridge never waits on, calls, or replaces <c>Debris.collect</c>, removes a chunk, or moves an item.
    /// </para>
    /// <para>
    /// The geometry lives in <see cref="MagneticPickupReach"/>: the reach is read from the engine on every request and
    /// the stand tile is chosen by the predicates the body controller already answers, so nothing here spells a tile
    /// count. When the body is already inside the rectangle no walk is armed at all, and the accepted receipt says so.
    /// </para>
    /// </remarks>
    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        StardewValley.GameLocation location = Game1.player.currentLocation;
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target =
            FindItemTarget(location, expectedTargetId, expectedQualifiedItemId);
        if (target is null)
        {
            // Three different facts hide behind "no chunk of this identity is on the ground", and one refusal for all of
            // them is a lie about two:
            //
            //   CHANGED - something else of this item now lies on the address the caller named. The same tile, a
            //             different chunk: a stack that lost half its count to another farmer's magnet is the common
            //             one. Reported as CHANGED with both identities and the shared tile, never as a move.
            //   GONE    - nothing is there. The engine's own magnet is the common cause: it delivers a chunk straight
            //             into a nearby Farmer's backpack, which is this action's SUCCESS when the actor's own count of
            //             the item rose from where it stood while the chunk was still on the ground (round 18 spent six
            //             turns of re-observation on drops the companion was already carrying).
            //   neither - a stale or forged address. Nothing was collected and nothing moved, so nothing is claimed.
            if (FindChunkOnTile(location, targetX, targetY, expectedQualifiedItemId) is { } changed)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"expected={expectedTargetId};actual={changed.TargetId};tile={targetX},{targetY}");
            if (this.TrySettleMagnetCollectedItem(requestId, executionId, boundActor, location, expectedTargetId, expectedQualifiedItemId, targetX, targetY) is LocalExecutionReceipt collected)
                return collected;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"expected={expectedTargetId};actual=none;tile={targetX},{targetY}");
        }
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (liveTargetTile.X != targetX || liveTargetTile.Y != targetY)
        {
            // A chunk that DRIFTED is still the same chunk; a chunk that was REINDEXED is not.
            //
            // `BuildItemTargetId` names the entity by `debrisIndex`/`chunkIndex`/item/stack/quality - deliberately NOT by
            // position, so a settling chunk keeps its identity. The coordinate was then checked as a second, EQUAL
            // authority, and `location.debris` is a list: removing one debris shifts every later index, so a stale
            // publication can resolve to a DIFFERENT chunk under the same id. Both facts are real, so neither
            // "trust the id" nor "trust the coordinate" is right on its own.
            //
            // Measured 2026-11-03 (`round28`): one `item_target_moved` in 13,937 log lines, carrying
            // `expected=x,y;actual=x,y` a couple of tiles apart - a chunk still settling, refused for a move that had
            // not changed what it was.
            //
            // So the coordinate is corroboration with a tolerance: a chunk within `ChunkDriftTolerance` tiles of where
            // the caller saw it is the same chunk that has moved; further away it may be an index that now points at
            // something else, and that stays a refusal. Either way the TILE moved, so `item_target_moved` is true here
            // and the two tiles are named.
            int driftX = Math.Abs(liveTargetTile.X - targetX);
            int driftY = Math.Abs(liveTargetTile.Y - targetY);
            if (Math.Max(driftX, driftY) > ChunkDriftTolerance)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTargetTile.X},{liveTargetTile.Y}");
        }
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        // WHERE the body stands. The engine's rectangle is the whole requirement: a chunk inside it is collected, and
        // a chunk on a tile nobody can stand on is collected from beside it. No standable tile inside the rectangle is
        // the one geometry no walk can fix, and it is refused as that rather than as a tile the world does not have.
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
        // `within_magnet` is a claim about the stand tile, not about where the body happens to be now: every acceptance
        // below is dispatched to a tile the engine's own rectangle contains, and `stand_at` names it.
        string magnetFacts = $"within_magnet=true;radius={magnetRadius};stand_at={standTile.Value.X},{standTile.Value.Y}";
        // The body controller drives the walk. `Debris.updateChunks` owns magnetic delivery and `Debris.collect` on
        // following game updates; the bridge never calls collect or touches chunks/inventory directly.
        this.slots.ItemPickup.Assign(new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs));
        if (standTile.Value != actorTile)
        {
            // Exact arrival on the chosen tile, not adjacency to it: the tile is standable and reachable by
            // construction, so a plan to it exists, and finishing a step short could leave the body outside the very
            // rectangle this walk exists to enter.
            LocalMoveSpec approach = new(executionId, requestId, new Vector2(standTile.Value.X, standTile.Value.Y), false, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
            this.slots.Active.Assign(approach);
            if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
            {
                this.slots.Active.Clear();
                this.slots.ItemPickup.Clear();
                // WHAT the walk was for, published whether or not the walk said why it refused. `??` made the two
                // exclusive, so every refusal that named its own cause dropped `within_magnet`, `radius` and
                // `stand_at` - the facts that say whether stepping closer would have helped or the drop is out of this
                // body's reach. Additive: the controller's own evidence is carried untouched, ahead of them.
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

    /// <summary>
    /// Where the body stands relative to the chunk, in the units <c>Debris.playerInRange</c> compares: both tiles, the
    /// per-axis pixel distance between the chunk's centre and the body's standing pixel, and the reach it is compared
    /// against.
    /// </summary>
    /// <remarks>
    /// A settlement that says only "no" sends the caller back to re-observe and guess. These four facts are the whole
    /// geometry of the refusal, and they are the engine's own measurements rather than a tile count of ours, so a
    /// caller can step one tile toward <c>chunk_tile</c> and try again knowing why.
    /// </remarks>
    private static string DescribeItemPickupReach(Farmer actor, Point chunkTile, Vector2 subject)
    {
        Point standing = actor.StandingPixel;
        float distanceX = subject.X + MagneticPickupReach.ChunkCentreOffset - standing.X;
        float distanceY = subject.Y + MagneticPickupReach.ChunkCentreOffset - standing.Y;
        return $"actor_tile={(int)actor.Tile.X},{(int)actor.Tile.Y};chunk_tile={chunkTile.X},{chunkTile.Y};"
            + $"axis_distance_px={distanceX.ToString("0.#", CultureInfo.InvariantCulture)},{distanceY.ToString("0.#", CultureInfo.InvariantCulture)};radius={MagneticPickupReach.ReachPixels(actor)}";
    }

    /// <summary>
    /// Settles a <c>pickup_item</c> whose chunk has already left the ground, when the actor's OWN backpack shows the
    /// delivery - i.e. the engine's magnet collected the drop before this request arrived.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns <see langword="null"/> whenever the evidence does not hold, so the caller keeps answering with the
    /// refusal it always has. The three checks are the three ways a vanished chunk is NOT this farmer's pickup:
    /// no publication ever described this target (nothing to measure from); the row describes a different location,
    /// tile or item than the request (a stale or forged id); or the actor's count of the item is still where it was
    /// when the chunk was last seen on the ground - which is exactly what another magnet-bearing Farmer, a chest or a
    /// shipping bin leaves behind, since none of them puts anything in THIS farmer's backpack.
    /// </para>
    /// <para>
    /// The evidence is the SAME nine keys <c>pickup_item</c>'s completion already uses, because the Host decides this
    /// action's completion by parsing exactly those keys
    /// (<c>host/src/stardew-game-integration-adapter.ts</c> - <c>hasPickupItemCompletionEvidence</c>: location, target,
    /// tile, item, stack, native_auto_collect, chunk_removed, inventory_before, inventory_after, with
    /// <c>stack &gt;= 1</c>, both flags true, and <c>after &gt;= before + stack</c>). <c>native_auto_collect</c> is this
    /// action's own mechanism, and <c>chunk_removed</c> is the fact the caller just proved by finding no chunk of this
    /// identity anywhere in the location.
    /// </para>
    /// </remarks>
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
