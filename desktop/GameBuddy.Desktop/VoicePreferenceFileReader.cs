using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Cloud TTS consent projected from the one Host-owned player preference record.
/// Narrow and immutable: only the fields the desktop launch gate consumes.
/// </summary>
internal sealed record VoicePreference(VoiceCloudTtsConsent Consent, string? DisclosureVersion, long Revision, string? OutputDevice, string? Persona)
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
/// Pure read-only seam over the one Host-owned player preference record (written by
/// host/src/settings/player-preference-store.ts). A missing file is the undecided
/// default; an existing file is projected onto the fields this launch gate consumes
/// and refused when one of them is absent or holds something it may not hold, so a bad
/// record can never be projected as accepted. Fields the record carries for other
/// settings surfaces are not read here and not required. No CAS, no writes, no token or
/// key material is read and no Host composition surface is referenced.
/// </summary>
internal sealed class VoicePreferenceFileReader
{
    private const int SchemaVersion = 1;
    private const string DisclosureContract = "mimo-cloud-tts-v1";

    /// <summary>
    /// The fields this launch gate consumes, in the writing Host's own order.
    ///
    /// **A projection, not the record's shape.** The Host owns this record and writes it
    /// for every settings surface at once, so a field added there - for Chat, for the
    /// appearance, for anything - is a change Voice has no opinion about. Demanding the
    /// record's exact key set made every such addition a refusal here, and because Voice
    /// is optional that refusal left no trace: the launch went out on pure-text Chat with
    /// nothing saying why. The keys named here are the ones this gate reads; every other
    /// key in the document is ignored; a key named here that the record does not carry is
    /// refused by name rather than skipped.
    /// </summary>
    internal static readonly string[] ConsumedKeys =
        { "schemaVersion", "revision", "disclosureVersion", "consent", "decidedAtMs", "outputDevice", "persona" };

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
            throw new InvalidVoicePreferenceException("unreadable_document", exception);
        }
    }

    private static VoicePreference Project(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidVoicePreferenceException("not_an_object");

        var schemaElement = Required(value, "schemaVersion");
        if (schemaElement.ValueKind != JsonValueKind.Number || !schemaElement.TryGetInt32(out var schemaVersion) || schemaVersion != SchemaVersion)
            throw new InvalidVoicePreferenceException("unsupported_schema_version");

        var revisionElement = Required(value, "revision");
        if (revisionElement.ValueKind != JsonValueKind.Number || !revisionElement.TryGetInt64(out var revision) || revision < 0)
            throw new InvalidVoicePreferenceException("invalid_revision");

        var disclosureElement = Required(value, "disclosureVersion");
        if (disclosureElement.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            throw new InvalidVoicePreferenceException("invalid_disclosure_version");
        var disclosureVersion = disclosureElement.ValueKind == JsonValueKind.Null ? null : disclosureElement.GetString();
        if (disclosureVersion is not null && disclosureVersion != DisclosureContract)
            throw new InvalidVoicePreferenceException("invalid_disclosure_version");

        var consentElement = Required(value, "consent");
        var consentText = consentElement.ValueKind == JsonValueKind.String ? consentElement.GetString() : null;
        if (consentText is not ("undecided" or "accepted" or "revoked"))
            throw new InvalidVoicePreferenceException("invalid_consent");

        var decidedElement = Required(value, "decidedAtMs");
        long? decidedAtMs = null;
        switch (decidedElement.ValueKind)
        {
            case JsonValueKind.Null:
                break;
            case JsonValueKind.Number when decidedElement.TryGetInt64(out var decided) && decided >= 0:
                decidedAtMs = decided;
                break;
            default:
                throw new InvalidVoicePreferenceException("invalid_decided_at_ms");
        }

        var consent = consentText switch
        {
            "accepted" => VoiceCloudTtsConsent.Accepted,
            "revoked" => VoiceCloudTtsConsent.Revoked,
            _ => VoiceCloudTtsConsent.Undecided,
        };
        if (consent == VoiceCloudTtsConsent.Undecided && (disclosureVersion is not null || decidedAtMs is not null))
            throw new InvalidVoicePreferenceException("consent_evidence_mismatch");
        if (consent == VoiceCloudTtsConsent.Accepted && disclosureVersion != DisclosureContract)
            throw new InvalidVoicePreferenceException("consent_evidence_mismatch");
        if (consent != VoiceCloudTtsConsent.Undecided && decidedAtMs is null)
            throw new InvalidVoicePreferenceException("consent_evidence_mismatch");

        // Output endpoint: null selects the Windows default at each open; a
        // pinned value is the frozen `waveout:N` endpoint shape only.
        var outputElement = Required(value, "outputDevice");
        string? outputDevice = outputElement.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String when OutputDeviceRegex.IsMatch(outputElement.GetString() ?? string.Empty) => outputElement.GetString(),
            _ => throw new InvalidVoicePreferenceException("invalid_output_device"),
        };

        // Voice persona: null is the player's "System default" - the launch plan
        // resolves it to the product's default persona rather than sending none;
        // a pinned value is the frozen lowercase-snake id shape only.
        var personaElement = Required(value, "persona");
        string? persona = personaElement.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String when VoicePersonaRegex.IsMatch(personaElement.GetString() ?? string.Empty) => personaElement.GetString(),
            _ => throw new InvalidVoicePreferenceException("invalid_persona"),
        };

        return new VoicePreference(consent, disclosureVersion, revision, outputDevice, persona);
    }

    /// <summary>
    /// One consumed field, or the refusal that names it. A record missing a field this
    /// gate reads is not the same fact as a corrupt document, and the two are told apart
    /// by name because the launch outcome - Voice does not start - is identical.
    /// </summary>
    private static JsonElement Required(JsonElement value, string name) =>
        value.TryGetProperty(name, out var element) ? element : throw new InvalidVoicePreferenceException($"missing_field:{name}");

    // The preference file only ever stores the frozen `waveout:N` endpoint shape
    // (never a device name or path), so a stale/edited value fails closed.
    private static readonly System.Text.RegularExpressions.Regex OutputDeviceRegex =
        new("^waveout:[0-9]{1,4}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // Similarly, only the frozen lowercase-snake persona id shape is stored.
    private static readonly System.Text.RegularExpressions.Regex VoicePersonaRegex =
        new("^[a-z][a-z0-9_]{0,31}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private static VoicePreference Undecided() => new(VoiceCloudTtsConsent.Undecided, null, 0, null, null);
}

internal sealed class InvalidVoicePreferenceException : Exception
{
    /// <summary>The prefix every refusal carries; the reason after it names the rule that refused.</summary>
    internal const string Code = "invalid_player_preference_store";

    internal InvalidVoicePreferenceException(string reason, Exception? innerException = null)
        : base($"{Code}:{reason}", innerException) => Reason = reason;

    /// <summary>
    /// Which rule refused the record - <c>missing_field:persona</c>,
    /// <c>invalid_consent</c>, <c>unreadable_document</c> and so on. A refused record
    /// and an unreadable one both leave the player on pure-text Chat, so this string is
    /// the only thing that says which happened; the launcher records the message in the
    /// operational root so the refusal survives the launch that made it.
    /// </summary>
    internal string Reason { get; }
}