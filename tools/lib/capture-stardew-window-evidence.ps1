param(
    [int]$ProcessId = 0,
    [string]$WindowMode = "visible",
    [string]$OutputDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "tools\artifacts"),
    [string]$Tag = ""
)

if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = if (-not [string]::IsNullOrWhiteSpace($WindowMode)) { $WindowMode } else { "live" }
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class StardewWindowEvidenceNative {
    public struct RECT { public int Left, Top, Right, Bottom; }
    public struct WINDOWPLACEMENT {
        public int length;
        public int flags;
        public int showCmd;
        public int ptMinPosition_x, ptMinPosition_y;
        public int ptMaxPosition_x, ptMaxPosition_y;
        public RECT rcNormalPosition;
    }

    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public class WindowRecord {
        public IntPtr Hwnd;
        public uint ProcessId;
        public string Title;
        public bool IsVisible;
        public bool IsIconic;
        public int ShowCmd;
        public int Left, Top, Right, Bottom, Width, Height;
    }

    public static WindowRecord[] EnumerateWindows(IntPtr hDesktop) {
        List<WindowRecord> list = new List<WindowRecord>();
        EnumDesktopWindows(hDesktop, (hWnd, lParam) => {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            RECT r;
            GetWindowRect(hWnd, out r);
            bool vis = IsWindowVisible(hWnd);
            bool ico = IsIconic(hWnd);
            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(wp);
            GetWindowPlacement(hWnd, ref wp);

            list.Add(new WindowRecord {
                Hwnd = hWnd,
                ProcessId = pid,
                Title = sb.ToString(),
                IsVisible = vis,
                IsIconic = ico,
                ShowCmd = wp.showCmd,
                Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Bottom,
                Width = r.Right - r.Left, Height = r.Bottom - r.Top
            });
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
"@ -ReferencedAssemblies @("System.Collections") -ErrorAction SilentlyContinue

$hDesk = [StardewWindowEvidenceNative]::OpenInputDesktop(0, $false, 0x01FF)
if ($hDesk -eq [IntPtr]::Zero) { $hDesk = [StardewWindowEvidenceNative]::OpenDesktop("Default", 0, $false, 0x01FF) }

$windows = [StardewWindowEvidenceNative]::EnumerateWindows($hDesk)
if ($hDesk -ne [IntPtr]::Zero) {
    [StardewWindowEvidenceNative]::CloseDesktop($hDesk)
}

# Find Stardew game window and console window
$gameWindow = $null
$consoleWindow = $null
if ($ProcessId -gt 0) {
    $gameWindow = $windows | Where-Object { $_.ProcessId -eq $ProcessId -and $_.Title -match "Stardew Valley" } | Select-Object -First 1
    if ($null -eq $gameWindow) {
        $gameWindow = $windows | Where-Object { $_.ProcessId -eq $ProcessId -and $_.IsVisible -and $_.Title -ne "StardewModdingAPI" } | Select-Object -First 1
    }
    $consoleWindow = $windows | Where-Object { $_.ProcessId -eq $ProcessId -and ($_.Title -match "StardewModdingAPI" -or $_.Title -match "SMAPI") } | Select-Object -First 1
}
if ($null -eq $gameWindow) {
    $gameWindow = $windows | Where-Object { $_.Title -match "Stardew Valley" } | Select-Object -First 1
}

$evidence = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    windowMode = $WindowMode
    tag = $Tag
    gameWindow = if ($null -ne $gameWindow) {
        [ordered]@{
            hwnd = $gameWindow.Hwnd.ToInt64()
            processId = $gameWindow.ProcessId
            title = $gameWindow.Title
            isVisible = $gameWindow.IsVisible
            isIconic = $gameWindow.IsIconic
            showCmd = $gameWindow.ShowCmd
            rect = [ordered]@{
                left = $gameWindow.Left
                top = $gameWindow.Top
                right = $gameWindow.Right
                bottom = $gameWindow.Bottom
                width = $gameWindow.Width
                height = $gameWindow.Height
            }
        }
    } else { $null }
    consoleWindow = if ($null -ne $consoleWindow) {
        [ordered]@{
            hwnd = $consoleWindow.Hwnd.ToInt64()
            processId = $consoleWindow.ProcessId
            title = $consoleWindow.Title
            isVisible = $consoleWindow.IsVisible
            isIconic = $consoleWindow.IsIconic
            showCmd = $consoleWindow.ShowCmd
        }
    } else { $null }
}

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
$jsonPath = Join-Path $OutputDir ("window-evidence-$Tag.json")
$evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath

Write-Output ($evidence | ConvertTo-Json -Depth 4)
