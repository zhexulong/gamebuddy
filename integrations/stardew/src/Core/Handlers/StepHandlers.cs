// integrations/stardew/src/Core/Handlers/StepHandlers.cs
namespace GameBuddy.Stardew.Core.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;

internal static class TileHandleParser
{
    private static readonly Regex TileHandleRegex = new(@"^(?:(?:soil|crop|forage|hoedirt|dirt)[_:])?(?:([A-Za-z0-9_]+)[_:])?(\d+)[,_](\d+)(?::.*)?$", RegexOptions.Compiled);

    public static Result<(int X, int Y, string RawHandle), string> Parse(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("targetHandle", out var handleElem) || handleElem.ValueKind != JsonValueKind.String)
        {
            return Result<(int, int, string), string>.Err("missing_target_handle");
        }

        var handle = handleElem.GetString();
        if (string.IsNullOrWhiteSpace(handle)) return Result<(int, int, string), string>.Err("invalid_target_handle");

        var match = TileHandleRegex.Match(handle);
        if (!match.Success) return Result<(int, int, string), string>.Err("invalid_tile_handle_format");

        int xGroupIdx = match.Groups.Count - 2;
        int yGroupIdx = match.Groups.Count - 1;

        if (!int.TryParse(match.Groups[xGroupIdx].Value, out int x) || !int.TryParse(match.Groups[yGroupIdx].Value, out int y))
        {
            return Result<(int, int, string), string>.Err("invalid_tile_coordinates");
        }

        return Result<(int, int, string), string>.Ok((x, y, handle));
    }
}

public sealed class TillSoilStepHandler : IStepHandler
{
    public string ActionType => "till_soil";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle));
    }
}

public sealed class WaterCropStepHandler : IStepHandler
{
    public string ActionType => "water_crop";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string expectedTargetId = args != null && args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;
        return TileHandleParser.Parse(args!).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class EquipToolStepHandler : IStepHandler
{
    public string ActionType => "equip_tool";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || slotElem.ValueKind != JsonValueKind.Number || !slotElem.TryGetInt32(out int slot))
        {
            return Result<StepParsedTarget, string>.Err("missing_tool_slot");
        }
        if (slot < 0 || slot > 36)
        {
            return Result<StepParsedTarget, string>.Err("invalid_tool_slot_range");
        }
        return Result<StepParsedTarget, string>.Ok(new StepParsedTarget(0, 0, $"slot:{slot}", Slot: slot));
    }
}

public sealed class PlantSeedStepHandler : IStepHandler
{
    public string ActionType => "plant_seed";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || slotElem.ValueKind != JsonValueKind.Number || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("invalid_slot_arg");
        if (!args.TryGetValue("qualifiedItemId", out var itemElem) || itemElem.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(itemElem.GetString()))
            return Result<StepParsedTarget, string>.Err("missing_qualified_item_id");

        string itemId = itemElem.GetString()!;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;

        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class FertilizeTileStepHandler : IStepHandler
{
    public string ActionType => "fertilize_tile";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || slotElem.ValueKind != JsonValueKind.Number || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("invalid_slot_arg");
        if (!args.TryGetValue("qualifiedItemId", out var itemElem) || itemElem.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(itemElem.GetString()))
            return Result<StepParsedTarget, string>.Err("missing_qualified_item_id");

        string itemId = itemElem.GetString()!;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;

        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class HarvestCropStepHandler : IStepHandler
{
    public string ActionType => "harvest_crop";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string itemId = args != null && args.TryGetValue("qualifiedItemId", out var itemElem) && itemElem.ValueKind == JsonValueKind.String
            ? (itemElem.GetString() ?? string.Empty)
            : string.Empty;
        string expectedTargetId = args != null && args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;
        return TileHandleParser.Parse(args!).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class ForageStepHandler : IStepHandler
{
    public string ActionType => "pickup_forage";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string itemId = args != null && args.TryGetValue("qualifiedItemId", out var itemElem) && itemElem.ValueKind == JsonValueKind.String
            ? (itemElem.GetString() ?? string.Empty)
            : string.Empty;
        string expectedTargetId = args != null && args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;
        return TileHandleParser.Parse(args!).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class UseItemStepHandler : IStepHandler
{
    public string ActionType => "use_item";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || slotElem.ValueKind != JsonValueKind.Number || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("missing_slot_arg");
        string itemId = args.TryGetValue("qualifiedItemId", out var itemElem) && itemElem.ValueKind == JsonValueKind.String
            ? (itemElem.GetString() ?? string.Empty)
            : string.Empty;
        return Result<StepParsedTarget, string>.Ok(new StepParsedTarget(0, 0, $"slot:{slot}", Slot: slot, QualifiedItemId: itemId));
    }
}

public sealed class ClearHoeDirtStepHandler : IStepHandler
{
    public string ActionType => "clear_hoedirt";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || slotElem.ValueKind != JsonValueKind.Number || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("missing_slot_arg");
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) && idElem.ValueKind == JsonValueKind.String
            ? (idElem.GetString() ?? string.Empty)
            : string.Empty;
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, ExpectedTargetId: expectedTargetId));
    }
}
