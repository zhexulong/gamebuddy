using System.Text.RegularExpressions;

namespace GameBuddy.Desktop.Tests;

public sealed class VoiceGatewaySupervisorTests
{
    private const string ValidToken = "vGQf7mKx2LpR9sBw4Aa1";

    [Fact]
    public void BuildLaunchPlan_requires_an_admitted_existing_absolute_node_path()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        var node = root.Node();

        Assert.Throws<ArgumentNullException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(null!, gateway, 49731, ValidToken, cloudTtsAdmitted: false));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan("   ", gateway, 49731, ValidToken, cloudTtsAdmitted: false));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan("node.exe", gateway, 49731, ValidToken, cloudTtsAdmitted: false));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(System.IO.Path.Combine(root.Path, "missing-node.exe"), gateway, 49731, ValidToken, cloudTtsAdmitted: false));

        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(node, gateway, 49731, ValidToken, cloudTtsAdmitted: false);
        Assert.Equal(node, plan.NodePath);
    }

    [Fact]
    public void BuildLaunchPlan_requires_an_admitted_existing_absolute_gateway_entry()
    {
        using var root = TemporaryRoot.Create();
        var node = root.Node();

        Assert.Throws<ArgumentNullException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(node, null!, 49731, ValidToken, cloudTtsAdmitted: false));
        var relative = new AdmittedVoiceGateway("voice/entry.js", "voice/protocol.js");
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(node, relative, 49731, ValidToken, cloudTtsAdmitted: false));
        var missing = new AdmittedVoiceGateway(System.IO.Path.Combine(root.Path, "missing-entry.js"), System.IO.Path.Combine(root.Path, "protocol.js"));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(node, missing, 49731, ValidToken, cloudTtsAdmitted: false));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65536)]
    public void BuildLaunchPlan_rejects_out_of_range_ports(int port)
    {
        using var root = TemporaryRoot.Create();
        Assert.Throws<ArgumentOutOfRangeException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), port, ValidToken, cloudTtsAdmitted: false));
    }

    [Fact]
    public void BuildLaunchPlan_accepts_boundary_ports()
    {
        using var root = TemporaryRoot.Create();
        Assert.Equal(1, VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 1, ValidToken, cloudTtsAdmitted: false).Port);
        Assert.Equal(65535, VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 65535, ValidToken, cloudTtsAdmitted: false).Port);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("short")]
    [InlineData("contains spaces and more")]
    [InlineData("has@invalid.chars")]
    [InlineData("has=equals=sign")]
    [InlineData("has+plus")]
    public void BuildLaunchPlan_rejects_tokens_the_gateway_entry_would_reject(string token)
    {
        using var root = TemporaryRoot.Create();
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, token, cloudTtsAdmitted: false));
    }

    [Fact]
    public void BuildLaunchPlan_rejects_tokens_longer_than_the_gateway_contract()
    {
        using var root = TemporaryRoot.Create();
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, new string('a', 257), cloudTtsAdmitted: false));
        Assert.Equal(256, VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, new string('a', 256), cloudTtsAdmitted: false).Token.Length);
    }

    [Fact]
    public void BuildLaunchPlan_rejects_a_persona_containing_a_null_character()
    {
        using var root = TemporaryRoot.Create();
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, ValidToken, cloudTtsAdmitted: false, persona: "a\0b"));
    }

    [Fact]
    public void BuildLaunchPlan_without_cloud_admission_keeps_the_frozen_minimal_environment()
    {
        using var root = TemporaryRoot.Create();
        // The operator's TTS credentials are keyed off this process's environment,
        // so this exact-set assertion clears them rather than inheriting the machine's.
        using var credentials = OperatorCredentials(null, null);
        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, ValidToken, cloudTtsAdmitted: false);

        Assert.Equal(
            new[] { "GAMEBUDDY_VOICE_PORT", "GAMEBUDDY_VOICE_TOKEN", "GAMEBUDDY_WINDOWS_OUTPUT_DEVICE", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP" },
            plan.Environment.Keys.OrderBy(key => key, StringComparer.Ordinal));
        Assert.Equal("49731", plan.Environment["GAMEBUDDY_VOICE_PORT"]);
        Assert.Equal(ValidToken, plan.Environment["GAMEBUDDY_VOICE_TOKEN"]);
        // The player's stored endpoint reaches the child verbatim; the default
        // plan selects the Windows current default multimedia output.
        Assert.Equal("default", plan.Environment["GAMEBUDDY_WINDOWS_OUTPUT_DEVICE"]);
        Assert.DoesNotContain(plan.Environment, pair => pair.Key.Equals("GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION", StringComparison.Ordinal));
        Assert.DoesNotContain(plan.Environment.Keys, key => key.Equals("PATH", StringComparison.OrdinalIgnoreCase) || key.Equals("APPDATA", StringComparison.OrdinalIgnoreCase) || key.Equals("USERNAME", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void BuildLaunchPlan_injects_the_desktop_consent_contract_only_when_cloud_tts_is_admitted()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");

        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true);

        Assert.Equal("desktop-consent-v1", plan.Environment["GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION"]);
    }

    [Fact]
    public void BuildLaunchPlan_carries_a_pinned_output_endpoint_and_rejects_a_malformed_one()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");

        var pinned = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: null, outputDevice: "waveout:3");
        Assert.Equal("waveout:3", pinned.Environment["GAMEBUDDY_WINDOWS_OUTPUT_DEVICE"]);

        // Only the frozen `default` / `waveout:N` shapes are forwarded: a device
        // name, path, or free text fails closed instead of reaching the child.
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: null, outputDevice: "Speakers"));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: null, outputDevice: "C:\\devices\\speakers"));
        Assert.Throws<ArgumentException>(() => VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: null, outputDevice: "waveout:"));
    }

    [Fact]
    public void BuildLaunchPlan_arguments_carry_only_the_entry()
    {
        using var root = TemporaryRoot.Create();
        var entry = root.Gateway("voice/entry.js").EntryPath;

        var noPersona = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), new AdmittedVoiceGateway(entry, System.IO.Path.Combine(root.Path, "protocol.js")), 49731, ValidToken, cloudTtsAdmitted: false);
        Assert.Equal($"\"{entry}\"", noPersona.Arguments);
        Assert.DoesNotContain(ValidToken, noPersona.Arguments, StringComparison.Ordinal);
        Assert.DoesNotContain(" --persona", noPersona.Arguments, StringComparison.Ordinal);
        Assert.DoesNotContain(" --port", noPersona.Arguments, StringComparison.Ordinal);

        // The persona is never an argv token: the bundled entry parses no argv
        // and reads the persona from the environment instead.
        var withPersona = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), new AdmittedVoiceGateway(entry, System.IO.Path.Combine(root.Path, "protocol.js")), 49731, ValidToken, cloudTtsAdmitted: false, persona: "companion.default", outputDevice: "default");
        Assert.Equal($"\"{entry}\"", withPersona.Arguments);
        Assert.DoesNotContain("companion.default", withPersona.Arguments, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildLaunchPlan_resolves_the_stored_persona_and_the_product_default_when_none_is_stored()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");

        // A stored persona is the player's choice and reaches the child verbatim.
        var chosen = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: "gentle_maid", outputDevice: "default");
        Assert.Equal("gentle_maid", chosen.Environment["GAMEBUDDY_MIMO_PERSONA"]);
        Assert.NotEqual(string.Empty, chosen.Environment["GAMEBUDDY_MIMO_PERSONA"]);

        // No stored persona is the picker's "System default", and it must still be
        // audible: the admitted plan resolves it to the product's default persona.
        // Leaving GAMEBUDDY_MIMO_PERSONA unset is what the extension reads as neither
        // a voice nor a persona - silence, not a default.
        var systemDefault = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true);
        Assert.Equal(VoicePersonaCatalogue.DefaultId, systemDefault.Environment["GAMEBUDDY_MIMO_PERSONA"]);
    }

    [Fact]
    public void BuildLaunchPlan_resolves_a_persona_the_catalogue_does_not_admit_to_the_default()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        using var credentials = OperatorCredentials(null, null);

        // An id neither the picker nor the extension declares must not reach the
        // child as-is: the extension refuses an unknown persona while constructing
        // the provider, which takes Voice down rather than degrading it.
        var clamped = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: "invented_persona", outputDevice: "default");
        Assert.Equal(VoicePersonaCatalogue.DefaultId, clamped.Environment["GAMEBUDDY_MIMO_PERSONA"]);

        // The clamp adds no variable: the child environment stays the declared allowlist.
        Assert.Equal(
            new[] { "GAMEBUDDY_MIMO_PERSONA", "GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION", "GAMEBUDDY_VOICE_PORT", "GAMEBUDDY_VOICE_TOKEN", "GAMEBUDDY_WINDOWS_OUTPUT_DEVICE", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP" },
            clamped.Environment.Keys.OrderBy(key => key, StringComparer.Ordinal));
    }

    [Fact]
    public void Voice_persona_catalogue_is_pinned_to_the_dialogue_web_picker()
    {
        // No import can cross from C# to the picker's TypeScript, so this is a
        // mirror, and this test is its gate: it reads the picker's own declaration
        // and asserts the mirrored ids and default are the same ones. The picker's
        // set is in turn pinned to the vendored extension's MIMO_TTS_PERSONAS by
        // dialogue-web/tests/persona-catalogue-gate.test.mjs, so the chain
        // launcher -> picker -> extension is closed at both ends.
        var source = File.ReadAllText(PickerSource());

        Assert.Equal(VoicePersonaCatalogue.Ids.OrderBy(id => id, StringComparer.Ordinal).ToArray(), PickerPersonaIds(source));
        Assert.Equal(VoicePersonaCatalogue.DefaultId, PickerDefaultPersona(source));
        Assert.Contains(VoicePersonaCatalogue.DefaultId, VoicePersonaCatalogue.Ids);
    }

    [Fact]
    public void BuildLaunchPlan_passes_operator_tts_credentials_by_allowlist_when_present()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        using var credentials = OperatorCredentials("mimo-synthetic-key-1", "groq-synthetic-key-2");

        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true);

        // Verbatim passthrough: the child is the only holder.
        Assert.Equal("mimo-synthetic-key-1", plan.Environment["MIMO_API_KEY"]);
        Assert.Equal("groq-synthetic-key-2", plan.Environment["GROQ_API_KEY"]);
        // And the only string representation never carries them.
        var text = plan.ToString();
        Assert.DoesNotContain("mimo-synthetic-key-1", text, StringComparison.Ordinal);
        Assert.DoesNotContain("groq-synthetic-key-2", text, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildLaunchPlan_leaves_operator_credentials_unset_when_absent()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        using var credentials = OperatorCredentials(null, null);

        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true);

        // Unset, not empty: the extension distinguishes the two, and an empty value
        // is not a usable key.
        Assert.False(plan.Environment.ContainsKey("MIMO_API_KEY"), "an absent MIMO_API_KEY must leave the variable unset");
        Assert.False(plan.Environment.ContainsKey("GROQ_API_KEY"), "an absent GROQ_API_KEY must leave the variable unset");
    }

    [Fact]
    public void BuildLaunchPlan_environment_is_exactly_the_declared_allowlist()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        using var credentials = OperatorCredentials("mimo-synthetic-key-1", "groq-synthetic-key-2");
        System.Environment.SetEnvironmentVariable("GAMEBUDDY_STRAY_OPERATOR_VAR", "must-not-leak");
        try
        {
            var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: "soft_maid", outputDevice: "waveout:1");

            Assert.Equal(
                new[] { "GAMEBUDDY_MIMO_PERSONA", "GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION", "GAMEBUDDY_VOICE_PORT", "GAMEBUDDY_VOICE_TOKEN", "GAMEBUDDY_WINDOWS_OUTPUT_DEVICE", "GROQ_API_KEY", "LOCALAPPDATA", "MIMO_API_KEY", "SystemRoot", "TEMP", "TMP" },
                plan.Environment.Keys.OrderBy(key => key, StringComparer.Ordinal));
            // The child environment was cleared: a stray operator variable is not inherited.
            Assert.DoesNotContain(plan.Environment.Keys, key => key.Equals("GAMEBUDDY_STRAY_OPERATOR_VAR", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            System.Environment.SetEnvironmentVariable("GAMEBUDDY_STRAY_OPERATOR_VAR", null);
        }
    }

    [Fact]
    public void BuildLaunchPlan_to_string_redacts_the_token()
    {
        using var root = TemporaryRoot.Create();
        var gateway = root.Gateway("voice/entry.js");
        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), gateway, 49731, ValidToken, cloudTtsAdmitted: true, persona: "companion.default");

        var text = plan.ToString();
        Assert.Contains(gateway.EntryPath, text, StringComparison.Ordinal);
        Assert.Contains("Port=49731", text, StringComparison.Ordinal);
        Assert.Contains("CloudTtsAdmitted=True", text, StringComparison.Ordinal);
        Assert.Contains("Persona=companion.default", text, StringComparison.Ordinal);
        Assert.DoesNotContain(ValidToken, text, StringComparison.Ordinal);
        Assert.DoesNotContain("GAMEBUDDY_VOICE", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CloseAsync_and_DisposeAsync_are_idempotent_without_a_started_child()
    {
        var supervisor = new VoiceGatewaySupervisor();
        await supervisor.DisposeAsync();
        await supervisor.DisposeAsync();
        await supervisor.CloseAsync(CancellationToken.None);
        await supervisor.CloseAsync(CancellationToken.None);
    }

    [Fact]
    public async Task StartAsync_after_close_throws_disposed()
    {
        using var root = TemporaryRoot.Create();
        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, ValidToken, cloudTtsAdmitted: false);
        var supervisor = new VoiceGatewaySupervisor();
        await supervisor.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() => supervisor.StartAsync(plan, CancellationToken.None));
    }

    // The already-started guard cannot be reached without a real admitted Node
    // runtime (a second StartAsync requires the first child to be running), so it
    // is pinned by the source test below instead of a behavioral process test.

    [Fact]
    public void Supervisor_source_launches_only_the_admitted_node_with_a_cleared_environment()
    {
        var source = File.ReadAllText(Source());

        Assert.Contains("FileName = plan.NodePath", source, StringComparison.Ordinal);
        Assert.Contains("start.Environment.Clear()", source, StringComparison.Ordinal);
        Assert.Contains("UseShellExecute = false", source, StringComparison.Ordinal);
        Assert.Contains("CreateNoWindow = true", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable(\"PATH\")", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PATH", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_never_restarts_replays_or_retries_the_child()
    {
        var source = File.ReadAllText(Source());
        var start = source.IndexOf("child.Start()", StringComparison.Ordinal);

        Assert.True(start >= 0);
        Assert.Equal(start, source.LastIndexOf("child.Start()", StringComparison.Ordinal));
        Assert.DoesNotContain("Restart", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Replay", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Retry", source, StringComparison.Ordinal);
        Assert.DoesNotContain("while", source, StringComparison.Ordinal);
        Assert.Contains("a supervisor starts exactly one child and never restarts it", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_closes_once_kills_the_exact_tree_and_observes_child_exit()
    {
        var source = File.ReadAllText(Source());
        var close = source.IndexOf("internal async ValueTask CloseAsync", StringComparison.Ordinal);

        Assert.True(close >= 0);
        Assert.Contains("Interlocked.Exchange(ref closed, 1) != 0) return;", source[close..], StringComparison.Ordinal);
        Assert.Contains("Interlocked.Exchange(ref process, null)", source[close..], StringComparison.Ordinal);
        Assert.Contains("child.Kill(entireProcessTree: true)", source[close..], StringComparison.Ordinal);
        Assert.Contains("await child.WaitForExitAsync(cancellationToken)", source[close..], StringComparison.Ordinal);
        Assert.Contains("public ValueTask DisposeAsync() => CloseAsync(CancellationToken.None)", source, StringComparison.Ordinal);
        Assert.Contains("internal sealed class VoiceGatewayLease", source, StringComparison.Ordinal);
        Assert.Contains("internal Task WaitForExitAsync(CancellationToken cancellationToken = default) => supervisor.WaitForExitAsync(cancellationToken)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_has_no_host_consent_publisher_or_v2_dependencies()
    {
        var source = File.ReadAllText(Source());

        Assert.DoesNotContain("GuardianSupervisor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GuardianLaunchUnavailableException", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RuntimeSupervisor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DesktopHostBootstrapBroker", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Program", source, StringComparison.Ordinal);
        Assert.DoesNotContain("current.json", source, StringComparison.Ordinal);
        Assert.DoesNotContain("publisher", source, StringComparison.Ordinal);
        Assert.DoesNotContain("v2", source, StringComparison.Ordinal);
        Assert.DoesNotContain("consent store", source, StringComparison.Ordinal);
    }

    private static string Source() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "VoiceGatewaySupervisor.cs"));

    private static string PickerSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "dialogue-web", "src", "components", "management-panels.tsx"));

    /// <summary>The ids the picker declares in its own MIMO_PERSONA_IDS literal, sorted.</summary>
    private static string[] PickerPersonaIds(string source)
    {
        var declaration = Regex.Match(source, @"export const MIMO_PERSONA_IDS = \[([^\]]*)\]");
        Assert.True(declaration.Success, "the picker declares MIMO_PERSONA_IDS as an array literal");
        var ids = Regex.Matches(declaration.Groups[1].Value, "\"([a-z][a-z0-9_]*)\"").Select(match => match.Groups[1].Value).ToArray();
        Assert.NotEmpty(ids);
        return ids.OrderBy(id => id, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The id the picker declares as its DEFAULT_MIMO_PERSONA_ID.</summary>
    private static string PickerDefaultPersona(string source)
    {
        var declaration = Regex.Match(source, "export const DEFAULT_MIMO_PERSONA_ID[^=]*= \"([a-z][a-z0-9_]*)\"");
        Assert.True(declaration.Success, "the picker declares DEFAULT_MIMO_PERSONA_ID as a literal id");
        return declaration.Groups[1].Value;
    }

    /// <summary>
    /// Sets the operator credential keys for one test and restores them on dispose.
    /// The environment is process-global, so this is scoped tightly and every test
    /// in this class runs sequentially.
    /// </summary>
    private static IDisposable OperatorCredentials(string? mimoApiKey, string? groqApiKey)
    {
        var previousMimo = System.Environment.GetEnvironmentVariable("MIMO_API_KEY");
        var previousGroq = System.Environment.GetEnvironmentVariable("GROQ_API_KEY");
        System.Environment.SetEnvironmentVariable("MIMO_API_KEY", mimoApiKey);
        System.Environment.SetEnvironmentVariable("GROQ_API_KEY", groqApiKey);
        return new RestoreCredentialEnvironment(previousMimo, previousGroq);
    }

    private sealed class RestoreCredentialEnvironment : IDisposable
    {
        private readonly string? mimoApiKey;
        private readonly string? groqApiKey;
        internal RestoreCredentialEnvironment(string? mimoApiKey, string? groqApiKey)
        {
            this.mimoApiKey = mimoApiKey;
            this.groqApiKey = groqApiKey;
        }
        public void Dispose()
        {
            System.Environment.SetEnvironmentVariable("MIMO_API_KEY", this.mimoApiKey);
            System.Environment.SetEnvironmentVariable("GROQ_API_KEY", this.groqApiKey);
        }
    }

    private sealed class TemporaryRoot : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
        internal static TemporaryRoot Create() { var root = new TemporaryRoot(); Directory.CreateDirectory(root.Path); return root; }
        internal string Node() => Write("runtime/node.exe");
        internal AdmittedVoiceGateway Gateway(string relative) { var entry = Write(relative); var protocol = Write("voice/protocol.js"); return new AdmittedVoiceGateway(entry, protocol); }
        private string Write(string relative) { var path = System.IO.Path.Combine(Path, relative.Replace('/', System.IO.Path.DirectorySeparatorChar)); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!); File.WriteAllText(path, "x"); return path; }
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}