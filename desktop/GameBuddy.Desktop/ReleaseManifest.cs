using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The published release description, as the release lane writes it (`release-manifest.json`).
///
/// Parsing is strict on purpose: this record is what an update decision is made from, so a manifest that is merely
/// "close enough" must be refused rather than half-read. Every field is required except the signature block, whose
/// absence and whose `required: false` mean different things.
/// </summary>
internal sealed record ReleaseManifest(
    string Version,
    string Repository,
    string DownloadUrl,
    string Generation,
    string InventoryDigest,
    string RuntimeAdmissionSha256,
    string PayloadSha256,
    long PayloadBytes,
    string InstallerFile,
    long InstallerBytes,
    string InstallerSha256,
    bool SignatureRequired)
{
    internal const string Schema = "gamebuddy-player-release-manifest/v1";

    private static readonly string[] RootKeys =
    [
        "schema",
        "version",
        "repository",
        "downloadUrl",
        "generation",
        "inventoryDigest",
        "runtimeAdmissionSha256",
        "payload",
        "configuration",
        "installer",
        "signature",
    ];

    /// <summary>
    /// Reads a manifest, or reports why it cannot be trusted.
    ///
    /// The checks are the ones an update needs and not one more: the schema it was written for, every field present with the
    /// right type, digests shaped like digests, and a download URL that points at the repository the manifest names - so a
    /// record from elsewhere cannot redirect an update.
    /// </summary>
    internal static bool TryParse(ReadOnlySpan<byte> utf8, out ReleaseManifest manifest, out string reason)
    {
        manifest = null!;
        reason = string.Empty;
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(utf8.ToArray());
        }
        catch (JsonException)
        {
            reason = "not_json";
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ExactKeys(root, RootKeys))
            {
                reason = "shape_mismatch";
                return false;
            }

            if (String(root, "schema") != Schema)
            {
                reason = "schema_mismatch";
                return false;
            }

            if (!GameBuddy.Release.ReleaseVersion.TryParse(String(root, "version"), out var version))
            {
                reason = "version_invalid";
                return false;
            }

            var repository = String(root, "repository");
            if (!LooksLikeRepository(repository))
            {
                reason = "repository_invalid";
                return false;
            }

            var downloadUrl = String(root, "downloadUrl");
            if (!PointsAtRepository(downloadUrl, repository, "GameBuddy.Setup.exe"))
            {
                reason = "download_url_off_repository";
                return false;
            }

            var generation = String(root, "generation");
            if (!InstalledGenerationPaths.ValidGeneration(generation)) reason = "generation_invalid";
            if (reason.Length > 0) return false;

            var inventoryDigest = String(root, "inventoryDigest");
            var admissionDigest = String(root, "runtimeAdmissionSha256");
            if (!IsDigest(inventoryDigest) || !IsDigest(admissionDigest))
            {
                reason = "generation_digest_invalid";
                return false;
            }

            if (!root.GetProperty("payload").TryGetProperty("sha256", out var payloadDigest) ||
                !root.GetProperty("payload").TryGetProperty("bytes", out var payloadBytes) ||
                payloadDigest.ValueKind != JsonValueKind.String ||
                !IsDigest(payloadDigest.GetString()!) ||
                payloadBytes.ValueKind != JsonValueKind.Number ||
                !payloadBytes.TryGetInt64(out var payloadSize) ||
                payloadSize <= 0)
            {
                reason = "payload_block_invalid";
                return false;
            }

            if (!root.GetProperty("installer").TryGetProperty("sha256", out var installerDigest) ||
                !root.GetProperty("installer").TryGetProperty("bytes", out var installerBytes) ||
                !root.GetProperty("installer").TryGetProperty("file", out var installerFile) ||
                installerDigest.ValueKind != JsonValueKind.String ||
                !IsDigest(installerDigest.GetString()!) ||
                installerBytes.ValueKind != JsonValueKind.Number ||
                !installerBytes.TryGetInt64(out var installerSize) ||
                installerSize <= 0 ||
                installerFile.ValueKind != JsonValueKind.String)
            {
                reason = "installer_block_invalid";
                return false;
            }

            // An installer smaller than the archive it embeds cannot be the single-file image, so the record is wrong.
            if (installerSize < payloadSize)
            {
                reason = "installer_smaller_than_payload";
                return false;
            }

            var signature = root.GetProperty("signature");
            if (signature.ValueKind != JsonValueKind.Object ||
                !signature.TryGetProperty("required", out var required) ||
                required.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                reason = "signature_block_invalid";
                return false;
            }

            manifest = new ReleaseManifest(
                version,
                repository,
                downloadUrl,
                generation,
                inventoryDigest,
                admissionDigest,
                payloadDigest.GetString()!,
                payloadSize,
                installerFile.GetString()!,
                installerSize,
                installerDigest.GetString()!,
                required.GetBoolean());
            return true;
        }
    }

    private static bool ExactKeys(JsonElement root, string[] expected)
    {
        var seen = new List<string>();
        foreach (var property in root.EnumerateObject())
        {
            if (!expected.Contains(property.Name, StringComparer.Ordinal)) return false;
            seen.Add(property.Name);
        }

        return seen.Count == expected.Length;
    }

    private static string String(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static bool IsDigest(string value) =>
        value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool LooksLikeRepository(string value)
    {
        var parts = value.Split('/');
        return parts.Length == 2 && parts.All(part => part.Length > 0 && part.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'));
    }

    /// <summary>
    /// A manifest may only name a download on its own repository. Without this, a record from anywhere could point the
    /// updater at an arbitrary host - and an unsigned build has no second anchor to catch that.
    /// </summary>
    private static bool PointsAtRepository(string url, string repository, string file)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps) return false;
        if (!string.Equals(uri.Host, "github.com", StringComparison.Ordinal)) return false;
        var expectedPrefix = $"/{repository}/releases/download/";
        return uri.AbsolutePath.StartsWith(expectedPrefix, StringComparison.Ordinal) &&
               uri.AbsolutePath.EndsWith("/" + file, StringComparison.Ordinal);
    }

}
