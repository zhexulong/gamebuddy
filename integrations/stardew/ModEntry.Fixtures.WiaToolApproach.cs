using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// WIA tool-approach interruption fixture (design/domains/stardew/
/// world-interruption-arbitration.md §4.1 ②), covering the tool family's WALK leg.
///
/// This is deliberately neither the move slot nor the item-use slot. A tool action
/// issued from outside the native Chebyshev-1 interaction radius begins an approach
/// leg (<c>TryBeginToolApproach</c>) that holds the body for many ticks before any
/// native tool call runs, so the interruption has to land INSIDE that window. The
/// fixture therefore establishes geometry alone — exactly one discoverable chop
/// target, and an actor standing Chebyshev-2 away in a straight walkable line — and
/// arms a real native modal two ticks after the native path controller appears.
///
/// Nothing here walks, chops, opens a menu intent, or emits a receipt: production
/// alone starts the approach from the published <c>chop_tree_source</c> request,
/// classifies the modal as invalidated/modal_interrupted, releases the slot, and
/// re-executes on the re-issued intent. The bridge attaches only after this method
/// returns, so no receipt can be produced by fixture state.
/// </summary>
public sealed partial class ModEntry
{
    private void InstallWiaToolApproachInterruptionFixture(Farmer player, GameLocation farm)
    {
        // One basic Axe, exactly like the live-proven chop-tree-source fixture: the
        // runner equips it with the production equip_tool action and never from here.
        foreach (Item? ownedItem in player.Items.Where(item => item is Axe).ToArray())
            player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Axe()) is not null)
            throw new InvalidOperationException("fixture_native_local_wia_tool_approach_axe_inventory_full");
        if (player.Items.OfType<Axe>().Count() != 1)
            throw new InvalidOperationException("fixture_native_local_wia_tool_approach_axe_missing_or_ambiguous");

        // The approach TARGET. Two facts have to hold together:
        //   * the tile must be the only chop target the bridge can discover from the
        //     standing tile (the runner resolves exactly one, so ambiguity is a
        //     blocked run, not a target choice), which is why the same Chebyshev-2
        //     tree exclusion the live-proven chop-tree-source fixture uses applies;
        //   * its whole Chebyshev-1 ring must be reachable, which is why the shared
        //     farm-tile search requires a walkable cardinal neighbour.
        Vector2? treeTile = FindNativeLocalFarmFixtureTile(
            farm,
            new Vector2(64f, 15f),
            12,
            requireEmptyObjectTile: true,
            extraPredicate: candidate => !farm.terrainFeatures.ContainsKey(candidate)
                && !farm.terrainFeatures.Pairs.Any(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                    && Math.Max(Math.Abs(pair.Key.X - candidate.X), Math.Abs(pair.Key.Y - candidate.Y)) <= 2f));
        if (treeTile is null)
            throw new InvalidOperationException("fixture_native_local_wia_tool_approach_tree_placement_missing");

        // The approach PRECONDITION is geometry, not timing: at Chebyshev-2 the
        // native click radius (<c>tileWithinRadiusOfPlayer(grabTile, 1)</c>) cannot be
        // satisfied, so `chop_tree_source` must take the approach leg. The midpoint
        // tile is required too, so the native planner has a one-step route onto the
        // tree's Chebyshev-1 arrival ring instead of a route that may not exist.
        Vector2[] approachDirections = { new(-1f, 0f), new(1f, 0f), new(0f, -1f), new(0f, 1f) };
        Vector2? standingTile = approachDirections
            .Select(direction => treeTile.Value + direction * 2f)
            .Where(candidate => IsFixtureWalkableFarmTile(farm, candidate)
                && IsFixtureWalkableFarmTile(farm, (treeTile.Value + candidate) / 2f))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_local_wia_tool_approach_standing_tile_missing");

        StardewValley.TerrainFeatures.Tree targetTree = new("1", StardewValley.TerrainFeatures.Tree.treeStage);
        targetTree.health.Value = 1f;
        farm.terrainFeatures.Add(treeTile.Value, targetTree);
        if (!farm.terrainFeatures.TryGetValue(treeTile.Value, out StardewValley.TerrainFeatures.TerrainFeature? placedTree)
            || !ReferenceEquals(placedTree, targetTree)
            || targetTree.stump.Value
            || targetTree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage
            || targetTree.hasMoss.Value
            || targetTree.tapped.Value
            || targetTree.health.Value != 1f)
            throw new InvalidOperationException("fixture_native_local_wia_tool_approach_tree_placement_validation_failed");

        // The actor lands on the standing tile, so the runner's FIRST native path
        // controller is the tool approach under test; the warp is the same native
        // lifecycle the other WIA fixtures use and invokes no action.
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
        player.stamina = 270f;

        int approachTicks = 0;
        void OnTick(object? sender, UpdateTickedEventArgs e)
        {
            Farmer? actor = Game1.player;
            if (actor is null
                || actor.currentLocation is not Farm
                || actor.controller is not StardewValley.Pathfinding.PathFindController
                || ChebyshevTileDistance(actor.Tile, standingTile.Value) > 0.5f
                || ChebyshevTileDistance(actor.Tile, treeTile.Value) < 1.5f)
            {
                // Only the approach walk that started on the fixture standing tile
                // and has NOT yet reached the tree's Chebyshev-1 ring arms the modal.
                // A leftover native controller, or an actor that already arrived,
                // must never produce a false-positive modal_interrupted receipt.
                approachTicks = 0;
                return;
            }
            approachTicks++;
            // Two ticks in, admission and the accepted approach are already durable,
            // so the staged world change can only surface through the body loop.
            if (approachTicks < 2)
                return;
            Game1.drawObjectDialogue("GameBuddy WIA tool-approach modal interruption probe");
            this.Helper.Events.GameLoop.UpdateTicked -= OnTick;
        }
        this.Helper.Events.GameLoop.UpdateTicked += OnTick;
        this.Monitor.Log($"GameBuddy native-local-player initialized WIA tool-approach interruption precondition before bridge attachment: tree_tile={(int)treeTile.Value.X},{(int)treeTile.Value.Y}; health=1; standing_tile={(int)standingTile.Value.X},{(int)standingTile.Value.Y}; distance=2; production alone starts the approach, receives invalidated/modal_interrupted, dismisses, and retries the same chop_tree_source intent.", LogLevel.Info);
    }

    private static float ChebyshevTileDistance(Vector2 left, Vector2 right) =>
        Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));

    private static bool IsFixtureWalkableFarmTile(GameLocation farm, Vector2 tile) =>
        farm.isTileOnMap(tile)
        && farm.isTilePassable(tile)
        && !farm.objects.ContainsKey(tile)
        && !farm.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
}
