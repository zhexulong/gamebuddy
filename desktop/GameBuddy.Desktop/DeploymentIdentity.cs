using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Minting the deployment identity a launch needs failed. It is named apart from
/// <see cref="DeploymentIdentityUnavailableException"/> because the event is
/// different: there was no identity to find and the one attempt to establish the
/// first one did not complete. This code is never a substitute for
/// <c>deployment_identity_conflict</c>, which means the opposite - two identities
/// already exist and disagree.
/// </summary>
internal sealed class DeploymentIdentityMintUnavailableException : Exception
{
    internal DeploymentIdentityMintUnavailableException(Exception innerException)
        : base("GameBuddy deployment identity could not be minted.", innerException)
    {
    }
}

/// <summary>
/// Establishing the deployment identity failed for a reason that is neither minting
/// nor disagreement: the durable identity beside the authority could not be read or
/// written, or a projection could not be written on one ordinary file creation.
/// </summary>
internal sealed class DeploymentIdentityEstablishUnavailableException : Exception
{
    internal DeploymentIdentityEstablishUnavailableException(Exception innerException)
        : base("GameBuddy deployment identity could not be established.", innerException)
    {
    }
}

/// <summary>
/// An operational manifest and a durable identity record both exist and do not carry
/// the same identity. The launch stops here: neither file is overwritten and neither
/// is preferred, because choosing one would decide which durable authority the
/// deployment belongs to.
/// </summary>
internal sealed class DeploymentIdentityConflictException : Exception
{
    internal DeploymentIdentityConflictException()
        : base("GameBuddy deployment identity conflicts with the durable identity record.")
    {
    }
}

/// <summary>
/// The launch's deployment identity, established before the admitted Host child
/// exists.
///
/// The identity is a durable fact about this installation, not about the media it
/// came from: `<operationalRoot>\deployment-manifest.json` is a projection of it and
/// the disposable operational root may be removed and recreated freely. The record
/// therefore lives beside the authority on the durable data side, in
/// `<dataRoot>\deployment-identity.json`, and the launcher establishes it exactly
/// once per installation:
///
/// <list type="bullet">
/// <item>manifest present - the identity already has an authority; nothing is
/// written, rewritten or repaired, and the record is not even read;</item>
/// <item>manifest absent, record present - the manifest is materialized from the
/// record: a projection, not a mint;</item>
/// <item>neither present - the identity is minted once and the record is written
/// before the projection that must agree with it, and the first-run staging marker - the
/// record that a mint was staged - is written before both;</item>
/// <item>both present and disagreeing - <see cref="DeploymentIdentityConflictException"/>,
/// with neither file touched.</item>
/// </list>
///
/// The identity answers who this deployment is, not whether the run that minted it ever
/// finished; the physical completeness of the durable authority answers the second question
/// (<see cref="ProductionAuthority"/>, <see cref="SessionModeDecision"/>) and the caller needs
/// both. A launch establishes the authority - and only a launch that establishes it may ask
/// the Host for a fresh one - when this step minted the identity or the identity it found has
/// no complete authority behind it.
///
/// The manifest must exist before the Host child does, because the supervisor
/// requires that file and the child reads it as input; the writer can therefore
/// never be the child itself. No identity value is derived from the generation, the
/// environment or an override, and there is deliberately no switch that can force a
/// mint or a re-mint: an installation that already carries an authority can only ever
/// be presented the identity it was created with, and no default principal name is
/// invented when a durable identity is absent.
/// </summary>
internal static class DeploymentIdentity
{
    /// <summary>
    /// The durable record beside the authority. The name is versioned because the
    /// record is a format, not an internal implementation detail: it outlives
    /// product updates.
    /// </summary>
    internal const string RecordFileName = "deployment-identity.json";

    internal const string RecordSchema = "gamebuddy-deployment-identity/v1";

