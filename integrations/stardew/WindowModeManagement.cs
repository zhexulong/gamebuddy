using System.Runtime.InteropServices;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private int windowModeAppliedTicks;

    private string GetEffectiveWindowMode()
    {
        string? envMode = Environment.GetEnvironmentVariable("GAMEBUDDY_WINDOW_MODE");
        if (!string.IsNullOrWhiteSpace(envMode))
        {
            return NormalizeMode(envMode);
        }
        if (!string.IsNullOrWhiteSpace(this.config.WindowMode))
        {
            return NormalizeMode(this.config.WindowMode);
        }
        return "visible";
    }

    internal static string NormalizeMode(string mode)
    {
        string trimmed = mode.Trim().ToLowerInvariant();
        return trimmed switch
        {
            // `background` is the contract's hidden-equivalent.
            "hidden" or "background" => "hidden",
            // The three modes that keep the window on screen. The contract
            // distinguishes them and so does this Mod now: collapsing them into
            // `visible` made `foreground` a lie - the window was shown without ever
            // being activated, so a human watching a "foreground" run saw whatever
            // happened to be on top instead of the game.
            "visible" or "foreground" or "minimized" => trimmed,
            // An unrecognised value must never hide a real player's game.
            _ => "visible"
        };
    }

    /// <summary>
    /// Window command for a mode. Pure so the mapping is unit-testable without a
    /// live window; `host/src/live-run/window-mode.ts` stays the vocabulary
    /// authority (this is the game-side half of that contract).
    /// </summary>
    internal static int ResolveWindowCommand(string mode)
    {
        return NormalizeMode(mode) switch
        {
            "hidden" => Win32WindowInterop.SW_HIDE,
            "minimized" => Win32WindowInterop.SW_SHOWMINIMIZED,
            "foreground" => Win32WindowInterop.SW_SHOW,
            _ => Win32WindowInterop.SW_SHOWNOACTIVATE
        };
    }

    /// <summary>True when the mode asks the OS to bring the window to the front.</summary>
    internal static bool RequiresActivation(string mode)
    {
        return NormalizeMode(mode) == "foreground";
    }

    /// <summary>How a `foreground` request actually resolved on the OS.</summary>
    internal enum WindowRaiseOutcome
    {
        /// <summary>SetForegroundWindow was accepted; the window is active.</summary>
        Activated,

        /// <summary>Focus theft was refused; the window was raised to the top of the z-order instead.</summary>
        Raised,

        /// <summary>Neither worked; the window keeps its current stacking.</summary>
        Unchanged
    }

    /// <summary>The reported outcome of a foreground request (testable without a window).</summary>
    internal static string DescribeRaiseOutcome(WindowRaiseOutcome outcome)
    {
        return outcome switch
        {
            WindowRaiseOutcome.Activated => "SetForegroundWindow=accepted",
            WindowRaiseOutcome.Raised => "SetForegroundWindow=refused; raised to the top of the z-order",
            _ => "SetForegroundWindow=refused; window not raised"
        };
    }

    /// <summary>
    /// Bring the window in front of the user.
    ///
    /// Measured on Windows (2026-10-05, foreground live run): a background process
    /// calling <c>SetForegroundWindow</c> is REFUSED - the OS does not let a process
    /// steal the foreground on demand - and <c>BringWindowToTop</c> only reorders the
    /// calling thread's own window stack, so the game stayed behind the active window
    /// while an independent probe kept reporting the other app as foreground.
    ///
    /// <c>SetWindowPos(HWND_TOPMOST)</c> needs no foreground right, so it is the
    /// mechanism that actually makes a run watchable; the topmost flag is dropped
    /// immediately so the window then behaves like any other.
    /// </summary>
    private static WindowRaiseOutcome RaiseWindow(IntPtr hWnd)
    {
        if (Win32WindowInterop.SetForegroundWindow(hWnd))
        {
            return WindowRaiseOutcome.Activated;
        }

        const uint flags = Win32WindowInterop.SWP_NOMOVE | Win32WindowInterop.SWP_NOSIZE | Win32WindowInterop.SWP_NOACTIVATE;
        bool raised = Win32WindowInterop.SetWindowPos(hWnd, Win32WindowInterop.HWND_TOPMOST, 0, 0, 0, 0, flags);
        // Drop the topmost flag either way: a permanently topmost game window would
        // sit over everything the user does.
        Win32WindowInterop.SetWindowPos(hWnd, Win32WindowInterop.HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        return raised ? WindowRaiseOutcome.Raised : WindowRaiseOutcome.Unchanged;
    }

    private void ApplyWindowModeInitial()
    {
        string mode = this.GetEffectiveWindowMode();
        this.Monitor.Log($"GameBuddy applying {mode} window mode (silent, 60Hz background loop).", LogLevel.Info);

        this.DisableThrottling();

        try
        {
            if (GameRunner.instance is not null)
            {
                GameRunner.instance.InactiveSleepTime = TimeSpan.Zero;
            }
            if (Game1.options is not null)
            {
                Game1.options.pauseWhenOutOfFocus = false;
                Game1.options.musicVolumeLevel = 0f;
                Game1.options.soundVolumeLevel = 0f;
            }
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"GameBuddy failed to apply engine options/mute: {ex.Message}", LogLevel.Trace);
        }

        int cmd = ResolveWindowCommand(mode);
        this.EnforceWindowAsync(mode, cmd);
    }

    private void DisableThrottling()
    {
        if (!OperatingSystem.IsWindows())
            return;

        try
        {
            Win32WindowInterop.timeBeginPeriod(1);

            Win32WindowInterop.PROCESS_POWER_THROTTLING_STATE throttling = new()
            {
                Version = Win32WindowInterop.PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask = Win32WindowInterop.PROCESS_POWER_THROTTLING_EXECUTION_SPEED
                    | Win32WindowInterop.PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
                StateMask = 0
            };

            bool success = Win32WindowInterop.SetProcessInformation(
                Win32WindowInterop.GetCurrentProcess(),
                Win32WindowInterop.ProcessPowerThrottling,
                ref throttling,
                (uint)Marshal.SizeOf<Win32WindowInterop.PROCESS_POWER_THROTTLING_STATE>());

            if (success)
            {
                this.Monitor.Log("GameBuddy disabled Windows EcoQoS power throttling and anchored 1ms timer period.", LogLevel.Trace);
            }
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"GameBuddy failed to disable power throttling: {ex.Message}", LogLevel.Trace);
        }
    }

    private void ApplyWindowModeTick()
    {
        if (this.windowModeAppliedTicks >= 60)
            return;

        this.windowModeAppliedTicks++;

        try
        {
            if (GameRunner.instance is not null && GameRunner.instance.InactiveSleepTime != TimeSpan.Zero)
            {
                GameRunner.instance.InactiveSleepTime = TimeSpan.Zero;
            }
            if (Game1.options is not null)
            {
                if (Game1.options.pauseWhenOutOfFocus)
                {
                    Game1.options.pauseWhenOutOfFocus = false;
                }
                if (Game1.options.musicVolumeLevel != 0f)
                {
                    Game1.options.musicVolumeLevel = 0f;
                }
                if (Game1.options.soundVolumeLevel != 0f)
                {
                    Game1.options.soundVolumeLevel = 0f;
                }
            }
        }
        catch
        {
        }

        string mode = this.GetEffectiveWindowMode();
        int cmd = ResolveWindowCommand(mode);
        this.EnforceWindowAsync(mode, cmd);
    }

    private void EnforceWindowAsync(string mode, int nCmdShow)
    {
        if (!OperatingSystem.IsWindows())
            return;

        try
        {
            IntPtr hWnd = GameRunner.instance?.Window?.Handle ?? IntPtr.Zero;
            if (hWnd == IntPtr.Zero)
            {
                return;
            }
            Win32WindowInterop.ShowWindowAsync(hWnd, nCmdShow);
            if (RequiresActivation(mode))
            {
                this.ReportActivation(mode, RaiseWindow(hWnd));
            }
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"GameBuddy failed to apply window mode {mode}: {ex.Message}", LogLevel.Trace);
        }
    }

    private string? windowActivationReport;

    private void ReportActivation(string mode, WindowRaiseOutcome outcome)
    {
        // Record the transition, not every tick: at startup the window handle may
        // not exist yet, so early attempts can legitimately fail and a later tick
        // succeed. Keying on the RESULT means a later success is still reported
        // rather than hidden behind an earlier attempt.
        string report = $"{mode}:{outcome}";
        if (this.windowActivationReport == report)
            return;
        this.windowActivationReport = report;
        this.Monitor.Log($"GameBuddy window mode {mode}: {DescribeRaiseOutcome(outcome)}.", LogLevel.Info);
    }

    private static class Win32WindowInterop
    {
        public const int SW_HIDE = 0;
        public const int SW_SHOWNORMAL = 1;
        public const int SW_SHOWMINIMIZED = 2;
        public const int SW_SHOWMAXIMIZED = 3;
        public const int SW_SHOWNOACTIVATE = 4;
        public const int SW_SHOW = 5;
        public const int SW_MINIMIZE = 6;
        public const int SW_SHOWMINNOACTIVE = 7;
        public const int SW_SHOWNA = 8;
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        public static readonly IntPtr HWND_TOPMOST = new(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new(-2);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int x,
            int y,
            int cx,
            int cy,
            uint flags);

        public const int ProcessPowerThrottling = 4;
        public const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
        public const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
        public const uint PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_POWER_THROTTLING_STATE
        {
            public uint Version;
            public uint ControlMask;
            public uint StateMask;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetProcessInformation(
            IntPtr hProcess,
            int processInformationClass,
            ref PROCESS_POWER_THROTTLING_STATE processInformation,
            uint processInformationSize);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod", SetLastError = true)]
        public static extern uint timeBeginPeriod(uint uMilliseconds);
    }
}
