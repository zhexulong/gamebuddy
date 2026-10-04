using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// WIA item-pickup interruption fixture (design/domains/stardew/
/// world-interruption-arbitration.md §4.1 ②), covering the <c>pickup_item</c>
/// slot's WALK leg.
///
/// <c>pickup_item</c> has two lives: the bridge owns a native approach
/// (<c>activeItemPickup</c> plus its <c>active</c> move spec) and target-version
/// <c>Debris.updateChunks</c> owns the magnetic delivery that follows it. The
/// interruption under test must land INSIDE the walk, before that native
/// delivery can run, so this fixture establishes geometry and a staged modal
/// only: the actor lands on a Farm tile, one ordinary <c>(O)388</c> OBJECT debris
/// sits exactly three tiles away along a straight walkable line — outside the
/// applied magnetic radius, so the chunks cannot home onto the actor before the
/// production approach walks there — and a real DialogueBox opens on the first
/// tick the native path controller appears.
///
/// Nothing here walks, collects, removes a chunk, writes inventory, or emits a
/// receipt: production alone starts the approach from the published
/// <c>pickup_item</c> request, classifies the modal as
/// invalidated/modal_interrupted, releases the slot, and re-executes on the
/// re-issued intent.
/// </summary>
public sealed partial class ModEntry
{
    private void InstallWiaItemPickupInterruptionFixture(Farmer player, GameLocation farm)
    {
        if (player.MaxItems < 36)
            player.increaseBackpackSize(36 - player.MaxItems);

        // The actor's landing tile. The runner issues pickup_item from here, so the
        // debris must stay inside the bridge's bounded discovery radius
        // (FindItemTarget radius 8) while remaining outside the native magnetic
        // radius.
        Vector2? anchorTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(20f, 20f), 18, requireEmptyObjectTile: true);
        if (anchorTile is null)
            throw new InvalidOperationException("fixture_native_local_wia_item_pickup_farm_anchor_missing");

        // The pickup TARGET. Two facts have to hold together:
        //   * three tiles along ONE axis, so the pixel gap (3 * 64 = 192 px) exceeds
        //     Farmer.GetAppliedMagneticRadius() (>= 128 px) and updateChunks cannot
        //     claim or home the chunks before the production approach arrives;
        //   * both intermediate tiles walkable (IsFixtureWalkableFarmTile is the
        //     fixture-family predicate the other WIA partials use), so the native
        //     planner has a straight route from the landing tile onto the debris's
        //     Chebyshev-1 ring.
        Vector2? debrisTile = FindNativeLocalFarmFixtureTile(
            farm,
            anchorTile.Value,
            4,
            requireEmptyObjectTile: true,
            extraPredicate: candidate =>
            {
                Vector2 offset = candidate - anchorTile.Value;
                // Debris.playerInRange compares EACH axis against the magnetic radius
                // (a rectangle, not a euclidean disc: Debris.cs:588-595), so the debris
                // has to clear the radius on both axes. A Chebyshev distance of 2
                // (128 px) sits exactly on the default radius boundary and
                // updateChunks magnetizes the debris away before any approach can
                // happen — measured live 2026-10-05: the first observe already had an
                // empty itemTargets and the fixture log showed debris_tile=19,17 for
                // anchor_tile=20,19 (dx 64, dy 128).
                if (Math.Max(Math.Abs(offset.X), Math.Abs(offset.Y)) < 3f)
                    return false;
                Vector2 towardAnchor = new Vector2(Math.Sign(-offset.X), Math.Sign(-offset.Y));
                return IsFixtureWalkableFarmTile(farm, candidate + towardAnchor);
            });
        if (debrisTile is null)
            throw new InvalidOperationException("fixture_native_local_wia_item_pickup_debris_placement_missing");

        // The same rectangle the native magnet uses, so the fixture's own guard
        // cannot pass while the game still considers the debris in range.
        float debrisGapX = Math.Abs(debrisTile.Value.X - anchorTile.Value.X) * 64f;
        float debrisGapY = Math.Abs(debrisTile.Value.Y - anchorTile.Value.Y) * 64f;
        if (Math.Max(debrisGapX, debrisGapY) <= player.GetAppliedMagneticRadius())
            throw new InvalidOperationException("fixture_native_local_wia_item_pickup_inside_magnetic_radius");

        const string itemId = "(O)388";
        StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>(itemId, 1);
        if (!player.couldInventoryAcceptThisItem(item))
            throw new InvalidOperationException("fixture_native_local_wia_item_pickup_inventory_unavailable");
        int debrisBefore = farm.debris.Count;
        StardewValley.Debris debris = Game1.createItemDebris(item, debrisTile.Value * 64f + new Vector2(32f, 32f), 2, farm, (int)(debrisTile.Value.Y * 64f + 32f));
        if (farm.debris.Count != debrisBefore + 1 || !farm.debris.Contains(debris)
            || debris.debrisType.Value != StardewValley.Debris.DebrisType.OBJECT || debris.Chunks.Count == 0
            || debris.item is null || debris.item.QualifiedItemId != itemId || debris.item.Stack != 1)
            throw new InvalidOperationException("fixture_native_local_wia_item_pickup_debris_setup_missing");

        // The actor lands on the approach's ORIGIN tile, so the runner's FIRST native
        // path controller is the pickup approach under test; the warp is the same
        // native lifecycle the other WIA fixtures use and invokes no action.
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)anchorTile.Value.X, (int)anchorTile.Value.Y, false));
        player.stamina = 270f;

        void OnTick(object? sender, UpdateTickedEventArgs e)
        {
            Farmer? actor = Game1.player;
            if (actor is null
                || actor.currentLocation is not Farm
                || actor.controller is not StardewValley.Pathfinding.PathFindController
                || ChebyshevTileDistance(actor.Tile, anchorTile.Value) > 0.5f)
            {
                // Only a controller that appeared while the actor still stands on the
                // landing tile is the pickup approach under test. A leftover native
                // controller, or an actor that already walked, must never arm the
                // modal and mint a false-positive modal_interrupted receipt.
                return;
            }
            // As early as the approach can be observed: the magnetic window opens
            // ~600 ms after the chunks settle and closes the moment the actor is in
            // range, so every tick spent waiting to stage the modal is a tick the
            // world can finish the pickup on its own.
            Game1.drawObjectDialogue("GameBuddy WIA item-pickup modal interruption probe");
            this.Helper.Events.GameLoop.UpdateTicked -= OnTick;
        }
        this.Helper.Events.GameLoop.UpdateTicked += OnTick;
        this.Monitor.Log($"GameBuddy native-local-player initialized WIA item-pickup interruption precondition before bridge attachment: item={itemId}; anchor_tile={(int)anchorTile.Value.X},{(int)anchorTile.Value.Y}; debris_tile={(int)debrisTile.Value.X},{(int)debrisTile.Value.Y}; gap=3; magnetic_radius={player.GetAppliedMagneticRadius()}; chunks={debris.Chunks.Count}. Production alone starts the approach, receives invalidated/modal_interrupted, dismisses, and retries the same pickup_item intent.", LogLevel.Info);
    }
}
