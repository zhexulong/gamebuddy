using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The wood fence's item id: the id `Data/Fences` keys its own removal rules under.</summary>
    private const string RemoveFenceFixtureItemId = "322";

    /// <summary>
    /// remove_fence pre-attachment Given: one placed wood fence on a tile with a standable neighbour, the
    /// actor standing on that neighbour, and a wood axe EQUIPPED in the slot the request will name.
    ///
    /// <para>
    /// Only the declared Given is established. The swing itself - `Fence.performToolAction` through the
    /// native <c>DoFunction</c> path, the second swing a fence carrying something needs, and the drop
    /// collection - belongs to production
    /// (<c>farmhandexecutioncontroller.furnituredecorationactions.cs</c>), and this fixture emits no receipt.
    /// </para>
    /// <para>
    /// THE TOOL IS EQUIPPED, not merely owned: the handler asks the fence's own
    /// <c>IsValidRemovalTool</c> about the CURRENT tool of the NAMED slot, and a tool that is owned but not
    /// equipped is refused by name (`remove_fence_tool_not_equipped_in_requested_slot`). Asserting that
    /// here means a missing Given fails before the bridge attaches instead of looking like a product
    /// refusal.
    /// </para>
    /// <para>
    /// The spot comes from the same finder the chest fixtures use - an empty tile with exactly one
    /// passable cardinal neighbour - so the actor's approach and the fence's own tile cannot be confused,
    /// and the fence is placed through <c>location.objects</c>, which is the collection the engine keeps
    /// fences in and the collection the handler reads.
    /// </para>
    /// </summary>
    private void InitializeNativeLocalRemoveFenceFixture(Farmer player, GameLocation location)
    {
        if (location?.map is null)
            throw new InvalidOperationException("fixture_native_local_remove_fence_location_missing");

        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(location);
        if (spot is null)
            throw new InvalidOperationException(
                $"fixture_native_local_remove_fence_spot_missing:location={location.NameOrUniqueName}");

        if (location.objects.ContainsKey(spot.Value.TargetTile))
            throw new InvalidOperationException(
                $"fixture_native_local_remove_fence_tile_occupied:tile={(int)spot.Value.TargetTile.X},{(int)spot.Value.TargetTile.Y};"
                + $"occupant={location.objects[spot.Value.TargetTile]?.QualifiedItemId ?? "unknown"}");

        StardewValley.Fence fence = new(spot.Value.TargetTile, RemoveFenceFixtureItemId, isGate: false);
        location.objects.Add(spot.Value.TargetTile, fence);
        if (!location.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placed)
            || placed is not StardewValley.Fence placedFence
            || !ReferenceEquals(placedFence, fence))
            throw new InvalidOperationException("fixture_native_local_remove_fence_placement_failed");

        int axeSlot = -1;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is Axe) { axeSlot = slot; break; }
        }
        if (axeSlot < 0)
        {
            if (player.Items.Count == 0)
                throw new InvalidOperationException("fixture_native_local_remove_fence_inventory_empty");
            player.Items[0] = new Axe();
            axeSlot = 0;
        }
        if (player.Items[axeSlot] is not Axe axe)
            throw new InvalidOperationException($"fixture_native_local_remove_fence_axe_missing:slot={axeSlot}");
        player.CurrentToolIndex = axeSlot;
        if (!ReferenceEquals(player.CurrentTool, axe))
            throw new InvalidOperationException($"fixture_native_local_remove_fence_axe_not_equipped:slot={axeSlot}");
        if (!fence.IsValidRemovalTool(axe))
            throw new InvalidOperationException(
                $"fixture_native_local_remove_fence_fence_refuses_axe:item={fence.QualifiedItemId};"
                + $"tool={axe.QualifiedItemId};is_gate={fence.isGate.Value.ToString().ToLowerInvariant()}");
        if (player.Stamina < player.MaxStamina) player.Stamina = player.MaxStamina;

        player.Position = new Vector2(spot.Value.StandingTile.X * 64f, spot.Value.StandingTile.Y * 64f);
        if (Math.Abs((int)spot.Value.StandingTile.X - (int)spot.Value.TargetTile.X) > 1
            || Math.Abs((int)spot.Value.StandingTile.Y - (int)spot.Value.TargetTile.Y) > 1)
            throw new InvalidOperationException(
                $"fixture_native_local_remove_fence_out_of_reach:tile={(int)spot.Value.TargetTile.X},{(int)spot.Value.TargetTile.Y};"
                + $"actor_tile={(int)spot.Value.StandingTile.X},{(int)spot.Value.StandingTile.Y}");

        string targetId = ExecutionManager.BuildPlacedItemTargetId(
            location, (int)spot.Value.TargetTile.X, (int)spot.Value.TargetTile.Y, fence);

        // THE WORLD THIS FIXTURE DECLARES HAS ONE REMOVABLE OBJECT IN RANGE: the fence. The template save
        // happens to carry weeds and stones around the actor's arrival tile (measured: four of them,
        // `(O)294`/`(O)295`), and they are published as `removable_object` rows beside the fence, so "the
        // fence is gone" would be a statement about a list of five. Clearing them here is the same
        // fixture discipline the harvest-full-bag Given uses when it thins the field it does not need.
        // The radius is measured from the ACTOR, because that is what the projection measures from: clearing
        // a box around the fence instead left one weed at the window's own edge (|9-3| = 6) published, and the
        // run reported two removable rows for a world that had one fence and one weed.
        for (int x = (int)spot.Value.StandingTile.X - 6; x <= (int)spot.Value.StandingTile.X + 6; x++)
        {
            for (int y = (int)spot.Value.StandingTile.Y - 6; y <= (int)spot.Value.StandingTile.Y + 6; y++)
            {
                Vector2 tile = new(x, y);
                if (tile == spot.Value.TargetTile) continue;
                if (location.objects.ContainsKey(tile)) location.objects.Remove(tile);
            }
        }

        // Asserted against the collection the handler reads: exactly ONE object stands within the
        // projection's own discovery radius of the fence tile, and it is this fence. The projection itself
        // cannot be asked here - it reads `Game1.player.currentLocation`, and the actor is still inside the
        // FarmHouse while this Given runs, so asking it would describe a different location than the one
        // the fence was placed in.
        Vector2[] inRange = location.objects.Pairs
            .Where(pair => Math.Abs((int)pair.Key.X - (int)spot.Value.StandingTile.X) <= 6
                && Math.Abs((int)pair.Key.Y - (int)spot.Value.StandingTile.Y) <= 6)
            .Select(pair => pair.Key)
            .ToArray();
        if (inRange.Length != 1 || inRange[0] != spot.Value.TargetTile)
            throw new InvalidOperationException(
                "fixture_native_local_remove_fence_removable_ambiguity:"
                + $"count={inRange.Length};"
                + $"rows={string.Join("|", inRange.Select(tile => $"{tile.X},{tile.Y}={location.objects[tile]?.QualifiedItemId ?? "none"}"))};"
                + $"expected={(int)spot.Value.TargetTile.X},{(int)spot.Value.TargetTile.Y}");
        player.warpFarmer(new Warp(0, 0, location.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=remove_fence"
                + $";location={location.NameOrUniqueName}"
                + $";tile={(int)spot.Value.TargetTile.X},{(int)spot.Value.TargetTile.Y}"
                + $";standing={(int)spot.Value.StandingTile.X},{(int)spot.Value.StandingTile.Y}"
                + $";target_id={targetId}"
                + $";item={fence.QualifiedItemId}"
                + $";is_gate={fence.isGate.Value.ToString().ToLowerInvariant()}"
                + $";health={fence.health.Value.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)}"
                + $";slot={axeSlot}"
                + $";tool={axe.QualifiedItemId}"
                + $";stamina={player.Stamina.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)}"
                + ";production alone swings the axe and emits the receipt.",
            LogLevel.Info);
    }
}
