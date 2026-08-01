[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [ValidateSet("Focus", "Click", "ClickCenter", "Escape", "Enter", "Action", "Up", "Down", "Left", "Right", "StartLocalCoop")]
    [string]$Action = "Focus",
    [int]$ClientX = 0,
    [int]$ClientY = 0,
    [switch]$AllowInput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GameBuddyInput {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError=true)] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError=true)] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    public const uint KEYEVENTF_KEYUP = 2;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public static void Key(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
"@

$p = Get-Process -Id $ProcessId -ErrorAction Stop
if ($p.ProcessName -notmatch "^(StardewModdingAPI|Stardew Valley)$") {
    throw "Refusing input: PID $ProcessId is $($p.ProcessName), not Stardew/SMAPI."
}
if (-not $p.Path -or $p.Path -notlike "*\Stardew Valley\*") {
    throw "Refusing input: process path is outside the installed Stardew Valley directory."
}
if (-not $p.MainWindowHandle -or $p.MainWindowTitle -notmatch "Stardew Valley") {
    throw "Refusing input: Stardew window is not available or title was not recognized."
}

if ($Action -eq "Focus") {
    [void][GameBuddyInput]::ShowWindow($p.MainWindowHandle, 9)
    [void][GameBuddyInput]::SetForegroundWindow($p.MainWindowHandle)
    Write-Output "Focused Stardew PID $ProcessId. No input sent."
    exit 0
}

if (-not $AllowInput) {
    throw "Input is disabled by default. Re-run with -AllowInput after confirming the dedicated test save and target window."
}

if ($Action -eq "StartLocalCoop") {
    & (Join-Path $PSScriptRoot "check-xinput.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Refusing local co-op automation: a second XInput controller endpoint is unavailable."
    }
}

[void][GameBuddyInput]::ShowWindow($p.MainWindowHandle, 9)
[void][GameBuddyInput]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 250

if ($Action -eq "Click" -or $Action -eq "ClickCenter") {
    if ($Action -eq "ClickCenter") {
        $rect = New-Object GameBuddyInput+RECT
        if (-not [GameBuddyInput]::GetWindowRect($p.MainWindowHandle, [ref]$rect)) {
            throw "Unable to query Stardew window bounds."
        }
        $point = New-Object GameBuddyInput+POINT
        $point.X = [int](($rect.Right - $rect.Left) / 2)
        $point.Y = [int](($rect.Bottom - $rect.Top) / 2)
    } else {
        $point = New-Object GameBuddyInput+POINT
        $point.X = $ClientX
        $point.Y = $ClientY
    }
    if (-not [GameBuddyInput]::ClientToScreen($p.MainWindowHandle, [ref]$point)) {
        throw "Unable to translate Stardew client coordinates to screen coordinates."
    }
    if (-not [GameBuddyInput]::SetCursorPos($point.X, $point.Y)) {
        throw "Unable to position cursor in Stardew window."
    }
    [GameBuddyInput]::mouse_event([GameBuddyInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [GameBuddyInput]::mouse_event([GameBuddyInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Write-Output "Clicked Stardew PID $ProcessId at client coordinates ($($point.X), $($point.Y))."
    exit 0
}

$keys = @{
    Escape = 0x1B; Enter = 0x0D; Action = 0x58; Up = 0x26; Down = 0x28; Left = 0x25; Right = 0x27
}
if ($Action -eq "StartLocalCoop") {
    # This only navigates the visible in-game menu. A real second XInput device
    # is still required for the Farmhand join action.
    [GameBuddyInput]::Key([byte]$keys["Escape"])
    Start-Sleep -Milliseconds 300
    [GameBuddyInput]::Key([byte]$keys["Down"])
    Start-Sleep -Milliseconds 150
    [GameBuddyInput]::Key([byte]$keys["Down"])
    Start-Sleep -Milliseconds 150
    [GameBuddyInput]::Key([byte]$keys["Enter"])
    Write-Output "Sent menu navigation toward Start Local Co-op to Stardew PID $ProcessId."
    exit 0
}

[GameBuddyInput]::Key([byte]$keys[$Action])
Write-Output "Sent $Action to Stardew PID $ProcessId. Press Escape manually or run -Action Escape for the safe stop."
