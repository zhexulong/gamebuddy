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

    private static string NormalizeMode(string mode)
    {
        string trimmed = mode.Trim().ToLowerInvariant();
        return trimmed switch
        {
            "hidden" or "background" => "hidden",
            _ => "visible"
        };
    }

    private void ApplyWindowModeInitial()
    {
        string mode = this.GetEffectiveWindowMode();
        this.Monitor.Log($"GameBuddy applying {mode} window mode (non-activating, 60Hz background loop, silent).", LogLevel.Info);

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

        int cmd = mode == "hidden" ? Win32WindowInterop.SW_HIDE : Win32WindowInterop.SW_SHOWNOACTIVATE;
        this.EnforceWindowAsync(cmd);
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
        int cmd = mode == "hidden" ? Win32WindowInterop.SW_HIDE : Win32WindowInterop.SW_SHOWNOACTIVATE;
        this.EnforceWindowAsync(cmd);
    }

    private void EnforceWindowAsync(int nCmdShow)
    {
        if (!OperatingSystem.IsWindows())
            return;

        try
        {
            IntPtr hWnd = GameRunner.instance?.Window?.Handle ?? IntPtr.Zero;
            if (hWnd != IntPtr.Zero)
            {
                Win32WindowInterop.ShowWindowAsync(hWnd, nCmdShow);
            }
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"GameBuddy failed to apply window style {nCmdShow}: {ex.Message}", LogLevel.Trace);
        }
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
