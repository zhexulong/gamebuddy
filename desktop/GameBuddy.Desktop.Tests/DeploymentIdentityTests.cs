using System.Globalization;
using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher's deployment-identity step. The identity is a durable fact beside
/// the authority: the operational manifest is only its projection, so a launch
/// materializes it from the durable record rather than minting a second identity,
/// a disagreement fails closed with neither file touched, and the one mint happens
/// exactly once per installation - including across the uninstall/reinstall cycle,
/// which removes the disposable roots and preserves durable data.
/// </summary>
public sealed class DeploymentIdentityTests
{
    [Fact]
    public async Task Establish_mints_the_identity_once_when_neither_the_record_nor_the_manifest_exists()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var manifestPath = ManifestPath(layout);
        var recordPath = RecordPath(layout);
        Assert.False(File.Exists(manifestPath));
        Assert.False(File.Exists(recordPath));

        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));

        // The manifest exists and is one the launcher's own reader accepts, so the
        // admitted Host child will load it.
        Assert.True(File.Exists(manifestPath));
        OperationalDeploymentManifest.Require(layout);

        // The record carries the same five values, and each root holds exactly the
        // one file this step owns.
        Assert.Single(Directory.EnumerateFileSystemEntries(layout.OperationalRoot));
        Assert.Single(Directory.EnumerateFileSystemEntries(layout.DataRoot));
        Assert.Equal(ReadManifestIdentity(manifestPath), ReadRecordIdentity(recordPath));
        Assert.Equal(layout.DataRoot, ManifestRuntimeRoot(manifestPath));

        // And the mint happened once: the same step in the same state mints nothing.
        Assert.False(DeploymentIdentity.EstablishForCurrentUser(layout));
        Assert.Single(Directory.EnumerateFileSystemEntries(layout.DataRoot));
    }

    [Fact]
    public async Task Establish_materializes_the_manifest_from_the_durable_record_when_the_manifest_is_absent()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // Mint once, then destroy the projection the way removing the disposable
        // roots does, so the durable record is the only surviving authority.
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var minted = ReadManifestIdentity(ManifestPath(layout));
        var recordBefore = File.ReadAllBytes(RecordPath(layout));
        Directory.Delete(layout.OperationalRoot, recursive: true);
        Directory.CreateDirectory(layout.OperationalRoot);

        Assert.False(DeploymentIdentity.EstablishForCurrentUser(layout));

        // Materialized, not minted: the projection carries the record's identity, the
        // record is untouched, and the launcher's own reader accepts the projection.
        Assert.Equal(minted, ReadManifestIdentity(ManifestPath(layout)));
        Assert.Equal(recordBefore, File.ReadAllBytes(RecordPath(layout)));
        OperationalDeploymentManifest.Require(layout);
    }

    [Fact]
    public async Task Establish_fails_closed_on_a_disagreement_and_overwrites_neither_file()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var manifestPath = ManifestPath(layout);
        var recordPath = RecordPath(layout);

        // The same five values except the companion: a durable record that names a
        // different identity now sits beside the manifest that names the minted one.
        var identity = ReadRecordIdentity(recordPath);
        WriteRecord(recordPath, [identity[0], "other-companion", identity[2], identity[3], identity[4]]);
        var manifestBefore = File.ReadAllBytes(manifestPath);
        var recordBefore = File.ReadAllBytes(recordPath);

        Assert.Throws<DeploymentIdentityConflictException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));

        // Neither side is overwritten, and neither is preferred: both are exactly
        // the bytes the conflicting pair had.
        Assert.Equal(manifestBefore, File.ReadAllBytes(manifestPath));
        Assert.Equal(recordBefore, File.ReadAllBytes(recordPath));
    }

    [Fact]
    public async Task Establish_fails_closed_on_an_unusable_durable_record_and_replaces_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var recordPath = RecordPath(layout);
        var manifestPath = ManifestPath(layout);

        // A record the product cannot read is not a missing one: it is refused as an
        // establishment failure, and no projection is written beside it, so a second
        // identity is never minted over an authority that may already exist.
        File.WriteAllBytes(recordPath, "{ not json"u8.ToArray());
        var unreadable = File.ReadAllBytes(recordPath);
        Assert.Throws<DeploymentIdentityEstablishUnavailableException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));
        Assert.Equal(unreadable, File.ReadAllBytes(recordPath));
        Assert.False(File.Exists(manifestPath));

        // A record that is valid JSON but not an exact record: same direction, and for
        // the same reason - it can never become a manifest any Host opens.
        WriteRecord(recordPath, ["continuity_01", "companion_01", "has spaces", "bootstrap_01", "1"]);
        var unusable = File.ReadAllBytes(recordPath);
        Assert.Throws<DeploymentIdentityEstablishUnavailableException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));
        Assert.Equal(unusable, File.ReadAllBytes(recordPath));
        Assert.False(File.Exists(manifestPath));

        // And an exact record missing one of the two formats' keys: refused too.
        File.WriteAllText(recordPath, "{\"schemaVersion\":\"" + DeploymentIdentity.RecordSchema + "\"}\n");
        var incomplete = File.ReadAllBytes(recordPath);
        Assert.Throws<DeploymentIdentityEstablishUnavailableException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));
        Assert.Equal(incomplete, File.ReadAllBytes(recordPath));
        Assert.False(File.Exists(manifestPath));
    }

    [Fact]
    public async Task An_existing_manifest_is_left_alone_and_needs_no_durable_record()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var manifestPath = TestDeploymentManifest.WriteDeploymentManifest(layout.OperationalRoot);
        var written = File.ReadAllBytes(manifestPath);

        // The manifest is the identity's existing authority, so this launch presents
        // it rather than establishing anything.
        Assert.False(DeploymentIdentity.EstablishForCurrentUser(layout));

        Assert.Equal(written, File.ReadAllBytes(manifestPath));
        Assert.False(File.Exists(RecordPath(layout)));
    }

    [Fact]
    public async Task The_second_launch_reports_known_and_presents_the_same_identity()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        var minted = DeploymentIdentity.EstablishForCurrentUser(layout);
        var manifestPath = ManifestPath(layout);
        var recordPath = RecordPath(layout);
        var manifestFirst = File.ReadAllBytes(manifestPath);
        var recordFirst = File.ReadAllBytes(recordPath);
        var identityFirst = ReadManifestIdentity(manifestPath);

        var later = DeploymentIdentity.EstablishForCurrentUser(layout);

        // The first launch mints and the later one does not, and the later one
        // presents the very same identity rather than a second one.
        Assert.True(minted);
        Assert.False(later);
        Assert.Equal(manifestFirst, File.ReadAllBytes(manifestPath));
        Assert.Equal(recordFirst, File.ReadAllBytes(recordPath));
        Assert.Equal(identityFirst, ReadManifestIdentity(manifestPath));

        // The step's answer is what the production entry turns into the Host session
        // mode, and only the minting answer may select `fresh`; every later launch
        // delivers `known` to the child so it opens the authority that exists.
        var known = RuntimeSupervisor.BuildBootstrapEnvironment(layout, new HostBootstrapEnvironmentOptions
        {
            GameSessionMode = HostBootstrapEnvironmentOptions.KnownGameSessionMode,
        });
        Assert.Contains("GAMEBUDDY_HOST_GAME_SESSION_MODE=known\0", known, StringComparison.Ordinal);
        Assert.DoesNotContain("GAMEBUDDY_HOST_GAME_SESSION_MODE=fresh", known, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_reinstall_presents_the_same_identity_instead_of_minting_a_second_one()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // The whole first launch: the launcher provisions the mutable roots, then
        // establishes the identity for them.
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var manifestPath = ManifestPath(layout);
        var recordPath = RecordPath(layout);
        var installed = ReadManifestIdentity(manifestPath);
        var record = File.ReadAllBytes(recordPath);

        // Uninstall: the disposable roots go and durable data stays, which is the
        // product's own preserve/purge policy.
        Directory.Delete(layout.OperationalRoot, recursive: true);
        Directory.Delete(layout.PresentationRoot, recursive: true);
        Assert.False(File.Exists(manifestPath));
        Assert.True(File.Exists(recordPath));

        // Reinstall, then the next launch's whole sequence over the surviving durable
        // authority: the same identity is presented, and no second one is minted.
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);
        Assert.False(DeploymentIdentity.EstablishForCurrentUser(layout));

        Assert.Equal(installed, ReadManifestIdentity(manifestPath));
        Assert.Equal(record, File.ReadAllBytes(recordPath));
    }

    [Fact]
    public async Task The_projection_is_an_exact_v2_manifest_of_five_identity_values()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));

        using var document = JsonDocument.Parse(File.ReadAllBytes(ManifestPath(layout)));
        var manifest = document.RootElement;
        // The closed Host schema and nothing else.
        Assert.Equal(
            OperationalDeploymentManifest.TopLevelKeys.OrderBy(name => name, StringComparer.Ordinal),
            manifest.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal(2, manifest.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("independent_chat_and_game_surfaces", manifest.GetProperty("topology").GetString());
        Assert.Equal(1, manifest.GetProperty("authorityGeneration").GetInt32());
        Assert.Equal(
            OperationalDeploymentManifest.PrincipalKeys.OrderBy(name => name, StringComparer.Ordinal),
            manifest.GetProperty("principal").EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal));

        // The deterministic minted shape: three independent bounded identifiers, one
        // stable bootstrap operation identifier, and authority generation 1.
        var identity = ReadManifestIdentity(ManifestPath(layout));
        Assert.StartsWith("continuity-", identity[0], StringComparison.Ordinal);
        Assert.StartsWith("companion-", identity[1], StringComparison.Ordinal);
        Assert.StartsWith("player-", identity[2], StringComparison.Ordinal);
        Assert.StartsWith("bootstrap-", identity[3], StringComparison.Ordinal);
        Assert.Equal("1", identity[4]);
        foreach (var value in identity[..4])
        {
            Assert.Matches("^[A-Za-z0-9_-]{1,128}$", value);
        }

        Assert.NotEqual(identity[0], identity[1]);
        Assert.NotEqual(identity[1], identity[2]);
    }

    private static string ManifestPath(CurrentUserRootLayout layout) =>
        Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName);

    private static string RecordPath(CurrentUserRootLayout layout) =>
        Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName);

    /// <summary>
    /// The five identity values a file carries, in one order both readers agree on:
    /// continuity, companion, player, bootstrap operation, authority generation.
    /// </summary>
    private static string[] ReadManifestIdentity(string manifestPath)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        var manifest = document.RootElement;
        var principal = manifest.GetProperty("principal");
        return
        [
            principal.GetProperty("continuityId").GetString()!,
            principal.GetProperty("companionId").GetString()!,
            principal.GetProperty("playerId").GetString()!,
            manifest.GetProperty("bootstrapOperationId").GetString()!,
            manifest.GetProperty("authorityGeneration").GetInt32().ToString(CultureInfo.InvariantCulture),
        ];
    }

    private static string[] ReadRecordIdentity(string recordPath)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(recordPath));
        var record = document.RootElement;
        return
        [
            record.GetProperty("continuityId").GetString()!,
            record.GetProperty("companionId").GetString()!,
            record.GetProperty("playerId").GetString()!,
            record.GetProperty("bootstrapOperationId").GetString()!,
            record.GetProperty("authorityGeneration").GetInt32().ToString(CultureInfo.InvariantCulture),
        ];
    }

    private static string ManifestRuntimeRoot(string manifestPath)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        return document.RootElement.GetProperty("runtimeRoot").GetString()!;
    }

    /// <summary>A durable identity record in the exact format the product writes.</summary>
    private static void WriteRecord(string recordPath, string[] identity)
    {
        var record = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["schemaVersion"] = DeploymentIdentity.RecordSchema,
            ["continuityId"] = identity[0],
            ["companionId"] = identity[1],
            ["playerId"] = identity[2],
            ["bootstrapOperationId"] = identity[3],
            ["authorityGeneration"] = int.Parse(identity[4], CultureInfo.InvariantCulture),
        };
        File.WriteAllText(recordPath, JsonSerializer.Serialize(record) + "\n");
    }
}
