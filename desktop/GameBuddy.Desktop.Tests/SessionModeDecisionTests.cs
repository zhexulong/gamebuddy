using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher's session-mode decision. Its highest criterion is the physical completeness
/// of the durable authority - the completion marker the Host's fresh path writes last - and
/// not the launcher's own first-run staging marker: the marker cannot tell a first run that
/// never finished from one that finished and died before clearing its own record, and a
/// marker that can force `fresh` over an authority that exists strands the machine (every
/// later launch asks the Host to establish an authority it already has, and the Host refuses
/// it). Each test names the failure it catches.
/// </summary>
public sealed class SessionModeDecisionTests
{
    [Fact]
    public async Task A_complete_authority_with_a_leftover_staging_marker_is_known_and_heals_itself()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // The residual window: the launcher minted the identity and staged the mint, the Host
        // provisioned and finished the authority, and the process died after accepting the
        // acknowledgement but before it cleared its own marker. On the previous code every
        // later launch declares itself a first run, the Host refuses it with
        // `production_authority_artifact_present`, and only deleting the marker by hand
        // recovers the machine.
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var markerPath = FirstRunStaging.MarkerPath(layout);
        Assert.True(File.Exists(markerPath));
        var completionMarker = TestProductionAuthority.WriteCompletionMarker(layout);
        var completionMarkerBytes = File.ReadAllBytes(completionMarker);

        // This launch opens the authority it finds: the leftover marker is a ghost, and it is
        // cleared as part of the decision, so the machine heals itself with no manual step.
        var decision = SessionModeDecision.EstablishesAuthority(layout, mintedDeploymentIdentity: false);
        Assert.False(decision);
        Assert.False(File.Exists(markerPath));
        AssertChildMode(layout, decision, "known");

        // The decision clears the ghost and nothing else: the authority's own artifacts are
        // left byte-for-byte as they were.
        Assert.True(ProductionAuthority.IsComplete(layout));
        Assert.Equal(completionMarkerBytes, File.ReadAllBytes(completionMarker));
    }

    [Fact]
    public async Task An_identity_with_an_incomplete_authority_is_fresh_and_the_launcher_clears_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var markerPath = FirstRunStaging.MarkerPath(layout);
        var authorityRoot = ProductionAuthority.DirectoryPath(layout);

        // Shape one: the crash between the authority directory's creation and the database's.
        TestProductionAuthority.CreateDirectory(layout);
        AssertFreshAndUntouched();

        // Shape two: the crash after the database and before the completion marker.
        var databasePath = TestProductionAuthority.WriteDatabase(layout);
        var databaseBytes = File.ReadAllBytes(databasePath);
        AssertFreshAndUntouched();
        Assert.Equal(databaseBytes, File.ReadAllBytes(databasePath));

        // The discard is the Host's step on the `fresh` mount this decision asks for, and only
        // for a root the Host can prove incomplete. The launcher deletes no authority and does
        // not clear its own marker either: this launch still has to see the acknowledgement.
        void AssertFreshAndUntouched()
        {
            Assert.False(ProductionAuthority.IsComplete(layout));
            var decision = SessionModeDecision.EstablishesAuthority(layout, mintedDeploymentIdentity: false);
            Assert.True(decision);
            AssertChildMode(layout, decision, "fresh");
            Assert.True(Directory.Exists(authorityRoot));
            Assert.True(File.Exists(markerPath));
        }
    }

    [Fact]
    public async Task An_absent_identity_mints_and_is_fresh()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.False(ProductionAuthority.IsComplete(layout));
        Assert.False(File.Exists(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName)));

        var minted = DeploymentIdentity.EstablishForCurrentUser(layout);

        // A mint is the establishment of a new baseline by definition, and it staged its own
        // record of intent before the identity record existed.
        Assert.True(minted);
        var decision = SessionModeDecision.EstablishesAuthority(layout, minted);
        Assert.True(decision);
        AssertChildMode(layout, decision, "fresh");
        Assert.True(File.Exists(FirstRunStaging.MarkerPath(layout)));
        Assert.False(ProductionAuthority.IsComplete(layout));
    }

    [Fact]
    public async Task A_complete_authority_with_no_staging_marker_is_known()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // A completed first run: the identity exists, the Host finished the authority, and the
        // run that established it saw its acknowledgement and cleared its own marker.
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        FirstRunStaging.Clear(layout);
        var completionMarker = TestProductionAuthority.WriteCompletionMarker(layout);
        var markerPath = FirstRunStaging.MarkerPath(layout);
        Assert.False(File.Exists(markerPath));

        var decision = SessionModeDecision.EstablishesAuthority(layout, mintedDeploymentIdentity: false);
        Assert.False(decision);
        AssertChildMode(layout, decision, "known");

        // Nothing appears and nothing is cleared: this launch opens the authority.
        Assert.False(File.Exists(markerPath));
        Assert.True(File.Exists(completionMarker));
        Assert.True(ProductionAuthority.IsComplete(layout));
    }

    [Fact]
    public async Task A_mint_beside_a_complete_authority_is_still_fresh_so_a_new_identity_never_opens_another_baseline()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // The one state in which the two criteria disagree: an authority is complete but no
        // identity is left beside it. A mint establishes a new baseline by definition and
        // therefore wins. Presenting this new identity to an authority created for another one
        // could never open it, and the Host refuses that `fresh` mount outright instead of
        // adopting an authority the identity does not belong to, which is the fail-closed
        // direction this product keeps.
        var completionMarker = TestProductionAuthority.WriteCompletionMarker(layout);
        var minted = DeploymentIdentity.EstablishForCurrentUser(layout);

        Assert.True(minted);
        var decision = SessionModeDecision.EstablishesAuthority(layout, minted);
        Assert.True(decision);
        AssertChildMode(layout, decision, "fresh");

        // And nothing of that foreign authority is deleted on the way there.
        Assert.True(File.Exists(completionMarker));
        Assert.True(ProductionAuthority.IsComplete(layout));
    }

    /// <summary>
    /// The mode the decision stands for, in the child's own vocabulary: `fresh` has the Host
    /// establish the authority and `known` has it open the one that exists. The production
    /// entry's mapping of the decision onto this environment is pinned separately, by
    /// LauncherProvisioningWiringTests.
    /// </summary>
    private static void AssertChildMode(CurrentUserRootLayout layout, bool establishesAuthority, string expected)
    {
        var environment = RuntimeSupervisor.BuildBootstrapEnvironment(layout, new HostBootstrapEnvironmentOptions
        {
            GameSessionMode = establishesAuthority
                ? HostBootstrapEnvironmentOptions.FreshGameSessionMode
                : HostBootstrapEnvironmentOptions.KnownGameSessionMode,
        });
        Assert.Contains($"GAMEBUDDY_HOST_GAME_SESSION_MODE={expected}\0", environment, StringComparison.Ordinal);
    }
}
