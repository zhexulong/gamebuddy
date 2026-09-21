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
        var plan = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), root.Gateway("voice/entry.js"), 49731, ValidToken, cloudTtsAdmitted: false);

        Assert.Equal(
            new[] { "GAMEBUDDY_VOICE_PORT", "GAMEBUDDY_VOICE_TOKEN", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP" },
            plan.Environment.Keys.OrderBy(key => key, StringComparer.Ordinal));
        Assert.Equal("49731", plan.Environment["GAMEBUDDY_VOICE_PORT"]);
        Assert.Equal(ValidToken, plan.Environment["GAMEBUDDY_VOICE_TOKEN"]);
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
    public void BuildLaunchPlan_arguments_carry_only_the_entry_and_optional_persona()
    {
        using var root = TemporaryRoot.Create();
        var entry = root.Gateway("voice/entry.js").EntryPath;

        var noPersona = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), new AdmittedVoiceGateway(entry, System.IO.Path.Combine(root.Path, "protocol.js")), 49731, ValidToken, cloudTtsAdmitted: false);
        Assert.Equal($"\"{entry}\"", noPersona.Arguments);
        Assert.DoesNotContain(ValidToken, noPersona.Arguments, StringComparison.Ordinal);
        Assert.DoesNotContain(" --port", noPersona.Arguments, StringComparison.Ordinal);

        var withPersona = VoiceGatewaySupervisor.BuildLaunchPlan(root.Node(), new AdmittedVoiceGateway(entry, System.IO.Path.Combine(root.Path, "protocol.js")), 49731, ValidToken, cloudTtsAdmitted: false, persona: "companion.default");
        Assert.Equal($"\"{entry}\" --persona \"companion.default\"", withPersona.Arguments);
        Assert.DoesNotContain(ValidToken, withPersona.Arguments, StringComparison.Ordinal);
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