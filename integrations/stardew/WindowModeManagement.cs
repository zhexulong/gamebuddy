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
                // Evidence, not theatre: SetForegroundWindow is refused when the
                // caller may not steal focus, so record which path actually ran
                // instead of assuming the mode was honoured. Only the transition
                // is logged, not every tick.
                bool activated = Win32WindowInterop.SetForegroundWindow(hWnd);
                if (!activated)
                {
                    Win32WindowInterop.BringWindowToTop(hWnd);
                }
                this.ReportActivation(mode, activated);
            }
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"GameBuddy failed to apply window mode {mode}: {ex.Message}", LogLevel.Trace);
        }
    }

    private string? windowActivationReport;

    private void ReportActivation(string mode, bool activated)
    {
        // Record the transition, not every tick: at startup the window handle may
        // not exist yet, so the first attempts can legitimately fail and a later
        // tick succeed. Keying on the RESULT means the successful activation is
        // still reported rather than hidden behind an earlier failure.
        string report = $"{mode}:{(activated ? "accepted" : "refused")}";
        if (this.windowActivationReport == report)
            return;
        this.windowActivationReport = report;
        this.Monitor.Log(
            $"GameBuddy window mode {mode}: SetForegroundWindow={(activated ? "accepted" : "refused, used BringWindowToTop")}.",
            LogLevel.Info);
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

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool BringWindowToTop(IntPtr hWnd);

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
