using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Cloud TTS consent projected from the one Host-owned player preference record.
/// Narrow and immutable: only the fields the desktop launch gate consumes.
/// </summary>
internal sealed record VoicePreference(VoiceCloudTtsConsent Consent, string? DisclosureVersion, long Revision, string? OutputDevice)
{
    /// <summary>Server TTS is admitted only while the preference is exactly "accepted".</summary>
    internal bool CloudTtsAdmitted => Consent == VoiceCloudTtsConsent.Accepted;

    /// <summary>
    /// Player-selected output endpoint, or null for the Windows default. The
    /// gateway receives this verbatim; an explicit endpoint never falls back.
    /// </summary>
    internal string SelectedOutputDevice => OutputDevice ?? "default";
}

internal enum VoiceCloudTtsConsent
{
    Undecided,
    Accepted,
    Revoked,
}

/// <summary>
/// Pure read-only seam over the one Host-owned player preference record (schema
/// frozen by host/src/settings/player-preference-store.ts). A missing file is the
/// undecided default; any existing file that is not an exact valid record fails
/// closed so a bad file can never be projected as accepted. The record also
/// carries the companion language; this launch gate consumes only its own Voice
/// fields. No CAS, no writes, no token or key material is read and no Host
/// composition surface is referenced.
/// </summary>
internal sealed class VoicePreferenceFileReader
{
    private const int SchemaVersion = 1;
    private const string DisclosureContract = "mimo-cloud-tts-v1";
    private readonly string path;

    internal VoicePreferenceFileReader(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!Path.IsPathFullyQualified(path))
            throw new ArgumentException("The voice preference file must be an absolute path.", nameof(path));
        this.path = path;
    }

    internal VoicePreference Read()
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            return Project(document.RootElement);
        }
        catch (FileNotFoundException) { return Undecided(); }
        catch (DirectoryNotFoundException) { return Undecided(); }
        catch (InvalidVoicePreferenceException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            throw new InvalidVoicePreferenceException(innerException: exception);
        }
    }

    private static VoicePreference Project(JsonElement value)
    {
        // The record's exact key set IS the frozen shape, and it now carries the
        // companion language, so a record written before that field existed is
        // refused rather than half-read.
        var properties = new[] { "schemaVersion", "revision", "locale", "disclosureVersion", "consent", "decidedAtMs", "outputDevice" };
        if (!InstalledGenerationPaths.ExactProperties(value, properties) ||
            !value.GetProperty("schemaVersion").TryGetInt32(out var schemaVersion) || schemaVersion != SchemaVersion ||
            !value.GetProperty("revision").TryGetInt64(out var revision) || revision < 0)
            throw new InvalidVoicePreferenceException();

        // The language a player speaks is the Host's business, not this launch
        // gate's: only the declared null-or-string kind is required here. Naming
        // the languages would let a newly added one silently switch Voice off.
        if (value.GetProperty("locale").ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            throw new InvalidVoicePreferenceException();

        var disclosureElement = value.GetProperty("disclosureVersion");
        if (disclosureElement.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            throw new InvalidVoicePreferenceException();
        var disclosureVersion = disclosureElement.ValueKind == JsonValueKind.Null ? null : disclosureElement.GetString();
        if (disclosureVersion is not null && disclosureVersion != DisclosureContract)
            throw new InvalidVoicePreferenceException();

        var consentElement = value.GetProperty("consent");
        var consentText = consentElement.ValueKind == JsonValueKind.String ? consentElement.GetString() : null;
        if (consentText is not ("undecided" or "accepted" or "revoked"))
            throw new InvalidVoicePreferenceException();

        long? decidedAtMs = null;
        switch (value.GetProperty("decidedAtMs").ValueKind)
        {
            case JsonValueKind.Null:
                break;
            case JsonValueKind.Number when value.GetProperty("decidedAtMs").TryGetInt64(out var decided) && decided >= 0:
                decidedAtMs = decided;
                break;
            default:
                throw new InvalidVoicePreferenceException();
        }

        var consent = consentText switch
        {
            "accepted" => VoiceCloudTtsConsent.Accepted,
            "revoked" => VoiceCloudTtsConsent.Revoked,
            _ => VoiceCloudTtsConsent.Undecided,
        };
        if (consent == VoiceCloudTtsConsent.Undecided && (disclosureVersion is not null || decidedAtMs is not null))
            throw new InvalidVoicePreferenceException();
        if (consent == VoiceCloudTtsConsent.Accepted && disclosureVersion != DisclosureContract)
            throw new InvalidVoicePreferenceException();
        if (consent != VoiceCloudTtsConsent.Undecided && decidedAtMs is null)
            throw new InvalidVoicePreferenceException();

        // Output endpoint: null selects the Windows default at each open; a
        // pinned value is the frozen `waveout:N` endpoint shape only.
        var outputElement = value.GetProperty("outputDevice");
        string? outputDevice = outputElement.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String when OutputDeviceRegex.IsMatch(outputElement.GetString() ?? string.Empty) => outputElement.GetString(),
            _ => throw new InvalidVoicePreferenceException(),
        };

        return new VoicePreference(consent, disclosureVersion, revision, outputDevice);
    }

    // The preference file only ever stores the frozen `waveout:N` endpoint shape
    // (never a device name or path), so a stale/edited value fails closed.
    private static readonly System.Text.RegularExpressions.Regex OutputDeviceRegex =
        new("^waveout:[0-9]{1,4}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private static VoicePreference Undecided() => new(VoiceCloudTtsConsent.Undecided, null, 0, null);
}

internal sealed class InvalidVoicePreferenceException : Exception
{
    internal InvalidVoicePreferenceException(string message = "invalid_player_preference_store", Exception? innerException = null)
        : base(message, innerException) { }
}