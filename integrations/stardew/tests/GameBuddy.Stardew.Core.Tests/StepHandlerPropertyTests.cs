// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerPropertyTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Handlers;
using Xunit;

public class StepHandlerPropertyTests
{
    [Property(MaxTest = 100)]
    public Property EquipToolHandler_RejectsInvalidSlots_AndAcceptsValidSlots(int slot)
    {
        var handler = new EquipToolStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(slot)
        };

        var result = handler.ValidateArgs(args);
        bool expectedSuccess = slot >= 0 && slot <= 36;
        return (result.IsSuccess == expectedSuccess).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property TillSoilHandler_ParsesCoordinates_AcrossPrefixVariations(NonNegativeInt x, NonNegativeInt y, int formatKind)
    {
        var handler = new TillSoilStepHandler();
        string handle = (formatKind % 4) switch
        {
            0 => $"soil:{x.Get},{y.Get}",
            1 => $"soil_Farm:{x.Get}_{y.Get}",
            2 => $"Farm:{x.Get},{y.Get}",
            _ => $"{x.Get},{y.Get}"
        };
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement(handle)
        };

        var result = handler.ValidateArgs(args);
        return (result.IsSuccess && result.Value.X == x.Get && result.Value.Y == y.Get).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property WaterCropHandler_ParsesCoordinates_AcrossPrefixVariations(NonNegativeInt x, NonNegativeInt y, int formatKind)
    {
        var handler = new WaterCropStepHandler();
        string handle = (formatKind % 4) switch
        {
            0 => $"crop:{x.Get},{y.Get}",
            1 => $"crop_Farm:{x.Get}_{y.Get}",
            2 => $"Farm:{x.Get},{y.Get}",
            _ => $"{x.Get},{y.Get}"
        };
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement(handle)
        };

        var result = handler.ValidateArgs(args);
        return (result.IsSuccess && result.Value.X == x.Get && result.Value.Y == y.Get).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property NegativeFuzzing_MalformedTargetHandles_FailClosed(NonEmptyString randomNoise)
    {
        var tillHandler = new TillSoilStepHandler();
        var waterHandler = new WaterCropStepHandler();

        // If noise does not contain valid numeric coordinates, it must fail closed
        if (!randomNoise.Get.Contains(","))
        {
            var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(randomNoise.Get) };
            var tillRes = tillHandler.ValidateArgs(args);
            var waterRes = waterHandler.ValidateArgs(args);
            return (tillRes.IsFailure && waterRes.IsFailure).ToProperty();
        }
        return true.ToProperty();
    }

    [Property(MaxTest = 50)]
    public Property NegativeFuzzing_NegativeCoordinates_FailClosed(NegativeInt negX, NegativeInt negY)
    {
        var tillHandler = new TillSoilStepHandler();
        var waterHandler = new WaterCropStepHandler();
        string handle = $"soil:{negX.Get},{negY.Get}";
        var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(handle) };
        var tillRes = tillHandler.ValidateArgs(args);
        var waterRes = waterHandler.ValidateArgs(args);
        return (tillRes.IsFailure && waterRes.IsFailure).ToProperty();
    }

    [Property(MaxTest = 50)]
    public Property CoordinateOverflow_ExceedingInt32_FailsClosedGracefully(PositiveInt largeOffset)
    {
        var tillHandler = new TillSoilStepHandler();
        long overflowX = (long)int.MaxValue + largeOffset.Get;
        string handle = $"soil:{overflowX},15";
        var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(handle) };
        var result = tillHandler.ValidateArgs(args);
        return (result.IsFailure && result.Error == "invalid_tile_coordinates").ToProperty();
    }
}
