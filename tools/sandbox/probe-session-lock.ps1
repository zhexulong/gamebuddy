$ErrorActionPreference = 'Continue'

# The platform allows exactly one running sandbox. After a guest shuts itself down, the session lock is
# released by the Host Compute Service, not by the UI processes: `WindowsSandbox.exe` and even `vmwp` can
# be gone while the platform still refuses a new instance. So this reports the two things that decide
# whether a launch can succeed right now:
#   * any sandbox/HCS process still alive
#   * whether a probe launch is accepted or refused (and, if refused, the dialog it raises)
'== processes =='
$holders = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'WindowsSandbox|vmwp|vmmemWindowsSandbox' }
if ($holders) {
    $holders | ForEach-Object { "  pid=$($_.ProcessId) $($_.Name)" }
} else {
    '  none'
}

'== a session lock can outlive its processes; ask the platform directly =='
# A launch with a deliberately trivial configuration is the cheapest way to ask "is an instance allowed
# right now". The launcher exits quickly when refused.
$probeDir = Join-Path $env:TEMP 'gamebuddy-lock-probe'
if (Test-Path -LiteralPath $probeDir) { Remove-Item -Recurse -Force -LiteralPath $probeDir }
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
$wsb = Join-Path $probeDir 'p.wsb'
[System.IO.File]::WriteAllText($wsb, @'
<Configuration>
  <Networking>Disable</Networking>
</Configuration>
'@, (New-Object System.Text.UTF8Encoding($false)))

$launcher = Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" -PassThru -ErrorAction SilentlyContinue
if ($launcher) {
    $exited = $launcher.WaitForExit(15000)
    if ($exited) {
        "  launcher exited with code $($launcher.ExitCode)"
        '  (a non-zero code here, or an immediate exit, is the platform refusing the launch)'
    } else {
        '  launcher still running: an instance was accepted'
    }
} else {
    '  Start-Process returned nothing'
}

Start-Sleep -Seconds 3
'== after the probe =='
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'WindowsSandbox|vmwp' } |
    Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String -Width 100
