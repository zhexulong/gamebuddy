using System.Text;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher-owned first-run staging marker. The deployment identity says who the
/// installation is; it cannot say whether the run that minted it ever finished, and the
/// two interrupted-first-launch failures come from exactly that gap. The marker closes
/// it: it is written before the durable identity record and cleared only when the run
/// that minted the identity has seen its Host acknowledge the bootstrap handshake, and
/// the mode decision reads it as the fact, not the identity's existence.
/// </summary>
public sealed class FirstRunStagingTests
{
    [Fact]
    public async Task The_marker_is_one_exact_versioned_document_beside_the_identity()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        var markerPath = FirstRunStaging.MarkerPath(layout);

        // Beside the durable identity record, under the launcher's own data root, which is
        // also the root the Host canonicalizes and opens the authority in.
        Assert.Equal(layout.DataRoot, Path.GetDirectoryName(markerPath));
        Assert.Equal(
            Encoding.UTF8.GetBytes($"{{\"schemaVersion\":\"{FirstRunStaging.MarkerSchema}\"}}\n"),
            File.ReadAllBytes(markerPath));
    }

    [Fact]
    public async Task The_marker_precedes_the_durable_record_so_a_crash_can_only_leave_it_present()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // The record cannot be created - a directory stands where it belongs - so the mint
        // does not happen. The marker must already be there: written the other way round,
        // this state would be an identity that no authority was ever created for, which is
        // the state with no in-product recovery.
        Directory.CreateDirectory(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));
        Assert.Throws<DeploymentIdentityMintUnavailableException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));

        Assert.True(FirstRunStaging.IsFirstRunIncomplete(layout));
        Assert.False(File.Exists(Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName)));
    }

    [Fact]
    public async Task A_crash_during_the_marker_write_still_leaves_a_present_marker()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var markerPath = FirstRunStaging.MarkerPath(layout);

        // The only shape a crash can leave is a partial document, and presence - not
        // content - is the fact: a zero-length or half-written marker still says the first
        // run is incomplete, so the next launch is still a first run.
        foreach (var partial in new[]
        {
            Array.Empty<byte>(),
            Encoding.UTF8.GetBytes("{\"schemaVersion\":\"gamebuddy-deployment-first"),
        })
        {
            File.WriteAllBytes(markerPath, partial);
            Assert.True(FirstRunStaging.IsFirstRunIncomplete(layout));
            Assert.True(FirstRunStaging.IsFirstRun(layout, mintedIdentity: false));
        }

        // Clearing is terminal for the run that completed: no marker, no first run.
        FirstRunStaging.MarkComplete(layout);
        Assert.False(FirstRunStaging.IsFirstRunIncomplete(layout));
        Assert.False(FirstRunStaging.IsFirstRun(layout, mintedIdentity: false));

        // And clearing a marker that is not there is not an event: a launch whose first
        // run never minted anything is not made a first run by the clear.
        FirstRunStaging.MarkComplete(layout);
        Assert.False(FirstRunStaging.IsFirstRun(layout, mintedIdentity: false));
    }

    [Fact]
    public async Task The_session_mode_decision_consults_the_marker_and_not_only_the_identity()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        // Identity absent: this launch mints, and the marker it just wrote says so.
        var minted = DeploymentIdentity.EstablishForCurrentUser(layout);
        Assert.True(minted);
        Assert.True(FirstRunStaging.IsFirstRun(layout, minted));

        // Identity present, marker present: the run that minted it never completed, so this
        // launch is still a first run. Reading the identity's existence alone would call it
        // `known` and open an authority that was never created.
        Assert.False(DeploymentIdentity.EstablishForCurrentUser(layout));
        var whileIncomplete = FirstRunStaging.IsFirstRun(layout, mintedIdentity: false);
        Assert.True(whileIncomplete);

        // Identity present, marker absent: the first run completed.
        FirstRunStaging.MarkComplete(layout);
        var afterCompletion = FirstRunStaging.IsFirstRun(layout, mintedIdentity: false);
        Assert.False(afterCompletion);

        // The mode the entry derives from those answers: `fresh` has the Host create the
        // authority, `known` has it open the one that exists.
        foreach (var (firstRun, expected) in new[] { (whileIncomplete, "fresh"), (afterCompletion, "known") })
        {
            var environment = RuntimeSupervisor.BuildBootstrapEnvironment(layout, new HostBootstrapEnvironmentOptions
            {
                GameSessionMode = firstRun
                    ? HostBootstrapEnvironmentOptions.FreshGameSessionMode
                    : HostBootstrapEnvironmentOptions.KnownGameSessionMode,
            });
            Assert.Contains($"GAMEBUDDY_HOST_GAME_SESSION_MODE={expected}\0", environment, StringComparison.Ordinal);
        }
    }
}
