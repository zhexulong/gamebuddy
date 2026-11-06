param(
    [Parameter(Mandatory = $true)][string]$WorkFolder,
    [string]$WindowTitle = 'Windows Sandbox',
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'

# Observe a sandbox guest without touching its RDP surface.
#
# The host cannot read the guest's control tree - the window is a DirectComposition surface - but it
# CAN read pixels and window metadata. Those two are enough to answer "is the guest booting, and what
# is it showing", which is what a mapped-folder channel needs before it can trust silence.
Add-Type -Path (Join-Path $PSScriptRoot 'SandboxWindow.cs')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $WorkFolder)) { New-Item -ItemType Directory -Force -Path $WorkFolder | Out-Null }

function Save-WindowScreenshot {
    param([IntPtr]$Handle, [string]$Path)
    $left = 0; $top = 0; $width = 0; $height = 0
    if ($Handle -eq [IntPtr]::Zero -or -not [SandboxWindow]::TryGetRect($Handle, [ref]$left, [ref]$top, [ref]$width, [ref]$height)) {
        return "screenshot_skipped:no_window"
    }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    return "screenshot:$Path (${width}x${height})"
}

$started = Get-Date
$deadline = $started.AddSeconds($TimeoutSeconds)
$reportPath = Join-Path $WorkFolder 'guest-observation.txt'
$lines = New-Object System.Collections.Generic.List[string]

while ((Get-Date) -lt $deadline) {
    $handle = [SandboxWindow]::FindByTitle($WindowTitle)
    $vm = Get-Process -Name 'vmmemWindowsSandbox' -ErrorAction SilentlyContinue
    $memoryMb = 0
    if ($vm) {
        $memoryMb = [math]::Round((($vm | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB)
    }
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $lines.Add("t+${elapsed}s memoryMb=$memoryMb window=" + $(if ($handle -eq [IntPtr]::Zero) { 'absent' } else { [SandboxWindow]::Describe($handle) }))

    if ($handle -ne [IntPtr]::Zero) {
        [SandboxWindow]::BringToFront($handle)
        $shot = Save-WindowScreenshot -Handle $handle -Path (Join-Path $WorkFolder 'guest-window.png')
        $lines.Add("  $shot")
        # One screenshot of a real window is the evidence; the loop only continues when there is none.
        break
    }
    Start-Sleep -Seconds 5
}

$lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
$lines | ForEach-Object { $_ }
"saved: $reportPath"
