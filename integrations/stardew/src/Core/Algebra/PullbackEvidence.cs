// integrations/stardew/src/Core/Algebra/PullbackEvidence.cs
namespace GameBuddy.Stardew.Core.Algebra;

using System.Collections.Generic;
using System.Text.Json.Serialization;

public sealed record CompositeExecutionReceiptPayload(
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("targetProperty")] string? TargetProperty,
    [property: JsonPropertyName("targetLocation")] SopLocationDescriptor? TargetLocation,
    [property: JsonPropertyName("expectedValue")] object? ExpectedValue,
    [property: JsonPropertyName("actualValue")] object? ActualValue,
    [property: JsonPropertyName("equalizerMatched")] bool EqualizerMatched,
    [property: JsonPropertyName("stepReceipts")] IReadOnlyList<SopStepReceipt> StepReceipts,
    [property: JsonPropertyName("failedStepIndex")] int? FailedStepIndex
);
