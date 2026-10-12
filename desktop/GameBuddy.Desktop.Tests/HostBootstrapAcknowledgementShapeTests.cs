using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Pins BOTH directions of the bootstrap acknowledgement's shape against a real child on the real
/// pipes: the field the launcher needs must be there and must say what it must, and a field beside
/// them must never be a reason to refuse a child that became ready.
///
/// The two sides of this handshake ship as separate generations. The child is the bundled Host of
/// the installed generation; the reader is this launcher, built and shipped on its own schedule. A
/// reader that demanded its own exact key set therefore failed the moment the Host published one
/// more field - an otherwise healthy child, refused by its own parent, with nothing on its standard
/// error to explain it. Everything below exists so that direction of skew is answered by the tests
/// instead of by a dead launch.
/// </summary>
public sealed class HostBootstrapAcknowledgementShapeTests
{
    private static readonly TimeSpan Silence = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The skew that stopped every launch: the field a newer child adds beside the acknowledged
    /// facts - the surface's own session entry, plus one field no version of this launcher has ever
    /// heard of - is ignored, and the acknowledgement decides.
    /// </summary>
    [Fact]
    public async Task An_acknowledgement_carrying_a_field_the_launcher_does_not_know_is_accepted()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            acknowledgementPlan: """{ "extra": { "sessionEntry": { "kind": "browser", "launchPath": "/", "bootFragmentKey": "boot" }, "fieldFromAFutureGeneration": 1 } }""",
            silenceTimeout: Silence);

        // The lease is the proof: it is only handed out for an accepted acknowledgement, so a
        // refused extra field ends this call with the launch failure instead.
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        // And the child really did write that field: this is the difference between a reader that
        // ignores an added field and a test whose child quietly dropped it.
        var applied = await AppliedAcknowledgementAsync(harness);
        Assert.Contains("\"sessionEntry\"", applied, StringComparison.Ordinal);
        Assert.Contains("\"fieldFromAFutureGeneration\"", applied, StringComparison.Ordinal);

        harness.RequestHostExit();
        Assert.True(await lease.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    /// <summary>The other direction, unchanged by the fix: additive is not lenient.</summary>
    [Fact]
    public async Task An_acknowledgement_missing_a_required_field_is_refused()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // The child never says how its root layout is shaped, so the launcher cannot act on
            // the fact it claims to have established.
            acknowledgementPlan: """{ "omit": [ "rootLayoutSchema" ] }""",
            silenceTimeout: Silence);

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal("host_runtime_unavailable", failure.Category);
        // The frame that was refused really was missing that field, so what failed the launch is
        // the shape this test planted and not something else on the way in.
        Assert.DoesNotContain("rootLayoutSchema", await AppliedAcknowledgementAsync(harness), StringComparison.Ordinal);
    }

    /// <summary>And nor is it untyped: a required field that is not the value it must be is refused.</summary>
    [Fact]
    public async Task An_acknowledgement_whose_required_field_has_the_wrong_type_is_refused()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            acknowledgementPlan: """{ "rewrite": { "protocolVersion": "1" } }""",
            silenceTimeout: Silence);

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal("host_runtime_unavailable", failure.Category);
        Assert.Contains("\"protocolVersion\":\"1\"", await AppliedAcknowledgementAsync(harness), StringComparison.Ordinal);
    }

    /// <summary>
    /// The acknowledgement the child itself says it wrote. It is written before the frame, so it is
    /// there whether the launcher accepted or refused it.
    /// </summary>
    private static async Task<string> AppliedAcknowledgementAsync(BootstrapHandshakeHarness harness) =>
        await File.ReadAllTextAsync(Path.Combine(harness.Layout.DataRoot, "desktop-host-runtime-fixture.ack.applied"));
}
