param(
    [string]$Root = 'C:\gamebuddy-cbus2',
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Continue'

# Last variable, and the one that decides whether the file-bus design can work at all on this host:
# does the guest reach an INTERACTIVE logon? LogonCommand runs after the user session starts, so if it
# never runs, the guest either did not reach a session or the command was rejected.
#
# Three observables, none of which needs the guest's control tree:
#   * vmmemWindowsSandbox working set over time (a guest that boots and then restarts shows a drop)
#   * whether an RDP client window for the sandbox exists
#   * whether ANY file appears in the share - including one the guest would write by default
#
# The share gets a file the guest can find trivially, and the logon command uses the simplest
# possible form (a bare `cmd /c echo`), so a syntax problem in our worker cannot explain silence.
if (Test-Path -LiteralPath $Root) { Remove-Item -Recurse -Force -LiteralPath $Root }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-Content -LiteralPath (Join-Path $Root 'host-marker.txt') -Value 'written by host' -Encoding UTF8

$wsb = Join-Path $Root 'last.wsb'
$xml = @'
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>__ROOT__</HostFolder>
      <SandboxFolder>C:\share</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Disable</Networking>
  <LogonCommand>
    <Command>cmd.exe /c "echo guest-ran > C:\share\guest-marker.txt"</Command>
  </LogonCommand>
</Configuration>
'@
$xml = $xml.Replace('__ROOT__', $Root)
[System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$started = Get-Date
Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null
"launched $($started.ToString('HH:mm:ss'))"

$guestMarker = Join-Path $Root 'guest-marker.txt'
$peak = 0
$dropped = $false
$lastMemory = 0
for ($tick = 1; $tick -le [math]::Ceiling($TimeoutSeconds / 5); $tick++) {
    Start-Sleep -Seconds 5
    $vm = Get-Process -Name 'vmmemWindowsSandbox' -ErrorAction SilentlyContinue
    $memory = 0
    if ($vm) { $memory = [math]::Round((($vm | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB) }
    if ($memory -gt $peak) { $peak = $memory }
    # A memory drop of more than 15% after a peak is the signature of a guest restart (first boot
    # completing into a second boot, or a failed session being retried).
    if (-not $dropped -and $peak -gt 2000 -and $memory -lt ($peak * 0.85) -and $lastMemory -gt 0) {
        $dropped = $true
        "t+$($tick * 5)s: guest memory dropped $peak MB -> $memory MB (a restart)"
    }
    $lastMemory = $memory
    if (Test-Path -LiteralPath $guestMarker) {
        "GUEST WROTE A FILE at t+$($tick * 5)s: " + (Get-Content -LiteralPath $guestMarker -Raw)
        break
    }
}
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)

'== conclusion inputs =='
"elapsed seconds:            $elapsed"
"peak guest memory (MB):     $peak"
"guest memory dropped:       $dropped"
"guest wrote to the share:   $(Test-Path -LiteralPath $guestMarker)"
"host marker still visible:  $(Test-Path -LiteralPath (Join-Path $Root 'host-marker.txt'))"
'== share contents (as the host sees them) =='
Get-ChildItem -LiteralPath $Root | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 100

# Capture the sandbox window if it is genuinely on top, for the record.
$shotPath = Join-Path $Root 'sandbox-window.png'
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"screenshot: $shotPath"
