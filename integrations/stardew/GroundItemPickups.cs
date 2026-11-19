using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;

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

/// <summary>
/// Where a body stands for <c>pickup_item</c>, measured by the engine's magnet instead of by the chunk's tile.
/// </summary>
/// <remarks>
/// <para>
/// <c>Debris.playerInRange</c> (Debris.cs:582-595) is the engine's whole answer to "may this farmer's body pull that
/// chunk in": per axis, <c>|position + 32 - farmer.StandingPixel| &lt;= farmer.GetAppliedMagneticRadius()</c>. It is a
/// PIXEL rectangle around the body, <c>Debris.updateChunks</c> asks it on every update for an ordinary OBJECT /
/// ARCHAEOLOGY / RESOURCE drop (Debris.cs:652-655) and calls <c>Debris.collect</c> for the Farmer it names, and a chunk
/// that leaves the rectangle is handed back to nobody (Debris.cs:678). Standing on the chunk's own tile was therefore
/// never the requirement - being inside that rectangle is, and a rectangle leaves room to stand beside a chunk.
/// </para>
/// <para>
/// The distinction the tile rule lost is the one that made this action ask a pathfinding question nobody had to
/// answer: a chunk can lie where no farmer can stand - a rock-pool edge, a doorway, the tile under an object - and it
/// is still collectable from the tile next to it. Measured across runs: <c>no_native_path</c>,
/// <c>no_reachable_approach</c> and <c>item_target_moved</c> for a chunk whose tile had not moved at all, all three the
/// same defect committed by the same line, <c>new LocalMoveSpec(..., liveTargetTile, ...)</c>.
/// </para>
/// <para>
/// The number is read from the engine on every call (<see cref="ReachPixels"/>); nothing here spells a tile count.
/// The geometry is arithmetic over supplied predicates, in the shape <see cref="GameBuddy.Stardew.Core.ApproachTileSelector"/>
/// established, so the rule is testable without a world and the caller keeps the game questions.
/// </para>
/// </remarks>
internal static class MagneticPickupReach
{
    /// <summary>
    /// The half-tile <c>Debris.playerInRange</c> adds to a debris position to reach the centre of its cell
    /// (Debris.cs:590-592, <c>position.X + 32f</c>).
    /// </summary>
    internal const float ChunkCentreOffset = 32f;

    /// <summary>The actor's own magnet reach in pixels, from the engine's own rule (Farmer.cs:4139-4142).</summary>
    internal static int ReachPixels(Farmer farmer) => farmer.GetAppliedMagneticRadius();

    /// <summary>
    /// The position the engine measures the rectangle from: the mean of this debris's chunks, which is what
    /// <c>Debris.approximatePosition</c> (Debris.cs:572-580) hands <c>playerInRange</c> on every update.
    ///
    /// Asked only about a debris whose chunk a caller has just found, so <see cref="Debris.Chunks"/> is never empty
    /// where this answer decides anything.
    /// </summary>
    internal static Vector2 Subject(Debris debris)
    {
        Vector2 total = default;
        int chunks = 0;
        foreach (Chunk chunk in debris.Chunks)
        {
            total += chunk.position.Value;
            chunks++;
        }

        return chunks == 0 ? total : total / chunks;
    }

    /// <summary>Whether a body standing on <paramref name="standingPixel"/> is inside the engine's rectangle.</summary>
    internal static bool WithinMagnet(Vector2 subject, Point standingPixel, int reachPixels) =>
        Math.Abs(subject.X + ChunkCentreOffset - standingPixel.X) <= reachPixels
        && Math.Abs(subject.Y + ChunkCentreOffset - standingPixel.Y) <= reachPixels;

