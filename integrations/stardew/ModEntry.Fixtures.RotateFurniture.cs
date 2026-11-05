using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>How far the fixture asks the game's own item registry for a furniture id.</summary>
    private const int RotateFurnitureFixtureMaximumFurnitureId = 2000;

    /// <summary>
    /// rotate_furniture pre-attachment Given: two pieces of the game's OWN furniture standing beside a
    /// tile the actor can stand on - one whose data allows a turn (<c>rotations >= 2</c>, the pass this
    /// slice proves) and one whose data does not (<c>rotations &lt; 2</c>, the refusal it proves).
    ///
    /// <para>
    /// Only the declared Given is established. The turn itself - <c>Furniture.rotate()</c>, the
    /// footprint probe and the postcondition - belongs to production
    /// (<c>farmhandexecutioncontroller.furnituredecorationactions.cs</c>), and this fixture emits no
    /// receipt.
    /// </para>
    /// <para>
    /// WHY BOTH PIECES COME FROM THE REGISTRY rather than from ids written here: whether a piece turns
    /// is not a property of this fixture, it is <c>Data/Furniture</c>'s <c>Rotations</c> column, and
    /// that column is the thing the action's own <c>furniture_rotation_unsupported</c> refusal reads.
    /// Writing <c>(F)1396</c> here would be a second, hand-copied authority for it and would rot the
    /// moment the game's data changed. So the fixture asks the registry for a piece whose own
    /// <c>rotations</c> says it turns, and for one whose own value says it does not.
    /// </para>
    /// <para>
    /// WHY THE PIECES ARE SQUARE AND ONE TILE: <c>rotate()</c> re-derives <c>boundingBox</c> from
    /// <c>defaultBoundingBox</c>, so a non-square piece swaps its width and height and its new footprint
    /// may not be placeable. That is a real product outcome
    /// (<c>furniture_rotation_blocked_by_occupant</c> / <c>_not_placeable_here</c>), and it is NOT what
    /// this slice is about. A square piece's footprint is identical under rotation, so the placeability
    /// the handler re-probes cannot depend on which rotation it landed on, and the Given cannot fail for
    /// a reason that is the fixture's fault.
    /// </para>
    /// <para>
    /// THE GIVEN IS ASSERTED THROUGH THE PRODUCT'S OWN PREDICATES, after the warp: both pieces are in
    /// <c>location.furniture</c>, both are inside <c>Furniture.IsCloseEnoughToFarmer</c> (the reach the
    /// handler refuses with <c>furniture_rotation_out_of_range</c>), and both ids are what
    /// <c>BuildPlacedFurnitureTargetId</c> mints for the tiles they stand on. A fixture that broke any
    /// of these would look like a product refusal later, which is exactly what this assertion prevents.
    /// </para>
    /// </summary>
    private void InitializeNativeLocalRotateFurnitureFixture(Farmer player, GameLocation location)
    {
        if (location?.map is null)
            throw new InvalidOperationException("fixture_native_local_rotate_furniture_location_missing");

        Furniture turnable = RequireNativeLocalFixtureFurniture(
            (candidate) => candidate.rotations.Value >= 2,
            "turnable");
        Furniture unsupported = RequireNativeLocalFixtureFurniture(
            (candidate) => candidate.rotations.Value < 2,
            "unsupported");

        (Vector2 TurnableTile, Vector2 UnsupportedTile, Vector2 StandingTile)? spot =
            FindNativeLocalFurnitureFixtureSpot(location, turnable, unsupported);
        if (spot is null)
            throw new InvalidOperationException(
                $"fixture_native_local_rotate_furniture_spot_missing:location={location.NameOrUniqueName};"
                + $"turnable={turnable.QualifiedItemId};unsupported={unsupported.QualifiedItemId}");

        turnable.TileLocation = spot.Value.TurnableTile;
        unsupported.TileLocation = spot.Value.UnsupportedTile;
        location.furniture.Add(turnable);
        location.furniture.Add(unsupported);
        if (!location.furniture.Contains(turnable) || !location.furniture.Contains(unsupported))
            throw new InvalidOperationException("fixture_native_local_rotate_furniture_placement_failed");

        // The actor's standing pixel is what `IsCloseEnoughToFarmer` reads, and the warp is asynchronous
        // (a fade is in flight when the bridge opens), so the pixel is set here as well: the Given is
        // asserted for the tile the actor will occupy, not for the one the template left it on.
        player.Position = new Vector2(spot.Value.StandingTile.X * 64f, spot.Value.StandingTile.Y * 64f);
        if (!turnable.IsCloseEnoughToFarmer(player))
            throw new InvalidOperationException(
                $"fixture_native_local_rotate_furniture_turnable_out_of_reach:"
                + $"tile={(int)turnable.TileLocation.X},{(int)turnable.TileLocation.Y};"
                + $"actor_tile={(int)player.Tile.X},{(int)player.Tile.Y}");
        if (!unsupported.IsCloseEnoughToFarmer(player))
            throw new InvalidOperationException(
                $"fixture_native_local_rotate_furniture_unsupported_out_of_reach:"
                + $"tile={(int)unsupported.TileLocation.X},{(int)unsupported.TileLocation.Y};"
                + $"actor_tile={(int)player.Tile.X},{(int)player.Tile.Y}");
        if (turnable.rotations.Value < 2 || unsupported.rotations.Value >= 2)
            throw new InvalidOperationException(
                $"fixture_native_local_rotate_furniture_rotation_facts_wrong:"
                + $"turnable_rotations={turnable.rotations.Value};unsupported_rotations={unsupported.rotations.Value}");

        string turnableTargetId = ExecutionManager.BuildPlacedFurnitureTargetId(
            location, (int)turnable.TileLocation.X, (int)turnable.TileLocation.Y, turnable);
        string unsupportedTargetId = ExecutionManager.BuildPlacedFurnitureTargetId(
            location, (int)unsupported.TileLocation.X, (int)unsupported.TileLocation.Y, unsupported);
        if (string.Equals(turnableTargetId, unsupportedTargetId, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_rotate_furniture_identities_collide");

        player.warpFarmer(new Warp(0, 0, location.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=rotate_furniture"
                + $";location={location.NameOrUniqueName}"
                + $";standing={(int)spot.Value.StandingTile.X},{(int)spot.Value.StandingTile.Y}"
                + $";turnable={turnable.QualifiedItemId}@{(int)turnable.TileLocation.X},{(int)turnable.TileLocation.Y}"
                + $";turnable_target={turnableTargetId}"
                + $";turnable_rotations={turnable.rotations.Value}"
                + $";turnable_rotation={turnable.currentRotation.Value}"
                + $";unsupported={unsupported.QualifiedItemId}@{(int)unsupported.TileLocation.X},{(int)unsupported.TileLocation.Y}"
                + $";unsupported_target={unsupportedTargetId}"
                + $";unsupported_rotations={unsupported.rotations.Value}"
                + $";unsupported_rotation={unsupported.currentRotation.Value}"
                + ";production alone turns the first piece and refuses the second.",
            LogLevel.Info);
    }

    /// <summary>
    /// One square, single-tile piece of the game's own furniture whose live <c>rotations</c> satisfies
    /// <paramref name="accepts"/>, or a named failure. The registry decides which ids exist; this method
    /// only rejects the shapes this slice cannot reason about (see the Given's remarks on squareness).
    /// </summary>
    private static Furniture RequireNativeLocalFixtureFurniture(Func<Furniture, bool> accepts, string expectation)
    {
        for (int id = 0; id < RotateFurnitureFixtureMaximumFurnitureId; id++)
        {
            Item? created;
            try
            {
                created = ItemRegistry.Create($"(F){id}", 1);
            }
            catch (Exception)
            {
                // An unregistered (F) id throws out of the registry; it is simply not a candidate.
                continue;
            }
            if (created is not Furniture candidate) continue;
            if (candidate.getTilesWide() != 1 || candidate.getTilesHigh() != 1) continue;
            if (string.IsNullOrEmpty(candidate.QualifiedItemId)) continue;
            if (!accepts(candidate)) continue;
            return candidate;
        }
        throw new InvalidOperationException($"fixture_native_local_rotate_furniture_no_{expectation}_furniture");
    }

    /// <summary>
    /// A standing tile with two neighbour tiles on which both pieces are placeable BY THE ENGINE'S OWN
    /// predicate (<c>Furniture.canBePlacedHere</c>, the same question the handler asks after turning).
    /// The tiles are asked, never calculated: the placement rules belong to the location.
    /// </summary>
    private static (Vector2 TurnableTile, Vector2 UnsupportedTile, Vector2 StandingTile)? FindNativeLocalFurnitureFixtureSpot(
        GameLocation location,
        Furniture turnable,
        Furniture unsupported)
    {
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        Vector2[] offsets =
        {
            new(1f, 0f), new(-1f, 0f), new(0f, 1f), new(0f, -1f),
        };
        for (int x = 1; x < width - 1; x++)
        {
            for (int y = 1; y < height - 1; y++)
            {
                Vector2 standing = new(x, y);
                if (!location.isTileOnMap(standing) || !location.isTilePassable(standing)) continue;
                if (location.IsTileOccupiedBy(standing, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    continue;
                List<Vector2> placeable = offsets
                    .Select(offset => standing + offset)
                    .Where(tile => location.isTileOnMap(tile)
                        && !location.objects.ContainsKey(tile)
                        && turnable.canBePlacedHere(location, tile))
                    .ToList();
                foreach (Vector2 first in placeable)
                {
                    foreach (Vector2 second in placeable)
                    {
                        if (second == first) continue;
                        if (!unsupported.canBePlacedHere(location, second)) continue;
                        return (first, second, standing);
                    }
                }
            }
        }
        return null;
    }
}
