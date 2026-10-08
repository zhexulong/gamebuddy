using System.Diagnostics;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's one dev/QA-only exception to "the player's own browser opens the entry".
/// <para>
/// A harness that has to drive the real page cannot use the player's browser association: the
/// shell starts that browser with no debugging port, so nothing can attach to the page, and the
/// entry it received is a one-time admission that a second client cannot recreate. This class lets
/// a nominated program - and only a nominated program - take the entry instead, and it is the whole
/// of that affordance.
/// </para>
/// <para>
/// Two environment variables and nothing else decide whether it exists in a launch. The flag
/// <c>GAMEBUDDY_DEV_BROWSER_HOOK</c> must be exactly <c>1</c>, and the program is named by
/// <c>GAMEBUDDY_DESKTOP_BROWSER_COMMAND</c>. Anything else - an absent flag, <c>0</c>,
/// <c>true</c>, a differently punctuated name - leaves the nominated command unread and the launch
/// opens the player's association exactly as it always has, so an installation that does not set
/// the flag cannot reach this path by accident.
/// </para>
/// <para>
/// The entry is handed over as one argv element of a directly started process: no shell runs and no
/// command line is composed anywhere, so the boot token in the entry cannot be split, quoted or
/// read as syntax. Everything that can go wrong - the flag is on and nothing is named, the named
/// program is not one this platform can start - is the same bounded category and never an
/// exception, a log line or a dead host: opening no presentation is a missing presentation, never
/// a failed session.
/// </para>
/// </summary>
internal static class DesktopDevBrowserHook
{
    internal const string EnableVariable = "GAMEBUDDY_DEV_BROWSER_HOOK";
    internal const string CommandVariable = "GAMEBUDDY_DESKTOP_BROWSER_COMMAND";
    internal const string EnableValue = "1";

    /// <summary>
    /// What an enabled hook that did not hand the entry over reports. It is deliberately not the
    /// presenter's "the player's shell could not open it" category: a launch that was told to use a
    /// nominated program and did not says so, instead of claiming a fact about an association that
    /// was never consulted.
    /// </summary>
    internal const string UnavailableCategory = "presentation_dev_browser_unavailable";

    /// <summary>
    /// Chooses the entry opener for one launch, and the bounded category a refused or failed open
    /// reports. <paramref name="read"/> is this process's environment; <paramref name="playerAssociation"/>
    /// is the launch's own shell open, which is returned untouched whenever this affordance is not
    /// enabled for this launch.
    /// </summary>
    internal static (Func<Uri, bool> Opener, string FailureCategory) Choose(
        Func<string, string?> read,
        Func<Uri, bool> playerAssociation)
    {
        ArgumentNullException.ThrowIfNull(read);
        ArgumentNullException.ThrowIfNull(playerAssociation);

        // The flag decides on its own whether this affordance exists, and it is one exact token:
        // absent, empty, "0", "true" and "1 " all leave the launch opening the player's own
        // association, and the nominated command is not even read. A command left in the
        // environment for some other tooling can never engage this one.
        if (!string.Equals(read(EnableVariable), EnableValue, StringComparison.Ordinal))
            return (playerAssociation, DesktopBrowserPresenter.UnavailableCategory);

        var command = read(CommandVariable);
        if (string.IsNullOrWhiteSpace(command))
        {
            // The flag is an explicit statement of intent, so falling back silently to the player's
            // association would spend this launch's one-time admission on exactly the browser this
            // affordance exists to remove. An enabled hook with nothing named therefore runs
            // nothing at all and reports its own bounded category; the launch, and the admitted
            // Host session behind it, is untouched.
            Func<Uri, bool> startNothing = static _ => false;
            return (startNothing, UnavailableCategory);
        }

        // The nominated program owns the handover from here.
        return (entry => Run(command, entry), UnavailableCategory);
    }

    /// <summary>
    /// Starts the nominated program with the entry as its single argument, and answers whether it
    /// started. It does not wait for it: a harness is expected to outlive this launch.
    /// </summary>
    private static bool Run(string command, Uri entry)
    {
        var start = new ProcessStartInfo(command)
        {
            // The nominated program is an executable image and the entry is one argv element of
            // its own: the association is not asked, no shell is involved, and no command line is
            // composed, so the '#' and '&' of the entry are characters inside an argument and
            // never syntax.
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(entry.AbsoluteUri);
        // A nominated .cmd or .bat therefore cannot start here, and that is a refusal rather than
        // a gap to close: the only way to start one is a command interpreter, and an interpreter
        // reads the entry's '&' as a command separator, which would split the boot token across
        // two commands. The launch reports the bounded category above and the Host keeps serving.
        using var process = Process.Start(start);
        return process is not null;
    }
}
