[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
if (-not ('GameBuddyWindowCapture' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class GameBuddyWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@
}

$process = Get-Process -Id $ProcessId -ErrorAction Stop
if ($process.ProcessName -notin @('Stardew Valley', 'StardewModdingAPI')) {
    throw "Refusing to capture non-Stardew process '$($process.ProcessName)'."
}
if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
    throw "Process $ProcessId has no main window handle."
}

$rect = New-Object GameBuddyWindowCapture+RECT
if (-not [GameBuddyWindowCapture]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw 'Unable to query Stardew window bounds.'
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "Invalid Stardew window size ${width}x${height}."
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $hdc = $graphics.GetHdc()
    try {
        if (-not [GameBuddyWindowCapture]::PrintWindow($process.MainWindowHandle, $hdc, 0)) {
            throw "PrintWindow failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
        }
    }
    finally {
        $graphics.ReleaseHdc($hdc)
    }

    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $OutputPath
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
