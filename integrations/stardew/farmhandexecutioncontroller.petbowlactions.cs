using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

// Pet-bowl watering over the native Watering Can seam.
//
// Seam decision: `PetBowl.watered` is the only gameplay terminal this action may
// claim, and the ONLY way the game sets it is `PetBowl.performToolAction`
// (PetBowl.cs:81-91): the tool must be a WateringCan AND the tile must carry the
// building's `PetBowl` map property. WateringCan.DoFunction reaches that through
// `location.performToolAction(...)` (WateringCan.cs:182) -> the buildings loop
// (GameLocation.cs:16256-16260). So the handler validates the equipped can and the
// bowl identity, then makes the ONE native call, exactly like RequestLocalWaterCrop.
//
// Why a separate action and not `water_crop`: `water_crop` is PUBLISHED with the
// reasonCode `crop_watered` and a postcondition about a HoeDirt crop changing
// unwatered->watered. A pet bowl has no crop, so reusing it would emit a false
// receipt. `refill_watering_can` is the precedent for a separate action over the
// same WateringCan.DoFunction seam.
//
// The player-visible consequence is native, not Mod-authored: at the next day
// update Pet.cs:463-469 grants the pet +6 friendship and resets the flag.
internal sealed partial class ExecutionManager
{
    /// <summary>Water the farm's built-in Pet Bowl through the native watering path.</summary>
    public LocalExecutionReceipt RequestLocalWaterPetBowl(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline → body
        // exclusivity): identical reasonCodes and order to its siblings. Geometry,
        // target identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not WateringCan wateringCan)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_not_equipped", null);
        if (wateringCan.WaterLeft <= 0 && !Game1.player.hasWateringCanEnchantment)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty", null);

        GameLocation location = Game1.player.currentLocation;
        if (ResolvePetBowl(location, targetX, targetY) is not { } bowl
            || !string.Equals(BuildPetBowlTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_bowl_target_unavailable", $"target={targetX},{targetY}");
        // The bowl object is read live after the native call too, so the
        // postcondition is this execution's own before/after observation rather
        // than a Mod-authored claim.
        if (bowl.watered.Value)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_bowl_already_watered", $"target={targetX},{targetY}");

        bool beforeWatered = bowl.watered.Value;
        int beforeWater = wateringCan.WaterLeft;
        // Observed, not asserted: the native watering path must not mount a menu.
        bool menuBefore = Game1.activeClickableMenu is not null;
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(wateringCan, location, targetX, targetY, Game1.player, staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        // WateringCan covers power with toolPower.Value (tap => 0), so a basic can
        // tap costs 2*(0+1) - Farming*0.1, identical to water_crop.
        float expectedStaminaCost = wateringCan.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
        bool afterWatered = bowl.watered.Value;
        bool menuOpened = Game1.activeClickableMenu is not null && !menuBefore;
        bool waterConsumed = wateringCan.IsBottomless || wateringCan.WaterLeft < beforeWater || Game1.player.hasWateringCanEnchantment;
        ExecutionState state = !beforeWatered && afterWatered ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "pet_bowl_watered" : "pet_bowl_water_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};before_watered={beforeWatered.ToString().ToLowerInvariant()};after_watered={afterWatered.ToString().ToLowerInvariant()};water_before={beforeWater};water_after={wateringCan.WaterLeft};water_consumed={waterConsumed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)};native_menu_opened={menuOpened.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>
    /// The tiles of this bowl that actually carry the building's PetBowl tile
    /// property, i.e. the tiles the native watering gate accepts.
    ///
    /// Why this is not just the footprint: <c>Building.doesTileHaveProperty</c>
    /// resolves <c>BuildingData.HasPropertyAtTile(tile - building.tileX, tile -
    /// building.tileY)</c> against each entry's relative <c>TileArea</c> rectangle.
    /// The shipped Pet Bowl building data places its PetBowl property at relative
    /// (1, 0) with a 1x1 area, NOT at the footprint origin, so watering the origin
    /// runs the native path while leaving <c>watered</c> false. Asking the building
    /// keeps this correct if the data ever moves the property.
    /// </summary>
    internal static IEnumerable<Vector2> PetBowlWaterableTiles(PetBowl bowl)
    {
        for (int x = bowl.tileX.Value; x < bowl.tileX.Value + bowl.tilesWide.Value; x++)
        {
            for (int y = bowl.tileY.Value; y < bowl.tileY.Value + bowl.tilesHigh.Value; y++)
            {
                string? propertyValue = null;
                if (bowl.doesTileHaveProperty(x, y, "PetBowl", "Buildings", ref propertyValue))
                    yield return new Vector2(x, y);
            }
        }
    }

    /// <summary>The completed Pet Bowl that accepts watering at this exact tile, or null.</summary>
    private static PetBowl? ResolvePetBowl(GameLocation location, int x, int y) =>
        location.buildings.OfType<PetBowl>()
            .FirstOrDefault(candidate => candidate.daysOfConstructionLeft.Value <= 0
                && PetBowlWaterableTiles(candidate).Any(tile => (int)tile.X == x && (int)tile.Y == y));

    /// <summary>
    /// Opaque Pet Bowl identity. Derived from the bowl's first waterable tile, so
    /// the id names the tile the actor actually waters rather than the footprint
    /// origin, while staying stable and unique per bowl.
    /// </summary>
    internal static string BuildPetBowlTargetId(GameLocation location, int x, int y)
    {
        PetBowl? bowl = location.buildings.OfType<PetBowl>()
            .FirstOrDefault(candidate => candidate.occupiesTile(x, y));
        Vector2 origin = bowl is null
            ? new Vector2(x, y)
            : PetBowlWaterableTiles(bowl).DefaultIfEmpty(new Vector2(bowl.tileX.Value, bowl.tileY.Value)).First();
        string raw = $"{location.NameOrUniqueName}:{(int)origin.X},{(int)origin.Y}:pet_bowl";
        return $"pet_bowl_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
