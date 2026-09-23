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
        root.WritePreference("""{"schemaVersion":1,"revision":2,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""");

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
        root.WritePreference("""{"schemaVersion":1,"revision":3,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":1700000000000,"outputDevice":null}""");

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
        root.WritePreference("""{"schemaVersion":1,"revision":4,"disclosureVersion":"mimo-cloud-tts-v1","consent":"revoked","decidedAtMs":1700000000000,"outputDevice":null}""");

        var preference = new VoicePreferenceFileReader(root.PreferencePath).Read();

        Assert.Equal(VoiceCloudTtsConsent.Revoked, preference.Consent);
        Assert.Equal("mimo-cloud-tts-v1", preference.DisclosureVersion);
        Assert.Equal(4, preference.Revision);
        Assert.False(preference.CloudTtsAdmitted);
    }

    [Fact]
    public void Constructor_requires_an_absolute_path()
    {
        Assert.Throws<ArgumentNullException>(() => new VoicePreferenceFileReader(null!));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader(""));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader("   "));
        Assert.Throws<ArgumentException>(() => new VoicePreferenceFileReader("voice-preference.json"));
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"extra":"x"}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided"}""")]
    [InlineData("""{"consent":"undecided"}""")]
    [InlineData("""{}""")]
    public void Read_rejects_unknown_or_missing_keys(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":2,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":"1","revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1.5,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    public void Read_rejects_a_schema_version_other_than_exactly_one(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":"mimo-cloud-tts-v2","consent":"accepted","decidedAtMs":1}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"accepted","decidedAtMs":1}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":"mimo-cloud-tts-v1","consent":"accepted","decidedAtMs":null,"outputDevice":null}""")]
    public void Read_rejects_accepted_without_the_exact_disclosure_contract_and_decision_time(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":1}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":"mimo-cloud-tts-v1","consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":0}""")]
    public void Read_rejects_undecided_with_any_decision_data(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":1,"disclosureVersion":null,"consent":"maybe","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"disclosureVersion":null,"consent":3,"decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":1,"disclosureVersion":null,"consent":null,"decidedAtMs":null,"outputDevice":null}""")]
    public void Read_rejects_unknown_consent_values(string json)
    {
        using var root = TemporaryRoot.Create();
        root.WritePreference(json);

        Assert.Throws<InvalidVoicePreferenceException>(() => new VoicePreferenceFileReader(root.PreferencePath).Read());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"revision":-1,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":"0","disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":7,"consent":"undecided","decidedAtMs":null,"outputDevice":null}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":"now"}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":-1}""")]
    [InlineData("""{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"revoked","decidedAtMs":null,"outputDevice":null}""")]
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
    [InlineData("\uFEFF{\"schemaVersion\":1,\"revision\":0,\"disclosureVersion\":null,\"consent\":\"undecided\",\"decidedAtMs\":null}")]
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
        Assert.Contains("ExactProperties(value", source, StringComparison.Ordinal);
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
        internal string PreferencePath => System.IO.Path.Combine(Path, "voice-preference.json");
        internal void WritePreference(string json) => File.WriteAllText(PreferencePath, json);
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
