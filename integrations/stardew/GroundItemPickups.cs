using System;
using System.Collections.Generic;

namespace GameBuddy.Stardew;

/// <summary>
/// What the Mod published about ONE chunk of ground debris, measured at the last publication that could still see
/// that chunk lying on the ground.
/// </summary>
/// <remarks>
/// <para>
/// This exists because the engine's magnet can settle a <c>pickup_item</c> before the request for it ever arrives.
/// <c>GameLocation</c>'s own debris update (<c>Debris.updateChunks</c>) magnetizes a chunk into an eligible nearby
/// Farmer and calls <c>Debris.collect</c> for it, with no bridge request involved; the drop is then already in the
/// actor's backpack by the time the plan node that walks to that tile dispatches <c>pickup_item</c>. Measured in
/// round 18: <c>item_target_changed</c> six times in one run, each one an item the companion was ALREADY CARRYING,
/// followed by turns of re-observation over a drop that no longer existed.
/// </para>
/// <para>
/// The count is the discriminating fact, and it is the only one that separates the engine's magnet from the other
/// explanations for a chunk that is no longer on the ground: another magnet-bearing Farmer in a shared world, a
/// chest, or a shipping bin all take the chunk while leaving THIS farmer's backpack untouched. So the claim is not
/// "the item vanished" but "the item vanished AND this farmer's own count of it rose by at least the stack that was
/// on that tile, measured from the last moment the Mod could prove the chunk was still there".
/// </para>
/// <para>
/// It is deliberately a COUNT and not an instance identity: Stardew items of one qualified id are fungible, which
/// is exactly the fact <c>pickup_forage</c> has always settled on (<c>inventoryChangedExactlyOnce</c>) and what the
/// accepted <c>pickup_item</c> postcondition already used while the approach was owned
/// (<c>inventoryAfter &gt;= InventoryBefore + Stack</c>). An instance-level claim would need a native collection
/// observer patched into <c>Debris.collect</c>; nothing in this receipt needs that identity, and inventing one
/// would add a Harmony surface over the game's debris loop for no product difference.
/// </para>
/// </remarks>
internal sealed record GroundItemPublication(
    string TargetId,
    string Location,
    int TileX,
    int TileY,
    string QualifiedItemId,
    int Stack,
    int InventoryAtPublication,
    int PublishedTick)
{
    /// <summary>
    /// Whether the actor's own backpack shows this chunk's delivery: it holds at least
    /// <see cref="InventoryAtPublication"/> plus the stack that was on the tile when the target was last published
    /// with the chunk still on the ground.
    /// </summary>
    /// <remarks>
    /// A stack below one cannot prove anything (`before + 0` is satisfied by an unchanged backpack), so it is
    /// refused rather than treated as a free pass.
    /// </remarks>
    internal bool MagnetDeliveredIt(int inventoryNow) =>
        this.Stack >= 1 && inventoryNow >= this.InventoryAtPublication + this.Stack;
}

/// <summary>
/// The bounded per-session memory of <see cref="GroundItemPublication"/> rows, keyed by the opaque target id the
/// Mod itself published for a chunk. A row is refreshed by every later publication that still sees its chunk on the
/// ground, so it always holds the count as of the LAST moment the chunk was provably there, and it is never
/// refreshed once the chunk is gone.
/// </summary>
internal sealed class GroundItemPickupLedger
{
    /// <summary>Same order of magnitude as the receipt ledger: a drop is acted on within a snapshot or two.</summary>
    internal const int MaximumRememberedTargets = 256;

    private readonly Dictionary<string, GroundItemPublication> byTargetId = new(StringComparer.Ordinal);
    private readonly Queue<string> publicationOrder = new();

    internal int Count => this.byTargetId.Count;

    internal void Record(GroundItemPublication publication)
    {
        if (!this.byTargetId.ContainsKey(publication.TargetId))
        {
            this.publicationOrder.Enqueue(publication.TargetId);
            if (this.publicationOrder.Count > MaximumRememberedTargets)
                this.byTargetId.Remove(this.publicationOrder.Dequeue());
        }

        this.byTargetId[publication.TargetId] = publication;
    }

    internal GroundItemPublication? Recall(string targetId) =>
        this.byTargetId.TryGetValue(targetId, out GroundItemPublication? publication) ? publication : null;
}
