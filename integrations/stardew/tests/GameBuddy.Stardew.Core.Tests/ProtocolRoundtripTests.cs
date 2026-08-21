using System;
using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ProtocolRoundtripTests
{
    [Property(MaxTest = 100)]
    public Property ExecutionRequestDto_FsCheck_RoundtripPreservesExactValues(
        NonEmptyString reqId,
        NonEmptyString idemKey,
        NonNegativeInt rev,
        PositiveInt deadline,
        int x,
        int y)
    {
        var args = new Dictionary<string, JsonElement>
        {
            ["x"] = JsonSerializer.SerializeToElement(x),
            ["y"] = JsonSerializer.SerializeToElement(y)
        };
        var original = new ExecutionRequestDto(reqId.Get, idemKey.Get, "till_soil", rev.Get, deadline.Get, args);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionRequestDto>(json);

        bool pass = deserialized != null &&
                    deserialized.RequestId == reqId.Get &&
                    deserialized.IdempotencyKey == idemKey.Get &&
                    deserialized.Action == "till_soil" &&
                    deserialized.ExpectedRevision == rev.Get &&
                    deserialized.DeadlineMs == deadline.Get &&
                    deserialized.Args != null &&
                    deserialized.Args.ContainsKey("x") &&
                    deserialized.Args["x"].GetInt32() == x;

        return pass.ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property ExecutionReceiptDto_FsCheck_RoundtripPreservesExactValues(
        NonEmptyString execId,
        NonEmptyString reqId,
        NonEmptyString reason,
        NonNegativeInt rev,
        bool hasEvidence,
        int evidenceVal)
    {
        IReadOnlyDictionary<string, JsonElement>? evidence = hasEvidence
            ? new Dictionary<string, JsonElement> { ["result"] = JsonSerializer.SerializeToElement(evidenceVal) }
            : null;

        var original = new ExecutionReceiptDto(execId.Get, reqId.Get, "succeeded", reason.Get, rev.Get, evidence);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionReceiptDto>(json);

        bool pass = deserialized != null &&
                    deserialized.ExecutionId == execId.Get &&
                    deserialized.RequestId == reqId.Get &&
                    deserialized.State == "succeeded" &&
                    deserialized.ReasonCode == reason.Get &&
                    deserialized.Revision == rev.Get &&
                    (hasEvidence ? (deserialized.Evidence != null && deserialized.Evidence.ContainsKey("result") && deserialized.Evidence["result"].GetInt32() == evidenceVal) : deserialized.Evidence == null);

        return pass.ToProperty();
    }

    [Fact]
    public void ExecutionRequestDto_SystemTextJson_RoundtripPreservesExactValues()
    {
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15"),
            ["slot"] = JsonSerializer.SerializeToElement(2)
        };
        var original = new ExecutionRequestDto("req_100", "idem_200", "till_soil", 42, 5000, args);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionRequestDto>(json);

        deserialized.Should().NotBeNull();
        deserialized!.RequestId.Should().Be("req_100");
        deserialized.IdempotencyKey.Should().Be("idem_200");
        deserialized.Action.Should().Be("till_soil");
        deserialized.ExpectedRevision.Should().Be(42);
        deserialized.DeadlineMs.Should().Be(5000);
        deserialized.Args.Should().ContainKey("targetHandle");
    }

    [Fact]
    public void ExecutionReceiptDto_SystemTextJson_HandlesNullAndNonNullEvidence()
    {
        var withNullEvidence = new ExecutionReceiptDto("exec_1", "req_1", "succeeded", "ok", 10, null);
        string jsonNull = JsonSerializer.Serialize(withNullEvidence);
        var deserializedNull = JsonSerializer.Deserialize<ExecutionReceiptDto>(jsonNull);
        deserializedNull.Should().NotBeNull();
        deserializedNull!.Evidence.Should().BeNull();

        var evidence = new Dictionary<string, JsonElement>
        {
            ["tilledTile"] = JsonSerializer.SerializeToElement("12,15")
        };
        var withEvidence = new ExecutionReceiptDto("exec_2", "req_2", "succeeded", "ok", 11, evidence);
        string jsonWith = JsonSerializer.Serialize(withEvidence);
        var deserializedWith = JsonSerializer.Deserialize<ExecutionReceiptDto>(jsonWith);
        deserializedWith.Should().NotBeNull();
        deserializedWith!.Evidence.Should().NotBeNull();
        deserializedWith.Evidence.Should().ContainKey("tilledTile");
    }
}
