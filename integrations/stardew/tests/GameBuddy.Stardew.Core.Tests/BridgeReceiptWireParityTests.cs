using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BridgeReceiptWireParityTests
{
    [Fact]
    public void MachineInspectWorldNotReadyReceipt_SerializesForHostWireParity()
    {
        string? outputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_EXECUTION_RECEIPT_WIRE_OUTPUT");
        if (outputPath is null)
            return;

        Path.IsPathFullyQualified(outputPath).Should().BeTrue(
            "the Host parity test must own an absolute private output path");

        var receipt = new BridgeReceipt(
            "typed_execution_router",
            "typed_request_router",
            "machine_inspect",
            "rejected",
            "world_not_ready",
            1,
            null);
        var response = new BridgeEnvelope<BridgeReceipt>(
            BridgeProtocol.Version,
            "receipt_publication_01",
            "execution_correlation_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "execution_receipt",
            receipt);

        BridgeProtocol.TrySerialize(response, out string json, out string serializationReason)
            .Should().BeTrue(serializationReason);
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("correlationId").GetString().Should().Be("execution_correlation_01");

        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(json);
    }
}
