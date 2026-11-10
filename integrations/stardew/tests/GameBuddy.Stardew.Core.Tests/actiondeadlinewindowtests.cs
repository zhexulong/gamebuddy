using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// One number, two parties: the deadline a sender writes into `execution_request` and the window this Mod admits.
///
/// <para>
/// Measured 2026-11-10: `node tools/live-action.mjs --action fish_here` was refused
/// `bridge_rejected:invalid_deadline` after 13.7 s. The runner had written 120 s; `fish_here` publishes a 60 s
/// window. Nothing compared the two numbers, so the disagreement was only ever visible as a refusal that named
/// neither side's value.
/// </para>
/// <para>
/// These pin the RECEIVER's half: the window is the action's own published watchdog, computed in exactly one place,
/// and an action the catalog does not carry is still bounded. The senders' half is held by
/// `tools/check-action-deadline-agreement.mjs`, which reads <c>action-deadline-windows.v1.json</c> - this same
/// declaration's export - against every gate runner's declared deadline.
/// </para>
/// </summary>
public sealed class ActionDeadlineWindowTests
{
    [Fact]
    public void EveryRegisteredActionsWindowIsItsOwnPublishedWatchdog()
    {
        IReadOnlyList<FarmhandActionDeadlineWindow> windows = FarmhandActionDeadlineAdmission.Windows();

        windows.Should().HaveSameCount(FarmhandActionCatalog.Registrations);
        windows.Select(window => window.ActionId)
            .Should().Equal(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId));
        foreach (FarmhandActionDeadlineWindow window in windows)
        {
            FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
                .Single(registration => registration.ActionId == window.ActionId)
                .Descriptor
                ?? throw new InvalidOperationException("Every catalog registration carries a descriptor.");
            window.AdmittedMs.Should().Be(descriptor.WatchdogMs, $"{window.ActionId} is bounded by its own watchdog");
            window.AdmittedMs.Should().BePositive();
        }
    }

    /// <summary>
    /// The windows are not one constant wearing 105 names: an action whose engine work outlives a minute publishes a
    /// longer watchdog, and this file's admission has to follow it. `sleep` is the cross-day lifecycle, which waits on
    /// the other players, the save and the day start.
    /// </summary>
    [Fact]
    public void AWindowThatOutlivesTheOrdinaryCeilingFollowsTheAction()
    {
        FarmhandActionDeadlineAdmission.WindowMs("sleep")
            .Should().Be(FarmhandActionCatalog.LifecycleWatchdogMs);
        FarmhandActionDeadlineAdmission.WindowMs("fish_here")
            .Should().Be(FarmhandActionCatalog.DefaultWatchdogMs);
        FarmhandActionCatalog.LifecycleWatchdogMs
            .Should().BeGreaterThan(FarmhandActionDeadlineAdmission.WindowMs("fish_here"));
    }

    [Fact]
    public void AnActionTheCatalogDoesNotCarryIsStillBounded()
    {
        FarmhandActionDeadlineAdmission.WindowMs("no_such_action").Should().Be(FarmhandActionDeadlineAdmission.UnpublishedActionWindowMs);
        FarmhandActionDeadlineAdmission.WindowMs(null).Should().Be(FarmhandActionDeadlineAdmission.UnpublishedActionWindowMs);
        FarmhandActionDeadlineAdmission.UnpublishedActionWindowMs
            .Should().Be(FarmhandActionCatalog.OrdinaryActionCeilingMs);
    }

    /// <summary>
    /// The export a sender outside this assembly reads must name the same number the receiver admits - that is the
    /// whole point of publishing it. A projection that dropped or re-derived the value would send every runner back to
    /// a number of its own.
    /// </summary>
    [Fact]
    public void TheExportCarriesTheAdmittedWindowForEveryAction()
    {
        FarmhandActionDeadlineWindowArtifact artifact = FarmhandActionDeadlineWindowExport.CreateArtifact();

        artifact.Schema.Should().Be(FarmhandActionDeadlineWindowExport.Schema);
        artifact.CatalogRevision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        artifact.Windows.Should().HaveSameCount(FarmhandActionCatalog.Registrations);
        foreach (FarmhandActionDeadlineWindow window in artifact.Windows)
            window.AdmittedMs.Should().Be(FarmhandActionDeadlineAdmission.WindowMs(window.ActionId));
    }
}
