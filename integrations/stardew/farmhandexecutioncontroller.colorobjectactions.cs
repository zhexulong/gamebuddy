using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

/// <summary>
/// One repaintable chest the actor can name right now: the opaque id discovery handed out, the
/// tile the chest occupies, and the chest's CURRENT palette colour. The colour is published
/// because it is the fact `color_placed_object` changes and this projection is the only read of
/// it - the target id deliberately does NOT bind the colour, so the SAME id republished after the
/// write carries the new colour and a repaint to the colour it already has stays detectable.
/// </summary>

// Repainting a placed chest for the `color_placed_object` action.
//
// THE SEAM. The game has NO callable settlement for this write. Its only general writer is a
// two-statement sequence inside the picker's own click handler:
//
//   Menus/DiscreteColorPicker.cs:75-79   (inside receiveLeftClick)
//       if (itemToDrawColored is Chest chest)
//       {
//           chest.playerChoiceColor.Value = getColorFromSelection(colorSelection);   // :77
//           chest.resetLidFrame();                                                   // :78
//       }
//
// This is the `ride_minecart` precedent exactly: there the native branch lived inside a nested
// dialogue and the action reproduced the public call sequence the branch performs
// (`GameLocation.MinecartWarp`), not the dialogue. Here the sequence is two public statements, and
// every ingredient is the game's own public face:
//
//   DiscreteColorPicker.cs:15   public static int totalColors = 21;                (the bound)
//   DiscreteColorPicker.cs:83   public static Color getColorFromSelection(int)     (the palette)
//   Chest.cs:59                 public readonly NetColor playerChoiceColor
//   Chest.cs:297                public void resetLidFrame()
//
// Nothing is re-implemented and no menu is opened: no `ItemGrabMenu`, no synthesized click, no
// reproduction of the picker's swatch layout or its own UI state (`colorSelection`, `visible`,
// `itemToDrawColored`). The palette is a static map, so a request names a palette INDEX rather than
// an RGB triple: `getSelectionFromColor` (DiscreteColorPicker.cs:39) returns -1 outside the
// palette, so an RGB parameter would have to pretend to accept colours the game will not paint.
//
// WHAT THE WRITE CHANGES. `playerChoiceColor` is a registered NetField (Chest.cs:199) and is
// XML-persisted (Chest.cs:58 `[XmlElement("playerChoiceColor")]`), so the change is saved and
// synced - not presentation-only - and must run on the game thread (project rule #3148). The lid
// renders from it (Chest.cs:1259 `:1356` branch on `Color.Black`), which is why the native branch
// refreshes the lid frame with the assignment. `Color.Black` is the picker's own "no colour"
// sentinel: `getColorFromSelection(0)` (and every out-of-palette index) returns it, so a chest
// starts black and the fixture paints a non-black index to make `before != after` observable.
//
// ARGUMENTS are exactly `{ x, y, expectedTargetId, colorSelection }`, all required (the protocol
// has no optional-argument concept). `x`/`y` locate the chest's tile, `expectedTargetId` is the
// opaque id discovery published, and `colorSelection` is the palette index in
// `0 .. DiscreteColorPicker.totalColors - 1` - the game's own input domain for this write. The
// bound is read from the game on the game thread and never hardcoded.
//
// REFUSALS (per the frozen card `design/tasks/active/cards/card-color-placed-object-boundary.md`
// §8) are named after the fact they read: no `Chest` at the tile (`color_target_unavailable`), a
// different chest id (`color_target_moved`), another location (`color_target_location_mismatch`),
// out of the interaction radius (`color_target_out_of_range`), an index outside the palette
// (`invalid_color_selection`), the colour it already carries (`color_already_set`), a write whose
// fresh read disagrees (`color_placed_object_postcondition_unavailable`). The shared admission
// supplies `native_local_player_required` / `player_not_actionable` / `invalid_deadline` /
// `body_owned_*`.
//
// POSTCONDITION is a fresh read of `chest.playerChoiceColor.Value` AFTER the write: it must equal
// the palette colour for `colorSelection` AND differ from the recorded before value, because a
// repaint to the same colour is not a world change (that request is refused `color_already_set`
// before the write ever runs). A body that ran but whose fresh read disagrees is `Uncertain`,
// never a success.
//
// PHASE. Interaction-range action with an approach leg, so it is two phases like its siblings:
// walking to the chest is motion and may be braked (`cancelSafe = true`, no world change); past the
// approach the two assignments run synchronously in one game tick with no yield
// (`cancelSafe = false`), and a cancel arriving there is refused by name carrying the phase.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Repaints one placed chest through the game's own public write sequence. Refusals are named per
    /// the frozen card §8, and `color_before`/`color_after` in the evidence are the colours read off
    /// the chest instance, not the values the request asked for.
    /// </summary>
    public LocalExecutionReceipt RequestLocalColorPlacedObject(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        int colorSelection,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam drives no tool and starts no swing - it is two public
        // statements on the chest, the same profile `clear_fish_pond` and `toggle_animal_door` admit under.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        ColorTargetResolution resolution = ResolveColorTarget(location, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // 5.2: out of the interaction radius, walk in rather than refuse. Every position-independent
        // check is re-run in the shared execution body after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "color_placed_object",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteColorPlacedObject(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, colorSelection),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteColorPlacedObject(executionId, requestId, targetX, targetY, expectedTargetId, colorSelection);
    }

    /// <summary>
    /// Executes color_placed_object against the current world, re-validating the chest and re-reading
    /// the preconditions in the card's own order because an approach leg may have taken several ticks.
    /// Shared by the in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteColorPlacedObject(string executionId, string requestId, int x, int y, string targetId, int colorSelection)
    {
        GameLocation location = Game1.player.currentLocation;
        ColorTargetResolution resolution = ResolveColorTarget(location, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        string identity = resolution.Identity;
        // 7. the target's own reach, in the family's Chebyshev-1 terms.
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "color_target_out_of_range",
                $"{identity};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        // 8. the palette bound is the GAME's own, read here and never hardcoded: a two-sided bound, so
        // a negative index and a past-the-end index are the same named refusal.
        int totalColors = DiscreteColorPicker.totalColors;
        if (colorSelection < 0 || colorSelection >= totalColors)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "invalid_color_selection",
                $"{identity};color_selection={colorSelection};total_colors={totalColors}");

        // 9. a repaint to the colour the chest already carries is not a world change.
        Chest chest = resolution.Chest!;
        Color expected = DiscreteColorPicker.getColorFromSelection(colorSelection);
        Color before = chest.playerChoiceColor.Value;
        if (before.Equals(expected))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "color_already_set",
                $"{identity};color_selection={colorSelection};color_before={FormatColor(before)}");

        try
        {
            // The game's own public sequence, reproduced exactly as the picker performs it
            // (Menus/DiscreteColorPicker.cs:77-78). No menu is opened and no click is synthesized.
            chest.playerChoiceColor.Value = expected;
            chest.resetLidFrame();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "color_placed_object_native_exception",
                $"{identity};color_selection={colorSelection};color_before={FormatColor(before)};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // The postcondition is the CHEST INSTANCE after the call, never "we assigned it".
        Color after = chest.playerChoiceColor.Value;
        bool changed = !after.Equals(before);
        bool matches = after.Equals(expected);
        string evidence =
            $"{identity};color_selection={colorSelection};color_before={FormatColor(before)};"
            + $"color_after={FormatColor(after)};color_changed={changed.ToString().ToLowerInvariant()}";
        return matches && changed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "placed_object_recolored", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "color_placed_object_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one place that answers "is this world object a chest this action may repaint?", shared by
    /// discovery, the execution body and the fixture's Given so the product and its declared
    /// precondition can never disagree. The game's own write is `is Chest`-guarded
    /// (DiscreteColorPicker.cs:75), so nothing else is this action's subject: a `Furniture` or
    /// `StorageFurniture` colour is a different write and a different action.
    /// </summary>
    internal static bool TryDescribeColorableChest(StardewValley.Object? placed, out Chest? chest)
    {
        chest = placed as Chest;
        return chest is not null;
    }

    /// <summary>
    /// Opaque, stable selector for one placed chest: the location, the tile and the chest's own
    /// qualified item id plus its runtime type. The chest's COLOUR is deliberately NOT part of the
    /// identity - the SAME target id must stay valid after the repaint (so a repaint to the colour it
    /// already has is the named `color_already_set` refusal rather than a phantom "moved" target),
    /// and a replaced container is a different target because the item id or type changed.
    /// </summary>
    internal static string BuildColorTargetId(GameLocation location, int x, int y, StardewValley.Object chest)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{chest.QualifiedItemId}:{chest.GetType().Name}:color";
        return $"color_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The palette colour of one index as the EVIDENCE spells it: the components the game's own
    /// `Color` carries, so two colours are equal exactly when their three components are.
    /// </summary>
    internal static string FormatColor(Color color) => $"{color.R},{color.G},{color.B}";

    /// <summary>
    /// Re-derives the named chest on the game thread. Every mismatch is a NAMED refusal, never a
    /// silent re-target.
    /// </summary>
    private static ColorTargetResolution ResolveColorTarget(GameLocation location, int x, int y, string expectedTargetId)
    {
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is null)
            return ColorTargetResolution.Reject(
                "color_target_unavailable",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object=none");

        if (!TryDescribeColorableChest(placed, out Chest? colorable))
            return ColorTargetResolution.Reject(
                "color_target_unavailable",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object={placed.QualifiedItemId};object_type={placed.GetType().Name}");

        string identity = $"target={expectedTargetId};tile={x},{y};location={location.NameOrUniqueName}";
        Chest chest = colorable!;
        string liveId = BuildColorTargetId(location, x, y, chest);
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return ColorTargetResolution.Reject(
                "color_target_moved",
                $"{identity};live={liveId};item={chest.QualifiedItemId}");

        // The card's location precondition: the chest the actor resolves must BE in the actor's
        // location. A chest whose own Location was reassigned elsewhere is not the world the
        // observation described, and the write would land outside the observed scene.
        if (chest.Location is not null && !string.Equals(chest.Location.NameOrUniqueName, location.NameOrUniqueName, StringComparison.Ordinal))
            return ColorTargetResolution.Reject(
                "color_target_location_mismatch",
                $"{identity};actor_location={location.NameOrUniqueName};chest_location={chest.Location.NameOrUniqueName}");

        return new ColorTargetResolution(true, "accepted", string.Empty, identity, chest);
    }

    /// <summary>
    /// The chests the actor can name right now, projected read-only from live state: every `Chest`
    /// in the current location within the shared discovery radius, with the colour it currently
    /// carries. Nothing is synthesized: whatever the game placed is published, and the caller reads
    /// the same colour the write will change.
    /// </summary>
    internal static IReadOnlyList<BridgeColorTarget> DiscoverColorTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeColorTarget>();
        List<BridgeColorTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (result.Count >= ColorTargetLimit)
                break;
            Vector2 tile = pair.Key;
            if (pair.Value is null || !TryDescribeColorableChest(pair.Value, out Chest? chest))
                continue;
            if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeColorTarget(
                BuildColorTargetId(location, (int)tile.X, (int)tile.Y, chest!),
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                FormatColor(chest!.playerChoiceColor.Value)));
        }
        return result;
    }

    /// <summary>Per-family cap on published repaintable chests, matching the siblings' bounded discovery.</summary>
    private const int ColorTargetLimit = 16;

    /// <summary>
    /// One resolved chest, or the named reason the published target no longer matches the live world.
    /// </summary>
    private sealed record ColorTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Identity,
        Chest? Chest)
    {
        internal static ColorTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, null);
    }
}
