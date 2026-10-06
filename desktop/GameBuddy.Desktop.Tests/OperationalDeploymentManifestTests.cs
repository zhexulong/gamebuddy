using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The operational deployment manifest step. The launcher only refuses: it accepts
/// an exact Host-owned manifest and leaves it byte-for-byte untouched, and an absent
/// or unusable manifest fails closed with its own outcome. It never creates, writes
/// or repairs the file, because the manifest's principal, bootstrap operation and
/// authority generation are the deployment's semantic identity and bootstrap does
/// not own that decision.
/// </summary>
public sealed class OperationalDeploymentManifestTests
{
    [Fact]
    public async Task Require_accepts_the_exact_manifest_schema_the_Host_writes()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var path = TestDeploymentManifest.WriteDeploymentManifest(layout.OperationalRoot);
        var written = File.ReadAllBytes(path);

        OperationalDeploymentManifest.Require(layout);

        // Left exactly as it is: the launcher is not the manifest's author.
        Assert.Equal(written, File.ReadAllBytes(path));
        Assert.Single(Directory.EnumerateFiles(layout.OperationalRoot));
    }

    [Fact]
    public async Task Require_fails_closed_when_the_manifest_is_absent_and_writes_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.False(File.Exists(Path.Combine(layout.OperationalRoot, "deployment-manifest.json")));
        Assert.Throws<DeploymentIdentityUnavailableException>(() => OperationalDeploymentManifest.Require(layout));

        // Refusing is all it does: it does not write a replacement.
        Assert.Empty(Directory.EnumerateFileSystemEntries(layout.OperationalRoot));
    }

    [Fact]
    public async Task Require_fails_closed_when_a_directory_stands_where_the_manifest_belongs_and_leaves_it()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var occupied = Path.Combine(layout.OperationalRoot, "deployment-manifest.json");
        Directory.CreateDirectory(occupied);
        File.WriteAllText(Path.Combine(occupied, "sentinel"), "untouched");

        Assert.Throws<DeploymentIdentityUnavailableException>(() => OperationalDeploymentManifest.Require(layout));

        // Refused, never replaced or adopted.
        Assert.Equal("untouched", File.ReadAllText(Path.Combine(occupied, "sentinel")));
    }

    [Fact]
    public async Task Require_accepts_the_Host_manifest_and_rejects_each_deviation()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var runtimeRoot = Path.Combine(fixture.LocalApplicationData, "GameBuddy", "data");

        // Absent first, so the same step is proven to refuse before it accepts.
        Assert.Throws<DeploymentIdentityUnavailableException>(() => OperationalDeploymentManifest.Require(layout));

        var accepted = new ManifestBuilder(runtimeRoot);
        accepted.Write(layout.OperationalRoot);
        OperationalDeploymentManifest.Require(layout);

        var rejected = new (string Name, ManifestBuilder Builder)[]
        {
            ("schema version", new ManifestBuilder(runtimeRoot).With("schemaVersion", 1)),
            ("schema version absent", new ManifestBuilder(runtimeRoot).Without("schemaVersion")),
            ("topology literal", new ManifestBuilder(runtimeRoot).With("topology", "independent_surfaces")),
            ("extra top-level key", new ManifestBuilder(runtimeRoot).With("rootLayout", "x")),
            ("missing top-level key", new ManifestBuilder(runtimeRoot).Without("bootstrapOperationId")),
            ("extra principal key", new ManifestBuilder(runtimeRoot).WithPrincipal("saveId", "save_01")),
            ("missing principal key", new ManifestBuilder(runtimeRoot).WithoutPrincipal("playerId")),
            ("principal identifier shape", new ManifestBuilder(runtimeRoot).WithPrincipal("continuityId", "not a bounded id")),
            ("empty principal identifier", new ManifestBuilder(runtimeRoot).WithPrincipal("companionId", "")),
            ("bootstrap operation identifier", new ManifestBuilder(runtimeRoot).With("bootstrapOperationId", "bootstrap.operation")),
            ("authority generation zero", new ManifestBuilder(runtimeRoot).With("authorityGeneration", 0)),
            ("authority generation non-numeric", new ManifestBuilder(runtimeRoot).With("authorityGeneration", "1")),
            ("relative runtime root", new ManifestBuilder(runtimeRoot).With("runtimeRoot", "data")),
            ("absent runtime root directory", new ManifestBuilder(runtimeRoot).With("runtimeRoot", Path.Combine(runtimeRoot, "missing"))),
        };

        foreach (var (name, builder) in rejected)
        {
            builder.Write(layout.OperationalRoot);
            Assert.Throws<DeploymentIdentityUnavailableException>(() => OperationalDeploymentManifest.Require(layout));
            Assert.False(string.IsNullOrEmpty(name));
        }
    }

    private sealed class ManifestBuilder(string runtimeRoot)
    {
        private readonly Dictionary<string, object?> value = new(StringComparer.Ordinal)
        {
            ["schemaVersion"] = 2,
            ["topology"] = "independent_chat_and_game_surfaces",
            ["runtimeRoot"] = runtimeRoot,
            ["principal"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["continuityId"] = "continuity_01",
                ["companionId"] = "companion_01",
                ["playerId"] = "player_01",
            },
            ["bootstrapOperationId"] = "bootstrap_01",
            ["authorityGeneration"] = 1,
        };

        private Dictionary<string, object?> Principal => (Dictionary<string, object?>)value["principal"]!;

        internal ManifestBuilder With(string key, object? newValue)
        {
            value[key] = newValue;
            return this;
        }

        internal ManifestBuilder Without(string key)
        {
            value.Remove(key);
            return this;
        }

        internal ManifestBuilder WithPrincipal(string key, object? newValue)
        {
            Principal[key] = newValue;
            return this;
        }

        internal ManifestBuilder WithoutPrincipal(string key)
        {
            Principal.Remove(key);
            return this;
        }

        internal void Write(string operationalRoot)
        {
            Directory.CreateDirectory(operationalRoot);
            File.WriteAllText(
                Path.Combine(operationalRoot, "deployment-manifest.json"),
                JsonSerializer.Serialize(value) + "\n");
        }
    }
}
