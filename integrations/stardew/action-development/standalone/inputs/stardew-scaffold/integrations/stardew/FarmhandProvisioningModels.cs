using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal static class FarmhandProvisioningProtocol
{
    internal const int Version = 1;
    internal const string IntegrationId = "stardew";
    internal const string AdvertisementFileName = "stardew-session.json";
    internal const string RequestFileName = "stardew-attachment-request.json";
    internal const string ManifestFileName = "stardew-farmhand-manifest.json";
    internal const string ResponseFileName = "stardew-attachment-response.json";
    internal const string FixtureReadinessFileName = "stardew-fixture-readiness.json";
    internal const string SaveDataKey = "GameBuddy.farmhand-bindings-v1";

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    internal static bool IsValidToken(string? value) => value is not null
        && value.Length is >= 16 and <= 256
        && value.All(character => character is >= (char)0x21 and <= (char)0x7e);

    internal static bool IsValidEndpoint(string? value)
    {
        if (value is null || value.Length is < 3 or > 255)
            return false;
        int separator = value.LastIndexOf(':');
        if (separator <= 0 || separator == value.Length - 1 || !int.TryParse(value[(separator + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out int port) || port is < 1 or > 65535)
            return false;
        string host = value[..separator];
        return host.Length <= 253 && host.All(character => char.IsLetterOrDigit(character) || character is '.' or '-');
    }

    internal static bool IsValidOpaque(string? value) => BridgeProtocol.IsOpaqueId(value);

    internal static string Sign<T>(T value, string token) where T : class
    {
        JsonNode? node = JsonSerializer.SerializeToNode(value, JsonOptions);
        if (node is not JsonObject objectNode)
            throw new InvalidOperationException("provisioning_payload_must_be_an_object");
        objectNode.Remove("signature");
        string unsigned = objectNode.ToJsonString(JsonOptions);
        byte[] digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(unsigned));
        return Convert.ToBase64String(digest).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    internal static bool HasValidSignature<T>(T value, string? signature, string token) where T : class
    {
        if (string.IsNullOrWhiteSpace(signature) || !IsValidToken(token))
            return false;
        string expected = Sign(value, token);
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(signature));
    }

    internal static bool TryParseNativeId(string? value, out long id) => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out id) && id != 0;
}

internal sealed record FarmhandSessionAdvertisement
{
    public int SchemaVersion { get; init; }
    public string IntegrationId { get; init; } = string.Empty;
    public string IntegrationVersion { get; init; } = string.Empty;
    public string GameVersion { get; init; } = string.Empty;
    public int GameBuildNumber { get; init; }
    public string SmapiVersion { get; init; } = string.Empty;
    public string MultiplayerProtocol { get; init; } = string.Empty;
    public string Endpoint { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string HostPlayerId { get; init; } = string.Empty;
    public string RuntimeRole { get; init; } = string.Empty;
    public string LaunchGeneration { get; init; } = string.Empty;
    public long PublishedAtUnixMs { get; init; }
    public long ExpiresAtUnixMs { get; init; }
    public string Nonce { get; init; } = string.Empty;
    public string State { get; init; } = string.Empty;
    public IReadOnlyList<FarmhandCabinFact> Cabins { get; init; } = Array.Empty<FarmhandCabinFact>();
    public string Signature { get; init; } = string.Empty;
}

internal sealed class FarmhandCabinFact
{
    public string CabinId { get; init; } = string.Empty;
    public string OwnerFarmhandId { get; init; } = string.Empty;
    public string BoundCompanionId { get; init; } = string.Empty;
    public bool IsBusy { get; init; }
}

internal sealed class FarmhandAttachmentRequest
{
    public int SchemaVersion { get; init; }
    public string IntegrationId { get; init; } = string.Empty;
    public string SessionNonce { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string CompanionId { get; init; } = string.Empty;
    public string CabinId { get; init; } = string.Empty;
    public string ExpectedFarmhandId { get; init; } = string.Empty;
    public long ConfirmedAtUnixMs { get; init; }
    public string RequestId { get; init; } = string.Empty;
    public string Signature { get; init; } = string.Empty;
}

/// <summary>
/// Signed Host-only report emitted after an allowlisted fixture initializer
/// establishes its native preconditions and before LAN/AI attachment begins.
/// It is diagnostic gating data, never a bridge receipt or target authority.
/// </summary>
internal sealed record FixtureReadinessReport
{
    public int SchemaVersion { get; init; }
    public string IntegrationId { get; init; } = string.Empty;
    public string FixtureScenario { get; init; } = string.Empty;
    public string SaveName { get; init; } = string.Empty;
    public string State { get; init; } = string.Empty;
    public string ReasonCode { get; init; } = string.Empty;
    public long PublishedAtUnixMs { get; init; }
    public string SessionNonce { get; init; } = string.Empty;
    public string Signature { get; init; } = string.Empty;
}

internal sealed record FarmhandAttachmentResponse
{
    public int SchemaVersion { get; init; }
    public string RequestId { get; init; } = string.Empty;
    public string State { get; init; } = string.Empty;
    public string ReasonCode { get; init; } = string.Empty;
    public long UpdatedAtUnixMs { get; init; }
    public string? ManifestPath { get; init; }
    public string Signature { get; init; } = string.Empty;
}

internal sealed record FarmhandJoinManifest
{
    public int SchemaVersion { get; init; }
    public string RequestId { get; init; } = string.Empty;
    public string IntegrationId { get; init; } = string.Empty;
    public string IntegrationVersion { get; init; } = string.Empty;
    public string GameVersion { get; init; } = string.Empty;
    public int GameBuildNumber { get; init; }
    public string SmapiVersion { get; init; } = string.Empty;
    public string MultiplayerProtocol { get; init; } = string.Empty;
    public string Endpoint { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string CompanionId { get; init; } = string.Empty;
    public string FarmhandId { get; init; } = string.Empty;
    public string CabinId { get; init; } = string.Empty;
    public string SessionNonce { get; init; } = string.Empty;
    public long IssuedAtUnixMs { get; init; }
    public long ExpiresAtUnixMs { get; init; }
    public string Signature { get; init; } = string.Empty;
}

internal sealed class FarmhandBindingStore
{
    public List<FarmhandBinding> Bindings { get; init; } = new();
    public List<string> ConsumedRequestIds { get; init; } = new();
}

internal sealed class FarmhandBinding
{
    public string CompanionId { get; init; } = string.Empty;
    public long FarmhandId { get; init; }
    public string CabinId { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public long BoundAtUnixMs { get; init; }
}

internal sealed record FarmhandProvisioningResult(string State, string ReasonCode, long? FarmhandId = null)
{
    internal bool IsReady => State == "ready";
}
