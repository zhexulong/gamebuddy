using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The palette index the fixture paints the chest with. Not black (a fresh chest already reads
    /// `Color.Black`), and asserted distinct from the index the runner paints, so `before != after`
    /// is a real move the product's own precondition will accept.
    /// </summary>
    private const int ColorPlacedObjectFixtureColorSelection = 1;

    /// <summary>
    /// The palette index the LIVE RUNNER paints. Kept here only so the Given can assert the two
    /// palette colours are distinct; the runner owns this choice
    /// (`tools/run-stardew-native-local-player-color-placed-object-smoke.mjs`, `COLOR_SELECTION`).
    /// </summary>
    private const int ColorPlacedObjectRunColorSelection = 2;

    /// <summary>
    /// color_placed_object pre-attachment Given: one owned ordinary Chest on an empty current-location
    /// tile with a standable neighbour, carrying a palette colour that is NOT black and NOT the colour
    /// the run will paint — the exact world the action's own preconditions read.
    ///
    /// Only that declared Given is established. The repaint itself — the native
    /// `chest.playerChoiceColor.Value` assignment plus `chest.resetLidFrame()` — belongs to
    /// production, and this fixture emits no receipt.
    ///
    /// WHY THE COLOUR IS SET HERE rather than found: the action refuses a repaint to the colour the
    /// chest already carries (`color_already_set`), so the starting state has to be known and
    /// different from the request. A save that happens to own a chest carries whatever it was left
    /// with, so the fixture sets the colour and then asserts the result THROUGH THE PRODUCT'S OWN
    /// predicate (`ExecutionManager.TryDescribeColorableChest`) so the Given and the product cannot
    /// disagree. The colour itself comes from the game's own palette
    /// (`DiscreteColorPicker.getColorFromSelection`), never from a literal here.
    ///
    /// THE ADVERTISEMENT IS NOT ASSERTED HERE: the published target set is a function of where the
    /// actor stands, so an eager assertion races the warp. Reading the target from a fresh
    /// observation is the runner's job.
    /// </summary>
    private void InitializeNativeLocalColorPlacedObjectFixture(Farmer player, GameLocation location)
    {
        if (location is null || location.map is null)
            throw new InvalidOperationException("fixture_native_local_color_placed_object_location_missing");

        // The palette, read from the game rather than hardcoded: the bound is the game's own
        // (`DiscreteColorPicker.totalColors`), and index 0 / every out-of-palette index is its
        // "no colour" sentinel.
        int totalColors = DiscreteColorPicker.totalColors;
        Color fixtureColor = DiscreteColorPicker.getColorFromSelection(ColorPlacedObjectFixtureColorSelection);
        Color runColor = DiscreteColorPicker.getColorFromSelection(ColorPlacedObjectRunColorSelection);
        if (fixtureColor.Equals(Color.Black))
            throw new InvalidOperationException(
                $"fixture_native_local_color_placed_object_fixture_color_is_black:selection={ColorPlacedObjectFixtureColorSelection};total_colors={totalColors}");
        if (fixtureColor.Equals(runColor))
            throw new InvalidOperationException(
                $"fixture_native_local_color_placed_object_run_color_not_distinct:"
                + $"fixture_selection={ColorPlacedObjectFixtureColorSelection};run_selection={ColorPlacedObjectRunColorSelection};total_colors={totalColors}");

        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(location);
        if (spot is null)
            throw new InvalidOperationException(
                $"fixture_native_local_color_placed_object_standing_missing:location={location.NameOrUniqueName};"
                + "looked_for=an empty tile with exactly one passable cardinal neighbour");

        // The actor's own tile must be empty for the runner's "no chest there" negative to read as
        // `color_target_unavailable` rather than finding a different container.
        if (location.objects.ContainsKey(spot.Value.StandingTile))
            throw new InvalidOperationException(
                $"fixture_native_local_color_placed_object_standing_occupied:tile={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y};"
                + $"occupant={location.objects[spot.Value.StandingTile]?.QualifiedItemId ?? "unknown"}");

        Chest chest = new(playerChest: true, spot.Value.TargetTile);
        if (!ExecutionManager.TryDescribeColorableChest(chest, out Chest? colorable) || !ReferenceEquals(colorable, chest))
            throw new InvalidOperationException($"fixture_native_local_color_placed_object_not_a_chest:item={chest.QualifiedItemId}");
        if (!IsFixtureOwnedOrdinaryChest(chest))
            throw new InvalidOperationException("fixture_native_local_color_placed_object_chest_invalid");

        // The Given, set explicitly: a placed chest whose colour is the fixture's palette index.
        chest.playerChoiceColor.Value = fixtureColor;
        location.objects.Add(spot.Value.TargetTile, chest);

        if (!location.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placed) || !ReferenceEquals(placed, chest))
            throw new InvalidOperationException("fixture_native_local_color_placed_object_placement_failed");
        // Asserts the Given THROUGH THE PRODUCT'S OWN predicate: the same question the handler asks.
        if (!ExecutionManager.TryDescribeColorableChest(placed, out Chest? asserted) || !ReferenceEquals(asserted, chest))
            throw new InvalidOperationException("fixture_native_local_color_placed_object_given_not_colorable");
        if (chest.playerChoiceColor.Value.Equals(Color.Black) || !chest.playerChoiceColor.Value.Equals(fixtureColor))
            throw new InvalidOperationException(
                $"fixture_native_local_color_placed_object_given_color_wrong:"
                + $"before={ExecutionManager.FormatColor(chest.playerChoiceColor.Value)};expected={ExecutionManager.FormatColor(fixtureColor)}");

        player.warpFarmer(new Warp(0, 0, location.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=color_placed_object"
                + $";location={location.NameOrUniqueName}"
                + $";tile={(int)spot.Value.TargetTile.X},{(int)spot.Value.TargetTile.Y}"
                + $";standing={(int)spot.Value.StandingTile.X},{(int)spot.Value.StandingTile.Y}"
                + $";target_id={ExecutionManager.BuildColorTargetId(location, (int)spot.Value.TargetTile.X, (int)spot.Value.TargetTile.Y, chest)}"
                + $";fixture_selection={ColorPlacedObjectFixtureColorSelection}"
                + $";run_selection={ColorPlacedObjectRunColorSelection}"
                + $";fixture_color={ExecutionManager.FormatColor(fixtureColor)}"
                + $";total_colors={totalColors}"
                + ";production alone repaints the chest and emits the receipt.",
            LogLevel.Info);
    }
}
