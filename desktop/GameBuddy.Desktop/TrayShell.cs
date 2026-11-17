using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

namespace GameBuddy.Desktop;

/// <summary>
/// The product's own presence on the player's desktop: one tray icon that owns Open, Hide and
/// Quit for the installed product.
/// <para>
/// It exists because the presentation is the player's own browser. A browser tab can be closed
/// without stopping anything, so without a shell-owned presence the player would have no way to
/// bring the presentation back and no honest statement of whether Chat or Game is still running.
/// The tray projects exactly the three typed intents and one fixed category at a time; it never
/// carries a command, a path, a token or a surface name beyond the two fixed labels below, and
/// it holds no authority of its own: Open reaches this launch's presentation, Quit reaches this
/// launch's close path, and Hide states the truth of this adapter - there is no shell-owned
/// window to remove, and the app keeps running.
/// </para>
/// </summary>
internal sealed class TrayShell : IDisposable
{
    /// <summary>The installed player copy's name for this surface. Never the development label.</summary>
    internal const string ProductLabel = ShellIntentRouter.ProductSurfaceLabel;
    internal const string OpenLabel = "Open GameBuddy";
    internal const string HideLabel = "Hide GameBuddy";
    internal const string QuitLabel = "Quit GameBuddy";

    /// <summary>
    /// The first-run explanation, in the installed copy's own words. It exists because the
    /// closing behaviour of a browser page that owns a background product is not something a
    /// player can guess.
    /// </summary>
    internal const string FirstRunExplanation =
        "This browser page is the installed GameBuddy interface (Desktop Browser Presentation). Closing it does not stop background work; use this tray icon to reopen or quit GameBuddy.";

    private static readonly TimeSpan ShutdownWait = TimeSpan.FromSeconds(5);

    private readonly ShellIntentRouter router;
    private readonly ManualResetEventSlim started = new(false);
    private readonly Thread thread;
    private ApplicationContext? context;
    private NotifyIcon? icon;
    private System.Windows.Forms.Timer? stillFinishing;
    private int disposed;

    private TrayShell(ShellIntentRouter router)
    {
        this.router = router;
        thread = new Thread(Run) { IsBackground = true, Name = "GameBuddy.Desktop.Tray" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        started.Wait(ShutdownWait);
    }

    /// <summary>Starts the tray on its own single-threaded apartment, where the shell's message loop lives.</summary>
    internal static TrayShell Start(ShellIntentRouter router)
    {
        ArgumentNullException.ThrowIfNull(router);
        return new TrayShell(router);
    }

    /// <summary>The label the shell is currently showing, in the form NotifyIcon accepts.</summary>
    internal static string TooltipFor(string statusText) =>
        statusText.Length <= 63 ? statusText : statusText[..60] + "...";

    private void Run()
    {
        context = new ApplicationContext();
        try
        {
            icon = new NotifyIcon
            {
                // The product's own icon is a packaging concern (design 103, task 5). Until a
                // product icon is admitted, the shell shows the platform's application icon
                // rather than inventing one here.
                Icon = SystemIcons.Application,
                Text = TooltipFor(router.StatusText),
                Visible = true,
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add(MenuItem(OpenLabel, ShellIntent.Open, menu));
            menu.Items.Add(MenuItem(HideLabel, ShellIntent.Hide, menu));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(MenuItem(QuitLabel, ShellIntent.Quit, menu));
            icon.ContextMenuStrip = menu;
            // The second closing copy is scheduled, not polled: the router says when the quit stops
            // being ordinary, and this timer fires exactly once at that instant. Its interval is the
            // Host's own published number, so the shell keeps no copy of it.
            stillFinishing = new System.Windows.Forms.Timer { Interval = TimerInterval(router.StillFinishingAfterMs) };
            stillFinishing.Tick += (_, _) =>
            {
                stillFinishing.Stop();
                ShowCopy();
            };
            ShowExplanation();
            started.Set();
            Application.Run(context);
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or ArgumentException)
        {
            // No tray surface can be created on this desktop (for example a session without an
            // interactive shell). The Host session and the presentation are unaffected: the tray
            // is the player's convenience, never the product's readiness.
            started.Set();
        }
        finally
        {
            if (icon is not null)
            {
                icon.Visible = false;
                icon.Dispose();
                icon = null;
            }
            stillFinishing?.Dispose();
            stillFinishing = null;
            context?.Dispose();
            context = null;
        }
    }

    /// <summary>
    /// One scheduled redraw of the tray copy, plus the one-shot arm for the second closing copy.
    ///
    /// Quit no longer ends this shell's message loop: the shell is the only surface that can tell
    /// the player the Host is still finishing, so it lives until the launch itself ends and the
    /// lease disposes it. Nothing here decides how long a quit takes - it renders what the router
    /// says at this instant.
    /// </summary>
    private ToolStripMenuItem MenuItem(string label, ShellIntent intent, ContextMenuStrip menu)
    {
        var item = new ToolStripMenuItem(label);
        item.Click += (_, _) =>
        {
            router.Dispatch(intent);
            ShowCopy();
            if (intent == ShellIntent.Quit) stillFinishing?.Start();
        };
        item.Tag = intent;
        _ = menu;
        return item;
    }

    /// <summary>The copy the router reports at this instant: one authority for both closing states.</summary>
    private void ShowCopy()
    {
        if (icon is null) return;
        // A quit under way is narrated by the router's closing copy - the only place the two closing
        // states are decided - and every other intent by the sentence that intent produced.
        icon.Text = TooltipFor(router.QuitCount > 0 ? router.ClosingCopy().Sentence : router.StatusText);
    }

    /// <summary>The Windows timer's interval for a bound expressed in milliseconds.</summary>
    private static int TimerInterval(long milliseconds) =>
        (int)Math.Clamp(milliseconds, 1, int.MaxValue / 2);

    private void ShowExplanation()
    {
        if (icon is null) return;
        try
        {
            icon.BalloonTipTitle = $"GameBuddy - {ProductLabel}";
            icon.BalloonTipText = FirstRunExplanation;
            icon.BalloonTipIcon = ToolTipIcon.Info;
            icon.ShowBalloonTip(10_000);
        }
        catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException)
        {
            // A desktop that cannot show the explanation still gets the tray menu. The
            // explanation is copy, not a gate.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        context?.ExitThread();
        _ = thread.Join(ShutdownWait);
        icon?.Dispose();
        started.Dispose();
    }
}
