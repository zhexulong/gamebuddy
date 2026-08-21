// integrations/stardew/src/Core/Abstractions/IStepHandler.cs
namespace GameBuddy.Stardew.Core.Abstractions;

using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Algebra;

public readonly record struct StepParsedTarget(
    int X,
    int Y,
    string RawHandle,
    int? Slot = null,
    string? QualifiedItemId = null,
    string? ExpectedTargetId = null
);

public interface IStepHandler
{
    string ActionType { get; }
    Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args);
}
