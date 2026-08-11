using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Independent observe-only wire namespace for the single-player Portfolio
/// topology. It intentionally shares only the byte-framed transport with the
/// Farmhand bridge; no Farmhand DTO, capability, receipt, or session is reused.
/// </summary>
internal static class PortfolioBridgeProtocol
{
    internal const int Version = 1;
    internal const string IntegrationId = "stardew_portfolio";
    internal const string Topology = "single_player_native_companion";
    internal const string TargetGameVersion = "1.6.15";
    internal const int TargetGameBuildNumber = 24356;
    internal const int MaximumMessageBytes = 16 * 1024;
    internal const string PipeNamePrefix = "gamebuddy-stardew-portfolio";

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static bool TrySerialize<T>(T value, out string json, out string reasonCode)
    {
        try
        {
            json = JsonSerializer.Serialize(value, JsonOptions);
            if (Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes)
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

    internal static bool IsToken(string? value) => value is not null && value.Length is >= 16 and <= 256 && IsOpaqueId(value);

    internal static bool IsReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-');

    internal static bool IsSha256(string? value) => value is not null && value.Length == 64 && value.All(character =>
        (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));

    internal static bool FixedEquals(string? left, string right) => CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(left ?? string.Empty),
        Encoding.UTF8.GetBytes(right));
}

internal sealed record PortfolioScope(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => IntegrationId == PortfolioBridgeProtocol.IntegrationId
        && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId)
        && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId)
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && BindingGeneration > 0
        && PortfolioBridgeProtocol.IsSha256(BindingHash)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    PortfolioScope Scope,
    string Type,
    TPayload Payload)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioHello(string Token)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioHelloAck(string SessionId, long BindingGeneration, string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioObserveRequest()
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

/// <summary>
/// Observe-only state. It deliberately has no capabilities, active execution,
/// request, receipt, DSM, checkpoint, or Farmhand identity fields.
/// </summary>
internal sealed record PortfolioSnapshot(
    int ProtocolVersion,
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash,
    long Revision,
    bool WorldReady,
    bool SinglePlayer,
    bool CurrentLocalPlayerMatches,
    string State,
    string ReasonCode);

internal sealed record PortfolioError(string ReasonCode);
