using System.Collections.Concurrent;
using System.Text;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The Guardian's public channel carries two kinds of frame: the reply to the command in
/// flight, and a role that ended on its own, at whatever instant it ended.
///
/// The property that was missing is the second one's timing: the channel used to be read
/// only while a command was in flight, so a death that arrived with nothing in front of it
/// waited for the next command - and the controller that has just launched a game sends no
/// next command at all. The Host is that controller, so the game could be gone while the
/// product still described it as running (`.tmp/lane-deathpub.md`).
///
/// These drive the real lease and the real reader over real pipe handles. The properties
/// kept from the reader this replaced are the ones that still hold: an event queued in
/// front of a reply must not be consumed as that reply (a mismatched reply fails the relay
/// and closes the Guardian's control channel), every event is delivered exactly once, and a
/// frame that is neither shape fails closed rather than being guessed at.
/// </summary>
public sealed class GuardianRoleExitRelayTests
{
    private const string ContainmentReply = "{\"schemaVersion\":1,\"result\":\"role_contained\"}\n";
    private const string PlayerExit = "{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":3}\n";
    private const string AiExit = "{\"operation\":\"role_exited\",\"role\":\"ai_client\",\"exitCode\":4294967295}\n";
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [Fact]
    public async Task A_role_exit_reaches_the_relay_with_no_command_in_flight()
    {
        using var channel = new RelayChannel();
        await channel.Write(PlayerExit);

        var exit = await channel.WaitForExitAsync();
        Assert.Equal("player_host", exit.Role);
        Assert.Equal(3L, exit.ExitCode);
    }

    [Fact]
    public async Task A_role_exit_queued_before_a_containment_reply_still_answers_the_containment()
    {
        // #506: the death is a frame in front of the reply, never instead of it, so the
        // product's own explicit containment still works for a session whose game ended.
        using var channel = new RelayChannel();
        var relay = channel.Lease.RelayResidentAsync(Containment("contain_role"), CancellationToken.None);
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(channel.ControlInput, CancellationToken.None));
        await channel.Write(PlayerExit + ContainmentReply);

        Assert.Equal("role_contained", await relay.WaitAsync(TimeSpan.FromSeconds(10)));
        var exit = await channel.WaitForExitAsync();
        Assert.Equal("player_host", exit.Role);
        Assert.Equal(3L, exit.ExitCode);
    }

    [Fact]
    public async Task A_reply_with_no_role_exit_answers_its_command_and_relays_nothing()
    {
        using var channel = new RelayChannel();
        var relay = channel.Lease.RelayResidentAsync(Containment("contain_role"), CancellationToken.None);
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(channel.ControlInput, CancellationToken.None));
        await channel.Write(ContainmentReply);

        Assert.Equal("role_contained", await relay.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(channel.ExitRelayedWithin(TimeSpan.FromMilliseconds(250)), "a reply published a role exit nobody sent");
    }

    [Fact]
    public async Task Both_role_exits_arrive_as_their_own_events()
    {
        using var channel = new RelayChannel();
        await channel.Write(PlayerExit + AiExit);

        Assert.Equal("player_host", (await channel.WaitForExitAsync()).Role);
        var ai = await channel.WaitForExitAsync();
        Assert.Equal("ai_client", ai.Role);
        Assert.Equal(4294967295L, ai.ExitCode);
    }

    [Theory]
    // A frame that is neither the reply nor the exact three-key role event is a frame this
    // channel must refuse rather than guess at.
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\"}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":-1}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"player_host\",\"exitCode\":4294967296}\n")]
    [InlineData("{\"operation\":\"role_exited\",\"role\":\"someone_else\",\"exitCode\":1}\n")]
    [InlineData("{\"operation\":\"role_paused\",\"role\":\"player_host\",\"exitCode\":1}\n")]
    [InlineData("{\"schemaVersion\":1,\"result\":\"role_contained\",\"role\":\"player_host\"}\n")]
    [InlineData("{\"schemaVersion\":2,\"result\":\"role_contained\"}\n")]
    public async Task A_frame_that_is_neither_the_reply_nor_a_role_event_fails_closed(string frame)
    {
        using var channel = new RelayChannel();
        var relay = channel.Lease.RelayResidentAsync(Containment("contain_role"), CancellationToken.None);
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(channel.ControlInput, CancellationToken.None));
        await channel.Write(frame + ContainmentReply);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => relay);
        Assert.False(channel.ExitRelayedWithin(TimeSpan.FromMilliseconds(250)));
    }

    [Fact]
    public async Task A_second_event_for_a_role_already_reported_fails_closed_instead_of_replacing_it()
    {
        // A role is launched at most once per attempt, so a second event for the same role
        // says the Guardian is repeating itself. Accepting it would let the last frame win:
        // the relay would publish one exit code for a role that published another, and the
        // product would report a native status the OS never gave it.
        using var channel = new RelayChannel();
        var relay = channel.Lease.RelayResidentAsync(Containment("contain_role"), CancellationToken.None);
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(channel.ControlInput, CancellationToken.None));
        await channel.Write(PlayerExit + PlayerExit + ContainmentReply);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => relay);
        Assert.Equal("player_host", (await channel.WaitForExitAsync()).Role);
        Assert.False(channel.ExitRelayedWithin(TimeSpan.FromMilliseconds(250)), "the repeated event was relayed as a second exit");
    }

    [Fact]
    public async Task Events_with_no_reply_never_answer_the_command_which_fails_at_its_own_deadline()
    {
        // The reader serves events whether or not a command is in flight, so an event stream
        // with no reply is not the reader's failure any more - it is the command's own budget
        // answering for a reply the native never wrote.
        using var channel = new RelayChannel();
        var relay = channel.Lease.RelayResidentAsync(Containment("contain_role", operationWaitBudgetMs: 750), CancellationToken.None);
        Assert.Contains("\"operation\":\"contain_role\"", await GuardianSupervisorLease.ReadLineAsync(channel.ControlInput, CancellationToken.None));
        await channel.Write(PlayerExit + AiExit);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => relay);
        Assert.Equal("player_host", (await channel.WaitForExitAsync()).Role);
        Assert.Equal("ai_client", (await channel.WaitForExitAsync()).Role);
    }

    private static GuardianRelayCommand Containment(string operation, long operationWaitBudgetMs = 5_000) =>
        new(operation, "11111111-1111-1111-1111-111111111111", 1, "22222222-2222-2222-2222-222222222222",
            "player_host", null, 0, operationWaitBudgetMs);

    /// <summary>
    /// One real lease over real pipe handles, with this test playing the Guardian's public
    /// channel and the relay collecting what the lease delivers.
    ///
    /// The lease holds the current process handle as its "guardian" so nothing is spawned;
    /// it is deliberately NOT disposed here, because its disposal ends that process.
    /// </summary>
    private sealed class RelayChannel : IDisposable
    {
        private readonly FileStream publicOutput;
        private readonly ConcurrentQueue<GuardianRoleExit> exits = new();

        internal RelayChannel()
        {
            Assert.True(WindowsNative.CreatePipe(out var controlRead, out var controlWrite, IntPtr.Zero, 0));
            Assert.True(WindowsNative.CreatePipe(out var publicRead, out var publicWrite, IntPtr.Zero, 0));
            Assert.True(WindowsNative.OpenProcess(ProcessQueryLimitedInformation, false, WindowsNative.GetCurrentProcessId(), out var self));
            ControlInput = new FileStream(controlRead, FileAccess.Read, bufferSize: 4096, isAsync: false);
            publicOutput = new FileStream(publicWrite, FileAccess.Write, bufferSize: 4096, isAsync: false);
            Lease = new GuardianSupervisorLease(new GuardianProcessResources(
                self, controlWrite, publicRead, GuardianPrivateIngress.Create(null), "unused-for-this-relay", null))
            {
                RoleExitRelay = (exit, _) => { exits.Enqueue(exit); return Task.CompletedTask; },
            };
        }

        internal FileStream ControlInput { get; }
        internal GuardianSupervisorLease Lease { get; }

        internal async Task Write(string frames)
        {
            await publicOutput.WriteAsync(Encoding.UTF8.GetBytes(frames));
            await publicOutput.FlushAsync();
        }

        internal bool ExitRelayedWithin(TimeSpan budget)
        {
            var deadline = DateTime.UtcNow + budget;
            while (DateTime.UtcNow < deadline)
            {
                if (!exits.IsEmpty) return true;
                Thread.Sleep(10);
            }
            return !exits.IsEmpty;
        }

        internal async Task<GuardianRoleExit> WaitForExitAsync()
        {
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline)
            {
                if (exits.TryDequeue(out var exit)) return exit;
                await Task.Delay(10);
            }
            throw new TimeoutException("no role exit was relayed");
        }

        public void Dispose() => publicOutput.Dispose();
    }
}
