using System.Diagnostics;

namespace GameBuddy.Desktop;

/// <summary>
/// Opens the player's own browser at the one presentation entry this launch received
/// from the admitted Host child.
/// <para>
/// This is the only place in the launcher that starts another process for the player,
/// and it is deliberately the weakest thing the launcher does: the admitted Host
/// session is already serving when it runs, so a shell that cannot open a browser is a
/// missing presentation and never a failed launch. Every failure mode - no default
/// browser, a refused association, a shell that throws - is reported as one bounded
/// category and swallowed here.
/// </para>
/// <para>
/// The entry is opened exactly once per launch by the automatic path, because the
/// entry is a one-time admission and a second automated open is a second belief about
/// it. An explicit tray <c>Open</c> is the player asking again, which is a different
/// act and is allowed to repeat.
/// </para>
/// <para>
/// The opener itself is the player's association, except in a launch that explicitly asks for a
/// nominated program instead: <see cref="DesktopDevBrowserHook"/> owns that dev/QA-only choice and
/// the bounded category an enabled hook that could not hand the entry over reports.
/// </para>
/// </summary>
internal sealed class DesktopBrowserPresenter
{
    internal const string OpenedCategory = "presentation_open_accepted";
    internal const string UnavailableCategory = "presentation_open_unavailable";
    internal const string NotAdoptedCategory = "presentation_entry_absent";

    private readonly Func<Uri, bool> openWithEntry;
    private readonly string failureCategory;
    private Uri? entry;
    private int opened;
    private int automatic;

    internal DesktopBrowserPresenter()
        : this(DesktopDevBrowserHook.Choose(Environment.GetEnvironmentVariable, OpenWithShell)) { }

    private DesktopBrowserPresenter((Func<Uri, bool> Opener, string FailureCategory) choice)
        : this(choice.Opener, choice.FailureCategory) { }

    private DesktopBrowserPresenter(Func<Uri, bool> openWithEntry, string failureCategory)
    {
        this.openWithEntry = openWithEntry;
        this.failureCategory = failureCategory;
    }

    /// <summary>Test seam: the same decision, with the entry's own launch replaced by an observer.</summary>
    internal static DesktopBrowserPresenter CreateForTesting(Func<Uri, bool> openWithEntry)
    {
        ArgumentNullException.ThrowIfNull(openWithEntry);
        return new DesktopBrowserPresenter(openWithEntry, UnavailableCategory);
    }

    /// <summary>
    /// Test seam: the same composition one launch performs, with the launch's own environment and
    /// association replaced, so a test observes the dev browser hook's own choice and its bounded
    /// category through the production path rather than through a second implementation of it.
    /// </summary>
    internal static DesktopBrowserPresenter CreateForTesting(Func<string, string?> read, Func<Uri, bool> playerAssociation)
    {
        ArgumentNullException.ThrowIfNull(read);
        ArgumentNullException.ThrowIfNull(playerAssociation);
        return new DesktopBrowserPresenter(DesktopDevBrowserHook.Choose(read, playerAssociation));
    }

    /// <summary>Whether this launch has a presentation entry at all.</summary>
    internal bool HasEntry => entry is not null;

    /// <summary>How many times this launch opened a browser. Evidence, not authority.</summary>
    internal int OpenCount => Volatile.Read(ref opened);

    /// <summary>
    /// Binds the entry this launch is allowed to open. It is adopted once: a second
    /// entry in one launch would be a second admission, which this channel does not
    /// carry.
    /// </summary>
    internal void Adopt(Uri launchUrl)
    {
        ArgumentNullException.ThrowIfNull(launchUrl);
        entry ??= launchUrl;
    }

    /// <summary>
    /// Opens the presentation for the first time in this launch, at most once. It never
    /// throws, so a browser that cannot start cannot end a healthy Host session.
    /// </summary>
    internal bool OpenOnce()
    {
        // A launch with no entry has nothing to open, and that attempt does not spend the one
        // automatic open: the entry is adopted after the acknowledgement, which is later than the
        // shell is constructed.
        if (entry is null) return false;
        if (Interlocked.Exchange(ref automatic, 1) != 0) return false;
        return Open();
    }

    /// <summary>
    /// Opens the presentation because the player asked for it - the tray's Open, or a
    /// secondary invocation's bounded open/focus intent.
    /// </summary>
    internal bool Open()
    {
        var current = entry;
        if (current is null) return false;
        bool openedNow;
        try
        {
            openedNow = openWithEntry(current);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException and not StackOverflowException)
        {
            // The exit code, the exception type and the player's own file associations
            // are the shell's business. Nothing about them - and above all nothing
            // about the entry - is carried out of this method.
            openedNow = false;
        }
        if (openedNow) Interlocked.Increment(ref opened);
        return openedNow;
    }

    /// <summary>The category of the last open attempt, for the tray's own truth.</summary>
    internal string ResultCategory() => entry is null ? NotAdoptedCategory : OpenCount > 0 ? OpenedCategory : failureCategory;

    /// <summary>
    /// The player's default handler for the entry. The entry is passed as the shell's
    /// own association object rather than through a command line this process builds,
    /// so the launcher never splices a URL into a command string. The shell is free to
    /// answer by focusing a browser that is already running - which starts no process
    /// here - so an answered launch, not a returned process handle, is what success
    /// means; the refusal is the exception the shell throws when there is no handler.
    /// </summary>
    private static bool OpenWithShell(Uri launchUrl)
    {
        var start = new ProcessStartInfo(launchUrl.AbsoluteUri) { UseShellExecute = true };
        using var process = Process.Start(start);
        return true;
    }
}
