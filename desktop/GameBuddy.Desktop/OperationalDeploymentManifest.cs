using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The operational deployment manifest is absent, unreadable, or not an exact
/// versioned deployment identity, so the launch can never enter Host composition.
/// </summary>
internal sealed class DeploymentIdentityUnavailableException : Exception
{
    internal DeploymentIdentityUnavailableException() : base("GameBuddy deployment identity is unavailable.")
    {
    }

    internal DeploymentIdentityUnavailableException(Exception innerException)
        : base("GameBuddy deployment identity is unavailable.", innerException)
    {
    }
}

/// <summary>
/// The five semantic-identity values a deployment manifest carries: the three
/// principal identifiers, the bootstrap operation identifier and the authority
/// generation. The durable identity record holds these same five values, which is
/// why the comparison between the two is one value comparison and not a field
/// walk repeated in two places.
/// </summary>
internal sealed record DeploymentIdentityValues(
    string ContinuityId,
    string CompanionId,
    string PlayerId,
    string BootstrapOperationId,
    int AuthorityGeneration);

/// <summary>
/// The schema reader for the operational deployment manifest, the one file the
/// admitted Host child loads from <c>&lt;operationalRoot&gt;\deployment-manifest.json</c>.
///
/// The content authority stays with Host: <c>host/src/deployment-manifest.ts</c>
/// defines the schema and the child revalidates the loaded document through
/// <c>loadHostDeploymentManifest</c> before any mutable owner opens. This type
/// therefore only reads: it returns the five semantic-identity values of an exact
/// v2 manifest, refuses one that is absent, unreadable or not exact, and writes
/// nothing. Establishing, projecting or minting the identity belongs to
/// <see cref="DeploymentIdentity"/>, which is the component that owns the durable
/// record's relationship with this file.
/// </summary>
internal static class OperationalDeploymentManifest
{
    // The exact file name is the one RuntimeSupervisor hands the Host child as
    // GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST; there is no second path or alias.
    internal const string FileName = "deployment-manifest.json";

    internal const int SchemaVersion = 2;
    internal const string Topology = "independent_chat_and_game_surfaces";

    // The Host schema is closed: exactly these keys, in both objects, with no
    // extra key tolerated (host/src/deployment-manifest.ts).
    internal static readonly string[] TopLevelKeys =
    [
        "schemaVersion",
        "topology",
        "runtimeRoot",
        "principal",
        "bootstrapOperationId",
        "authorityGeneration",
    ];

    internal static readonly string[] PrincipalKeys = ["continuityId", "companionId", "playerId"];

    /// <summary>
    /// Requires an exact operational deployment manifest for this layout and leaves
    /// it exactly as it is. An absent or unusable manifest fails closed with this
    /// step's own outcome rather than the later, opaque launch failure it would
    /// otherwise become.
    /// </summary>
    internal static void Require(CurrentUserRootLayout layout) => _ = Read(layout);

    /// <summary>
    /// Reads the exact operational deployment manifest and returns its five semantic
    /// identity values. This is the schema's one reader: <see cref="Require"/> is this
    /// read with the result discarded, and the identity owner compares the durable
    /// record against these values instead of re-deriving the schema. It writes
    /// nothing and leaves the file exactly as it is.
    /// </summary>
    internal static DeploymentIdentityValues Read(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var path = Path.Combine(layout.OperationalRoot, FileName);
        try
        {
            if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new DeploymentIdentityUnavailableException();
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var manifest = document.RootElement;
            if (manifest.ValueKind != JsonValueKind.Object ||
                !ExactKeys(manifest, TopLevelKeys) ||
                !IntegerEquals(manifest.GetProperty("schemaVersion"), SchemaVersion) ||
                !StringEquals(manifest.GetProperty("topology"), Topology) ||
                !ExistingOrdinaryDirectory(manifest.GetProperty("runtimeRoot")) ||
                !ExactKeys(manifest.GetProperty("principal"), PrincipalKeys) ||
                manifest.GetProperty("principal").EnumerateObject().Any(property => !OpaqueIdentifier(property.Value)) ||
                !OpaqueIdentifier(manifest.GetProperty("bootstrapOperationId")) ||
                !PositiveInteger(manifest.GetProperty("authorityGeneration")))
            {
                throw new DeploymentIdentityUnavailableException();
            }

            var principal = manifest.GetProperty("principal");
            return new DeploymentIdentityValues(
                principal.GetProperty("continuityId").GetString()!,
                principal.GetProperty("companionId").GetString()!,
                principal.GetProperty("playerId").GetString()!,
                manifest.GetProperty("bootstrapOperationId").GetString()!,
                manifest.GetProperty("authorityGeneration").GetInt32());
        }
        catch (DeploymentIdentityUnavailableException)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        {
            throw new DeploymentIdentityUnavailableException(exception);
        }
    }

    // The three principal identifiers, the bootstrap operation identifier and the
    // Host-side identifier pattern: 1-128 of [A-Za-z0-9_-].
    internal static bool OpaqueIdentifier(string? text) =>
        text is { Length: >= 1 and <= 128 } &&
        text.All(static character => character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-');

    private static bool OpaqueIdentifier(JsonElement value) =>
        value.ValueKind == JsonValueKind.String && OpaqueIdentifier(value.GetString());

    private static bool IntegerEquals(JsonElement value, int expected) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var actual) && actual == expected;

    private static bool StringEquals(JsonElement value, string expected) =>
        value.ValueKind == JsonValueKind.String && StringComparer.Ordinal.Equals(value.GetString(), expected);

    private static bool PositiveInteger(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var actual) && actual >= 1;

    // Host canonicalizes runtimeRoot and requires it to be a directory, so a
    // manifest that names a non-directory or a reparse point is refused here rather
    // than becoming an opaque late failure inside the child.
    private static bool ExistingOrdinaryDirectory(JsonElement value) =>
        value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: > 0 } path &&
        Path.IsPathFullyQualified(path) &&
        Directory.Exists(path) &&
        (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;

    private static bool ExactKeys(JsonElement value, string[] names) =>
        value.ValueKind == JsonValueKind.Object &&
        value.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal)
            .SequenceEqual(names.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal);
}
