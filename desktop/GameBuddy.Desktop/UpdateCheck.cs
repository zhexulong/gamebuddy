using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Answers one question - is there a newer release than the one installed? - and stops there.
///
/// It deliberately does not download or run anything. Those are the two steps that turn a check into an installer of
/// remote code, and they need their own decision about what vouches for the bytes: with no code-signing certificate the only
/// anchor is TLS to the host named in the manifest, which is a position to state in the runbook rather than bury in code.
///
/// The installed version is read from what is actually on disk (`current.json` names a generation, and that generation
/// carries the Host's own admission record), so "what am I running" is never taken from a caller's claim.
/// </summary>
internal static class UpdateCheck
{
    internal enum Verdict
    {
        UpToDate,
        Available,
        InstalledVersionUnknown,
        ManifestUnusable,
        SourceUnavailable,
    }

    internal sealed record Result(
        Verdict Verdict,
        string? InstalledVersion = null,
        string? AvailableVersion = null,
        string? DownloadUrl = null,
        string? Reason = null);

    /// <summary>
    /// Compares the installed release with a manifest fetched from <paramref name="source"/>.
    ///
    /// `source` is a path or an `https:` URL. A path exists so the whole decision is testable without a network, which is the
    /// only way to prove a version comparison rather than a connection.
    /// </summary>
    internal static async Task<Result> CheckAsync(string programRoot, string source, CancellationToken cancellationToken)
    {
        var installed = InstalledVersion(programRoot);
        if (installed is null) return new Result(Verdict.InstalledVersionUnknown);

        byte[]? bytes;
        try
        {
            bytes = await FetchAsync(source, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            return new Result(Verdict.SourceUnavailable, installed, Reason: "http");
        }

        if (bytes is null) return new Result(Verdict.SourceUnavailable, installed, Reason: "unreachable");

        if (!ReleaseManifest.TryParse(bytes, out var manifest, out var reason))
        {
            return new Result(Verdict.ManifestUnusable, installed, Reason: reason);
        }

        var comparison = Compare(installed, manifest.Version);
        return comparison < 0
            ? new Result(Verdict.Available, installed, manifest.Version, manifest.DownloadUrl)
            : new Result(Verdict.UpToDate, installed, manifest.Version);
    }

    /// <summary>
    /// The installed release's version, from the record the installer wrote at the program root.
    ///
    /// Nothing else on disk names it: the pointer carries digests, the admission record carries the *Node* version, and a
    /// generation id is a timestamp. The installer is the one place that knows, because its own `Version` property is the
    /// release the artifact was built for - the same value the manifest carries.
    /// </summary>
    internal static string? InstalledVersion(string programRoot)
    {
        try
        {
            programRoot = InstalledGenerationPaths.CanonicalDirectory(programRoot);
            var recordPath = InstalledGenerationPaths.ChildFile(programRoot, GameBuddy.Release.ReleaseRecord.FileName);
            using var record = JsonDocument.Parse(File.ReadAllBytes(recordPath));
            var root = record.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("schema", out var schema) ||
                schema.ValueKind != JsonValueKind.String ||
                schema.GetString() != GameBuddy.Release.ReleaseRecord.Schema ||
                !root.TryGetProperty("version", out var version) ||
                version.ValueKind != JsonValueKind.String ||
                !GameBuddy.Release.ReleaseVersion.TryParse(version.GetString(), out var normalised))
            {
                return null;
            }

            return normalised;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or GuardianLaunchUnavailableException)
        {
            return null;
        }
    }

    private static async Task<byte[]?> FetchAsync(string source, CancellationToken cancellationToken)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            using var response = await client.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        }

        // A path - and on Windows every absolute path parses as a `file:` URI, so this branch is the ordinary local case rather
        // than an edge. A file that is not there is "unavailable", not an exception: the launcher must report a verdict either
        // way, and a missing manifest is a normal thing to find.
        var path = Uri.TryCreate(source, UriKind.Absolute, out var file) && file.IsFile ? file.LocalPath : source;
        try
        {
            return File.Exists(path) ? await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false) : null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Compares two release versions, pre-release included: `1.0.0-rc.2` sorts before `1.0.0`, so a player on a release
    /// candidate is offered the release and a player on the release is not offered a candidate.
    /// </summary>
    internal static int Compare(string left, string right)
    {
        var (leftCore, leftPre) = Split(left);
        var (rightCore, rightPre) = Split(right);
        for (var index = 0; index < 3; index++)
        {
            var comparison = leftCore[index].CompareTo(rightCore[index]);
            if (comparison != 0) return comparison;
        }

        return (leftPre, rightPre) switch
        {
            (null, null) => 0,
            (null, _) => 1,
            (_, null) => -1,
            _ => ComparePreRelease(leftPre, rightPre),
        };
    }

    private static (int[] Core, string? Pre) Split(string value)
    {
        var candidate = value.StartsWith('v') && value.Length > 1 && char.IsAsciiDigit(value[1]) ? value[1..] : value;
        var separator = candidate.IndexOf('-');
        var core = separator < 0 ? candidate : candidate[..separator];
        var pre = separator < 0 ? null : candidate[(separator + 1)..];
        var parts = core.Split('.');
        var numbers = new int[3];
        for (var index = 0; index < 3 && index < parts.Length; index++)
        {
            _ = int.TryParse(parts[index], NumberStyles.None, CultureInfo.InvariantCulture, out numbers[index]);
        }

        return (numbers, pre);
    }

    /// <summary>
    /// Semver's pre-release ordering, simplified to what this product publishes: dot-separated identifiers, numeric ones
    /// compared as numbers and others lexically.
    /// </summary>
    private static int ComparePreRelease(string left, string right)
    {
        var leftParts = left.Split('.');
        var rightParts = right.Split('.');
        for (var index = 0; index < Math.Min(leftParts.Length, rightParts.Length); index++)
        {
            var leftNumeric = int.TryParse(leftParts[index], NumberStyles.None, CultureInfo.InvariantCulture, out var leftValue);
            var rightNumeric = int.TryParse(rightParts[index], NumberStyles.None, CultureInfo.InvariantCulture, out var rightValue);
            var comparison = (leftNumeric, rightNumeric) switch
            {
                (true, true) => leftValue.CompareTo(rightValue),
                (true, false) => -1,
                (false, true) => 1,
                _ => string.CompareOrdinal(leftParts[index], rightParts[index]),
            };
            if (comparison != 0) return comparison;
        }

        return leftParts.Length.CompareTo(rightParts.Length);
    }
}
