// integrations/stardew/src/Core/Handlers/SopCompositeActionHandler.cs
namespace GameBuddy.Stardew.Core.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Models;

public sealed class SopCompositeActionHandler : IFarmhandActionHandler
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly SopStepPipelineRunner _pipelineRunner;
    private readonly ISopStepRunner _stepRunner;

    public SopCompositeActionHandler(ISopStepRunner stepRunner)
    {
        _stepRunner = stepRunner ?? throw new ArgumentNullException(nameof(stepRunner));
        _pipelineRunner = new SopStepPipelineRunner(stepRunner);
    }

    public IReadOnlyCollection<string> SupportedActions { get; } = new[] { "sop_composite_pipeline" };

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(ledger);

        SopPipelineWirePayload? wirePayload = null;

        if (request.Args.AdditionalProperties != null &&
            request.Args.AdditionalProperties.TryGetValue("pipelinePayload", out JsonElement payloadElement))
        {
            try
            {
                wirePayload = JsonSerializer.Deserialize<SopPipelineWirePayload>(
                    payloadElement.GetRawText(),
                    JsonOptions
                );
            }
            catch (Exception ex)
            {
                return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, $"invalid_sop_payload:exception_{ex.GetType().Name.ToLowerInvariant()}", null);
            }
        }

        if (wirePayload == null)
        {
            return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "missing_sop_pipeline_payload", null);
        }

        if (wirePayload.Steps == null || wirePayload.Steps.Count == 0)
        {
            return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "empty_sop_pipeline", null);
        }

        var result = _pipelineRunner.Execute(wirePayload.Steps, request.DeadlineMs);
        var state = result.IsSuccess ? ExecutionState.Succeeded : ExecutionState.Failed;

        object? actualValue = null;
        if (wirePayload.ExpectedPullback != null)
        {
            actualValue = _stepRunner.SampleStateProperty(
                wirePayload.ExpectedPullback.TargetLocation.Location,
                wirePayload.ExpectedPullback.TargetLocation.Tile.X,
                wirePayload.ExpectedPullback.TargetLocation.Tile.Y,
                wirePayload.ExpectedPullback.TargetProperty
            );
        }

        var compositeEvidence = new CompositeExecutionReceiptPayload(
            request.Action,
            wirePayload.ExpectedPullback?.TargetProperty,
            wirePayload.ExpectedPullback?.TargetLocation,
            wirePayload.ExpectedPullback?.ExpectedValue,
            actualValue,
            result.IsSuccess,
            result.StepReceipts,
            result.FailedStepIndex
        );

        var evidenceJson = JsonSerializer.Serialize(compositeEvidence);
        return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), state, result.ReasonCode, evidenceJson);
    }
}
