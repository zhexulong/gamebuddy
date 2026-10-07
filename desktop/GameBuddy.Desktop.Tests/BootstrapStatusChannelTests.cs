using System.Diagnostics;
using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Guards the bootstrap status channel and the silence watch that replaced the whole-startup timer.
///
/// One binary signal plus a timer could not tell a child that is slow from one that is waiting for
/// its player from one that is wedged, and every launch failure in this area was reported as the
/// same thing. These tests drive the REAL launcher against a REAL child on the real pipes: the
/// child announces bounded stages, goes quiet on a schedule, says it is waiting for its player, or
/// writes a frame that is not what it claims to be, and the launcher has to answer differently
/// each time.
/// </summary>
public sealed class BootstrapStatusChannelTests
{
    private const string StatusSchema = "gamebuddy-desktop-host-bootstrap-status/v1";
    private static readonly TimeSpan Silence = TimeSpan.FromMilliseconds(400);

    /// <summary>One well-formed status frame, exactly as the child's own writer emits it.</summary>
    private static string Status(string stage, string? waitingForPlayerInput = null)
    {
        var frame = new Dictionary<string, object> { ["schema"] = StatusSchema, ["protocolVersion"] = 1, ["stage"] = stage };
        if (waitingForPlayerInput is not null) frame["waitingForPlayerInput"] = waitingForPlayerInput;
        return JsonSerializer.Serialize(frame);
    }

    [Fact]
    public async Task Status_frames_before_the_acknowledgement_are_dispatched_and_the_launch_still_succeeds()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        // Three informational frames - one of them a wait statement - before the acknowledgement.
        // A launcher that demanded exactly one frame, or that read the stream to its end, could not
        // get past these, so the lease below is the proof that they are dispatched and skipped.
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status("bootstrap-frame"), Status("provisioning"), Status("setup", "installation-folder-picker")], delayMs: 20),
            silenceTimeout: TimeSpan.FromSeconds(30));

        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        Assert.True(File.Exists(Path.Combine(harness.Layout.DataRoot, "desktop-host-runtime-fixture.ready")));
        harness.RequestHostExit();
        Assert.True(await lease.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task A_child_that_stops_announcing_anything_fails_with_the_silence_reason_and_reports_its_last_stage()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // Alive, healthy, and quiet: exactly the child whose ten silent minutes used to be
            // indistinguishable from a broken installation.
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status("provisioning")], holdMs: 60_000),
            silenceTimeout: Silence);

        var stopwatch = Stopwatch.StartNew();
        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));
        stopwatch.Stop();

        // Silence is its own reason, and it is the SILENCE that expired - not a whole-startup budget
        // that cannot tell the two apart.
        Assert.Equal(RuntimeSupervisor.BootstrapTimeoutCategory, failure.Category);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(15), $"the silence watch did not bound the wait: {stopwatch.Elapsed}");
        // And the operator reads where the child stopped, which is what the channel is for.
        Assert.NotNull(failure.Diagnostic);
        Assert.StartsWith("host_bootstrap_last_stage: provisioning", failure.Diagnostic!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_child_waiting_for_its_player_is_not_timed_out_for_being_quiet()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // Four silence intervals of quiet AFTER the child said it is waiting for its player: far
            // past the watch, and still not a reason to kill a child that is waiting for a human.
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status("setup", "installation-folder-picker")], holdMs: 1_600),
            silenceTimeout: Silence);

        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        harness.RequestHostExit();
        Assert.True(await lease.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task The_silence_watch_is_armed_again_by_the_next_frame_that_does_not_wait_for_the_player()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // The child waits for its player and then says it is working again. The quiet stretch
            // after THAT frame has to be watched: without the re-arm the acknowledgement below would
            // have arrived and this launch would have succeeded.
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status("setup", "installation-folder-picker"), Status("provisioning")], holdMs: 1_600),
            silenceTimeout: Silence);

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal(RuntimeSupervisor.BootstrapTimeoutCategory, failure.Category);
        Assert.NotNull(failure.Diagnostic);
        Assert.StartsWith("host_bootstrap_last_stage: provisioning", failure.Diagnostic!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_malformed_status_frame_is_refused_instead_of_being_passed_over_or_served()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // A stage token the child's own writer can never produce. The frame claims the status
            // schema, so it is validated as a status frame - and being neither that nor the
            // acknowledgement, it fails the handshake closed.
            statusPlan: BootstrapHandshakeHarness.StatusPlan(["""{ "schema":"gamebuddy-desktop-host-bootstrap-status/v1","protocolVersion":1,"stage":"PROVISIONING"}"""]),
            silenceTimeout: TimeSpan.FromSeconds(30));

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        // Refused as a frame, not waited out until the watch expired and not accepted.
        Assert.Equal("host_runtime_unavailable", failure.Category);
    }

    [Fact]
    public async Task A_status_frame_that_carries_the_acknowledgements_fields_is_never_served_as_ready()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // Every field the acknowledgement is judged by, under the status schema and in the
            // status schema's own frame: a reader that matched on status == "accepted" alone would
            // lease a child that never became ready.
            statusPlan: BootstrapHandshakeHarness.StatusPlan(["""{ "schema":"gamebuddy-desktop-host-bootstrap-status/v1","protocolVersion":1,"stage":"provisioning","status":"accepted","bootstrapId":"0","generation":"g","inventoryDigest":"d","runtimeAdmissionSha256":"r","rootLayoutSchema":"gamebuddy-windows-root-layout/v1"}"""]),
            silenceTimeout: TimeSpan.FromSeconds(30));

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal("host_runtime_unavailable", failure.Category);
    }

    [Fact]
    public async Task Status_frames_without_an_acknowledgement_are_never_readiness()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // The child announces a stage, never acknowledges, and closes its handshake.
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status("provisioning")], acknowledgement: false),
            silenceTimeout: TimeSpan.FromSeconds(30));

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal("host_runtime_unavailable", failure.Category);
        Assert.NotNull(failure.Diagnostic);
        Assert.StartsWith("host_bootstrap_last_stage: provisioning", failure.Diagnostic!, StringComparison.Ordinal);
    }
}
