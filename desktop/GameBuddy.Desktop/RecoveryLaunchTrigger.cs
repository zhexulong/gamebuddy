namespace GameBuddy.Desktop;

/// <summary>
/// Binds the two facts a recovery launch needs - the admitted Guardian image
/// (the lock holder both launches re-verify) and the supervisor that performs the
/// native create - so the assembler that owns them can hand the capability to the
/// authenticated Host broker as one value.
///
/// It deliberately lives outside <see cref="RuntimeSupervisor"/>: the runtime
/// supervisor starts and contains the Host, and must not name the recovery
/// machinery. The capability is mounted on the broker after host authentication
/// and before the command loop starts, which is the only window in which a
/// recovery request can arrive.
///
/// It owns no lease, no process and no state: the recovery child's lifetime
/// belongs to the lease the <see cref="Start"/> delegate returns.
/// </summary>
internal sealed class RecoveryLaunchTrigger
{
    private readonly AdmittedGuardianImage _image;
    private readonly GuardianSupervisor _supervisor;

    internal RecoveryLaunchTrigger(AdmittedGuardianImage image, GuardianSupervisor supervisor)
    {
        ArgumentNullException.ThrowIfNull(image);
        ArgumentNullException.ThrowIfNull(supervisor);
        _image = image;
        _supervisor = supervisor;
    }

    /// <summary>
    /// The recovery launch the Host broker session drives when it is asked to
    /// recover an attempt. The supervisor re-verifies the image lock on every
    /// launch, so a stale image fails closed there rather than being reused.
    /// </summary>
    internal Func<CancellationToken, Task<GuardianRecoverySupervisorLease>> Start =>
        cancellationToken => _supervisor.StartRecoveryAsync(_image, cancellationToken);
}
