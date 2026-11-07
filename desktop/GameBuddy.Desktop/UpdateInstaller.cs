using System.Net;
using System.Security.Cryptography;

namespace GameBuddy.Desktop;

/// <summary>
/// The install half of an update: download, verify, stage, hand off.
///
/// It exists because the only thing vouching for these bytes is TLS to the host the manifest names - so the four things that
/// make that anchor real are the whole implementation, not decoration:
///
///   1. the download may not leave the repository the manifest names, and a redirect is refused rather than followed (a hop is
///      exactly where a pinned URL stops meaning what it says);
///   2. the installer's SHA-256 is checked before anything is executed, which also catches a truncated file from a dropped
///      connection and a stale edge-cached object;
///   3. the bytes land in a temporary file beside their final path and are renamed into place only after verification, so a
///      half-written binary is never executable and never has the executable's name;
///   4. only a strictly greater version is installed, so an old manifest replayed at the player cannot silently downgrade the
///      product.
///
/// The hand-off is a delayed launch rather than a direct one: the installer refuses to run while the product runs
/// (`installer_product_running`), and this process *is* the product. So the launcher starts the installer after it exits and
/// says so, instead of fighting its own guard.
/// </summary>
internal static class UpdateInstaller
{
    internal enum Outcome
    {
        Staged,
        NotNewer,
        Unusable,
        DownloadFailed,
        DigestMismatch,
        StagingFailed,
    }

    internal sealed record Result(
        Outcome Outcome,
        string? StagedPath = null,
        string? Version = null,
        string? Reason = null);

    private const string StagingDirectoryName = ".updates";
    private const string InstallerFileName = "GameBuddy.Setup.exe";

    /// <summary>Any redirect at all is a refusal: the pinned URL is the anchor, and a hop is where it stops holding.</summary>
    internal static bool IsRedirect(HttpStatusCode status) => (int)status is >= 300 and < 400;

    /// <summary>
    /// Compares a downloaded body with what the manifest promised. Pure, so the two ways an update can be wrong - a truncated
    /// file and a substituted one - are testable without a network.
    /// </summary>
    internal static bool Matches(ReadOnlySpan<byte> body, long expectedBytes, string expectedSha256, out string reason)
    {
        if (body.Length != expectedBytes)
        {
            reason = $"length:{body.Length}!={expectedBytes}";
            return false;
        }

        var digest = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        if (!string.Equals(digest, expectedSha256, StringComparison.Ordinal))
        {
            reason = "sha256";
            return false;
        }

        reason = string.Empty;
        return true;
    }

    /// <summary>
    /// Downloads, verifies, stages and hands off. `source` is a manifest path or an `https:` URL for the manifest itself.
    /// </summary>
    /// <param name="download">
    /// The network, as a boundary this code does not own. Production passes null and gets the pinned HTTP client; a test passes
    /// the bytes, because the manifest validation already forbids a `file:` URL for the installer itself and weakening that to
    /// test the download would trade a real guarantee for a test.
    /// </param>
    /// <param name="handOff">How the staged installer is started; production passes null.</param>
    internal static async Task<Result> ApplyAsync(
        string programRoot,
        string source,
        CancellationToken cancellationToken,
        Func<string, Task<byte[]?>>? download = null,
        Action<string>? handOff = null)
    {
        var check = await UpdateCheck.CheckAsync(programRoot, source, cancellationToken).ConfigureAwait(false);
        switch (check.Verdict)
        {
            case UpdateCheck.Verdict.Available:
                break;
            case UpdateCheck.Verdict.UpToDate:
                // Pillar 4: nothing here installs a version that is not strictly newer.
                return new Result(Outcome.NotNewer, Version: check.AvailableVersion, Reason: "not_newer");
            default:
                return new Result(Outcome.Unusable, Reason: check.Reason ?? check.Verdict.ToString());
        }

        if (!ReleaseManifest.TryParse(await ReadSourceAsync(source, cancellationToken).ConfigureAwait(false) ?? [], out var manifest, out var manifestReason))
        {
            return new Result(Outcome.Unusable, Reason: manifestReason);
        }

        byte[]? body;
        try
        {
            body = await (download ?? (url => DownloadAsync(url, cancellationToken)))(manifest.DownloadUrl).ConfigureAwait(false);
        }
        catch (HttpRequestException exception)
        {
            return new Result(Outcome.DownloadFailed, Version: manifest.Version, Reason: exception.Message);
        }

        if (body is null) return new Result(Outcome.DownloadFailed, Version: manifest.Version, Reason: "unreachable");

        if (!Matches(body, manifest.InstallerBytes, manifest.InstallerSha256, out var mismatch))
        {
            return new Result(Outcome.DigestMismatch, Version: manifest.Version, Reason: mismatch);
        }

        try
        {
            var staged = await StageAsync(programRoot, body, cancellationToken).ConfigureAwait(false);
            handOff?.Invoke(staged);
            return new Result(Outcome.Staged, staged, manifest.Version);
        }
        catch (IOException exception)
        {
            return new Result(Outcome.StagingFailed, Version: manifest.Version, Reason: exception.Message);
        }
        catch (UnauthorizedAccessException exception)
        {
            return new Result(Outcome.StagingFailed, Version: manifest.Version, Reason: exception.Message);
        }
    }

