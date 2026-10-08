namespace GameBuddy.Desktop;

/// <summary>
/// The complete vocabulary a shell surface may ask this product's primary instance to
/// perform. It is a closed set on purpose: there is no member that carries text, a path, a
/// root, a profile, a credential, a task or a command, so no surface can grow a generic
/// command bridge by passing one more string.
/// </summary>
internal enum ShellIntent
{
    /// <summary>Open (or re-open) the Desktop Browser Presentation for this launch.</summary>
    Open,

    /// <summary>
    /// Remove the shell's visible window. In the Desktop Browser Presentation adapter there is
    /// no shell-owned window to remove - the visible surface is the player's own browser - so
    /// this intent's honest outcome is the statement of that fact, never a fabricated hide.
    /// </summary>
    Hide,

    /// <summary>
    /// Ask the mounted surface owners to close, then seal Host ingress and exit. It is not one
    /// global STOP, and a close that cannot prove its bounded outcome is reported as uncertain.
    /// </summary>
    Quit,
}

/// <summary>
/// One shell intent's outcome: which intent it was, and the fixed category it produced. The
/// category is what the tray presents and what a test can pin; nothing here can carry the
/// presentation entry, a path, a credential or any other private fact out of the shell.
/// </summary>
internal readonly record struct ShellIntentOutcome(ShellIntent Intent, string Category);

/// <summary>
/// The primary instance's own routing of shell intents. It holds no authority of its own:
/// <c>Open</c> reaches the one presenter this launch already owns, and <c>Quit</c> reaches the
/// one close path this launch already owns. Everything it decides is expressed as a fixed
/// category and a fixed sentence, so the tray can tell the player what happened without a
/// second, invented story about Chat and Game.
/// </summary>
internal sealed class ShellIntentRouter
{
    internal const string OpenAccepted = "shell_open_accepted";
    internal const string OpenUnavailable = "shell_open_unavailable";
    internal const string WindowNotOwned = "shell_window_not_owned";
    internal const string QuitRequested = "shell_quit_requested";
    internal const string QuitUnavailable = "shell_quit_unavailable";

    /// <summary>The installed player copy's name for this surface. Never "Browser Preview".</summary>
    internal const string ProductSurfaceLabel = "Desktop Browser Presentation";

    private readonly Func<bool> openPresentation;
    private readonly Func<bool> requestQuit;
    private int quitRequested;

    internal ShellIntentRouter(Func<bool> openPresentation, Func<bool> requestQuit)
    {
        ArgumentNullException.ThrowIfNull(openPresentation);
        ArgumentNullException.ThrowIfNull(requestQuit);
        this.openPresentation = openPresentation;
        this.requestQuit = requestQuit;
    }

    /// <summary>The sentence the shell shows for the most recent intent.</summary>
    internal string StatusText { get; private set; } = DefaultStatusText;

    /// <summary>The most recent outcome, for evidence and for the shell's own status.</summary>
    internal ShellIntentOutcome LastOutcome { get; private set; } = new(ShellIntent.Open, OpenUnavailable);

    /// <summary>How many times the player asked for a quit. One quit closes once.</summary>
    internal int QuitCount => Volatile.Read(ref quitRequested);

    /// <summary>
    /// Routes one typed intent. It never throws: the shell's job is to tell the player what
    /// happened, and an exception inside a menu callback would tell them nothing at all.
    /// </summary>
    internal ShellIntentOutcome Dispatch(ShellIntent intent)
    {
        var outcome = intent switch
        {
            ShellIntent.Open => Open(),
            ShellIntent.Hide => new ShellIntentOutcome(ShellIntent.Hide, WindowNotOwned),
            ShellIntent.Quit => Quit(),
            _ => new ShellIntentOutcome(intent, WindowNotOwned),
        };
        LastOutcome = outcome;
        StatusText = Sentence(outcome);
        return outcome;
    }

    private ShellIntentOutcome Open() =>
        new(ShellIntent.Open, openPresentation() ? OpenAccepted : OpenUnavailable);

    private ShellIntentOutcome Quit()
    {
        if (Interlocked.Exchange(ref quitRequested, 1) != 0)
            return new ShellIntentOutcome(ShellIntent.Quit, QuitRequested);
        return new ShellIntentOutcome(ShellIntent.Quit, requestQuit() ? QuitRequested : QuitUnavailable);
    }

    private static string Sentence(ShellIntentOutcome outcome) => outcome.Category switch
    {
        OpenAccepted => $"{ProductSurfaceLabel} opened in your browser.",
        OpenUnavailable => $"{ProductSurfaceLabel} is not available right now.",
        WindowNotOwned => $"{ProductSurfaceLabel} is your own browser window: GameBuddy owns no window to hide, and the app keeps running.",
        QuitRequested => "Closing GameBuddy.",
        QuitUnavailable => "GameBuddy could not confirm the close. It is still running.",
        _ => DefaultStatusText,
    };

    private const string DefaultStatusText = $"GameBuddy - {ProductSurfaceLabel}";
}
