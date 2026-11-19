namespace GameBuddy.Desktop.Tests;

public sealed class VoicePreferenceFileReaderTests
{
    [Fact]
    public void Read_returns_the_undecided_default_when_the_preference_file_is_missing()
    {
        using var root = TemporaryRoot.Create();

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.Equal(VoiceCloudTtsConsent.Undecided, preference.Consent);
        Assert.Null(preference.DisclosureVersion);
        Assert.Equal(0, preference.Revision);
        Assert.False(preference.CloudTtsAdmitted);
    }

    [Fact]
    public void Read_projects_a_valid_undecided_preference()
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":2,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.Equal(VoiceCloudTtsConsent.Undecided, preference.Consent);
        Assert.Null(preference.DisclosureVersion);
        Assert.Equal(2, preference.Revision);
        Assert.False(preference.CloudTtsAdmitted);
    }

    [Fact]
    public void Read_projects_a_valid_accepted_preference_and_admits_cloud_tts()
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":3,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":null,"persona":null,"paced":false}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.Equal(VoiceCloudTtsConsent.Accepted, preference.Consent);
        Assert.Equal("mimo-cloud-tts-v1", preference.DisclosureVersion);
        Assert.Equal(3, preference.Revision);
        Assert.True(preference.CloudTtsAdmitted);
    }

    [Fact]
    public void Read_projects_a_valid_revoked_preference_without_admission()
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":4,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"revoked","decidedAtMs":1700000000000,"outputDevice":null,"persona":null,"paced":false}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.Equal(VoiceCloudTtsConsent.Revoked, preference.Consent);
        Assert.Equal("mimo-cloud-tts-v1", preference.DisclosureVersion);
        Assert.Equal(4, preference.Revision);
        Assert.False(preference.CloudTtsAdmitted);
    }

    [Fact]
    public void Read_projects_the_voice_fields_of_a_record_that_also_carries_a_language()
    {
        // The record is one file for both settings groups: a chosen companion
        // language must not stop the Voice fields from being projected.
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":5,"locale":"en-US","disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":"waveout:2","persona":null,"paced":false}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.True(preference.CloudTtsAdmitted);
        Assert.Equal(5, preference.Revision);
        Assert.Equal("waveout:2", preference.SelectedOutputDevice);
    }

    [Fact]
    public void Read_projects_a_record_that_also_carries_the_paced_delivery_preference()
    {
        // The one record also stores whether the player chose short paced Chat
        // replies. That choice belongs to Chat: this launch gate neither reads the
        // value nor requires the key, and the record still projects.
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":7,"locale":"en-US","disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":null,"persona":null,"paced":true}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.True(preference.CloudTtsAdmitted);
        Assert.Equal(7, preference.Revision);
    }

    [Fact]
    public void Read_projects_the_voice_persona_and_defaults_it_to_null()
    {
        // No persona in an accepted record leaves it null - the player's
        // "System default", which the launch plan resolves to the product's own
        // default persona instead of sending no persona at all.
        using var undecided = TemporaryRoot.Create();
        undecided.WritePreference("""{"schemaVersion":1,"revision":3,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":null,"persona":null,"paced":false}""");
        Assert.Null(new VoicePreferenceFileReader(undecided.PreferencePath).Read().Persona);

        // A stored persona is projected verbatim.
        using var chosen = TemporaryRoot.Create();
        chosen.WritePreference("""{"schemaVersion":1,"revision":6,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":null,"persona":"soft_maid","paced":false}""");
        Assert.Equal("soft_maid", new VoicePreferenceFileReader(chosen.PreferencePath).Read().Persona);
    }

    [Fact]
    public void Constructor_requires_an_absolute_path()
    {
        Assert.Throws<ArgumentNullException>(() => new VoicePreferenceFileReader(null!));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader(""));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader("   "));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader("player-preference.json"));
    }

    [Fact]
    public void Read_projects_the_voice_fields_of_a_record_that_carries_settings_this_gate_does_not_consume()
    {
        // The Host owns one preference record for every settings surface, so it grows
        // fields for surfaces that are none of this launch gate's business. A field the
        // Host added must not be able to switch Voice off: demanding the record's exact
        // key set made every such addition a refusal here, and because Voice is optional
        // the refusal left no trace - the launch went out on pure-text Chat with nothing
        // saying why. This record carries what the Host writes today plus a field no
        // side has heard of yet, and the Voice fields still project.
        using var root = TemporaryRoot.Create();
        root.WritePreference("""{"schemaVersion":1,"revision":8,"locale":"zh-CN","disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":"waveout:2","persona":"soft_maid","paced":false,"gamePromptAddition":"talk to me","appearance":"dark","uiLocale":"zh-CN","samplingTemperature":0.7,"aFieldAddedAfterThisGateWasWritten":{"nested":[1,2]}}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.True(preference.CloudTtsAdmitted);
        Assert.Equal(8, preference.Revision);
        Assert.Equal("waveout:2", preference.SelectedOutputDevice);
        Assert.Equal("soft_maid", preference.Persona);
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""", "persona")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","outputDevice":null,"persona":null}""", "decidedAtMs")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"persona":null}""", "outputDevice")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"decidedAtMs":null,"outputDevice":null,"persona":null}""", "consent")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided"}""", "decidedAtMs")]
    [InlineData("""{"consent":"undecided"}""", "schemaVersion")]
    [InlineData("""{}""", "schemaVersion")]
    public void Read_refuses_a_consumed_field_that_is_missing_and_names_it(string json, string missing)
    {
        // A required field that is absent is still a refusal - and the refusal says
        // which one, because a Voice that does not start has to be attributable.
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        var exception = Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
        Assert.Equal($"invalid_player_preference_store:missing_field:{missing}", exception.Message);
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":"0","locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null}""", "invalid_revision")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"maybe","decidedAtMs":null,"outputDevice":null,"persona":null}""", "invalid_consent")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":7}""", "invalid_persona")]
    [InlineData("""{"schemaVersion":2,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null}""", "unsupported_schema_version")]
    public void Read_refuses_a_consumed_field_whose_value_is_not_the_contract_and_names_the_rule(string json, string reason)
    {
        // Strictness stays where it belongs: a field this gate reads, holding something
        // that field may never hold, is refused by name rather than skipped.
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        var exception = Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
        Assert.Equal($"invalid_player_preference_store:{reason}", exception.Message);
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":"SoftMaid","paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":"soft-maid","paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":"","paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":7,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","paced":false}""")]
    public void Read_rejects_a_persona_outside_the_bounded_shape(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":2,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":"1","revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1.5,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    public void Read_rejects_a_schema_version_other_than_exactly_one(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":"mimo-cloud-tts-v2","consent":"accepted","decidedAtMs":1,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"accepted","decidedAtMs":1,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    public void Read_rejects_accepted_without_the_exact_disclosure_contract_and_decision_time(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":1,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":"mimo-cloud-tts-v1","consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":0,"outputDevice":null,"persona":null,"paced":false}""")]
    public void Read_rejects_undecided_with_any_decision_data(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":"maybe","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":3,"decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"locale":null,"disclosureVersion":null,"consent":null,"decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    public void Read_rejects_unknown_consent_values(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":-1,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":"0","locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":7,"consent":"undecided","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":"now","outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"undecided","decidedAtMs":-1,"outputDevice":null,"persona":null,"paced":false}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"locale":null,"disclosureVersion":null,"consent":"revoked","decidedAtMs":null,"outputDevice":null,"persona":null,"paced":false}""")]
    public void Read_rejects_wrong_field_types_and_missing_decision_time(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("")]
    [InlineData("{missing")]
    [InlineData("\uFEFF{\"schemaVersion\":1,\"revision\":0,\"locale\":null,\"disclosureVersion\":null,\"consent\":\"undecided\",\"decidedAtMs\":null,\"outputDevice\":null}")]
    [InlineData("[]")]
    [InlineData("null")]
    public void Read_rejects_non_json_documents(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Fact]
    public void Reader_source_is_a_pure_fail_closed_read_only_seam()
    {
        var source = File.ReadAllText(Source());

        Assert.Contains("Path.IsPathFullyQualified", source, StringComparison.Ordinal);
        Assert.Contains("JsonDocument.Parse(File.ReadAllBytes(path))", source, StringComparison.Ordinal);
        Assert.Contains("FileNotFoundException", source, StringComparison.Ordinal);
        // The reader projects the fields it consumes and ignores every other key: the
        // record's exact key set is the Host's, and demanding it here turned an additive
        // Host change into a silent Voice outage.
        Assert.Contains("ConsumedKeys", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ExactProperties", source, StringComparison.Ordinal);
        Assert.Contains("\"mimo-cloud-tts-v1\"", source, StringComparison.Ordinal);
        Assert.Contains("VoiceCloudTtsConsent.Undecided", source, StringComparison.Ordinal);
        Assert.Contains("CloudTtsAdmitted", source, StringComparison.Ordinal);
        Assert.Contains("InvalidVoicePreferenceException", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.WriteAllText", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.Delete", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.Copy", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RuntimeSupervisor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GuardianLaunchUnavailableException", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DesktopHostBootstrapBroker", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Program", source, StringComparison.Ordinal);
        Assert.DoesNotContain("v2", source, StringComparison.Ordinal);
    }

    private static string Source() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "VoicePreferenceFileReader.cs"));

    private sealed class TemporaryRoot : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
        internal static TemporaryRoot Create() { var root = new TemporaryRoot(); Directory.CreateDirectory(root.Path); return root; }
        internal string PreferencePath => System.IO.Path.Combine(Path, "player-preference.json");
        internal void WritePreference(string json) => File.WriteAllText(PreferencePath, json);
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
