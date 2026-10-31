using System.Text;
using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Switching which companion this installation plays, as the launcher performs it at the
/// next launch.
///
/// The model is the one the product can state without lying: one companion plays at a
/// time and the library holds the rest. What blocks a switch is NOT her conversations,
/// her Memory or her cabin binding - every one of those lives under a path derived from
/// her identity key, so a second companion's records sit beside the first's and are never
/// touched. The one thing that is singleton per installation is the semantic authority
/// root, because its database is bound to exactly one principal. So a switch parks the
/// authority root that is in play and puts the target's back, and everything else is
/// already where it belongs.
///
/// That is what makes the operation reversible rather than destructive, and why these
/// tests are written as a round trip first: switching away and back has to leave the
/// first companion's authority byte-identical, not merely present.
/// </summary>
public sealed class CompanionSwitchTests
{
    [Fact]
    public async Task Switching_away_and_back_leaves_the_first_companions_authority_byte_identical()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);

        // Her completed authority, written the way the Host's fresh path writes it.
        var firstRoot = TestProductionAuthority.CreateDirectory(layout);
        var firstDatabase = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var firstBytes = File.ReadAllBytes(firstDatabase);
        Assert.True(ProductionAuthority.IsComplete(layout));

        // --- switch away -------------------------------------------------------
        var targetContinuity = "continuity-target";
        WriteRequest(layout, first.CompanionId, "companion-target", targetContinuity);
        var away = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Switched, away.Status);
        Assert.Equal("companion-target", away.ActiveCompanionId);

        // Her root is GONE from the active path and parked under a name that says who and
        // when - never deleted, and never parked as "backup-1".
        Assert.False(Directory.Exists(firstRoot));
        var parked = CompanionSwitch.ReadParked(layout);
        var entry = Assert.Single(parked);
        Assert.Equal(first.CompanionId, entry.CompanionId);
        Assert.Equal(first.BootstrapOperationId, entry.BootstrapOperationId);
        Assert.StartsWith("2026", entry.DirectoryName, StringComparison.Ordinal);
        Assert.Contains(first.CompanionId, entry.DirectoryName, StringComparison.Ordinal);
        Assert.True(Directory.Exists(CompanionSwitch.ParkedRootPath(layout, entry.DirectoryName)));
        Assert.Equal(
            firstBytes,
            File.ReadAllBytes(Path.Combine(CompanionSwitch.ParkedRootPath(layout, entry.DirectoryName), TestProductionAuthority.DatabaseFileName)));

        // The identity record now names the target, with the target's own continuity and a
        // launcher-minted operation identifier: a first switch is a new baseline.
        var active = DeploymentIdentity.ReadActive(layout);
        Assert.Equal("companion-target", active.CompanionId);
        Assert.Equal(targetContinuity, active.ContinuityId);
        Assert.Equal(first.PlayerId, active.PlayerId);
        Assert.NotEqual(first.BootstrapOperationId, active.BootstrapOperationId);
        Assert.Equal(1, active.AuthorityGeneration);

        // The projection is gone so the launcher re-materializes it from the record: the
        // manifest is derived, never a second place the identity is written.
        Assert.False(File.Exists(Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName)));
        Assert.False(CompanionSwitch.HasPendingRequest(layout));

        // --- switch back -------------------------------------------------------
        WriteRequest(layout, "companion-target", first.CompanionId, first.ContinuityId);
        var back = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Switched, back.Status);
        Assert.Equal(first.CompanionId, back.ActiveCompanionId);
        Assert.True(Directory.Exists(firstRoot));
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.Equal(firstBytes, File.ReadAllBytes(firstDatabase));

        // Her recorded identity is restored verbatim - the same operation identifier and
        // generation the authority she carries was created with. A re-mint here would make
        // the Host refuse the root she still has.
        var restored = DeploymentIdentity.ReadActive(layout);
        Assert.Equal(first.CompanionId, restored.CompanionId);
        Assert.Equal(first.ContinuityId, restored.ContinuityId);
        Assert.Equal(first.BootstrapOperationId, restored.BootstrapOperationId);
        Assert.Equal(first.AuthorityGeneration, restored.AuthorityGeneration);

        // Nothing is left set aside: the target never played here, so she had no authority
        // root to park when she was replaced. A parked entry for a companion who never had
        // one would be a claim about data that does not exist.
        Assert.Empty(CompanionSwitch.ReadParked(layout));
        Assert.False(Directory.Exists(CompanionSwitch.ParkedRootPath(layout, entry.DirectoryName)));
    }

    [Fact]
    public async Task A_switch_that_cannot_restore_the_target_leaves_the_current_companion_current()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var recordBefore = File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));

        // A parked entry whose directory was removed out of band: the record promises a
        // root that is not there. The restore cannot complete, so nothing may change.
        CompanionSwitch.WriteParkedForTesting(
            layout,
            [
                new ParkedCompanion("companion-target", "continuity-target", first.PlayerId, "bootstrap-target", 1, "20260101T000000Z-companion-target"),
            ]);
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");

        var outcome = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Refused, outcome.Status);
        Assert.Equal("companion_switch_unavailable", outcome.Code);

        // Fail closed: the current companion is still the current companion, her authority
        // is still at the active path, and her identity record was never touched.
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.Equal(recordBefore, File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.False(Directory.EnumerateDirectories(CompanionSwitch.ParkedDirectoryPath(layout)).Any());
    }

    [Fact]
    public async Task A_request_written_against_another_active_companion_is_refused_as_stale_and_changes_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);

        // The surface read her as in play, then someone else changed the installation: the
        // request's compare-and-set no longer holds, so it must not be applied to whoever is
        // there now. This is the same bounded refusal every other companion write reports.
        WriteRequest(layout, "companion-someone-else", "companion-target", "continuity-target");
        var outcome = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Refused, outcome.Status);
        Assert.Equal("companion_switch_request_stale", outcome.Code);
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.True(ProductionAuthority.IsComplete(layout));
    }

    [Fact]
    public async Task A_settled_request_is_never_applied_a_second_time()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);

        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        Assert.Equal(CompanionSwitchStatus.Switched, CompanionSwitch.ApplyPending(layout).Status);

        // The settled record is the Host's to read and clear. Every launch between the
        // switch and that read must find nothing to do - otherwise a relaunch loop would
        // switch again and again from a record that already happened.
        Assert.Equal(CompanionSwitchStatus.None, CompanionSwitch.ApplyPending(layout).Status);
        Assert.Equal("companion-target", DeploymentIdentity.ReadActive(layout).CompanionId);
    }

    [Fact]
    public async Task An_unreadable_request_is_discarded_rather_than_left_to_refuse_every_future_launch()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);

        File.WriteAllText(CompanionSwitch.RequestPath(layout), "{\"schemaVersion\":\"not-ours\"}\n", new UTF8Encoding(false));
        var outcome = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Refused, outcome.Status);
        Assert.Equal("companion_switch_record_unreadable", outcome.Code);
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.False(CompanionSwitch.HasPendingRequest(layout));
        Assert.Equal(CompanionSwitchStatus.None, CompanionSwitch.ApplyPending(layout).Status);
    }

    [Fact]
    public async Task The_parked_directory_name_names_the_companion_and_the_moment()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);

        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        CompanionSwitch.ApplyPending(layout);

        var entry = Assert.Single(CompanionSwitch.ReadParked(layout));
        // `<utc instant>-<her durable identifier>`: a player or an operator reading the data
        // root can tell which companion this is and when she was set aside, without opening
        // anything. The instant is fixed-width UTC so the names sort by time.
        Assert.Matches("^[0-9]{8}T[0-9]{6}Z-companion-[A-Za-z0-9_-]+$", entry.DirectoryName);
        Assert.Equal(
            Path.Combine(layout.DataRoot, CompanionSwitch.ParkedDirectoryName, entry.DirectoryName),
            CompanionSwitch.ParkedRootPath(layout, entry.DirectoryName));
    }

    [Fact]
    public async Task A_fault_after_the_first_moves_rolls_every_step_back_and_she_is_still_playing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var bytesBefore = File.ReadAllBytes(database);
        var recordBefore = File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));
        var manifestBefore = File.ReadAllBytes(Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName));

        // A switch back to a companion who really was parked: the fault is injected at the move
        // that puts HER root in place, which is the last mutating step. Every step before it has
        // already run - the index entry, the projection's removal, the park, the identity write -
        // so the rollback is exercised where it actually matters and not in front of the first
        // mutation, where nothing needs undoing yet.
        CompanionSwitch.WriteParkedForTesting(
            layout,
            [new ParkedCompanion("companion-second", "continuity-second", first.PlayerId, "bootstrap-second", 1, "20260101T000000Z-companion-second")]);
        Directory.CreateDirectory(CompanionSwitch.ParkedRootPath(layout, "20260101T000000Z-companion-second"));
        WriteRequest(layout, first.CompanionId, "companion-second", "continuity-second");

        Assert.Throws<CompanionSwitchUnavailableException>(() =>
            CompanionSwitch.ApplyPendingForTesting(layout, DateTimeOffset.UtcNow, _ => throw new IOException("injected")));

        // Fail closed, and by undo rather than by luck: the identity record is the one it was,
        // her authority is back in the active position with the same bytes, and the projection
        // that the switch removed is back too.
        Assert.Equal(recordBefore, File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.True(Directory.Exists(ProductionAuthority.DirectoryPath(layout)));
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.Equal(bytesBefore, File.ReadAllBytes(database));
        Assert.Equal(manifestBefore, File.ReadAllBytes(Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName)));

        // The companion who was being switched to is still exactly as parked as she was, so the
        // player can retry the same switch instead of finding her gone.
        Assert.Equal("companion-second", Assert.Single(CompanionSwitch.ReadParked(layout)).CompanionId);
        Assert.True(Directory.Exists(CompanionSwitch.ParkedRootPath(layout, "20260101T000000Z-companion-second")));
    }

    private static DeploymentIdentityValues MintedIdentity(CurrentUserRootLayout layout)
    {
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        return DeploymentIdentity.ReadActive(layout);
    }

    /// <summary>
    /// The record the Host's own route writes: the companion it read as in play, and the
    /// companion the player chose. Nothing else - the launcher derives the rest, because
    /// the operation identifier it mints is the launcher's to mint.
    /// </summary>
    private static void WriteRequest(
        CurrentUserRootLayout layout,
        string expectedActiveCompanionId,
        string targetCompanionId,
        string targetContinuityId)
    {
        var record = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["schemaVersion"] = CompanionSwitch.RequestSchema,
            ["requestId"] = "request-01",
            ["status"] = "requested",
            ["expectedActiveCompanionId"] = expectedActiveCompanionId,
            ["targetCompanionId"] = targetCompanionId,
            ["targetContinuityId"] = targetContinuityId,
        };
        File.WriteAllText(
            CompanionSwitch.RequestPath(layout),
            JsonSerializer.Serialize(record) + "\n",
            new UTF8Encoding(false));
    }
}