    // A durable identity record the product cannot read is refused rather than
    // replaced, so it is read through the platform's own default text decoder: the
    // BOM, if the file has one, decodes and no stray U+FEFF reaches the parser.
    private static readonly Encoding RecordEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    private static readonly string[] RecordKeys =
    [
        "schemaVersion",
        "continuityId",
        "companionId",
        "playerId",
        "bootstrapOperationId",
        "authorityGeneration",
    ];

    /// <summary>
    /// The launcher's pre-launch identity step: returns whether this launch mints the
    /// deployment identity, and guarantees that on return an admitted Host child can
    /// read `<operationalRoot>\deployment-manifest.json`. The caller presents
    /// <c>fresh</c> to a minting launch and to a launch whose identity has no physically
    /// complete authority behind it, and <c>known</c> to every launch that opens the
    /// authority a completed run left, because the identity this returns is the one the
    /// authority was created with.
    /// </summary>
    internal static bool EstablishForCurrentUser(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var manifestPath = Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName);
        var recordPath = Path.Combine(layout.DataRoot, RecordFileName);

        // The manifest is the identity's existing authority: it is validated and then
        // left byte-for-byte as it is, never rewritten and never repaired. Its values
        // are still read, because a durable record beside the authority that says
        // something different is the disagreement this step exists to refuse.
        if (File.Exists(manifestPath))
        {
            var existing = OperationalDeploymentManifest.Read(layout);
            var durable = ReadRecord(recordPath);
            if (durable is not null && !Agree(existing, durable))
            {
                throw new DeploymentIdentityConflictException();
            }

            return false;
        }

        // A record the product cannot read is refused rather than replaced, and it is
        // never treated as a missing identity: minting beside it would put a second
        // identity into an installation that may already have one.
        var record = ReadRecord(recordPath);
        if (record is not null)
        {
            // A projection, not a mint: the identity is the record's and the manifest
            // is only the form the Host child reads it in.
            WriteProjection(manifestPath, layout.DataRoot, record);
            return false;
        }

