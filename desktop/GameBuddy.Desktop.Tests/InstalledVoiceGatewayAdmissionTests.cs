using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Desktop.Tests;

public sealed class InstalledVoiceGatewayAdmissionTests
{
    [Fact]
    public void Admit_returns_full_paths_for_valid_sidecar_and_files()
    {
        using var root = TemporaryRoot.Create();
        var entry = root.Write("voice/entry.js", "entry");
        var protocol = root.Write("voice/protocol.js", "protocol");
        root.WriteSidecar("g-test-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "b".PadLeft(64, 'a'), "voice/entry.js", entry, "voice/protocol.js", protocol);

        var admitted = new InstalledVoiceGatewayAdmission().Admit(root.Path, "g-test-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "b".PadLeft(64, 'a'));

        Assert.Equal(entry, admitted.EntryPath);
        Assert.Equal(protocol, admitted.ProtocolPath);
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("inventoryDigest")]
    public void Admit_rejects_wrong_binding(string field)
    {
        using var root = TemporaryRoot.Create();
        var entry = root.Write("entry.js", "entry");
        var protocol = root.Write("protocol.js", "protocol");
        root.WriteSidecar("g", "d", "entry.js", entry, "protocol.js", protocol);
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledVoiceGatewayAdmission().Admit(root.Path, field == "generation" ? "other" : "g", field == "inventoryDigest" ? "other" : "d"));
    }

    [Fact]
    public void Admit_rejects_missing_sidecar_or_file_and_digest_mismatch()
    {
        using var root = TemporaryRoot.Create();
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledVoiceGatewayAdmission().Admit(root.Path, "g", "d"));
        var entry = root.Write("entry.js", "entry");
        var protocol = root.Write("protocol.js", "protocol");
        root.WriteSidecar("g", "d", "entry.js", entry, "missing.js", "0".PadLeft(64, '0'));
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledVoiceGatewayAdmission().Admit(root.Path, "g", "d"));
        root.WriteSidecar("g", "d", "entry.js", "0".PadLeft(64, '0'), "protocol.js", protocol);
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledVoiceGatewayAdmission().Admit(root.Path, "g", "d"));
    }

    [Fact]
    public void Admit_rejects_traversal_and_unknown_keys()
    {
        using var root = TemporaryRoot.Create();
        var entry = root.Write("entry.js", "entry");
        var protocol = root.Write("protocol.js", "protocol");
        root.WriteSidecar("g", "d", "../entry.js", entry, "protocol.js", protocol, unknown: true);
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledVoiceGatewayAdmission().Admit(root.Path, "g", "d"));
    }

    private sealed class TemporaryRoot : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
        internal static TemporaryRoot Create() { var root = new TemporaryRoot(); Directory.CreateDirectory(root.Path); return root; }
        internal string Write(string relative, string content) { var path = System.IO.Path.Combine(Path, relative.Replace('/', System.IO.Path.DirectorySeparatorChar)); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!); File.WriteAllText(path, content); return path; }
        internal void WriteSidecar(string generation, string digest, string entryPath, string entryDigest, string protocolPath, string protocolDigest, bool unknown = false) => File.WriteAllText(System.IO.Path.Combine(Path, "voice-gateway-admission.json"), JsonSerializer.Serialize(new { schema = "gamebuddy-host-voice-gateway-admission/v1", generation, inventoryDigest = digest, entryPath, entrySha256 = entryDigest.Length == 64 ? entryDigest : Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(System.IO.Path.Combine(Path, entryPath.Replace('/', System.IO.Path.DirectorySeparatorChar))))).ToLowerInvariant(), protocolPath, protocolSha256 = protocolDigest.Length == 64 ? protocolDigest : Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(System.IO.Path.Combine(Path, protocolPath.Replace('/', System.IO.Path.DirectorySeparatorChar))))).ToLowerInvariant(), nodeVersion = "v24.20.0", platform = "win32", arch = "x64", extra = unknown ? "x" : null }, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull }));
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
