namespace GameBuddy.Desktop;

/// <summary>
/// The one player-facing statement a failed launch produces: what stopped, what the Host itself said
/// about it, what the player can do, and where the record is.
///
/// It exists because a launch that failed during Host composition produced NOTHING the player could
/// see - no browser (the launch URL is published after composition), no tray (it starts after the
/// acknowledgement), no dialog, and no record - so the only survivor was one stderr line on a channel
/// the player never reads. Every field here is built from codes the Host and the launcher already
/// emit (<see cref="DesktopLaunchResult"/> and the child's own bounded code); this file invents no
/// error taxonomy.
///
/// The copy is C# and English, like the rest of the shell surface the player sees
/// (<c>ShellIntentRouter</c>, <c>TrayShell</c>): the launcher has no locale layer, so this file is the
/// one owner of this copy. Browser copy stays in <c>dialogue-web/src/i18n.ts</c>, which is the only
/// place that has two languages.
/// </summary>
internal sealed class LaunchFailureNotice
{
    /// <summary>The window's own title: one line, the same whatever failed.</summary>
    internal const string Title = "GameBuddy could not start";

    /// <summary>The window's one control. A failed launch has nothing else to offer.</summary>
    internal const string CloseLabel = "Close";

    private LaunchFailureNotice(string whatFailed, string? reportedCode, string whatYouCanDo, string? recordPath)
    {
        WhatFailed = whatFailed;
        ReportedCode = reportedCode;
        WhatYouCanDo = whatYouCanDo;
        RecordPath = recordPath;
    }

    /// <summary>What stopped, in one sentence, naming the step when the Host announced one.</summary>
    internal string WhatFailed { get; }

    /// <summary>
    /// The child's own code for the same refusal, verbatim, or <c>null</c> when the child named
    /// nothing that is already one bounded code. It is what a support path matches on, so it is
    /// quoted rather than paraphrased.
    /// </summary>
    internal string? ReportedCode { get; }

    /// <summary>What the player can do about it. Never a promise the product cannot keep.</summary>
    internal string WhatYouCanDo { get; }

    /// <summary>The record written for this launch, or <c>null</c> when none could be written.</summary>
    internal string? RecordPath { get; }

    /// <summary>
    /// Builds the statement for one failed launch. <paramref name="stage"/> is the bootstrap step the
    /// child had announced and <paramref name="reportedCode"/> is the code the child itself wrote, both
    /// absent when the launch never reached a child.
    /// </summary>
    internal static LaunchFailureNotice For(DesktopLaunchResult result, string? stage, string? reportedCode)
    {
        var whatFailed = WhatFailedFor(result);
        if (stage is not null) whatFailed = $"{whatFailed} It stopped at the step \"{stage}\".";
        return new LaunchFailureNotice(
            whatFailed,
            DesktopLaunchFailureRecord.Bounded(reportedCode),
            WhatYouCanDoFor(result),
            recordPath: null);
    }

    /// <summary>The same statement, now naming the record that was written for it.</summary>
    internal LaunchFailureNotice WithRecord(string? recordPath) =>
        new(WhatFailed, ReportedCode, WhatYouCanDo, recordPath);

    /// <summary>
    /// The lines the window shows, one blank line between each: what failed, what the Host said, what
    /// to do, and where the record is. It is the whole rendering, so a test can read exactly what the
    /// player reads without a desktop.
    /// </summary>
    internal IReadOnlyList<string> BodyLines()
    {
        var lines = new List<string>(4) { WhatFailed };
        if (ReportedCode is not null) lines.Add($"It reported: {ReportedCode}");
        lines.Add(WhatYouCanDo);
        if (RecordPath is not null) lines.Add($"Report: {RecordPath}");
        return lines;
    }

    /// <summary>
    /// What stopped, per the entry's own classification. The default says the one thing that is true
    /// of every unnamed failure rather than inventing a cause.
    /// </summary>
    private static string WhatFailedFor(DesktopLaunchResult result) => result switch
    {
        DesktopLaunchResult.RootRegistrationUnavailable =>
            "This Windows account has no GameBuddy installation registered.",
        DesktopLaunchResult.RootLayoutUnavailable =>
            "The folders GameBuddy keeps your conversations in could not be read.",
        DesktopLaunchResult.MutableRootsUnavailable =>
            "The folders GameBuddy keeps your conversations in could not be created.",
        DesktopLaunchResult.HostGenerationUnavailable =>
            "The installed copy of GameBuddy is incomplete.",
        DesktopLaunchResult.GenerationAdmissionRefused =>
            "The installed copy of GameBuddy did not pass its own integrity check.",
        DesktopLaunchResult.GuardianLaunchUnavailable =>
            "GameBuddy's background service stopped before it was ready.",
        DesktopLaunchResult.DeploymentIdentityUnavailable =>
            "The record that identifies this GameBuddy installation is missing.",
        DesktopLaunchResult.DeploymentIdentityMintUnavailable =>
            "The record that identifies this GameBuddy installation could not be created.",
        DesktopLaunchResult.DeploymentIdentityEstablishUnavailable =>
            "The record that identifies this GameBuddy installation could not be written.",
        DesktopLaunchResult.DeploymentIdentityConflict =>
            "Two records of this GameBuddy installation disagree, and neither was overwritten.",
        DesktopLaunchResult.HostSessionFailed =>
            "GameBuddy's background service ended unexpectedly.",
        DesktopLaunchResult.PrimaryInstanceUnavailable =>
            "GameBuddy is already running, and it did not answer the request to open.",
        _ => "GameBuddy stopped before it could show your conversations.",
    };

    /// <summary>
    /// What the player can do. For a Host that will not compose the honest advice is to try once and,
    /// if it stops at the same point, to send the record - restarting is the only action the launcher
    /// owns, and the record is the only thing that names the rest.
    /// </summary>
    private static string WhatYouCanDoFor(DesktopLaunchResult result) => result switch
    {
        DesktopLaunchResult.RootRegistrationUnavailable =>
            "Install GameBuddy again: nothing is registered for this account to start.",
        DesktopLaunchResult.GenerationAdmissionRefused or DesktopLaunchResult.HostGenerationUnavailable =>
            "Start GameBuddy again to reinstall this copy; if it stops at the same point, send the report below to support.",
        DesktopLaunchResult.PrimaryInstanceUnavailable =>
            "Open GameBuddy from the tray icon of the copy that is already running.",
        _ =>
            "Start GameBuddy again. If it stops at the same point, send the report below to support.",
    };
}