    /// <summary>
    /// Writes the verified bytes to a temporary name beside their final one, then renames.
    ///
    /// Pillar 3: the rename is the only step that gives the file the installer's name, so nothing can execute a partially
    /// written binary - and a rename within one directory is atomic on the volume that matters.
    /// </summary>
    internal static async Task<string> StageAsync(string programRoot, byte[] body, CancellationToken cancellationToken)
    {
        var stagingRoot = Path.Combine(programRoot, StagingDirectoryName);
        Directory.CreateDirectory(stagingRoot);

        // Drain: every run is a new attempt, and a previous attempt's leftovers are not a collection anything reads.
        foreach (var stale in Directory.GetDirectories(stagingRoot))
        {
            try
            {
                Directory.Delete(stale, recursive: true);
            }
            catch (IOException)
            {
                // A still-running previous hand-off owns it; leaving it is safer than fighting it.
            }
        }

        var attempt = Path.Combine(stagingRoot, Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(attempt);
        var temporary = Path.Combine(attempt, InstallerFileName + "." + Guid.NewGuid().ToString("n") + ".tmp");
        var final = Path.Combine(attempt, InstallerFileName);
        try
        {
            await File.WriteAllBytesAsync(temporary, body, cancellationToken).ConfigureAwait(false);
            File.Move(temporary, final, overwrite: true);
            return final;
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static async Task<byte[]?> DownloadAsync(string url, CancellationToken cancellationToken)
    {
        using var handler = new HttpClientHandler
        {
            // Pillar 1: no automatic hop. A 3xx is reported instead, because the pinned URL is the whole anchor.
            AllowAutoRedirect = false,
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) };
        using var response = await client.GetAsync(new Uri(url), CancellationToken.None).ConfigureAwait(false);
        if (IsRedirect(response.StatusCode)) return null;
        if (!response.IsSuccessStatusCode) return null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
        return buffer.ToArray();
    }

    private static async Task<byte[]?> ReadSourceAsync(string source, CancellationToken cancellationToken)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            using var response = await client.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false)
                : null;
        }

        var path = Uri.TryCreate(source, UriKind.Absolute, out var file) && file.IsFile ? file.LocalPath : source;
        return File.Exists(path) ? await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false) : null;
    }

    /// <summary>
    /// Starts the staged installer after this process exits, and returns immediately.
    ///
    /// The installer refuses to run while the product runs, and this process *is* the product, so the hand-off is a delayed
    /// launch rather than a direct one. The delay is the smallest interval that reliably outlives this process; the installer's
    /// own guard remains the authority if it does not.
    /// </summary>
    internal static void HandOff(string stagedPath)
    {
        var command = $"/c ping -n 3 127.0.0.1 >nul & start \"\" \"{stagedPath}\" install";
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = command,
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
        });
    }
}
