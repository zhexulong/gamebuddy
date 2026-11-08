using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The update decision: is there a newer release than the installed one, and may the manifest be trusted enough to answer.
///
/// Everything here runs against a file path, not a network, because a comparison is what needs proving - a connection proves
/// nothing about whether `0.2.0` is newer than `0.1.0`. The manifest is built in the tests at the shape the release lane writes,
/// and the installed side is a real program root with a real release record.
///
/// What is deliberately NOT tested: downloading and running an installer. Those are a separate decision about what vouches
/// for the bytes, and proving them here would imply a trust model that does not exist yet.
/// </summary>
public sealed class UpdateCheckTests
{
    private const string Repository = "zhexulong/gamebuddy";

    [Fact]
    public async Task A_newer_manifest_is_offered_with_the_download_url_it_names()
    {
        using var root = new InstalledRoot("0.1.0");
        var manifest = ManifestPath(version: "0.2.0");

        var result = await UpdateCheck.CheckAsync(root.Path, manifest, CancellationToken.None);

        Assert.Equal(UpdateCheck.Verdict.Available, result.Verdict);
        Assert.Equal("0.1.0", result.InstalledVersion);
        Assert.Equal("0.2.0", result.AvailableVersion);
        Assert.Equal($"https://github.com/{Repository}/releases/download/v0.2.0/GameBuddy.Setup.exe", result.DownloadUrl);
    }

    [Fact]
    public async Task The_same_version_is_up_to_date()
    {
        using var root = new InstalledRoot("0.2.0");
        var result = await UpdateCheck.CheckAsync(root.Path, ManifestPath(version: "0.2.0"), CancellationToken.None);
        Assert.Equal(UpdateCheck.Verdict.UpToDate, result.Verdict);
    }

    [Fact]
    public async Task An_older_manifest_is_not_offered_as_an_update()
    {
        using var root = new InstalledRoot("0.3.0");
        var result = await UpdateCheck.CheckAsync(root.Path, ManifestPath(version: "0.2.0"), CancellationToken.None);
        Assert.Equal(UpdateCheck.Verdict.UpToDate, result.Verdict);
    }

    [Theory]
    [InlineData("1.0.0", "1.0.0-rc.1", 1)]
    [InlineData("1.0.0-rc.1", "1.0.0", -1)]
    [InlineData("1.0.0-rc.2", "1.0.0-rc.10", -1)]
    [InlineData("1.0.0-rc.10", "1.0.0-rc.9", 1)]
    [InlineData("0.1.0", "v0.1.0", 0)]
    [InlineData("1.10.0", "1.9.0", 1)]
    public void Pre_releases_and_numeric_segments_order_the_way_semver_says(string left, string right, int expected)
    {
        Assert.Equal(expected, Math.Sign(UpdateCheck.Compare(left, right)));
    }

    [Fact]
    public async Task A_manifest_without_a_release_record_is_not_an_answer()
    {
        // The installed version is unknown, so "up to date" would be a guess. It is reported as unknown instead.
        using var root = new InstalledRoot(version: null);
        var result = await UpdateCheck.CheckAsync(root.Path, ManifestPath(version: "0.2.0"), CancellationToken.None);
        Assert.Equal(UpdateCheck.Verdict.InstalledVersionUnknown, result.Verdict);
    }

    [Fact]
    public async Task A_missing_manifest_source_is_unavailable_rather_than_up_to_date()
    {
        using var root = new InstalledRoot("0.1.0");
        var result = await UpdateCheck.CheckAsync(root.Path, Path.Combine(root.Path, "absent.json"), CancellationToken.None);
        Assert.Equal(UpdateCheck.Verdict.SourceUnavailable, result.Verdict);
    }

