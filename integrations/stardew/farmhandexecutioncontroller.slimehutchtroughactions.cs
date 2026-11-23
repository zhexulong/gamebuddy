using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

// Slime Hutch trough watering over the native Watering Can seam.
//
// Seam decision: `SlimeHutch.waterSpots[y - 6]` is the only gameplay terminal
// this action may claim, and the ONLY way the game sets it is
// `SlimeHutch.performToolAction` (SlimeHutch.cs:154-161):
//
//     public override bool performToolAction(Tool t, int tileX, int tileY)
//     {
//         if (t is WateringCan && tileX == 16 && tileY >= 6 && tileY <= 9)
//             waterSpots[tileY - 6] = true;
//         return false;
//     }
//
// WateringCan.DoFunction reaches that through `location.performToolAction(...)`
// (WateringCan.cs:182), exactly like RequestLocalWaterCrop. SlimeHutch FULLY
// overrides performToolAction with no base call, so this is the whole gate.
//
// Why a separate action and not `water_crop`: `water_crop` is PUBLISHED with the
// reasonCode `crop_watered` and a postcondition about a HoeDirt crop changing
// unwatered->watered. A slime hutch trough has no crop; its postcondition is a
// `waterSpots[]` flag. Reusing `water_crop` would emit a receipt that asserts
// something false. `refill_watering_can` and `water_pet_bowl` are the precedent
// for a separate action over the same WateringCan.DoFunction seam.
//
// Target resolution is coordinate-fixed, NOT a building-property lookup: the
// native gate above compares literal interior coordinates `x == 16`,
// `y in 6..9`. There is no relative-offset or BuildingData entry involved, so
// this handler must not enumerate building tile properties.
//
// The player-visible consequence is native, not Mod-authored:
// `SlimeHutch.DayUpdate` (SlimeHutch.cs:68-94) consumes watered spots and
// produces slimes up to `characters.Count / 5`. This action does NOT implement
// that; it only reports its own before/after `waterSpots` observation.
internal sealed partial class ExecutionManager
{
    internal const int SlimeHutchTroughColumn = 16;
    internal const int SlimeHutchTroughFirstRow = 6;
    internal const int SlimeHutchTroughLastRow = 9;

    /// <summary>Water the built-in Slime Hutch trough through the native watering path.</summary>
    public LocalExecutionReceipt RequestLocalWaterSlimeHutchTrough(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        DeclaredToolResolution can = ResolveDeclaredTool(Game1.player.Items, "water_slime_hutch_trough");
        if (can.RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "water_slime_hutch_trough", toolRefusal));
        if (Game1.player.Items[can.Slot] is not WateringCan ownedCan)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty",
                $"slot={can.Slot};can=none");
        if (ownedCan.WaterLeft <= 0 && !Game1.player.hasWateringCanEnchantment)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty",
                $"slot={can.Slot};water_left={ownedCan.WaterLeft}");

        if (ResolveSlimeHutchTrough(targetX, targetY) is not { } hutch)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_not_current_location", $"location={Game1.player.currentLocation?.NameOrUniqueName};target={targetX},{targetY}");
        if (!string.Equals(BuildSlimeHutchTroughTargetId(hutch, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_trough_target_changed", $"target={targetX},{targetY};expected={expectedTargetId}");
        if (hutch.waterSpots[targetY - SlimeHutchTroughFirstRow])
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_trough_already_watered", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "water_slime_hutch_trough",
                hutch,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteWaterSlimeHutchTrough(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteWaterSlimeHutchTrough(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteWaterSlimeHutchTrough(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "water_slime_hutch_trough", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "water_slime_hutch_trough", toolRefusalCode));
        ExecutionState state;
        string reasonCode;
        string evidence;
        try
        {
            if (selection.Tool is not WateringCan wateringCan)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            if (wateringCan.WaterLeft <= 0 && !Game1.player.hasWateringCanEnchantment)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty",
                    $"water_left={wateringCan.WaterLeft};slot={selection.Slot}");

            if (ResolveSlimeHutchTrough(targetX, targetY) is not { } hutch)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_not_current_location", $"location={Game1.player.currentLocation?.NameOrUniqueName};target={targetX},{targetY}");
            if (!string.Equals(BuildSlimeHutchTroughTargetId(hutch, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_trough_target_changed", $"target={targetX},{targetY};expected={expectedTargetId}");
            if (hutch.waterSpots[targetY - SlimeHutchTroughFirstRow])
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "slime_hutch_trough_already_watered", $"target={targetX},{targetY}");

            bool beforeWatered = hutch.waterSpots[targetY - SlimeHutchTroughFirstRow];
            int beforeWater = wateringCan.WaterLeft;
            bool menuBefore = Game1.activeClickableMenu is not null;
            float staminaBefore = Game1.player.Stamina;
            UseNativeToolOnTile(wateringCan, hutch, targetX, targetY, Game1.player, staminaBefore);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // WateringCan covers power with toolPower.Value (tap => 0), so a basic can
            // tap costs 2*(0+1) - Farming*0.1, identical to water_crop.
            float expectedStaminaCost = wateringCan.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
            bool afterWatered = hutch.waterSpots[targetY - SlimeHutchTroughFirstRow];
            bool menuOpened = Game1.activeClickableMenu is not null && !menuBefore;
            bool waterConsumed = wateringCan.IsBottomless || wateringCan.WaterLeft < beforeWater || Game1.player.hasWateringCanEnchantment;
            state = !beforeWatered && afterWatered ? ExecutionState.Succeeded : ExecutionState.Uncertain;
            reasonCode = state == ExecutionState.Succeeded ? "slime_hutch_trough_watered" : "slime_hutch_trough_water_postcondition_unavailable";
            evidence = $"location={hutch.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};before_watered={beforeWatered.ToString().ToLowerInvariant()};after_watered={afterWatered.ToString().ToLowerInvariant()};water_before={beforeWater};water_after={wateringCan.WaterLeft};water_consumed={waterConsumed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)};native_menu_opened={menuOpened.ToString().ToLowerInvariant()}";
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }
        evidence += $";{SelectionSuffix(selection)}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    private static StardewValley.SlimeHutch? ResolveSlimeHutchTrough(int x, int y) =>
        Game1.player.currentLocation is StardewValley.SlimeHutch hutch
            && IsSlimeHutchTroughTile(x, y)
                ? hutch
                : null;

    /// <summary>The fixed interior tiles `SlimeHutch.performToolAction` accepts.</summary>
    internal static bool IsSlimeHutchTroughTile(int x, int y) =>
        x == SlimeHutchTroughColumn && y >= SlimeHutchTroughFirstRow && y <= SlimeHutchTroughLastRow;

    /// <summary>
    /// Opaque Slime Hutch trough identity, derived from the hutch's stable
    /// location identity plus the exact watered tile, so the id names the tile
    /// the actor actually waters while staying stable across ticks.
    /// </summary>
    internal static string BuildSlimeHutchTroughTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:slime_hutch_trough";
        return $"slime_hutch_trough_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
