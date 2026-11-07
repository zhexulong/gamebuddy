using System.Net;
using System.Security.Cryptography;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The four pillars that make "TLS to the repository the manifest names" a real anchor rather than a phrase.
///
/// Each case is a failure the flow has to survive, and each is named after the failure rather than the method:
///
///   * a redirect, which is where a pinned URL stops meaning what it says;
///   * a truncated download, which is what a dropped connection leaves behind;
///   * a substituted body, which is what the digest is for;
///   * an equal or older version, which is what a replayed manifest would install.
///
/// Staging is driven against a scratch program root, so the atomic-rename property is measured on real files.
/// </summary>
public sealed class UpdateInstallerTests
{
    [Theory]
    [InlineData(301)]
    [InlineData(302)]
    [InlineData(303)]
    [InlineData(307)]
    [InlineData(308)]
    public void Any_redirect_is_a_refusal_because_the_pinned_url_is_the_anchor(int status)
    {
        Assert.True(UpdateInstaller.IsRedirect((HttpStatusCode)status));
    }

    [Theory]
    [InlineData(200)]
    [InlineData(404)]
    [InlineData(500)]
    public void A_non_redirect_status_is_decided_by_success_not_by_hops(int status)
    {
        Assert.False(UpdateInstaller.IsRedirect((HttpStatusCode)status));
    }

