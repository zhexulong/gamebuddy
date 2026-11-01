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
    private SceneTargetResolver? sceneTargetResolver;

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

    internal void SetSceneTargetResolver(SceneTargetResolver resolver)
    {
        this.sceneTargetResolver = resolver ?? throw new ArgumentNullException(nameof(resolver));
    }

    /// <summary>Published native forage pickup. The native location action owns inventory and object removal.</summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, ObservationBindingV1? sceneTarget, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        SceneAffordanceBinding? binding = null;
        string sceneReason = "scene_ref_invalid";
        if (this.sceneTargetResolver is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "observation_binding_precondition_failed", null);
        if (!this.sceneTargetResolver(sceneTarget, out binding, out sceneReason))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, sceneReason, null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "observation_binding_target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (binding is null
            || !string.Equals(binding.LocationName, location.NameOrUniqueName, StringComparison.Ordinal)
            || binding.TileX != targetX
            || binding.TileY != targetY
            || !location.objects.TryGetValue(tile, out StardewValley.Object? forage)
            || !forage.isForage())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "observation_binding_target_unavailable", $"target={targetX},{targetY}");
        if (!string.Equals(binding.OpaqueEntityIdentity, forage.QualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(BuildForageTargetId(location, targetX, targetY, forage), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "observation_binding_target_unavailable", $"target={targetX},{targetY}");
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
    /// Requests pickup through target-version Debris lifecycle. Ordinary debris
    /// has no click action: its own GameLocation update magnetizes it to an
    /// eligible nearby Farmer and calls Debris.collect. The bridge only waits
    /// for that native delivery; it never calls collect, removes chunks, or
    /// mutates inventory itself.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
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

        StardewValley.GameLocation location = Game1.player.currentLocation;
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = FindItemTarget(location, Game1.player, expectedTargetId, expectedQualifiedItemId, radius: 8);
        if (target is null)
        {
            // The chunk is not in the reaching radius. Two very different facts hide behind that one answer, and they
            // must not be collapsed into one refusal:
            //
            //   MOVED - the chunk is still lying on the ground somewhere in this location, just not where the action
            //           can reach it. Nothing has been collected, so this must never settle as a pickup.
            //   GONE  - the chunk has left the ground. The engine's own magnet is the common cause: it delivers a
            //           chunk to a nearby Farmer straight into their backpack, which is this action's SUCCESS, not its
            //           failure. Round 18 spent six turns of re-observation on drops the companion was already carrying
            //           because the magnet got there first and this preflight called it `item_target_changed`.
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? stillOnGround =
                FindItemTarget(location, Game1.player, expectedTargetId, expectedQualifiedItemId, radius: int.MaxValue);
            if (stillOnGround is not null)
            {
                Point liveTile = GetChunkTile(stillOnGround.Value.Chunk);
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTile.X},{liveTile.Y}");
            }
            if (this.TrySettleMagnetCollectedItem(requestId, executionId, boundActor, location, expectedTargetId, expectedQualifiedItemId, targetX, targetY) is LocalExecutionReceipt collected)
                return collected;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"target={targetX},{targetY}");
        }
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (liveTargetTile.X != targetX || liveTargetTile.Y != targetY)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTargetTile.X},{liveTargetTile.Y}");
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        int beforeCount = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        // The body controller drives this native approach. Debris.updateChunks
        // owns magnetic delivery and Debris.collect on following game updates;
        // the bridge never calls collect or touches chunks/inventory directly.
        LocalMoveSpec approach = new(executionId, requestId, new Vector2(liveTargetTile.X, liveTargetTile.Y), true, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
        this.activeItemPickup = new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs);
        this.active = approach;
        if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
        {
            this.active = null;
            this.activeItemPickup = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, approachEvidence ?? $"target={expectedTargetId};tile={targetX},{targetY}");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};stack={target.Value.Stack};inventory_before={beforeCount};native_auto_collect=true");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
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
