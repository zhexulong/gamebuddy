namespace GameBuddy.Desktop.Tests;

public sealed class GuardianBrokerTests
{
    [Fact]
    public void Broker_source_has_distinct_recovery_session_and_fixed_redacted_acknowledgements()
    {
        var source = File.ReadAllText(Source("DesktopHostBootstrapBroker.cs"));

        Assert.Contains("\"arm_attempt\"", source, StringComparison.Ordinal);
        Assert.Contains("\"launch_role\"", source, StringComparison.Ordinal);
        Assert.Contains("\"contain_role\"", source, StringComparison.Ordinal);
        Assert.Contains("\"recover_attempt\"", source, StringComparison.Ordinal);
        Assert.Contains("RelayRecoveryAsync", source, StringComparison.Ordinal);
        Assert.Contains("startRecovery", source, StringComparison.Ordinal);
        Assert.Contains("GuardianRecoverySessionState", source, StringComparison.Ordinal);
        Assert.Contains("recovery_accepted", source, StringComparison.Ordinal);
        Assert.Contains("player_contained", source, StringComparison.Ordinal);
        Assert.Contains("ai_contained", source, StringComparison.Ordinal);
        Assert.Contains("ReleaseAndVerifyExitAsync", source, StringComparison.Ordinal);
        Assert.Contains("GetNamedPipeClientProcessId", source, StringComparison.Ordinal);
        Assert.Contains("PipeOptions.CurrentUserOnly", source, StringComparison.Ordinal);
        Assert.DoesNotContain("sessionToken", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Recovery_state_machine_rejects_replay_cross_correlation_and_out_of_order_release()
    {
        var recovery = new DesktopHostBootstrapBroker.GuardianRecoverySessionState(
            "11111111-1111-1111-1111-111111111111", 1, "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333");

        Assert.Throws<GuardianLaunchUnavailableException>(() => recovery.ReleaseRequested());
        recovery.GateAcquired();
        Assert.Throws<GuardianLaunchUnavailableException>(() => recovery.GateAcquired());
        Assert.False(recovery.Matches("11111111-1111-1111-1111-111111111111", 1, "22222222-2222-2222-2222-222222222222", "44444444-4444-4444-4444-444444444444"));
        recovery.PostCasBound();
        recovery.RecoverAuthorized();
        Assert.Throws<GuardianLaunchUnavailableException>(() => recovery.RoleContained("aiClient"));
        recovery.RoleContained("playerHost");
        recovery.RoleContained("aiClient");
        Assert.Throws<GuardianLaunchUnavailableException>(() => recovery.ReleaseRequested());
        recovery.FinalizeAcknowledged();
        recovery.ReleaseRequested();
        recovery.TerminalVerified();
        Assert.Throws<GuardianLaunchUnavailableException>(() => recovery.TerminalVerified());
    }

    [Fact]
    public void Broker_source_rejects_replay_and_private_frame_leakage_before_native_relay()
    {
        var source = File.ReadAllText(Source("DesktopHostBootstrapBroker.cs"));

        var parse = source.IndexOf("TryParseCommand", StringComparison.Ordinal);
        var relay = source.IndexOf("RelayResidentAsync", StringComparison.Ordinal);
        Assert.True(parse >= 0 && relay > parse);
        Assert.Contains("deadlineUnixMs", source, StringComparison.Ordinal);
        Assert.Contains("launchedRoles.Contains", source, StringComparison.Ordinal);
        Assert.Contains("containedRoles.Contains", source, StringComparison.Ordinal);
        Assert.Contains("!ValidTokenlessArmBody", source, StringComparison.Ordinal);
        Assert.Contains("new BrokerCommand", source, StringComparison.Ordinal);
        Assert.Contains("privateFrame, deadline", source, StringComparison.Ordinal);
        Assert.Contains("BindCommandDeadline(parsed, cancellationToken)", source, StringComparison.Ordinal);
        Assert.Contains("parsed.ThrowIfExpired(commandCancellation)", source, StringComparison.Ordinal);
        Assert.Contains("var result = await guardian!.RelayResidentAsync", source, StringComparison.Ordinal);
        Assert.Contains("parsed.ThrowIfExpired(commandCancellation);\n                AdvanceTransition(parsed);", source, StringComparison.Ordinal);
        Assert.DoesNotContain("deadlineUnixMs =", source, StringComparison.Ordinal);
        Assert.DoesNotContain("sessionToken", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Guardian_relay_source_enforces_native_ordering_and_closes_eof_on_failure()
    {
        var source = File.ReadAllText(Source("GuardianSupervisor.cs"));

        var publicWrite = source.IndexOf("WritePublicCommandAsync(command, commandCancellation)", StringComparison.Ordinal);
        var privateConnect = source.IndexOf("privateIngress.ConnectAsync(commandCancellation)", StringComparison.Ordinal);
        var privateAccepted = source.IndexOf("!= \"accepted\"", StringComparison.Ordinal);
        var nativeResult = source.IndexOf("ReadPublicResultAsync(commandCancellation)", publicWrite, StringComparison.Ordinal);
        Assert.True(publicWrite >= 0 && privateConnect > publicWrite && privateAccepted > privateConnect && nativeResult > privateAccepted);
        Assert.Contains("command.ThrowIfExpired(commandCancellation);\n            await WritePublicCommandAsync", source, StringComparison.Ordinal);
        Assert.Contains("command.ThrowIfExpired(commandCancellation);\n                var ingress", source, StringComparison.Ordinal);
        Assert.Contains("command.ThrowIfExpired(commandCancellation);\n            if (await ReadPublicResultAsync", source, StringComparison.Ordinal);
        Assert.Contains("BindDeadline(cancellationToken)", source, StringComparison.Ordinal);
        Assert.Contains("await CloseControlAsync(CancellationToken.None)", source, StringComparison.Ordinal);
        Assert.Contains("InjectArmToken", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.", source, StringComparison.Ordinal);
    }

    private static string Source(string file) => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", file));
}
