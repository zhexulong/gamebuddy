// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopCompositeActionHandlerTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using Xunit;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Routing;

public sealed class SopCompositeActionHandlerTests
{
    private sealed class InMemoryLedger : IExecutionLedger
    {
        public long CurrentRevision => 10;
        public bool IsBodyBusy => false;
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt)
        {
            receipt = default!;
            return false;
        }
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)
            => new(executionId, requestId, state, reasonCode, this.CurrentRevision, evidence);
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    private sealed class DummyStepRunner : ISopStepRunner
    {
        public List<string> Executed { get; } = new();
        public bool FailOnStep1 { get; set; }

        public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
        {
            this.Executed.Add($"{stepIndex}:{actionType}");
            if (this.FailOnStep1 && stepIndex == 1)
            {
                return Result<string, string>.Fail("simulated_step_failure");
            }
            return Result<string, string>.Ok("step_succeeded");
        }

        public object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath)
        {
            if (propertyPath == "terrain.soil_dirt.state.watered") return true;
            return null;
        }
    }

    [Fact]
    public void Handler_RegistersInRouter_AndExecutesCompositePipelineSuccessfully()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var router = new FarmhandActionRouter();
        router.Register(handler);

        var pipelinePayload = new SopPipelineWirePayload(
            "test_pipeline_01",
            new[]
            {
                new SopStepWireDescriptor(0, "equip_tool", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(1, "till_soil", new Dictionary<string, JsonElement>())
            },
            new SopExpectedPullbackDescriptor("terrain.soil_dirt.state.watered", new SopLocationDescriptor("Farm", new SopTileDescriptor(24, 34)), JsonSerializer.SerializeToElement(true))
        );

        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        var request = new BridgeExecutionRequest("req_sop_1", "idem_1", "sop_composite_pipeline", args, 10, deadline);
        var ledger = new InMemoryLedger();

        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("pipeline_succeeded");
        dummyRunner.Executed.Should().Equal("0:equip_tool", "1:till_soil");
        receipt.Evidence.Should().NotBeNullOrEmpty();
        receipt.Evidence.Should().Contain("\"actualValue\":true");
    }

    [Fact]
    public void Handler_ShortCircuitsOnFailure_AndPreservesPartialEvidence()
    {
        var dummyRunner = new DummyStepRunner { FailOnStep1 = true };
        var handler = new SopCompositeActionHandler(dummyRunner);
        var router = new FarmhandActionRouter();
        router.Register(handler);

        var pipelinePayload = new SopPipelineWirePayload(
            "test_pipeline_02",
            new[]
            {
                new SopStepWireDescriptor(0, "equip_tool", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(1, "till_soil", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(2, "water_crop", new Dictionary<string, JsonElement>())
            },
            null
        );

        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        var request = new BridgeExecutionRequest("req_sop_2", "idem_2", "sop_composite_pipeline", args, 10, deadline);
        var ledger = new InMemoryLedger();

        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        receipt.State.Should().Be(ExecutionState.Failed);
        receipt.ReasonCode.Should().Be("step_failed:till_soil:simulated_step_failure");
        dummyRunner.Executed.Should().Equal("0:equip_tool", "1:till_soil");
    }

    [Fact]
    public void Handler_FailsClosed_OnMissingOrMalformedPayload()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var args = new BridgeExecutionArgs();
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        var request = new BridgeExecutionRequest("req_sop_err", "idem_err", "sop_composite_pipeline", args, 10, deadline);
        var ledger = new InMemoryLedger();

        var receipt = handler.Execute(request, ledger);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("missing_sop_pipeline_payload");
        dummyRunner.Executed.Should().BeEmpty();
    }

    [Fact]
    public void Handler_Rejects_PipelineExceedingMaxSteps()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i <= SopStepPipelineRunner.MaxPipelineSteps; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, "equip_tool", new Dictionary<string, JsonElement>()));
        }

        var pipelinePayload = new SopPipelineWirePayload("oversized_pipe", steps, null);
        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        var request = new BridgeExecutionRequest("req_sop_oversized", "idem_oversized", "sop_composite_pipeline", args, 10, deadline);
        var ledger = new InMemoryLedger();

        var receipt = handler.Execute(request, ledger);

        receipt.State.Should().Be(ExecutionState.Failed);
        receipt.ReasonCode.Should().Be("pipeline_too_long");
        dummyRunner.Executed.Should().BeEmpty();
    }
}