        // Staging before the record: a crash between the two has to leave a mint that
        // did not happen, never an identity that no authority was ever created for.
        FirstRunStaging.MarkIncomplete(layout);
        var minted = Mint();
        WriteRecord(recordPath, minted);
        WriteProjection(manifestPath, layout.DataRoot, minted);
        return true;
    }

    /// <summary>Whether a manifest's identity and a durable record carry the same five values.</summary>
    internal static bool Agree(DeploymentIdentityValues first, DeploymentIdentityValues second) =>
        StringComparer.Ordinal.Equals(first.ContinuityId, second.ContinuityId) &&
        StringComparer.Ordinal.Equals(first.CompanionId, second.CompanionId) &&
        StringComparer.Ordinal.Equals(first.PlayerId, second.PlayerId) &&
        StringComparer.Ordinal.Equals(first.BootstrapOperationId, second.BootstrapOperationId) &&
        first.AuthorityGeneration == second.AuthorityGeneration;

    /// <summary>
    /// The one mint in the product. Every value is fresh and independent: none is
    /// derived from the generation, the environment, an override or the other values,
    /// and the shape is the identifier pattern the manifest schema and the semantic
    /// store both enforce (<c>^[A-Za-z0-9_-]{1,128}$</c>).
    /// </summary>
    private static DeploymentIdentityValues Mint() => new(
        $"continuity-{Guid.NewGuid():D}",
        $"companion-{Guid.NewGuid():D}",
        $"player-{Guid.NewGuid():D}",
        $"bootstrap-{Guid.NewGuid():D}",
        1);

    /// <summary>Reads the durable record; a missing one is <c>null</c> and unreadable one fails closed.</summary>
    private static DeploymentIdentityValues? ReadRecord(string recordPath)
    {
        try
        {
            if (!File.Exists(recordPath) || (File.GetAttributes(recordPath) & FileAttributes.ReparsePoint) != 0)
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(recordPath));
            var record = document.RootElement;
            if (record.ValueKind != JsonValueKind.Object ||
                !ExactKeys(record, RecordKeys) ||
                !StringEquals(record.GetProperty("schemaVersion"), RecordSchema) ||
                !Opaque(record.GetProperty("continuityId")) ||
                !Opaque(record.GetProperty("companionId")) ||
                !Opaque(record.GetProperty("playerId")) ||
                !Opaque(record.GetProperty("bootstrapOperationId")) ||
                !PositiveInteger(record.GetProperty("authorityGeneration")))
            {
                throw new DeploymentIdentityEstablishUnavailableException(new InvalidDataException("The durable deployment identity record is not an exact record."));
            }

            return new DeploymentIdentityValues(
                record.GetProperty("continuityId").GetString()!,
                record.GetProperty("companionId").GetString()!,
                record.GetProperty("playerId").GetString()!,
                record.GetProperty("bootstrapOperationId").GetString()!,
                record.GetProperty("authorityGeneration").GetInt32());
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        {
            throw new DeploymentIdentityEstablishUnavailableException(exception);
        }
    }

    /// <summary>
    /// Writes the durable record before the projection that must agree with it, and
    /// never replaces one that appeared meanwhile: this is the exact format whose
    /// existence decides that this deployment has already been minted.
    /// </summary>
    private static void WriteRecord(string recordPath, DeploymentIdentityValues values)
    {
        try
        {
            var bytes = Encode(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schemaVersion"] = RecordSchema,
                ["continuityId"] = values.ContinuityId,
                ["companionId"] = values.CompanionId,
                ["playerId"] = values.PlayerId,
                ["bootstrapOperationId"] = values.BootstrapOperationId,
                ["authorityGeneration"] = values.AuthorityGeneration,
            });
            using var stream = new FileStream(recordPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(bytes, 0, bytes.Length);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // A record that already exists is a lost race, not a lost identity: the
            // authority has not been created yet, so the mint did not happen.
            throw new DeploymentIdentityMintUnavailableException(exception);
        }
    }

    /// <summary>
    /// Writes the operational manifest as the identity's projection. The runtime root
    /// is the layout's durable data root, which is where the Host canonicalizes and
    /// opens the semantic authority.
    /// </summary>
    private static void WriteProjection(string manifestPath, string runtimeRoot, DeploymentIdentityValues values)
    {
        try
        {
            var bytes = Encode(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schemaVersion"] = OperationalDeploymentManifest.SchemaVersion,
                ["topology"] = OperationalDeploymentManifest.Topology,
                ["runtimeRoot"] = runtimeRoot,
                ["principal"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["continuityId"] = values.ContinuityId,
                    ["companionId"] = values.CompanionId,
                    ["playerId"] = values.PlayerId,
                },
                ["bootstrapOperationId"] = values.BootstrapOperationId,
                ["authorityGeneration"] = values.AuthorityGeneration,
            });
            using var stream = new FileStream(manifestPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(bytes, 0, bytes.Length);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            throw new DeploymentIdentityEstablishUnavailableException(exception);
        }
    }

    /// <summary>
    /// One ordinary file write: UTF-8 without a BOM, LF line ending, and exactly one
    /// trailing newline for every record and projection.
    /// </summary>
    private static byte[] Encode(Dictionary<string, object?> value) =>
        [.. RecordEncoding.GetBytes(JsonSerializer.Serialize(value)), (byte)'\n'];

    private static bool IsSameOrChild(string path, string ancestor)
    {
        var candidate = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var boundary = Path.TrimEndingDirectorySeparator(Path.GetFullPath(ancestor));
        return StringComparer.Ordinal.Equals(candidate, boundary) ||
            candidate.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static bool Opaque(JsonElement value) =>
        value.ValueKind == JsonValueKind.String && OperationalDeploymentManifest.OpaqueIdentifier(value.GetString());

    private static bool StringEquals(JsonElement value, string expected) =>
        value.ValueKind == JsonValueKind.String && StringComparer.Ordinal.Equals(value.GetString(), expected);

    private static bool PositiveInteger(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var actual) && actual >= 1;

    private static bool ExactKeys(JsonElement value, string[] names) =>
        value.ValueKind == JsonValueKind.Object &&
        value.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal)
            .SequenceEqual(names.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal);
}
