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
    public async Task A_parked_root_that_is_not_complete_is_refused_by_name_instead_of_being_restored()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var activeBytes = File.ReadAllBytes(database);
        var recordBefore = File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));

        // She was set aside while her own first launch was still unfinished. The Host publishes an
        // authority by writing the completion marker LAST, so a root that never reached it is not
        // an authority any Host will open - it is the leftover of a run that died. Restoring it
        // would put it in front of the session-mode decision, which reads an absent marker as
        // `fresh`, and `fresh` is the one mount that DISCARDS a leftover root. This is the whole
        // reason a restored root must be checked before it is moved, not after.
        const string directoryName = "20260101T000000Z-companion-target";
        CompanionSwitch.WriteParkedForTesting(
            layout,
            [new ParkedCompanion("companion-target", "continuity-target", first.PlayerId, "bootstrap-target", 1, directoryName)]);
        var parkedRoot = CompanionSwitch.ParkedRootPath(layout, directoryName);
        Directory.CreateDirectory(parkedRoot);
        var parkedDatabase = Path.Combine(parkedRoot, TestProductionAuthority.DatabaseFileName);
        File.WriteAllText(parkedDatabase, "unfinished-first-bootstrap");
        var parkedBytes = File.ReadAllBytes(parkedDatabase);

        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        var outcome = CompanionSwitch.ApplyPending(layout);

        // Refused by name, before anything moved: she is not mounted, and her authority is still
        // the one in play, byte-identical and complete.
        Assert.Equal(CompanionSwitchStatus.Refused, outcome.Status);
        Assert.Equal("companion_switch_target_authority_incomplete", outcome.Code);
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.Equal(recordBefore, File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.Equal(activeBytes, File.ReadAllBytes(database));

        // Her unfinished root is still parked, byte for byte, and still named by the index: the
        // switch refused to mount it, and it did not drop the fact that she has a root there.
        Assert.Equal(parkedBytes, File.ReadAllBytes(parkedDatabase));
        Assert.Equal("companion-target", Assert.Single(CompanionSwitch.ReadParked(layout)).CompanionId);
    }

    [Fact]
    public async Task A_crash_that_left_an_incomplete_root_in_the_park_is_not_restored_into_the_mount_position()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);

        // The state step 6 of a switch leaves when it dies before step 7: the identity record
        // already names the target and the active position is empty, so `Reconcile` is what puts
        // her root there. If that root is unfinished, restoring it is the same discard the switch
        // refuses - the two seams answer one rule, not two.
        DeploymentIdentity.ReplaceActive(
            layout,
            new DeploymentIdentityValues("continuity-target", "companion-target", first.PlayerId, "bootstrap-target", 1));
        const string directoryName = "20260101T000000Z-companion-target";
        CompanionSwitch.WriteParkedForTesting(
            layout,
            [new ParkedCompanion("companion-target", "continuity-target", first.PlayerId, "bootstrap-target", 1, directoryName)]);
        var parkedRoot = CompanionSwitch.ParkedRootPath(layout, directoryName);
        Directory.CreateDirectory(parkedRoot);
        var parkedDatabase = Path.Combine(parkedRoot, TestProductionAuthority.DatabaseFileName);
        File.WriteAllText(parkedDatabase, "unfinished-first-bootstrap");
        var parkedBytes = File.ReadAllBytes(parkedDatabase);

        CompanionSwitch.Reconcile(layout);

        // Nothing was mounted: the mount position is still empty and her root is still parked,
        // still named. `fresh` is not asked for on her behalf either - the launcher deletes no
        // authority and moves none it cannot vouch for.
        Assert.False(Directory.Exists(ProductionAuthority.DirectoryPath(layout)));
        Assert.Equal(parkedBytes, File.ReadAllBytes(parkedDatabase));
        Assert.Equal("companion-target", Assert.Single(CompanionSwitch.ReadParked(layout)).CompanionId);
    }

    [Fact]
    public async Task A_request_that_cannot_be_removed_is_answered_the_same_way_next_launch_and_never_applied_twice()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var bytesBefore = File.ReadAllBytes(database);

        // Spending the request is the switch's last step and it can fail. A read-only request is
        // the reproducible stand-in for that (the real one is a sharing violation while something
        // else has the file open), and it is what makes the launcher's silence about the failure a
        // claim that has to hold rather than one that is assumed to.
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        File.SetAttributes(CompanionSwitch.RequestPath(layout), FileAttributes.ReadOnly);

        var settled = CompanionSwitch.ApplyPending(layout);

        // The switch happened: a request that outlived its own answer is not a second failure.
        Assert.Equal(CompanionSwitchStatus.Switched, settled.Status);
        Assert.True(CompanionSwitch.HasPendingRequest(layout));
        Assert.Equal("companion-target", DeploymentIdentity.ReadActive(layout).CompanionId);

        // The next launch re-reads the same request and lands on the same answer from the identity
        // record, and it applies nothing twice - neither a second switch nor a second park - so a
        // failed delete cannot turn one choice into two operations.
        var recordAfter = File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));
        var parkedAfter = CompanionSwitch.ReadParked(layout);
        var again = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Switched, again.Status);
        Assert.Equal("companion-target", again.ActiveCompanionId);
        Assert.Equal(recordAfter, File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));
        Assert.Equal(parkedAfter, CompanionSwitch.ReadParked(layout));
        Assert.Equal(
            bytesBefore,
            File.ReadAllBytes(Path.Combine(
                CompanionSwitch.ParkedRootPath(layout, Assert.Single(parkedAfter).DirectoryName),
                TestProductionAuthority.DatabaseFileName)));
        Assert.True(CompanionSwitch.HasPendingRequest(layout));

        // The fixture deletes the tree it made, and a read-only file outlives that on Windows:
        // the attribute this case set is put back so the cleanup is not the thing that fails.
        File.SetAttributes(CompanionSwitch.RequestPath(layout), FileAttributes.Normal);
    }

    [Fact]
    public async Task A_host_that_still_holds_the_authority_refuses_the_switch_by_name_and_no_root_is_touched()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var recordBefore = File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");

        // The one predecessor this operation has: a Host from a launch that was killed instead of
        // quit. Its SQLite connection is exactly what the park would collide with, and exactly what
        // this open handle stands in for. Before this check the move failed as a sharing violation,
        // rolled back, and ended the launch with a code that said nothing about the Host.
        using (new FileStream(database, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
        {
            var outcome = CompanionSwitch.ApplyPendingForTesting(
                layout,
                DateTimeOffset.UtcNow,
                _ => { },
                TimeSpan.FromMilliseconds(250));

            Assert.Equal(CompanionSwitchStatus.Refused, outcome.Status);
            Assert.Equal("companion_switch_host_still_running", outcome.Code);
            Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
            Assert.Equal(recordBefore, File.ReadAllBytes(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));
            Assert.True(ProductionAuthority.IsComplete(layout));
            Assert.Empty(CompanionSwitch.ReadParked(layout));
            Assert.False(Directory.Exists(CompanionSwitch.ParkedDirectoryPath(layout)));
        }
    }

    [Fact]
    public async Task A_refusal_about_a_moment_keeps_the_players_request_for_the_next_launch()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");

        // A Host that is still leaving is a moment, not a state: this launch is inside it and the
        // next one is not. Spending the player's request here would make her ask a second time for
        // something that was already on its way - and nothing tells her to, so she would not.
        using (new FileStream(database, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
        {
            var refused = CompanionSwitch.ApplyPendingForTesting(
                layout,
                DateTimeOffset.UtcNow,
                _ => { },
                TimeSpan.FromMilliseconds(250));

            Assert.Equal(CompanionSwitchStatus.Refused, refused.Status);
            Assert.Equal("companion_switch_host_still_running", refused.Code);
            Assert.Equal(CompanionSwitchRefusalLifetime.Transient, refused.Lifetime);
            Assert.True(CompanionSwitch.HasPendingRequest(layout));
        }

        // The relaunch the player would make anyway applies the choice she already made: the same
        // request, the same facts, and now a Host that has gone.
        var applied = CompanionSwitch.ApplyPending(layout);

        Assert.Equal(CompanionSwitchStatus.Switched, applied.Status);
        Assert.Equal("companion-target", applied.ActiveCompanionId);
        Assert.False(CompanionSwitch.HasPendingRequest(layout));
    }

    [Fact]
    public async Task A_host_that_is_already_leaving_is_waited_for_instead_of_refusing_the_players_choice()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);

        // A child that was killed is normally reclaiming, not wedged: it releases its handles well
        // inside the ceiling. Waiting for that is the difference between a bound and a refusal -
        // the player's choice is applied instead of being spent on a race with a process that was
        // already on its way out.
        var leaving = new FileStream(database, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        _ = Task.Run(async () =>
        {
            await Task.Delay(300).ConfigureAwait(false);
            leaving.Dispose();
        });

        var outcome = CompanionSwitch.ApplyPendingForTesting(
            layout,
            DateTimeOffset.UtcNow,
            _ => { },
            TimeSpan.FromSeconds(30));

        Assert.Equal(CompanionSwitchStatus.Switched, outcome.Status);
        Assert.Equal("companion-target", DeploymentIdentity.ReadActive(layout).CompanionId);
    }

    [Fact]
    public async Task A_park_that_never_happened_does_not_block_her_from_ever_coming_back()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var first = MintedIdentity(layout);
        TestProductionAuthority.CreateDirectory(layout);
        var database = TestProductionAuthority.WriteDatabase(layout);
        TestProductionAuthority.WriteCompletionMarker(layout);
        var bytesBefore = File.ReadAllBytes(database);

        // The window step 3 opens and no later step closes: the index already names her park, and
        // step 5 never moved her. Her authority is still in the active position and the identity
        // record still names her, so the entry describes a park that did not happen - a claim the
        // two facts the launcher owns refute, not a missing directory to shrug at.
        CompanionSwitch.WriteParkedForTesting(
            layout,
            [new ParkedCompanion(first.CompanionId, first.ContinuityId, first.PlayerId, first.BootstrapOperationId, 1, "20260101T000000Z-companion-park")]);
        Assert.False(Directory.Exists(CompanionSwitch.ParkedRootPath(layout, "20260101T000000Z-companion-park")));

        // The player's next launch asks for the other companion, and then asks for her again.
        WriteRequest(layout, first.CompanionId, "companion-target", "continuity-target");
        Assert.Equal(CompanionSwitchStatus.Switched, CompanionSwitch.ApplyPending(layout).Status);

        // She was set aside for real this time, under a name of her own - and the index carries
        // exactly one entry for her, whose directory is there.
        var parked = CompanionSwitch.ReadParked(layout);
        Assert.Equal(first.CompanionId, Assert.Single(parked).CompanionId);
        Assert.True(Directory.Exists(CompanionSwitch.ParkedRootPath(layout, parked[0].DirectoryName)));

        WriteRequest(layout, "companion-target", first.CompanionId, first.ContinuityId);
        Assert.Equal(CompanionSwitchStatus.Switched, CompanionSwitch.ApplyPending(layout).Status);

        // She is back with her authority byte-identical: the phantom entry that would have answered
        // `companion_switch_unavailable` for her forever never got to.
        Assert.Equal(first.CompanionId, DeploymentIdentity.ReadActive(layout).CompanionId);
        Assert.Equal(bytesBefore, File.ReadAllBytes(database));
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.Empty(CompanionSwitch.ReadParked(layout));
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

        // A stale request is refused by the state itself: every later launch would compare the same
        // record against the same identity and answer identically, so it is spent and the request
        // is gone rather than left to refuse forever.
        Assert.Equal(CompanionSwitchRefusalLifetime.Permanent, outcome.Lifetime);
        Assert.False(CompanionSwitch.HasPendingRequest(layout));
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
        // A finished root, because that is what a companion who played carries into the park and
        // the only kind a switch may move back.
        TestProductionAuthority.WriteCompleteRoot(CompanionSwitch.ParkedRootPath(layout, "20260101T000000Z-companion-second"));
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