    [Fact]
    public void A_truncated_body_is_refused_by_length_before_the_digest_is_even_studied()
    {
        var body = new byte[] { 1, 2, 3 };
        Assert.False(UpdateInstaller.Matches(body, expectedBytes: 4, expectedSha256: "unused", out var reason));
        Assert.StartsWith("length:", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_body_of_the_right_length_with_the_wrong_bytes_is_refused_by_digest()
    {
        var body = new byte[] { 1, 2, 3, 4 };
        Assert.False(UpdateInstaller.Matches(body, 4, new string('a', 64), out var reason));
        Assert.Equal("sha256", reason);
    }

    [Fact]
    public void The_exact_bytes_and_digest_pass()
    {
        var body = new byte[] { 9, 8, 7 };
        var digest = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        Assert.True(UpdateInstaller.Matches(body, 3, digest, out var reason));
        Assert.Equal(string.Empty, reason);
    }

    [Fact]
    public async Task Staging_writes_the_verified_bytes_under_the_installers_name_and_leaves_no_temporary_file()
    {
        using var root = new ScratchProgramRoot();
        var body = new byte[] { 5, 5, 5, 5 };

        var staged = await UpdateInstaller.StageAsync(root.Path, body, CancellationToken.None);

        Assert.Equal("GameBuddy.Setup.exe", Path.GetFileName(staged));
        Assert.Equal(body, await File.ReadAllBytesAsync(staged));
        Assert.Empty(Directory.GetFiles(root.Path, "*.tmp", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Staging_drains_the_previous_attempt_so_the_directory_is_bounded()
    {
        using var root = new ScratchProgramRoot();
        var first = await UpdateInstaller.StageAsync(root.Path, new byte[] { 1 }, CancellationToken.None);

        var second = await UpdateInstaller.StageAsync(root.Path, new byte[] { 2 }, CancellationToken.None);

        // One attempt remains: the new one. The previous directory is gone rather than accumulating on every update.
        var attempts = Directory.GetDirectories(Path.Combine(root.Path, ".updates"));
        Assert.Single(attempts);
        Assert.NotEqual(Path.GetDirectoryName(first), Path.GetDirectoryName(second));
        Assert.False(File.Exists(first));
    }

    /// <summary>
    /// The whole chain with the network supplied: a manifest, bytes that match it, a staging directory, and the path a
    /// hand-off would receive.
    /// </summary>
    [Fact]
    public async Task A_matching_download_is_staged_and_handed_off_with_the_path_that_was_written()
    {
        using var root = new ScratchProgramRoot();
        root.InstallRecord("0.1.0");
        var body = new byte[] { 7, 7, 7, 7, 7, 7 };
        var manifest = root.WriteManifest("0.2.0", body);
        string? handedOff = null;

        var result = await UpdateInstaller.ApplyAsync(
            root.Path,
            manifest,
            CancellationToken.None,
            _ => Task.FromResult<byte[]?>(body),
            staged => handedOff = staged);

        Assert.Equal(UpdateInstaller.Outcome.Staged, result.Outcome);
        Assert.NotNull(result.StagedPath);
        Assert.Equal(result.StagedPath, handedOff);
        Assert.Equal(body, await File.ReadAllBytesAsync(result.StagedPath!));
    }

    [Fact]
    public async Task A_download_that_does_not_match_the_manifest_is_never_staged_and_never_handed_off()
    {
        using var root = new ScratchProgramRoot();
        root.InstallRecord("0.1.0");
        var manifest = root.WriteManifest("0.2.0", new byte[] { 1, 1, 1 });
        var handedOff = false;

        // Same length, different bytes: the digest is the only thing that catches it.
        var result = await UpdateInstaller.ApplyAsync(
            root.Path,
            manifest,
            CancellationToken.None,
            _ => Task.FromResult<byte[]?>(new byte[] { 2, 2, 2 }),
            _ => handedOff = true);

        Assert.Equal(UpdateInstaller.Outcome.DigestMismatch, result.Outcome);
        Assert.False(handedOff);
        Assert.False(Directory.Exists(Path.Combine(root.Path, ".updates")));
    }

    [Fact]
    public async Task An_older_manifest_is_refused_rather_than_installed_over_a_newer_release()
    {
        using var root = new ScratchProgramRoot();
        root.InstallRecord("0.3.0");
        var manifest = root.WriteManifest("0.2.0", new byte[] { 1 });

        var result = await UpdateInstaller.ApplyAsync(
            root.Path,
            manifest,
            CancellationToken.None,
            _ => Task.FromResult<byte[]?>(new byte[] { 1 }),
            _ => Assert.Fail("nothing may be handed off for an older version"));

        Assert.Equal(UpdateInstaller.Outcome.NotNewer, result.Outcome);
    }

    private sealed class ScratchProgramRoot : IDisposable
    {
        internal ScratchProgramRoot()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "update-installer", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        /// <summary>The release record the installer writes, so the installed version is a real fact about the root.</summary>
        internal void InstallRecord(string version)
        {
            File.WriteAllText(
                System.IO.Path.Combine(Path, GameBuddy.Release.ReleaseRecord.FileName),
                $"{{\"schema\":\"{GameBuddy.Release.ReleaseRecord.Schema}\",\"version\":\"{version}\"}}");
        }

        /// <summary>
        /// A manifest at the published shape, whose installer digest describes <paramref name="body"/> - so a test states the one
        /// fact it is changing and everything else is internally consistent.
        /// </summary>
        internal string WriteManifest(string version, byte[] body)
        {
            var digest = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
            var payloadBytes = Math.Max(1, body.Length / 2);
            var json =
                "{" +
                "\"schema\":\"gamebuddy-player-release-manifest/v1\"," +
                $"\"version\":\"{version}\"," +
                "\"repository\":\"zhexulong/gamebuddy\"," +
                $"\"downloadUrl\":\"https://github.com/zhexulong/gamebuddy/releases/download/v{version}/GameBuddy.Setup.exe\"," +
                "\"generation\":\"g-mw6k4d6g-31568-00000000000000000000000000000000\"," +
                $"\"inventoryDigest\":\"{new string('d', 64)}\"," +
                $"\"runtimeAdmissionSha256\":\"{new string('e', 64)}\"," +
                $"\"payload\":{{\"sha256\":\"{new string('b', 64)}\",\"bytes\":{payloadBytes}}}," +
                "\"configuration\":\"Debug\"," +
                $"\"installer\":{{\"file\":\"GameBuddy.Setup.exe\",\"bytes\":{body.Length},\"sha256\":\"{digest}\"}}," +
                "\"signature\":{\"required\":false,\"scheme\":\"none\",\"thumbprint\":null}" +
                "}";
            var path = System.IO.Path.Combine(Path, "release-manifest.json");
            File.WriteAllText(path, json);
            return path;
        }

        internal string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
    }
}
