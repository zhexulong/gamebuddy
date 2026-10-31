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
    /// The installed product is running, so its images are locked. Refused before the first
    /// write rather than discovered halfway through overwriting them.
    /// </summary>
    ProductRunning,
    /// <summary>
    /// A failure this installer did not classify. It exists so an unexpected exception cannot be
    /// reported as a cause it is not: the code says only that setup failed, which is what is known.
    /// </summary>
    Unhandled,
}

internal sealed class SetupException(SetupFailure failure, string? detail = null) : Exception
{
    internal SetupFailure Failure { get; } = failure;

    /// <summary>
    /// One bounded sentence a player can act on. It never carries a path, a registry value or a
    /// stack, for the same reason the codes do not.
    /// </summary>
    internal string? Detail { get; } = detail;
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
        SetupFailure.ProductRunning => "installer_product_running",
        SetupFailure.Unhandled => "installer_failed",
        _ => "installer_failed",
    };
}
