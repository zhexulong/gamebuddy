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
// WHAT SHE MAY RECOLOUR, and why this family asks its own question. Two facts decide it, both the
// engine's:
//
//   Menus/ItemGrabMenu.cs:603-610   CanHaveColorPicker()  - the picker exists only for a `Chest`
//                                   whose SpecialChestType is None or BigChest, and not a fridge.
//   Chest.cs:773-792 / :766-772     the picker is reached from the `playerChest` branch of
//                                   `checkForAction`; a giftbox dumps its contents instead and a
//                                   world chest opens through the `!playerChest` branch (:794-807).
//   Chest.cs:1257-1303              `draw` paints `playerChoiceColor` only in its `playerChest`
//                                   branches; anything else takes the plain sprite path (:1315-1347),
//                                   so a colour written to a world chest is a field nobody sees.
//
// So colour-addressable (the picker's own set) and hers-to-recolour (`playerChest`) are two
// questions, and `TryDescribeColorableChest` answers both. This is NOT the count predicate return:
// `TryDescribePlacedChest` answers "is this world object a chest" for `SummarizeChests` and the
// location's container walk, and that widening was the 2026-11-19 fix - a room's chests are a room
// inventory, while recolouring is a claim about one box being hers. `IsStorageContainer` is a third
// question again (a Junimo chest is storage and not colourable), so the three predicates stay three
// and none of them is reached through another's answer.
//
// THE GIFT BOX IS REFUSED ON ITS OWN FACT, not only because the engine builds it with
// `playerChest == false` (`FarmHouse.cs:142`). Its contents are handed over and the box destroyed on
// the first interaction (`dumpContents` removes it, `Chest.cs:725-736`; `checkForAction` removes it
// once empty, `:829-831`), so a colour on one is a field on a box that is about to stop existing -
// there is nothing for the colour to be true about a turn later.
//
// REFUSALS (per the frozen card `design/tasks/active/cards/card-color-placed-object-boundary.md`
// §8) are named after the fact they read: no colour target at the tile (`color_target_unavailable`,
// whether nothing is there or what is there is not hers to repaint - the evidence names which), a
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
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        ColorTargetResolution resolution = ResolveColorTarget(location, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

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

    private LocalExecutionReceipt ExecuteColorPlacedObject(string executionId, string requestId, int x, int y, string targetId, int colorSelection)
    {
        GameLocation location = Game1.player.currentLocation;
        ColorTargetResolution resolution = ResolveColorTarget(location, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        string identity = resolution.Identity;
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "color_target_out_of_range",
                $"{identity};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        int totalColors = DiscreteColorPicker.totalColors;
        if (colorSelection < 0 || colorSelection >= totalColors)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "invalid_color_selection",
                $"{identity};color_selection={colorSelection};total_colors={totalColors}");

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
    /// The one place that answers "is this world object a chest?", asked by the location's container walk and so by the
    /// chest summary. The colour family asks it through <see cref="TryDescribeColorableChest"/> below and the container
    /// actions through `IsStorageContainer`, so no reader of "is it a chest" is handed that answer as something else.
    ///
    /// <para>
    /// A chest is a placed <c>Chest</c> - the game's own type. WHAT a chest is, WHICH chests an action may open
    /// (<see cref="IsStorageContainer"/>) and WHICH chests she may recolour (<see cref="TryDescribeColorableChest"/>)
    /// are three questions: this answers the first, and the other two are asked after it rather than derived from it.
    /// That is deliberate - measured 2026-11-19 (`round79`), answering "is it a chest" was taken for an answer to "may
    /// she repaint it", and the first act of day one was `color_placed_object` on the farmhouse's starter gift box,
    /// which is a `Chest` the engine shows no picker for and never paints a colour on.
    /// </para>
    /// <para>
    /// The split has to be this one. Measured 2026-11-18 (`round76`, the FarmHouse): the summary counted the room's
    /// chests through the ownership test while this family addressed them through the type test, so one revision printed
    /// 「本图箱子: 0（物品 0）」 above a chest the same block listed at (3,7) - a count and a list computed from two
    /// predicates, reported as if the world had said both.
    /// </para>
    /// </summary>
    internal static bool TryDescribePlacedChest(StardewValley.Object? placed, out Chest? chest)
    {
        chest = placed as Chest;
        return chest is not null;
    }

    /// <summary>
    /// The one place that answers "may she recolour this world object?", asked by discovery, the execution body and the
    /// fixture Given alike. It asks the identity question first through <see cref="TryDescribePlacedChest"/>, then the two
    /// facts the engine's own colour path is gated on: the picker can be built for this chest
    /// (`ItemGrabMenu.CanHaveColorPicker`, `ItemGrabMenu.cs:603-610` - `None` or `BigChest`, never a fridge), and the
    /// chest is one the player placed, the only branch whose `draw` paints `playerChoiceColor` (`Chest.cs:1257-1303`) and
    /// the only branch `checkForAction` reaches the picker from (`Chest.cs:773-792`).
    ///
    /// <para>
    /// A GIFT BOX IS REFUSED BY ITS OWN FLAG: its branch hands the contents over and destroys the box on the first
    /// interaction (`Chest.cs:725-736`), and `checkForAction` removes the box once it is empty (`:829-831`), so a colour on
    /// one would be a change to an object that is about to stop existing. Every gift box the shipped constructor makes is
    /// also `playerChest == false` (`FarmHouse.cs:142`), which the test above already refuses; the flag is checked
    /// separately because it is the fact that survives a save file or a mod building both flags at once.
    /// </para>
    ///
    /// <para>
    /// MEASURED 2026-11-19 (`round79`, the FarmHouse, the first turn of day one): this family addressed every `Chest`, so
    /// the first thing she did was `color_placed_object` on the starter gift box at (3,7), selection 3 - the
    /// parsnip-seed box painted cyan - and the receipt said `placed_object_recolored`. `draw` never reads
    /// `playerChoiceColor` for a world chest (`Chest.cs:1315-1347`), so the write succeeded and the claim was false.
    /// </para>
    /// </summary>
    internal static bool TryDescribeColorableChest(StardewValley.Object? placed, out Chest? chest)
    {
        chest = null;
        if (!TryDescribePlacedChest(placed, out Chest? candidate)) return false;
        if (!candidate!.playerChest.Value) return false;
        if (candidate.giftbox.Value) return false;
        if (candidate.SpecialChestType is not (Chest.SpecialChestTypes.None or Chest.SpecialChestTypes.BigChest)) return false;
        chest = candidate;
        return true;
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
    /// Re-derives the named chest on the game thread through the colour admission discovery reads too, so an execution can
    /// only address a target the same observation would have published. Every mismatch is a NAMED refusal, never a silent
    /// re-target.
    /// </summary>
    internal static ColorTargetResolution ResolveColorTarget(GameLocation location, int x, int y, string expectedTargetId)
    {
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is null)
            return ColorTargetResolution.Reject(
                "color_target_unavailable",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_object=none");

        if (!TryDescribeColorableChest(placed, out Chest? colorable))
            return ColorTargetResolution.Reject(
                "color_target_unavailable",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};"
                + $"tile_object={placed.QualifiedItemId};object_type={placed.GetType().Name};"
                + (placed is Chest refused
                    ? $"player_chest={refused.playerChest.Value.ToString().ToLowerInvariant()};"
                      + $"giftbox={refused.giftbox.Value.ToString().ToLowerInvariant()};special_chest_type={refused.SpecialChestType}"
                    : "not_a_chest"));

        string identity = $"target={expectedTargetId};tile={x},{y};location={location.NameOrUniqueName}";
        Chest chest = colorable!;
        string liveId = BuildColorTargetId(location, x, y, chest);
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return ColorTargetResolution.Reject(
                "color_target_moved",
                $"{identity};live={liveId};item={chest.QualifiedItemId}");

        if (chest.Location is not null && !string.Equals(chest.Location.NameOrUniqueName, location.NameOrUniqueName, StringComparison.Ordinal))
            return ColorTargetResolution.Reject(
                "color_target_location_mismatch",
                $"{identity};actor_location={location.NameOrUniqueName};chest_location={chest.Location.NameOrUniqueName}");

        return new ColorTargetResolution(true, "accepted", string.Empty, identity, chest);
    }

    internal const int ColorTargetLimit = 16;

    internal sealed record ColorTargetResolution(
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
