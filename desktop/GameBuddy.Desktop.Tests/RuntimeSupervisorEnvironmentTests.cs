using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

public sealed class RuntimeSupervisorEnvironmentTests
{
    private const string Nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Fact]
    public void BuildBootstrapEnvironment_injects_the_frozen_wire_environment_with_the_default_assembly_input()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        var environment = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout));

        Assert.Equal(7, environment.Count);
        Assert.Equal(Path.Combine(layout.Layout.OperationalRoot, "deployment-manifest.json"), environment["GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST"]);
        Assert.Equal("fresh", environment["GAMEBUDDY_HOST_GAME_SESSION_MODE"]);
        Assert.Equal("composed-reference-game", environment["GAMEBUDDY_HOST_SURFACE"]);
        Assert.False(environment.ContainsKey("GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"));
        Assert.Equal(Environment.GetEnvironmentVariable("SystemRoot"), environment["SystemRoot"]);
        Assert.Equal(Environment.GetEnvironmentVariable("TEMP"), environment["TEMP"]);
        Assert.Equal(Environment.GetEnvironmentVariable("TMP"), environment["TMP"]);
        Assert.Equal(Environment.GetEnvironmentVariable("LOCALAPPDATA"), environment["LOCALAPPDATA"]);
    }

    [Fact]
    public void BuildBootstrapEnvironment_injects_the_nonce_only_when_a_valid_nonce_is_configured()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        var withNonce = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { TavernNarrativeGateNonceSha256 = Nonce }));
        Assert.Equal(Nonce, withNonce["GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"]);
        Assert.Equal(8, withNonce.Count);

        var withoutNonce = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { TavernNarrativeGateNonceSha256 = null }));
        Assert.False(withoutNonce.ContainsKey("GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"));
        Assert.Equal(7, withoutNonce.Count);
    }

    [Fact]
    public void BuildBootstrapEnvironment_injects_explicit_overrides_only_after_strict_validation()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        var environment = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions
        {
            GameSessionMode = HostBootstrapEnvironmentOptions.KnownGameSessionMode,
            Surface = HostBootstrapEnvironmentOptions.ChatOnlySurface,
            TavernNarrativeGateNonceSha256 = Nonce,
        }));

        Assert.Equal("known", environment["GAMEBUDDY_HOST_GAME_SESSION_MODE"]);
        Assert.Equal("chat-only", environment["GAMEBUDDY_HOST_SURFACE"]);
        Assert.Equal(Nonce, environment["GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"]);
        Assert.Equal(8, environment.Count);
    }

    [Fact]
    public void BuildBootstrapEnvironment_fails_closed_when_the_deployment_manifest_is_absent()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout));
    }

    [Theory]
    [InlineData("bogus")]
    [InlineData("")]
    [InlineData("Fresh")]
    public void BuildBootstrapEnvironment_fails_closed_on_invalid_game_session_mode(string mode)
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { GameSessionMode = mode }));
    }

    [Theory]
    [InlineData("web")]
    [InlineData("composed")]
    [InlineData("Composed-reference-game")]
    public void BuildBootstrapEnvironment_fails_closed_on_invalid_surface(string surface)
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { Surface = surface }));
    }

    [Theory]
    [InlineData("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0")]
    public void BuildBootstrapEnvironment_fails_closed_on_invalid_nonce_values(string nonce)
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { TavernNarrativeGateNonceSha256 = nonce }));
    }

    [Fact]
    public void BuildBootstrapEnvironment_injects_the_voice_port_and_token_only_as_a_paired_set()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        var withVoice = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions
        {
            VoicePort = 49731,
            VoiceToken = "vGQf7mKx2LpR9sBw4Aa1",
        }));

        Assert.Equal("49731", withVoice["GAMEBUDDY_VOICE_PORT"]);
        Assert.Equal("vGQf7mKx2LpR9sBw4Aa1", withVoice["GAMEBUDDY_VOICE_TOKEN"]);
        Assert.Equal(9, withVoice.Count);

        // Both absent means pure text; no Voice environment is delivered.
        var withoutVoice = ParseEnvironmentBlock(RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout));
        Assert.False(withoutVoice.ContainsKey("GAMEBUDDY_VOICE_PORT"));
        Assert.False(withoutVoice.ContainsKey("GAMEBUDDY_VOICE_TOKEN"));
        Assert.Equal(7, withoutVoice.Count);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65_536)]
    public void BuildBootstrapEnvironment_fails_closed_on_out_of_range_voice_port(int port)
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions
        {
            VoicePort = port,
            VoiceToken = "vGQf7mKx2LpR9sBw4Aa1",
        }));
    }

    [Theory]
    [InlineData("short")]
    [InlineData("has spaces")]
    [InlineData("has@invalid")]
    [InlineData("has+plus")]
    [InlineData("has=equals")]
    [InlineData("" )]
    public void BuildBootstrapEnvironment_fails_closed_on_invalid_voice_token(string token)
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions
        {
            VoicePort = 49731,
            VoiceToken = token,
        }));
    }

    [Fact]
    public void BuildBootstrapEnvironment_fails_closed_when_only_one_voice_variable_is_present()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var layout = CreateLayout();
        TestDeploymentManifest.WriteDeploymentManifest(layout.Layout.OperationalRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { VoicePort = 49731 }));
        Assert.Throws<GuardianLaunchUnavailableException>(() => RuntimeSupervisor.BuildBootstrapEnvironment(layout.Layout, new HostBootstrapEnvironmentOptions { VoiceToken = "vGQf7mKx2LpR9sBw4Aa1" }));
    }

    [Fact]
    public void Supervisor_source_forwards_the_assembly_input_environment_to_the_bundled_host_child()
    {
        var source = File.ReadAllText(SupervisorSource());

        Assert.Contains("HostBootstrapEnvironmentOptions? options = null", source, StringComparison.Ordinal);
        Assert.Contains("var environmentBlock = BuildBootstrapEnvironment(layout, options)", source, StringComparison.Ordinal);
        Assert.Contains("DeploymentManifestFileName", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST\"", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_HOST_GAME_SESSION_MODE\"", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_HOST_SURFACE\"", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256\"", source, StringComparison.Ordinal);
        Assert.Contains("string.Concat(values.OrderBy(item => item.Key, StringComparer.Ordinal)", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_VOICE_PORT\"", source, StringComparison.Ordinal);
        Assert.Contains("\"GAMEBUDDY_VOICE_TOKEN\"", source, StringComparison.Ordinal);
        Assert.Contains("+ \"\\0\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable(\"GAMEBUDDY", source, StringComparison.Ordinal);
    }

    private static Dictionary<string, string> ParseEnvironmentBlock(string block)
    {
        // The child environment block is sorted by key and terminated by a
        // doubled NULL; each entry is exactly "KEY=VALUE\0".
        Assert.EndsWith("\0\0", block, StringComparison.Ordinal);
        var entries = block[..^2].Split('\0');
        Assert.Equal(entries.OrderBy(entry => entry, StringComparer.Ordinal), entries);
        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            var separator = entry.IndexOf('=');
            Assert.True(separator > 0, $"Environment entry has no key/value separator: {entry}");
            var key = entry[..separator];
            var value = entry[(separator + 1)..];
            Assert.False(string.IsNullOrEmpty(key));
            Assert.DoesNotContain('\0', value);
            environment.Add(key, value);
        }
        return environment;
    }

    private sealed class LayoutFixture : IDisposable
    {
        private readonly string root;

        internal LayoutFixture(string root, CurrentUserRootLayout layout)
        {
            this.root = root;
            Layout = layout;
        }

        internal CurrentUserRootLayout Layout { get; }

        public void Dispose()
        {
            try { Directory.Delete(root, recursive: true); }
            catch { /* Best-effort test cleanup. */ }
        }
    }

    private static LayoutFixture CreateLayout()
    {
        var root = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "environment", Guid.NewGuid().ToString("N"));
        var registration = new CurrentUserRootRegistrationRecord(
            CurrentUserRootRegistration.SchemaVersion,
            Path.Combine(root, "Programs", "GameBuddy"));
        foreach (var path in new[] { registration.ProgramRoot, Path.Combine(root, "GameBuddy", "data"), Path.Combine(root, "GameBuddy", "operational"), Path.Combine(root, "GameBuddy", "presentation") })
        {
            Directory.CreateDirectory(path);
        }
        return new LayoutFixture(root, CurrentUserRootLayout.DeriveForTesting(registration, new LocalApplicationDataProvider(root)));
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }

    private static string SupervisorSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "RuntimeSupervisor.cs"));
}