using System.Security.Cryptography;

namespace GameBuddy.Desktop.Tests;

public sealed class VoiceLaunchCoordinatorTests
{
    private const string ValidToken = "vGQf7mKx2LpR9sBw4Aa1";

    [Fact]
    public void GenerateToken_matches_the_channel_contract_and_is_opaque()
    {
        var token = VoiceLaunchCoordinator.GenerateToken();
        Assert.Matches("^[A-Za-z0-9_-]{16,256}$", token);
        Assert.DoesNotContain("+", token);
        Assert.DoesNotContain("/", token);
        Assert.DoesNotContain("=", token);
        Assert.NotEqual(token, VoiceLaunchCoordinator.GenerateToken());
    }

    [Fact]
    public void PickFreeLoopbackPort_returns_a_boundable_loopback_port()
    {
        var port = VoiceLaunchCoordinator.PickFreeLoopbackPort();
        Assert.InRange(port, 1, 65_535);
        // The port was free moments ago; a fresh listener on the same loopback
        // port must bind successfully, proving the value is a real usable port.
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
        try
        {
            listener.Start();
            Assert.Equal(port, ((System.Net.IPEndPoint)listener.LocalEndpoint).Port);
        }
        finally { listener.Stop(); }
    }

    [Fact]
    public void Resolve_returns_null_when_the_artifact_sidecar_is_missing()
    {
        using var root = TemporaryRoot.Create();
        WriteAcceptedPreference(root);
        // No voice-gateway-admission.json in the generation root.
        Assert.Null(VoiceLaunchCoordinator.Resolve(root.Path, "g-voice-1-00000000000000000000000000000000", "a".PadLeft(64, 'a'), root.PreferencePath));
    }
    [Fact]
    public void Resolve_returns_null_for_undecided_or_revoked_consent()
    {
        using var root = TemporaryRoot.Create();
        var gateway = WriteSidecar(root);
        // Undecided default (no preference file).
        Assert.Null(VoiceLaunchCoordinator.Resolve(root.Path, "g-voice-1-00000000000000000000000000000000", "a".PadLeft(64, 'a'), root.PreferencePath));
        // Revoked.
        WritePreference(root, "revoked", null, 1);
        Assert.Null(VoiceLaunchCoordinator.Resolve(root.Path, "g-voice-1-00000000000000000000000000000000", "a".PadLeft(64, 'a'), root.PreferencePath));
        Assert.NotNull(gateway);
    }

    [Fact]
    public void Resolve_returns_a_paired_launch_for_accepted_consent_with_an_admitted_artifact()
    {
        using var root = TemporaryRoot.Create();
        WriteSidecar(root);
        WriteAcceptedPreference(root);
        var generation = "g-voice-1-00000000000000000000000000000000";
        var digest = "a".PadLeft(64, 'a');

        var launch = VoiceLaunchCoordinator.Resolve(root.Path, generation, digest, root.PreferencePath);

        Assert.NotNull(launch);
        Assert.InRange(launch.Port, 1, 65_535);
        Assert.Matches("^[A-Za-z0-9_-]{16,256}$", launch.Token);
        Assert.NotNull(launch.Gateway.EntryPath);
        Assert.NotNull(launch.Gateway.ProtocolPath);
        // No stored endpoint selection => the Windows default output.
        Assert.Equal("default", launch.OutputDevice);
    }

    [Fact]
    public void Resolve_carries_the_players_stored_output_endpoint()
    {
        using var root = TemporaryRoot.Create();
        WriteSidecar(root);
        WritePreference(root, "accepted", "mimo-cloud-tts-v1", 3, outputDevice: "waveout:3");
        const string generation = "g-voice-1-00000000000000000000000000000000";

        var launch = VoiceLaunchCoordinator.Resolve(root.Path, generation, "a".PadLeft(64, 'a'), root.PreferencePath);

        Assert.NotNull(launch);
        Assert.Equal("waveout:3", launch.OutputDevice);
    }

    [Fact]
    public void Resolve_returns_null_when_the_preference_file_is_corrupt()
    {
        using var root = TemporaryRoot.Create();
        WriteSidecar(root);
        File.WriteAllText(root.PreferencePath, "not json");
        const string generation = "g-voice-1-00000000000000000000000000000000";

        // The strict reader refuses the corrupt file; the composition declines
        // Voice (pure text) instead of letting the optional capability break
        // Chat. The reader itself remains fail-closed on its own contract.
        Assert.Null(VoiceLaunchCoordinator.Resolve(root.Path, generation, "a".PadLeft(64, 'a'), root.PreferencePath));
    }

    private static AdmittedVoiceGateway WriteSidecar(TemporaryRoot root)
    {
        var entry = root.Write("voice-gateway/entry/gateway.mjs", "entry-body\n");
        var protocol = root.Write("voice-gateway/protocol/protocol.js", "protocol-body\n");
        var sidecar = new
        {
            schema = "gamebuddy-host-voice-gateway-admission/v1",
            generation = "g-voice-1-00000000000000000000000000000000",
            inventoryDigest = "a".PadLeft(64, 'a'),
            entryPath = "voice-gateway/entry/gateway.mjs",
            entrySha256 = Digest(File.ReadAllBytes(entry)),
            protocolPath = "voice-gateway/protocol/protocol.js",
            protocolSha256 = Digest(File.ReadAllBytes(protocol)),
            nodeVersion = "v24.20.0",
            platform = "win32",
            arch = "x64",
        };
        File.WriteAllText(Path.Combine(root.Path, "voice-gateway-admission.json"), System.Text.Json.JsonSerializer.Serialize(sidecar));
        return new AdmittedVoiceGateway(entry, protocol);
    }

    private static void WriteAcceptedPreference(TemporaryRoot root) => WritePreference(root, "accepted", "mimo-cloud-tts-v1", 3);

    private static void WritePreference(TemporaryRoot root, string consent, string? disclosureVersion, long revision, string? outputDevice = null)
    {
        var preference = new
        {
            schemaVersion = 1,
            revision,
            disclosureVersion,
            consent,
            decidedAtMs = consent == "undecided" ? (long?)null : 1_700_000_000_000L,
            outputDevice,
        };
        File.WriteAllText(root.PreferencePath, System.Text.Json.JsonSerializer.Serialize(preference));
    }

    private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private sealed class TemporaryRoot : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), Random.Shared.Next().ToString("x8") + "-voice-launch");
        internal string PreferencePath => System.IO.Path.Combine(Path, "preference.json");
        internal static TemporaryRoot Create() { var root = new TemporaryRoot(); Directory.CreateDirectory(root.Path); return root; }
        internal string Write(string relative, string content) { var path = System.IO.Path.Combine(Path, relative.Replace('/', System.IO.Path.DirectorySeparatorChar)); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!); File.WriteAllText(path, content); return path; }
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}