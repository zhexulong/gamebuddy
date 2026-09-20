using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

internal sealed record AdmittedVoiceGateway(string EntryPath, string ProtocolPath);

internal sealed class InstalledVoiceGatewayAdmission
{
    private const string AdmissionSchema = "gamebuddy-host-voice-gateway-admission/v1";
    private const string NodeVersion = "v24.20.0";
    private const string Platform = "win32";
    private const string Arch = "x64";

    internal AdmittedVoiceGateway Admit(string generationRoot, string expectedGeneration, string expectedInventoryDigest)
    {
        ArgumentNullException.ThrowIfNull(generationRoot);
        ArgumentNullException.ThrowIfNull(expectedGeneration);
        ArgumentNullException.ThrowIfNull(expectedInventoryDigest);

        try
        {
            var sidecarPath = InstalledGenerationPaths.ChildFile(generationRoot, "voice-gateway-admission.json");
            using var document = JsonDocument.Parse(File.ReadAllBytes(sidecarPath));
            var value = document.RootElement;
            var properties = new[] { "schema", "generation", "inventoryDigest", "entryPath", "entrySha256", "protocolPath", "protocolSha256", "nodeVersion", "platform", "arch" };
            if (!InstalledGenerationPaths.ExactProperties(value, properties) ||
                value.GetProperty("schema").GetString() != AdmissionSchema ||
                value.GetProperty("generation").GetString() != expectedGeneration ||
                value.GetProperty("inventoryDigest").GetString() != expectedInventoryDigest ||
                value.GetProperty("nodeVersion").GetString() != NodeVersion ||
                value.GetProperty("platform").GetString() != Platform ||
                value.GetProperty("arch").GetString() != Arch)
                throw new GuardianLaunchUnavailableException();

            var entryRelative = value.GetProperty("entryPath").GetString();
            var entryDigest = value.GetProperty("entrySha256").GetString();
            var protocolRelative = value.GetProperty("protocolPath").GetString();
            var protocolDigest = value.GetProperty("protocolSha256").GetString();
            if (!InstalledGenerationPaths.ValidRelativeFile(entryRelative) || !InstalledGenerationPaths.ValidDigest(entryDigest) ||
                !InstalledGenerationPaths.ValidRelativeFile(protocolRelative) || !InstalledGenerationPaths.ValidDigest(protocolDigest))
                throw new GuardianLaunchUnavailableException();

            var entryPath = InstalledGenerationPaths.ChildFile(generationRoot, entryRelative!.Replace('/', Path.DirectorySeparatorChar));
            var protocolPath = InstalledGenerationPaths.ChildFile(generationRoot, protocolRelative!.Replace('/', Path.DirectorySeparatorChar));
            if (!Digest(entryPath).Equals(entryDigest, StringComparison.Ordinal) || !Digest(protocolPath).Equals(protocolDigest, StringComparison.Ordinal))
                throw new GuardianLaunchUnavailableException();
            return new AdmittedVoiceGateway(entryPath, protocolPath);
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or CryptographicException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
    }

    private static string Digest(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
}
