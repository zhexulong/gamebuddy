using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class FarmhandTypedReceiptContractTests
{
    [Fact]
    public void LocalPipeBridge_CompletionsTrackActualGenerationBoundDelivery()
    {
        FarmhandLocalPipeBridgeDeliveryTests.Run();
    }

    [Fact]
    public void RegisteredMachineInspect_ProducesExactWorldNotReadyReceipt()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "machine_inspect" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations.Single(candidate => candidate.ActionId == "machine_inspect");
        var router = new FarmhandActionRouter();
        router.Register(registration, new MachineAndAnimalActionHandler(executions));

        bool routed = router.TryRoute(
            new BridgeExecutionRequest("typed_request_router", "typed_idempotency_router", "machine_inspect", new BridgeExecutionArgs { X = 1, Y = 1, ExpectedTargetId = "machine_target_contract" }, 0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000),
            executions,
            out LocalExecutionReceipt receipt,
            out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.RequestId.Should().Be("typed_request_router");
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
        receipt.Revision.Should().Be(1);

        string? outputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_EXECUTION_RECEIPT_WIRE_OUTPUT");
        if (outputPath is null)
            return;

        Path.IsPathFullyQualified(outputPath).Should().BeTrue(
            "the Host parity test must own an absolute private output path");
        var bridgeReceipt = new BridgeReceipt(
            receipt.ExecutionId,
            receipt.RequestId,
            "machine_inspect",
            receipt.State.ToWireValue(),
            receipt.ReasonCode,
            receipt.Revision,
            null);
        var response = new BridgeEnvelope<BridgeReceipt>(
            BridgeProtocol.Version,
            "receipt_publication_01",
            "execution_correlation_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "execution_receipt",
            bridgeReceipt);
        BridgeProtocol.TrySerialize(response, out string json, out string serializationReason)
            .Should().BeTrue(serializationReason);
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("correlationId").GetString().Should().Be("execution_correlation_01");
        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false));
        writer.Write(json);
    }
}
