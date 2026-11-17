using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

namespace GameBuddy.Desktop;

/// <summary>
/// The window a failed launch is allowed to show.
///
/// It exists for one measured failure: the Host child refused while composing, the entry wrote one
/// stderr line and returned, and because <c>OutputType=Exe</c> a double click left a console window
/// that closed before anything could be read. The product owns no other surface at that moment - the
/// tray only starts after the acknowledgement, and the browser is opened from a launch URL the
/// composition never published - so this is the whole of what the player can be told.
///
/// It is a shell surface like the tray, and WinForms belongs to the shell files only. Nothing here
/// decides anything: the sentence is <see cref="LaunchFailureNotice"/>, and this renders it. A desktop
/// that cannot create a window (no interactive session) is not a second failure: the process still
/// exits non-zero with its bounded code on stderr, and the record is already on disk.
/// </summary>
internal sealed class LaunchFailureWindow : Form
{
    private readonly string closeLabel;

    /// <summary>
    /// The window for one statement. It is created on a single-threaded apartment, because that is
    /// where a Windows Forms window lives; the message loop is the caller's.
    /// </summary>
    internal LaunchFailureWindow(LaunchFailureNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        Text = LaunchFailureNotice.Title;
        RenderedBody = BodyText(notice);
        closeLabel = LaunchFailureNotice.CloseLabel;
        AutoScaleMode = AutoScaleMode.Font;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowIcon = false;
        TopMost = true;
        ClientSize = new Size(560, 240);

        var body = new Label
        {
            Text = RenderedBody,
            AutoSize = false,
            Dock = DockStyle.Fill,
            Padding = new Padding(16),
            TextAlign = ContentAlignment.TopLeft,
        };
        var close = new Button
        {
            Text = closeLabel,
            AutoSize = true,
            Anchor = AnchorStyles.Right | AnchorStyles.Bottom,
        };
        close.Click += (_, _) => Close();
        // The two rows are the sentence and the one control: the body takes every spare pixel, so a
        // longer code never pushes the button off the window.
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(body, 0, 0);
        layout.Controls.Add(close, 0, 1);
        Controls.Add(layout);
        AcceptButton = close;
        CancelButton = close;
    }

    /// <summary>The whole rendering of one statement, exactly as the window shows it.</summary>
    internal static string BodyText(LaunchFailureNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        return string.Join(Environment.NewLine + Environment.NewLine, notice.BodyLines());
    }

    /// <summary>What the window's own body says at this instant.</summary>
    internal string RenderedBody { get; }

    /// <summary>The label of the window's one control.</summary>
    internal string CloseLabel => closeLabel;

    /// <summary>
    /// Shows the statement on its own single-threaded apartment and waits for the player to close it.
    ///
    /// The wait is deliberate and has no bound: the launch has already failed, the record is already on
    /// disk, and the only thing left for this process to do is let its player read why. A desktop that
    /// cannot create the window ends the thread instead, and the entry exits exactly as it would have.
    /// </summary>
    internal static void Show(LaunchFailureNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        try
        {
            var thread = new Thread(Run)
            {
                IsBackground = false,
                Name = "GameBuddy.Desktop.FailureWindow",
            };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start(notice);
            thread.Join();
        }
        catch (Exception exception) when (exception is OutOfMemoryException or ThreadStateException)
        {
            // A machine that cannot create the thread cannot show the window; the bounded code and the
            // record are unaffected, so this is never a second failure of the launch.
        }
    }

    private static void Run(object? state)
    {
        var notice = (LaunchFailureNotice)state!;
        try
        {
            using var window = new LaunchFailureWindow(notice);
            Application.Run(window);
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or ArgumentException)
        {
            // No interactive desktop to draw on. The entry still exits with its code and its record.
        }
    }
}