    [Theory]
    [InlineData("{}", "shape_mismatch")]
    [InlineData("not json", "not_json")]
    public async Task A_manifest_that_is_not_the_published_shape_is_refused(string content, string reason)
    {
        using var root = new InstalledRoot("0.1.0");
        var path = Path.Combine(root.Path, "manifest.json");
        File.WriteAllText(path, content);

        var result = await UpdateCheck.CheckAsync(root.Path, path, CancellationToken.None);

        Assert.Equal(UpdateCheck.Verdict.ManifestUnusable, result.Verdict);
        Assert.Equal(reason, result.Reason);
    }

    [Fact]
    public async Task A_download_url_off_the_named_repository_is_refused()
    {
        // Without this, an unsigned build has no second anchor: a manifest from anywhere could point the updater at any host.
        using var root = new InstalledRoot("0.1.0");
        var path = ManifestPath(
            version: "0.2.0",
            overrides: new() { ["downloadUrl"] = "\"https://example.com/evil/GameBuddy.Setup.exe\"" });

        var result = await UpdateCheck.CheckAsync(root.Path, path, CancellationToken.None);

        Assert.Equal(UpdateCheck.Verdict.ManifestUnusable, result.Verdict);
        Assert.Equal("download_url_off_repository", result.Reason);
    }

    [Fact]
    public async Task A_manifest_claiming_an_installer_smaller_than_its_payload_is_refused()
    {
        using var root = new InstalledRoot("0.1.0");
        var path = ManifestPath(version: "0.2.0", overrides: new() { ["installer"] = InstallerBlock(bytes: 1024) });

        var result = await UpdateCheck.CheckAsync(root.Path, path, CancellationToken.None);

        Assert.Equal(UpdateCheck.Verdict.ManifestUnusable, result.Verdict);
        Assert.Equal("installer_smaller_than_payload", result.Reason);
    }

    private static string InstallerBlock(long bytes) =>
        $"{{\"file\":\"GameBuddy.Setup.exe\",\"bytes\":{bytes},\"sha256\":\"{new string('a', 64)}\"}}";

    /// <summary>
    /// A manifest at the shape the release lane writes. `overrides` replaces a whole top-level member, so a test states the
    /// one fact it is changing.
    /// </summary>
    private static string ManifestPath(string version, Dictionary<string, string>? overrides = null)
    {
        var directory = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "update-check", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var payload = "{\"sha256\":\"" + new string('b', 64) + "\",\"bytes\":4096}";
        var installer = InstallerBlock(bytes: 8192);
        var members = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["schema"] = "\"gamebuddy-player-release-manifest/v1\"",
            ["version"] = $"\"{version}\"",
            ["repository"] = $"\"{Repository}\"",
            ["downloadUrl"] = $"\"https://github.com/{Repository}/releases/download/v{version.TrimStart('v')}/GameBuddy.Setup.exe\"",
            ["generation"] = $"\"g-mw6k4d6g-31568-{new string('c', 32)}\"",
            ["inventoryDigest"] = $"\"{new string('d', 64)}\"",
            ["runtimeAdmissionSha256"] = $"\"{new string('e', 64)}\"",
            ["payload"] = payload,
            ["configuration"] = "\"Debug\"",
            ["installer"] = installer,
            ["signature"] = "{\"required\":false,\"scheme\":\"none\",\"thumbprint\":null}",
        };
        foreach (var (key, value) in overrides ?? [])
        {
            members[key] = value;
        }

        var json = "{" + string.Join(",", members.Select(member => $"\"{member.Key}\":{member.Value}")) + "}";
        var path = Path.Combine(directory, "release-manifest.json");
        File.WriteAllText(path, json);
        return path;
    }

    /// <summary>
    /// A program root with a release record, which is all the installed side needs: the version is read from the record the
    /// installer writes, not from the generation.
    /// </summary>
    private sealed class InstalledRoot : IDisposable
    {
        internal InstalledRoot(string? version)
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "update-installed", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            if (version is null) return;
            File.WriteAllText(
                System.IO.Path.Combine(Path, GameBuddy.Release.ReleaseRecord.FileName),
                $"{{\"schema\":\"{GameBuddy.Release.ReleaseRecord.Schema}\",\"version\":\"{version}\"}}");
        }

        internal string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
    }
}
