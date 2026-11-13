using System.Text;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The public channel carries the Guardian's replies and, on the same channel,
/// the role events it publishes when a role process ends on its own.
///
/// These drive the real reader the relay uses, over the real frame bytes. The
/// property that matters is the one the product depended on and did not have: an
/// event queued in front of a command's reply must not be consumed as that
/// reply, because a mismatched reply fails the relay and closes the Guardian's
/// control channel - which is how an unexpected player-role death made the
/// product's own explicit containment unavailable.
/// </summary>
public sealed class GuardianRoleExitRelayTests
{
    private const string ContainmentReply = "{\"schemaVersion\":1,\"result\":\"role_contained\"}\n";
    private const string PlayerExit = "{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":3}\n";
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [Fact]
    public async Task A_role_exit_queued_before_a_containment_reply_still_answers_the_containment()
    {
        var result = await GuardianPublicResultReader.ReadAsync(Stream(PlayerExit + ContainmentReply), CancellationToken.None);

        Assert.Equal("role_contained", result.Status);
        Assert.NotNull(result.RoleExit);
        Assert.Equal("player_host", result.RoleExit.Role);
        Assert.Equal(3L, result.RoleExit.ExitCode);
    }

    [Fact]
    public async Task A_role_exit_that_arrives_before_a_containment_reply_does_not_break_the_containment_relay()
    {
        // The real relay over real pipe handles, with the test playing the
        // Guardian's public channel. `contain_role` is the operation whose loss
        // this defect caused: it is the product's explicit endgame containment.
        Assert.True(WindowsNative.CreatePipe(out var controlRead, out var controlWrite, IntPtr.Zero, 0));
        Assert.True(WindowsNative.CreatePipe(out var publicRead, out var publicWrite, IntPtr.Zero, 0));
        Assert.True(WindowsNative.OpenProcess(ProcessQueryLimitedInformation, false, WindowsNative.GetCurrentProcessId(), out var self));
        using var controlInput = new FileStream(controlRead, FileAccess.Read, bufferSize: 4096, isAsync: false);
        using var publicOutput = new FileStream(publicWrite, FileAccess.Write, bufferSize: 4096, isAsync: false);
        var lease = new GuardianSupervisorLease(new GuardianProcessResources(
            self, controlWrite, publicRead, GuardianPrivateIngress.Create(null), "unused-for-this-relay", null));
        var command = new GuardianRelayCommand(
            "contain_role", "11111111-1111-1111-1111-111111111111", 1, "22222222-2222-2222-2222-222222222222",
            "player_host", null, 0, 5_000);

        var relay = lease.RelayResidentAsync(command, CancellationToken.None);
        // The relay has written its command and is now waiting for its own reply.
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(controlInput, CancellationToken.None));
        await publicOutput.WriteAsync(Encoding.UTF8.GetBytes(PlayerExit + ContainmentReply));
        await publicOutput.FlushAsync();

        var result = await relay.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("role_contained", result.Status);
        Assert.Equal("player_host", result.RoleExit!.Role);
        Assert.Equal(3L, result.RoleExit.ExitCode);
    }

    [Fact]
    public async Task A_reply_with_no_role_exit_reports_no_exit_and_keeps_its_own_status()
    {
        var result = await GuardianPublicResultReader.ReadAsync(Stream(ContainmentReply), CancellationToken.None);

        Assert.Equal("role_contained", result.Status);
        Assert.Null(result.RoleExit);
    }

    [Fact]
    public async Task Both_role_exits_can_precede_one_reply_and_each_is_read_as_an_event()
    {
        var result = await GuardianPublicResultReader.ReadAsync(
            Stream($"{PlayerExit}{"{\"operation\":\"role_exited\",\"role\":\"ai_client\",\"exitCode\":4294967295}\n"}{ContainmentReply}"),
            CancellationToken.None);

        Assert.Equal("role_contained", result.Status);
        Assert.Equal("ai_client", result.RoleExit!.Role);
        Assert.Equal(4294967295L, result.RoleExit.ExitCode);
    }

    [Theory]
    // A role event that is not the exact three-key shape is not an event: it is a
    // frame this reader must refuse rather than guess at.
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\"}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":-1}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":4294967296}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"someone_else\",\"exitCode\":1}\n")]
    [InlineData("{\"operation\":\"role_paused\",\"role\":\"player_host\",\"exitCode\":1}\n")]
    [InlineData("{\"schemaVersion\":1,\"result\":\"role_contained\",\"role\":\"player_host\"}\n")]
    [InlineData("{\"schemaVersion\":2,\"result\":\"role_contained\"}\n")]
    public async Task A_frame_that_is_neither_the_reply_nor_a_role_event_fails_closed(string frame)
    {
        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => GuardianPublicResultReader.ReadAsync(Stream(frame + ContainmentReply), CancellationToken.None));
    }

    [Fact]
    public async Task A_stream_of_role_events_that_never_ends_in_a_reply_fails_closed()
    {
        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => GuardianPublicResultReader.ReadAsync(Stream(PlayerExit + PlayerExit + PlayerExit), CancellationToken.None));
    }

    private static MemoryStream Stream(string frames) => new(Encoding.UTF8.GetBytes(frames));
}
