using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Transport-neutral Phase 2 wire DTOs. A future local IPC adapter may move
/// these bounded JSON envelopes between processes, but never invokes Stardew
/// APIs off the game thread. Property names intentionally match host protocol.
/// </summary>
internal static class BridgeProtocol
{
    internal const int Version = 1;
    internal const int MaximumMessageBytes = 16 * 1024;

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static bool TrySerialize<T>(T value, out string json, out string reasonCode)
    {
        try
        {
            json = JsonSerializer.Serialize(value, JsonOptions);
            if (System.Text.Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes)
            {
                json = string.Empty;
                reasonCode = "message_too_large";
                return false;
            }

            reasonCode = "accepted";
            return true;
        }
        catch (JsonException)
        {
            json = string.Empty;
            reasonCode = "message_not_serializable";
            return false;
        }
    }

    internal static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    internal static bool IsReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-');
}

internal sealed record BridgeScope(string IntegrationId, string SaveId, string WorldId, string PlayerId, string CompanionId)
{
    internal bool IsValid => BridgeProtocol.IsOpaqueId(IntegrationId) && BridgeProtocol.IsOpaqueId(SaveId) && BridgeProtocol.IsOpaqueId(WorldId) && BridgeProtocol.IsOpaqueId(PlayerId) && BridgeProtocol.IsOpaqueId(CompanionId);
}

internal sealed record BridgeEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    BridgeScope Scope,
    string Type,
    TPayload Payload);

internal sealed record BridgeSnapshot(
    long Revision,
    string Location,
    float TileX,
    float TileY,
    float Stamina,
    int Health,
    bool Actionable,
    IReadOnlyList<string> Capabilities,
    BridgeActiveExecution? ActiveExecution);

internal sealed record BridgeActiveExecution(
    string ExecutionId,
    string RequestId,
    string Action,
    string State,
    string ReasonCode,
    IReadOnlyDictionary<string, string>? Evidence);

internal sealed record BridgeReceipt(
    string ExecutionId,
    string RequestId,
    string State,
    string ReasonCode,
    long Revision,
    IReadOnlyDictionary<string, string>? Evidence);
