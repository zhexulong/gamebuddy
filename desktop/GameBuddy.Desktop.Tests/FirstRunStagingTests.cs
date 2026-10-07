using System.Text;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher-owned first-run staging marker. The deployment identity says who the
/// installation is; the physical completeness of the durable authority
/// (<see cref="SessionModeDecisionTests"/>) says whether the run that minted it ever
/// finished. The marker records that a mint was staged: it is written before the durable
/// identity record and cleared once that intent is spent, and nothing decides on it.
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
        // this state would be a mint that left no record of having been attempted.
        Directory.CreateDirectory(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName));
        Assert.Throws<DeploymentIdentityMintUnavailableException>(() => DeploymentIdentity.EstablishForCurrentUser(layout));

        Assert.True(File.Exists(FirstRunStaging.MarkerPath(layout)));
        Assert.False(File.Exists(Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName)));
    }

    [Fact]
    public async Task A_crash_during_the_marker_write_still_leaves_a_marker_a_later_mint_leaves_alone()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        var markerPath = FirstRunStaging.MarkerPath(layout);

        // The only shape a crash can leave is a partial document, and presence - not content -
        // is still the fact the file records: a zero-length or half-written marker is the
        // staging fact of the run that wrote it, and a later mint must record its intent over
        // it rather than fail because that directory entry is already taken.
        foreach (var partial in new[]
        {
            Array.Empty<byte>(),
            Encoding.UTF8.GetBytes("{\"schemaVersion\":\"gamebuddy-deployment-first"),
        })
        {
            File.WriteAllBytes(markerPath, partial);

            // The create loses to the marker that is already there, and the partial document is
            // left exactly as it is: it is the earlier run's fact, not this launch's.
            FirstRunStaging.MarkIncomplete(layout);
            Assert.Equal(partial, File.ReadAllBytes(markerPath));
        }

        // The whole identity step over such a marker: it mints rather than refusing, and the
        // partial marker survives the mint untouched.
        var truncated = Encoding.UTF8.GetBytes("{\"schemaVersion\":\"gamebuddy-deployment-first");
        File.WriteAllBytes(markerPath, truncated);
        Assert.True(DeploymentIdentity.EstablishForCurrentUser(layout));
        Assert.Equal(truncated, File.ReadAllBytes(markerPath));

        // Clearing is terminal for the run whose intent is spent: no marker, and clearing an
        // absent marker is not an event either.
        FirstRunStaging.Clear(layout);
        Assert.False(File.Exists(markerPath));
        FirstRunStaging.Clear(layout);
        Assert.False(File.Exists(markerPath));
    }

    [Fact]
    public void The_marker_is_a_record_and_no_longer_decides_the_session_mode()
    {
        var sources = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop"));

        // The decision is the physical completeness of the durable authority, so no production
        // source may ask the marker whether this launch is a first run any more: the readers
        // that did - `IsFirstRun` and `IsFirstRunIncomplete` - are gone, and the marker is
        // written, cleared and never consulted. This is the failure the change removes: a
        // marker that can force `fresh` over an authority that exists strands the machine.
        foreach (var source in Directory.EnumerateFiles(sources, "*.cs", SearchOption.TopDirectoryOnly))
        {
            Assert.DoesNotContain("IsFirstRun", File.ReadAllText(source), StringComparison.Ordinal);
        }
    }
}
