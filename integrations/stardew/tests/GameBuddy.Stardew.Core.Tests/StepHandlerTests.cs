// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
using Xunit;

public class StepHandlerTests
{
    [Fact]
    public void TillSoilHandler_MissingTargetHandle_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void TillSoilHandler_CoordinateOverflow_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:999999999999999999,10")
        };

        var result = handler.ValidateArgs(args);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("invalid_tile_coordinates");
    }

    [Fact]
    public void TillSoilHandler_NegativeCoordinates_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:-5,-10")
        };

        var result = handler.ValidateArgs(args);
        result.IsFailure.Should().BeTrue();
    }

    [Fact]
    public void TillSoilHandler_ValidHandle_Succeeds()
    {
        var handler = new TillSoilStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.X.Should().Be(12);
        result.Value.Y.Should().Be(15);
        result.Value.RawHandle.Should().Be("soil:12,15");
    }

    [Fact]
    public void EquipToolHandler_NonIntegerOrOutOfRangeSlot_FailsClosed()
    {
        var handler = new EquipToolStepHandler();
        var strSlotArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement("first_slot")
        };
        handler.ValidateArgs(strSlotArgs).IsFailure.Should().BeTrue();

        var outOfRangeArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(99)
        };
        handler.ValidateArgs(outOfRangeArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(outOfRangeArgs).Error.Should().Be("invalid_tool_slot_range");
    }

    [Fact]
    public void EquipToolHandler_ValidSlot_Succeeds()
    {
        var handler = new EquipToolStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(5)
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(5);
        result.Value.RawHandle.Should().Be("slot:5");
    }

    [Fact]
    public void WaterCropHandler_MissingCropTarget_FailsClosed()
    {
        var handler = new WaterCropStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void WaterCropHandler_ValidCropTarget_PreservesExpectedTargetId()
    {
        var handler = new WaterCropStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("crop:10,20"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("crop_Farm:10,20:472")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.X.Should().Be(10);
        result.Value.Y.Should().Be(20);
        result.Value.ExpectedTargetId.Should().Be("crop_Farm:10,20:472");
    }

    [Fact]
    public void PlantSeedHandler_ValidatesSlotAndTargetAndItemId()
    {
        var handler = new PlantSeedStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(2),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)472"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("seed_custom_id")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(2);
        result.Value.X.Should().Be(12);
        result.Value.Y.Should().Be(15);
        result.Value.QualifiedItemId.Should().Be("(O)472");
        result.Value.ExpectedTargetId.Should().Be("seed_custom_id");
    }

    [Fact]
    public void PlantSeedHandler_MissingRequiredFields_FailsClosed()
    {
        var handler = new PlantSeedStepHandler();

        // Missing slot
        var noSlotArgs = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)472")
        };
        handler.ValidateArgs(noSlotArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(noSlotArgs).Error.Should().Be("invalid_slot_arg");

        // Missing itemId
        var noItemArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(0),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15")
        };
        handler.ValidateArgs(noItemArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(noItemArgs).Error.Should().Be("missing_qualified_item_id");
    }

    [Fact]
    public void FertilizeTileHandler_ValidatesSlotAndTargetAndItemId()
    {
        var handler = new FertilizeTileStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(1),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:8,9"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)368"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("fert_target")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(1);
        result.Value.X.Should().Be(8);
        result.Value.Y.Should().Be(9);
        result.Value.QualifiedItemId.Should().Be("(O)368");
        result.Value.ExpectedTargetId.Should().Be("fert_target");
    }

    [Fact]
    public void FertilizeTileHandler_MissingFields_FailsClosed()
    {
        var handler = new FertilizeTileStepHandler();
        var noSlotArgs = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:8,9"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)368")
        };
        handler.ValidateArgs(noSlotArgs).IsFailure.Should().BeTrue();

        var noItemArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(1),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:8,9")
        };
        handler.ValidateArgs(noItemArgs).IsFailure.Should().BeTrue();
    }

    [Fact]
    public void HarvestCropHandler_ValidatesCoordinates()
    {
        var handler = new HarvestCropStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("crop:5,8"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)24"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("crop_target")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.X.Should().Be(5);
        result.Value.Y.Should().Be(8);
        result.Value.QualifiedItemId.Should().Be("(O)24");
        result.Value.ExpectedTargetId.Should().Be("crop_target");
    }

    [Fact]
    public void HarvestCropHandler_MissingTargetHandle_FailsClosed()
    {
        var handler = new HarvestCropStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void ForageHandler_ValidatesCoordinatesAndPreservesEvidence()
    {
        var handler = new ForageStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("forage:3,7"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)16"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("forage_target")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.X.Should().Be(3);
        result.Value.Y.Should().Be(7);
        result.Value.QualifiedItemId.Should().Be("(O)16");
        result.Value.ExpectedTargetId.Should().Be("forage_target");
    }

    [Fact]
    public void ForageHandler_MissingTargetHandle_FailsClosed()
    {
        var handler = new ForageStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void UseItemHandler_ValidatesSlotAndItemId()
    {
        var handler = new UseItemStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(0),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)167")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(0);
        result.Value.QualifiedItemId.Should().Be("(O)167");
    }

    [Fact]
    public void UseItemHandler_InvalidSlot_FailsClosed()
    {
        var handler = new UseItemStepHandler();
        var invalidSlotArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(40)
        };

        var result = handler.ValidateArgs(invalidSlotArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_slot_arg");
    }

    [Fact]
    public void ClearHoeDirtHandler_ValidatesSlotAndTarget()
    {
        var handler = new ClearHoeDirtStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(0),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:15,20"),
            ["expectedTargetId"] = JsonSerializer.SerializeToElement("dirt_target")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(0);
        result.Value.X.Should().Be(15);
        result.Value.Y.Should().Be(20);
        result.Value.ExpectedTargetId.Should().Be("dirt_target");
    }

    [Fact]
    public void ClearHoeDirtHandler_MissingSlotOrTarget_FailsClosed()
    {
        var handler = new ClearHoeDirtStepHandler();

        var noSlotArgs = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:15,20")
        };
        handler.ValidateArgs(noSlotArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(noSlotArgs).Error.Should().Be("missing_slot_arg");

        var noTargetArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(0)
        };
        handler.ValidateArgs(noTargetArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(noTargetArgs).Error.Should().Be("missing_target_handle");
    }
}
