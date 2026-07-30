[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [ValidateSet("Focus", "Escape", "Enter", "Up", "Down", "Left", "Right", "StartLocalCoop")]
    [string]$Action = "Focus",
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
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KEYBDINPUT ki; public MOUSEINPUT mi; public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    public const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 2;
    public static void Key(ushort vk) {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].ki.wVk = vk;
        inputs[1].type = INPUT_KEYBOARD; inputs[1].ki.wVk = vk; inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
            throw new InvalidOperationException("SendInput failed: " + Marshal.GetLastWin32Error());
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

$keys = @{
    Escape = 0x1B; Enter = 0x0D; Up = 0x26; Down = 0x28; Left = 0x25; Right = 0x27
}
if ($Action -eq "StartLocalCoop") {
    # This only navigates the visible in-game menu. A real second XInput device
    # is still required for the Farmhand join action.
    [GameBuddyInput]::Key($keys["Escape"])
    Start-Sleep -Milliseconds 300
    [GameBuddyInput]::Key($keys["Down"])
    Start-Sleep -Milliseconds 150
    [GameBuddyInput]::Key($keys["Down"])
    Start-Sleep -Milliseconds 150
    [GameBuddyInput]::Key($keys["Enter"])
    Write-Output "Sent menu navigation toward Start Local Co-op to Stardew PID $ProcessId."
    exit 0
}

[GameBuddyInput]::Key($keys[$Action])
Write-Output "Sent $Action to Stardew PID $ProcessId. Press Escape manually or run -Action Escape for the safe stop."
