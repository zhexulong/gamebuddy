using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Cloud TTS consent projected from the Host-owned voice-preference.json.
/// Narrow and immutable: only the fields the desktop launch gate consumes.
/// </summary>
internal sealed record VoicePreference(VoiceCloudTtsConsent Consent, string? DisclosureVersion, long Revision)
{
    /// <summary>Server TTS is admitted only while the preference is exactly "accepted".</summary>
    internal bool CloudTtsAdmitted => Consent == VoiceCloudTtsConsent.Accepted;
}

internal enum VoiceCloudTtsConsent
{
    Undecided,
    Accepted,
    Revoked,
}

/// <summary>
/// Pure read-only seam over one Host-owned voice-preference.json (schema frozen by
/// host/src/settings/voice-preference-store.ts). A missing file is the undecided
/// default; any existing file that is not an exact valid preference fails closed so
/// a bad file can never be projected as accepted. No CAS, no writes, no token or
/// key material is read and no Host composition surface is referenced.
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
        var properties = new[] { "schemaVersion", "revision", "disclosureVersion", "consent", "decidedAtMs" };
        if (!InstalledGenerationPaths.ExactProperties(value, properties) ||
            !value.GetProperty("schemaVersion").TryGetInt32(out var schemaVersion) || schemaVersion != SchemaVersion ||
            !value.GetProperty("revision").TryGetInt64(out var revision) || revision < 0)
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

        return new VoicePreference(consent, disclosureVersion, revision);
    }

    private static VoicePreference Undecided() => new(VoiceCloudTtsConsent.Undecided, null, 0);
}

internal sealed class InvalidVoicePreferenceException : Exception
{
    internal InvalidVoicePreferenceException(string message = "invalid_voice_preference_store", Exception? innerException = null)
        : base(message, innerException) { }
}