    /// <summary>
    /// The tile the body should stand on: the nearest one to where it already is that lies inside the engine's
    /// rectangle, or <see langword="null"/> - carried on <see cref="MagneticStandSearch"/> - when the rectangle holds no
    /// tile this body could stand on and walk to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Null is the honest answer and the caller's refusal: a chunk in the middle of a pond whose bank is three tiles
    /// away is out of a 128-pixel magnet's reach, and no walk would change that. What the answer may never be is
    /// <i>silent</i> about which tiles it asked: <see cref="MagneticStandSearch"/> carries how many tiles the rectangle
    /// covered and which of them came closest, so a caller's refusal can name the tile it could not use instead of
    /// asserting that no such tile exists.
    /// </para>
    /// <para>
    /// THE POPULATION IS THE RECTANGLE, NOT A RING AROUND THE DROP'S TILE. The engine measures
    /// <c>Debris.playerInRange</c> from <c>approximatePosition()</c>, the MEAN of the debris' chunks (Debris.cs:572-580
    /// asked at :603 and :664, compared at :582-595), so the rectangle belongs to the DEBRIS - and a target names ONE
    /// chunk of it. A pile spreads when it is dropped and again while a magnet drags it, so the named chunk's tile can
    /// sit several tiles from the centre the rectangle is built on. A window centred on that tile then answers `none`
    /// without ever asking about a tile the rectangle holds, which is a rejection the world never gave. Measured
    /// `round80`: seven pickups refused `stand_at=none` in one burst from tile 7,39, and in the same minute the SAME
    /// tile 6,38 from the same body was `within_magnet=true;stand_at=7,39` for a different chunk - the reach is a fact
    /// about one debris, and the search has to be centred where the engine centres it.
    /// </para>
    /// </remarks>
    internal static MagneticStandSearch SelectStandTile(
        Vector2 subject,
        (int X, int Y) actorTile,
        Point actorStandingPixel,
        int reachPixels,
        Func<(int X, int Y), bool> isStandable,
        Func<(int X, int Y), bool> isReachable)
    {
        int tileSize = Game1.tileSize;
        // The body keeps its own sub-tile standing offset, so a candidate's standing pixel is this actor's own
        // reading moved by whole tiles. Nothing here assumes the offset is the tile's centre.
        int offsetX = actorStandingPixel.X - actorTile.X * tileSize;
        int offsetY = actorStandingPixel.Y - actorTile.Y * tileSize;
        float centreX = subject.X + ChunkCentreOffset - offsetX;
        float centreY = subject.Y + ChunkCentreOffset - offsetY;
        // One tile of slack on each side absorbs the rounding of a standing pixel that lands exactly on a boundary; the
        // DECISION below is the engine's own predicate, so a bound one tile too wide costs iterations, never correctness.
        int minX = (int)Math.Floor((centreX - reachPixels) / tileSize) - 1;
        int maxX = (int)Math.Floor((centreX + reachPixels) / tileSize) + 1;
        int minY = (int)Math.Floor((centreY - reachPixels) / tileSize) - 1;
        int maxY = (int)Math.Floor((centreY + reachPixels) / tileSize) + 1;

        (int X, int Y)? best = null;
        int bestDistance = int.MaxValue;
        (int X, int Y)? nearestRefused = null;
        int nearestRefusedDistance = int.MaxValue;
        string? nearestRefusal = null;
        int inReach = 0;
        for (int x = minX; x <= maxX; x++)
        {
            for (int y = minY; y <= maxY; y++)
            {
                (int X, int Y) candidate = (x, y);
                Point standing = new(x * tileSize + offsetX, y * tileSize + offsetY);
                if (!WithinMagnet(subject, standing, reachPixels))
                    continue;
                inReach++;

                // Nearest to where the body already is, so the shortest walk that suffices wins; ties are decided by
                // lowest y then lowest x, because one world state has to yield one tile.
                int distance = Math.Abs(x - actorTile.X) + Math.Abs(y - actorTile.Y);
                bool standable = isStandable(candidate);
                bool reachable = standable && isReachable(candidate);
                if (!standable || !reachable)
                {
                    if (Nearer(distance, candidate, nearestRefused, nearestRefusedDistance))
                    {
                        nearestRefused = candidate;
                        nearestRefusedDistance = distance;
                        nearestRefusal = standable ? "reachability" : "standability";
                    }
                    continue;
                }
                if (distance > bestDistance)
                    continue;
                if (!Nearer(distance, candidate, best, bestDistance))
                    continue;

                best = candidate;
                bestDistance = distance;
            }
        }

        return new MagneticStandSearch(best, inReach, nearestRefused, nearestRefusal);
    }

    /// <summary>
    /// Whether <paramref name="candidate"/> displaces the tile already held at <paramref name="distance"/>: nearer to the
    /// body wins, and a tie goes to the lower y then the lower x, because one world state has to yield one tile.
    /// </summary>
    private static bool Nearer(int distance, (int X, int Y) candidate, (int X, int Y)? current, int currentDistance) =>
        current is not { } held
        || distance < currentDistance
        || (distance == currentDistance && (candidate.Y < held.Y || (candidate.Y == held.Y && candidate.X < held.X)));
}

/// <summary>
/// Where a body may stand for one ground drop, with the answer's own facts.
///
/// <para>
/// A bare `stand_at=none` is the defect this type closes: it says "no standable tile puts this drop in reach" about a
/// question the caller cannot check, and the three ways that answer can arise - nothing inside the rectangle, everything
/// inside it occupied, everything inside it walled off from the body - need three different repairs. Measured `round80`:
/// seven `item_target_out_of_reach` refusals in one burst, every one of them `stand_at=none`, and no field that told a
/// reader whether the rectangle was empty or full.
/// </para>
/// <para>
/// <see cref="InReach"/> is the population - how many tiles the engine's own rectangle covered - and it is printed
/// whether or not a tile was chosen, so zero is a measured zero rather than a silence. <see cref="NearestRefused"/> and
/// <see cref="NearestRefusal"/> name the tile the search could not use and the predicate that refused it.
/// </para>
internal readonly record struct MagneticStandSearch(
    (int X, int Y)? Tile,
    int InReach,
    (int X, int Y)? NearestRefused,
    string? NearestRefusal)
{
    /// <summary>The body is already inside the rectangle: nothing to search, and nothing to walk.</summary>
    internal static MagneticStandSearch AlreadyInReach((int X, int Y) actorTile) => new(actorTile, 1, null, null);

    /// <summary>
    /// The stand-tile half of a receipt: the tile, or the refusal with the two facts that make it checkable.
    /// </summary>
    internal string Describe() =>
        this.Tile is { } tile
            ? $"stand_at={tile.X},{tile.Y}"
            : $"stand_at=none;in_reach={this.InReach};nearest="
                + (this.NearestRefused is { } refused ? $"{refused.X},{refused.Y}" : "none");

    /// <summary>
    /// The layer detail a refusal blames, derived from the same measurement: which predicate refused the nearest tile,
    /// or that the rectangle held no tile at all to refuse.
    /// </summary>
    internal string RefusalDetail => this.NearestRefusal ?? "in_reach_none";
}
