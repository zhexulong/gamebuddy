using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BridgeReceiptWireParityTests
{
    /// <summary>
    /// Structurally valid observation id: "so1_" plus exactly 22 wire characters
    /// (BridgeProtocol.IsValidObservationId requires the "so1_" prefix, a total
    /// length of 26, and a [A-Za-z0-9_-] tail).
    /// </summary>
    private const string ObservationId = "so1_0123456789abcdefghijkl";

    /// <summary>
    /// Host wire parity fixture: every BridgeReceipt field carries a real legal
    /// value, including all three optional fields (observation, piggybackedScene,
    /// nativeNotices). A fixture that leaves an optional field null would omit it
    /// from the wire (JsonIgnore WhenWritingNull), so the cross-language parity
    /// chain would never validate how the Host reads that field -- that exact gap
    /// silently let the three optional fields drift on the Host side.
    /// </summary>
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
            new Dictionary<string, string> { ["detail"] = "machine=target;slot=none" },
            new BridgeLocalObservation("Farm", 1, 2, 0, "0600", false, 7),
            new ObserveSceneResultPayload(
                ObservationId,
                "Farm",
                "Farm",
                System.Array.Empty<ObserveSceneAffordancePayload>(),
                "Farm",
                false,
                null,
                null),
            new[] { "Out of season.", "Inventory Full" });
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

        // The three optional fields must actually reach the wire; an output that
        // omits them would defeat the Host parity chain (the Host side has already
        // drifted on these fields once).
        JsonElement payload = document.RootElement.GetProperty("payload");
        payload.GetProperty("executionId").GetString().Should().Be("typed_execution_router");
        payload.GetProperty("requestId").GetString().Should().Be("typed_request_router");
        payload.GetProperty("actionId").GetString().Should().Be("machine_inspect");
        payload.GetProperty("state").GetString().Should().Be("rejected");
        payload.GetProperty("reasonCode").GetString().Should().Be("world_not_ready");
        payload.GetProperty("revision").GetInt64().Should().Be(1);
        payload.GetProperty("evidence").GetProperty("detail").GetString().Should().Be("machine=target;slot=none");
        payload.GetProperty("observation").GetProperty("location").GetString().Should().Be("Farm");
        payload.GetProperty("observation").GetProperty("revision").GetInt64().Should().Be(7);
        payload.GetProperty("piggybackedScene").GetProperty("observationId").GetString().Should().Be(ObservationId);
        payload.GetProperty("piggybackedScene").GetProperty("partial").GetBoolean().Should().BeFalse();
        payload.GetProperty("piggybackedScene").GetProperty("truncatedReason").ValueKind.Should().Be(JsonValueKind.Null);
        payload.GetProperty("nativeNotices").EnumerateArray().Select(item => item.GetString())
            .Should().Equal("Out of season.", "Inventory Full");

        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(json);
    }
}