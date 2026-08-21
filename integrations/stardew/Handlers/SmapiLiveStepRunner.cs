// integrations/stardew/Handlers/SmapiLiveStepRunner.cs
namespace GameBuddy.Stardew.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;

/// <summary>
/// Native SMAPI game-thread execution runner that dispatches atomic domain morphisms to Mod coordinators.
/// </summary>
internal sealed class SmapiLiveStepRunner : ISopStepRunner
{
    private readonly ExecutionManager executions;
    private readonly IReadOnlyDictionary<string, IStepHandler> handlers;

    public SmapiLiveStepRunner(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
        var equip = new EquipToolStepHandler();
        var forage = new ForageStepHandler();
        this.handlers = new Dictionary<string, IStepHandler>(StringComparer.OrdinalIgnoreCase)
        {
            ["till_soil"] = new TillSoilStepHandler(),
            ["equip_tool"] = equip,
            ["equip_tool_slot"] = equip,
            ["water_crop"] = new WaterCropStepHandler(),
            ["plant_seed"] = new PlantSeedStepHandler(),
            ["fertilize_tile"] = new FertilizeTileStepHandler(),
            ["harvest_crop"] = new HarvestCropStepHandler(),
            ["pickup_forage"] = forage,
            ["collect_forage"] = forage,
            ["use_item"] = new UseItemStepHandler(),
            ["clear_hoedirt"] = new ClearHoeDirtStepHandler(),
        };
    }

    public object? SampleStateProperty(string locationName, int tileX, int tileY, string propertyPath)
    {
        if (!Context.IsWorldReady || Game1.player?.currentLocation is null)
            return null;

        var location = Game1.getLocationFromName(locationName) ?? Game1.player.currentLocation;
        Vector2 tile = new(tileX, tileY);

        switch (propertyPath)
        {
            case "terrain.soil_dirt.state.watered":
                if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feat) && feat is HoeDirt dirt)
                    return dirt.isWatered();
                return false;

            case "terrain.soil_dirt.state.tilled":
                return location.terrainFeatures.TryGetValue(tile, out TerrainFeature? tf) && tf is HoeDirt;

            case "terrain.crop.state.harvestable":
                if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? cFeature) && cFeature is HoeDirt hd && hd.crop != null)
                    return hd.crop.currentPhase.Value >= hd.crop.phaseDays.Count - 1;
                return false;

            default:
                return null;
        }
    }

    public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
    {
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return Result<string, string>.Fail("world_not_ready");

        if (!this.handlers.TryGetValue(actionType, out var handler))
        {
            return Result<string, string>.Fail($"unsupported_step_action:{actionType.ToLowerInvariant()}");
        }

        var validation = handler.ValidateArgs(args);
        if (validation.IsFailure)
        {
            return Result<string, string>.Fail(validation.Error);
        }

        string stepReqId = $"step_{stepIndex}_{Guid.NewGuid():N}";
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        GameLocation location = Game1.player.currentLocation;
        var target = validation.Value;

        LocalExecutionReceipt receipt;
        switch (actionType.ToLowerInvariant())
        {
            case "equip_tool":
            case "equip_tool_slot":
                receipt = this.executions.RequestLocalEquipTool(stepReqId, target.Slot ?? 0);
                break;

            case "till_soil":
                receipt = this.executions.RequestLocalTillSoil(stepReqId, target.X, target.Y, deadline);
                break;

            case "water_crop":
                string waterTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveCropTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalWaterCrop(stepReqId, target.X, target.Y, waterTargetId, deadline);
                break;

            case "plant_seed":
                string seedTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : $"seed_{location.NameOrUniqueName}:{target.Slot}:{target.X},{target.Y}:{target.QualifiedItemId}";
                receipt = this.executions.RequestLocalPlantSeed(stepReqId, target.Slot ?? 0, target.X, target.Y, target.QualifiedItemId ?? string.Empty, seedTargetId, deadline);
                break;

            case "fertilize_tile":
                string fertTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : $"fertilizer_{location.NameOrUniqueName}:{target.Slot}:{target.X},{target.Y}:{target.QualifiedItemId}";
                receipt = this.executions.RequestLocalFertilizeTile(stepReqId, target.Slot ?? 0, target.X, target.Y, target.QualifiedItemId ?? string.Empty, fertTargetId, deadline);
                break;

            case "harvest_crop":
                string harvestTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveCropTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalHarvestCrop(stepReqId, target.X, target.Y, target.QualifiedItemId ?? string.Empty, harvestTargetId, deadline);
                break;

            case "pickup_forage":
            case "collect_forage":
                string forageTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveForageTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalPickupForage(stepReqId, target.X, target.Y, target.QualifiedItemId ?? string.Empty, forageTargetId, deadline);
                break;

            case "use_item":
                receipt = this.executions.RequestLocalUseItem(stepReqId, target.Slot ?? 0, target.QualifiedItemId ?? string.Empty, deadline);
                break;

            case "clear_hoedirt":
                receipt = this.executions.RequestLocalClearHoeDirt(stepReqId, target.Slot ?? 0, target.X, target.Y, target.ExpectedTargetId ?? string.Empty, deadline);
                break;

            default:
                return Result<string, string>.Fail($"unsupported_step_action:{actionType.ToLowerInvariant()}");
        }

        return receipt.State == ExecutionState.Succeeded
            ? Result<string, string>.Ok(receipt.ReasonCode)
            : Result<string, string>.Fail(receipt.ReasonCode);
    }

    private static string ResolveCropTargetId(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature) && feature is HoeDirt dirt && dirt.crop != null)
        {
            return ExecutionManager.BuildCropTargetId(location, x, y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value);
        }
        return string.Empty;
    }

    private static string ResolveForageTargetId(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? forage) && forage.isForage())
        {
            return ExecutionManager.BuildForageTargetId(location, x, y, forage);
        }
        return string.Empty;
    }
}
