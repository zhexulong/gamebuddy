namespace GameBuddy.Setup;

/// <summary>
/// The bounded failure vocabulary of the installer. Every failure names one code
/// and never carries a path, a registry value or a stack, so the installer's own
/// output can be read on any channel without leaking the machine's layout.
/// </summary>
internal enum SetupFailure
{
    None = 0,
    UsageInvalid,
    PayloadUnavailable,
    ProgramRootUnavailable,
    RegistrationUnavailable,
    UninstallUnavailable,
    /// <summary>
    /// A failure this installer did not classify. It exists so an unexpected exception cannot be
    /// reported as a cause it is not: the code says only that setup failed, which is what is known.
    /// </summary>
    Unhandled,
}

internal sealed class SetupException(SetupFailure failure) : Exception
{
    internal SetupFailure Failure { get; } = failure;
}

internal static class SetupOutcome
{
    internal static string Code(SetupFailure failure) => failure switch
    {
        SetupFailure.None => "installer_ok",
        SetupFailure.UsageInvalid => "installer_usage_invalid",
        SetupFailure.PayloadUnavailable => "installer_payload_unavailable",
        SetupFailure.ProgramRootUnavailable => "installer_program_root_unavailable",
        SetupFailure.RegistrationUnavailable => "installer_registration_unavailable",
        SetupFailure.UninstallUnavailable => "installer_uninstall_unavailable",
        SetupFailure.Unhandled => "installer_failed",
        _ => "installer_failed",
    };
}
