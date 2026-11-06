param(
    [string]$Output = 'E:\projects\ai-game-companion\scratch\guest-capture.png',
    [string]$WindowTitle = 'Windows Sandbox',
    [int]$SettleMilliseconds = 1200
)

$ErrorActionPreference = 'Stop'

# Bring the sandbox window to the front, then screenshot the screen.
#
# `PrintWindow` returned a 158x26 strip for this window: an RDP/DirectComposition surface renders into
# its own swap chain, so asking the window to paint itself yields the frame, not the content. A real
# screen capture is the only way to see what the guest is displaying - and it needs the window in front,
# which needs a foreground grant the host does not have while another app holds focus. That grant can
# fail; when it does, the honest report is "could not bring it forward", not a picture of the wrong
# window.
Add-Type -Path (Join-Path $PSScriptRoot 'WindowCapture.cs') -ReferencedAssemblies System.Drawing
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$handle = [WindowCapture]::FindByTitle($WindowTitle)
"window handle: $handle"
if ($handle -eq [IntPtr]::Zero) {
    'no visible Windows Sandbox window'
    exit 2
}

$null = [WindowCapture]::BringToFront($handle)
Start-Sleep -Milliseconds $SettleMilliseconds

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

# Report what is actually in front, so a capture of the wrong window cannot be mistaken for the guest.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FrontWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public static string Title() {
        var sb = new StringBuilder(512);
        GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
        return sb.ToString();
    }
}
"@
"saved: $Output"
"foreground window title: [$([FrontWindow]::Title())]"
