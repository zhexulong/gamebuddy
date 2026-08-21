// integrations/stardew/src/Core/Algebra/SopStepPipeline.cs
namespace GameBuddy.Stardew.Core.Algebra;

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed record SopStepWireDescriptor(
    [property: JsonPropertyName("stepIndex")] int StepIndex,
    [property: JsonPropertyName("actionType")] string ActionType,
    [property: JsonPropertyName("args")] IReadOnlyDictionary<string, JsonElement> Args
);

public sealed record SopTileDescriptor(
    [property: JsonPropertyName("x")] int X,
    [property: JsonPropertyName("y")] int Y
);

public sealed record SopLocationDescriptor(
    [property: JsonPropertyName("location")] string Location,
    [property: JsonPropertyName("tile")] SopTileDescriptor Tile
);

public sealed record SopExpectedPullbackDescriptor(
    [property: JsonPropertyName("targetProperty")] string TargetProperty,
    [property: JsonPropertyName("targetLocation")] SopLocationDescriptor TargetLocation,
    [property: JsonPropertyName("expectedValue")] JsonElement ExpectedValue
);

public sealed record SopPipelineWirePayload(
    [property: JsonPropertyName("pipelineId")] string PipelineId,
    [property: JsonPropertyName("steps")] IReadOnlyList<SopStepWireDescriptor> Steps,
    [property: JsonPropertyName("expectedPullback")] SopExpectedPullbackDescriptor? ExpectedPullback
);

public sealed record SopStepReceipt(
    [property: JsonPropertyName("stepIndex")] int StepIndex,
    [property: JsonPropertyName("actionType")] string ActionType,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("reasonCode")] string ReasonCode
);

public sealed record SopPipelineResult(
    [property: JsonPropertyName("isSuccess")] bool IsSuccess,
    [property: JsonPropertyName("failedStepIndex")] int? FailedStepIndex,
    [property: JsonPropertyName("stepReceipts")] IReadOnlyList<SopStepReceipt> StepReceipts,
    [property: JsonPropertyName("reasonCode")] string ReasonCode
);

public interface ISopStepRunner
{
    Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args);
    object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath);
}

public sealed class SopStepPipelineRunner
{
    public const int MaxPipelineSteps = 16;
    private readonly ISopStepRunner _runner;

    public SopStepPipelineRunner(ISopStepRunner runner)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
    }

    public SopPipelineResult Execute(IReadOnlyList<SopStepWireDescriptor> steps, long? requestedDeadlineMs = null)
    {
        if (steps == null || steps.Count == 0)
        {
            return new SopPipelineResult(false, null, Array.Empty<SopStepReceipt>(), "empty_sop_pipeline");
        }

        if (steps.Count > MaxPipelineSteps)
        {
            return new SopPipelineResult(false, null, Array.Empty<SopStepReceipt>(), "pipeline_too_long");
        }

        var receipts = new List<SopStepReceipt>();

        for (int i = 0; i < steps.Count; i++)
        {
            var step = steps[i];
            if (step.StepIndex != i)
            {
                return new SopPipelineResult(false, step.StepIndex, receipts, "invalid_step_index_sequence");
            }

            if (requestedDeadlineMs.HasValue && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > requestedDeadlineMs.Value)
            {
                receipts.Add(new SopStepReceipt(step.StepIndex, step.ActionType, "failed", "timed_out"));
                return new SopPipelineResult(false, step.StepIndex, receipts, "timed_out");
            }

            Result<string, string> stepResult;
            try
            {
                stepResult = _runner.ExecuteStep(step.StepIndex, step.ActionType, step.Args);
            }
            catch (Exception ex)
            {
                stepResult = Result<string, string>.Fail($"exception_{ex.GetType().Name.ToLowerInvariant()}");
            }

            string state = stepResult.IsSuccess ? "succeeded" : "failed";
            string reason = stepResult.IsSuccess ? stepResult.Value : $"step_failed:{step.ActionType}:{stepResult.Error}";
            receipts.Add(new SopStepReceipt(step.StepIndex, step.ActionType, state, reason));

            if (!stepResult.IsSuccess)
            {
                return new SopPipelineResult(false, step.StepIndex, receipts, reason);
            }
        }

        return new SopPipelineResult(true, null, receipts, "pipeline_succeeded");
    }
}
