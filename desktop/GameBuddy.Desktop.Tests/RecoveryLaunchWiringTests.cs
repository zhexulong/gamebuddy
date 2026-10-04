namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Guards the recovery launch wiring: the assembler builds the trigger, mounts it
/// on the authenticated broker through the runtime lease before the broker's
/// command loop starts, and neither the runtime supervisor nor the guarded
/// production entry ever names the recovery launch itself.
///
/// The chain is text-asserted because the recovery path only runs inside an
/// authenticated broker session with a real Guardian child; what these tests can
/// prove is that every link exists, in the required order, and that the guards on
/// the supervisor and entry stay intact.
/// </summary>
public sealed class RecoveryLaunchWiringTests
{
    [Fact]
    public void Broker_accepts_a_late_recovery_mount_and_refuses_it_after_the_command_loop_starts()
    {
        var broker = File.ReadAllText(Source("DesktopHostBootstrapBroker.cs"));

        Assert.Contains("internal void AttachRecoveryLaunch(Func<CancellationToken, Task<GuardianRecoverySupervisorLease>> startRecovery)", broker, StringComparison.Ordinal);
        // Refusing a late mount is what makes the ordering load-bearing: without
        // it a recovery request between the loop start and the mount would fail
        // closed with no signal that the wiring was wrong.
        Assert.Contains("if (closed || commandLoop is not null || this.startRecovery is not null) throw new GuardianLaunchUnavailableException();", broker, StringComparison.Ordinal);
        // The field must not stay readonly, or the mount could not take effect.
        Assert.DoesNotContain("private readonly Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery;", broker, StringComparison.Ordinal);
        // The command loop still starts in exactly one place.
        Assert.Contains("commandLoop = Task.Run(() => ServeCommandsAsync(cancellationToken), CancellationToken.None);", broker, StringComparison.Ordinal);
    }

    [Fact]
    public void Runtime_lease_forwards_a_trigger_by_name_only_and_keeps_the_supervisor_guard()
    {
        var supervisor = File.ReadAllText(Source("RuntimeSupervisor.cs"));

        Assert.Contains("internal void AttachRecoveryLaunch(RecoveryLaunchTrigger trigger)", supervisor, StringComparison.Ordinal);
        Assert.Contains("currentBroker.AttachRecoveryLaunch(trigger.Start);", supervisor, StringComparison.Ordinal);
        // The standing guard: the runtime supervisor must not name the recovery
        // supervisor type or construct one.
        Assert.DoesNotContain("GuardianRecovery", supervisor, StringComparison.Ordinal);
        Assert.DoesNotContain("new GuardianSupervisor", supervisor, StringComparison.Ordinal);
    }

    [Fact]
    public void Production_entry_mounts_the_trigger_before_the_command_loop_starts()
    {
        var program = File.ReadAllText(Source("Program.cs"));
        var productionPath = program[program.IndexOf("private static async Task<DesktopLaunchResult> RunProductionAsync", StringComparison.Ordinal)..];

        var start = productionPath.IndexOf("await runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions)", StringComparison.Ordinal);
        var mount = productionPath.IndexOf("host.AttachRecoveryLaunch(new RecoveryLaunchTrigger(image, guardianSupervisor));", StringComparison.Ordinal);
        var loop = productionPath.IndexOf("await host.AttachResidentGuardianAsync(resident, cancellationToken)", StringComparison.Ordinal);

        // Host start, then the recovery mount, then the resident attach that
        // starts the broker's command loop.
        Assert.True(start >= 0 && start < mount && mount < loop, $"expected start < mount < loop, got start={start} mount={mount} loop={loop}");
        Assert.DoesNotContain("StartRecoveryAsync", productionPath, StringComparison.Ordinal);
    }

    [Fact]
    public void Recovery_trigger_binds_the_admitted_image_to_the_supervisor_launch()
    {
        var trigger = File.ReadAllText(Source("RecoveryLaunchTrigger.cs"));

        Assert.Contains("_supervisor.StartRecoveryAsync(_image, cancellationToken)", trigger, StringComparison.Ordinal);
        Assert.Contains("ArgumentNullException.ThrowIfNull(image)", trigger, StringComparison.Ordinal);
        Assert.Contains("ArgumentNullException.ThrowIfNull(supervisor)", trigger, StringComparison.Ordinal);
    }

    [Fact]
    public void Recovery_trigger_requires_both_dependencies()
    {
        Assert.Throws<ArgumentNullException>(() => new RecoveryLaunchTrigger(null!, new GuardianSupervisor()));
        Assert.Throws<ArgumentNullException>(() => new RecoveryLaunchTrigger(Image(), null!));
    }

    [Fact]
    public async Task Recovery_trigger_start_delegate_reaches_the_bound_supervisor()
    {
        var trigger = new RecoveryLaunchTrigger(Image(), new GuardianSupervisor());

        // The delegate must be a per-call closure over the bound supervisor: a
        // cancelled token must reach the supervisor and fail closed there, which
        // proves the binding is live without launching a Guardian child.
        Assert.NotNull(trigger.Start);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => trigger.Start(cancelled.Token));
    }

    private static AdmittedGuardianImage Image() =>
        (AdmittedGuardianImage)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(AdmittedGuardianImage));

    private static string Source(string file) => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", file));
}
