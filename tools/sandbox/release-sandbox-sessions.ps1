param(
    [int]$DrainTimeoutSeconds = 120,
    [switch]$VerifyWithProbe
)

$ErrorActionPreference = 'Continue'

# Clear a stuck sandbox session, elevated or not.
#
# Two things this deliberately does NOT do, both learned from failed attempts:
#
#   * It does not stop the `vmcompute` service. `CmService` depends on it, so the SCM refuses with
#     error 1051 ("a stop control has been sent to a service that other running services depend on"),
#     and the follow-up start reports 1056 ("already running"). The service is not the problem anyway:
#     the sandbox VM is, and its worker can be terminated directly.
#
#   * It does not assume killing the UI releases the lock. `WindowsSandbox*.exe` are the client side;
#     the lock is the compute system behind `vmwp`.
#
# What it does, in order: close the UI, then terminate the VM worker (elevated only - it is a protected
# process), then wait for both to disappear, then optionally prove the platform accepts a launch again.
function Test-Elevated {
    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

$elevated = Test-Elevated
"elevated: $elevated"

$ui = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' })
foreach ($process in $ui) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }
}
if ($ui.Count -gt 0) { "closed $($ui.Count) sandbox UI process(es)" } else { 'no sandbox UI process was running' }

# The VM worker is the actual holder. It is protected, so this only works elevated - and that is
# reported rather than attempted silently.
$workers = @(Get-Process -ErrorAction SilentlyContinue -Name 'vmwp')
foreach ($worker in $workers) {
    try {
        Stop-Process -Id $worker.Id -Force -ErrorAction Stop
        "terminated vmwp $($worker.Id)"
    } catch {
        "could not terminate vmwp $($worker.Id): $($_.Exception.Message)"
    }
}
if ($workers.Count -gt 0 -and -not $elevated) {
    'vmwp is a protected process: run this script elevated to terminate it'
}

$waited = 0
while ($waited -lt $DrainTimeoutSeconds) {
    $holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'WindowsSandbox|vmwp' })
    if ($holders.Count -eq 0) { break }
    Start-Sleep -Seconds 2
    $waited += 2
}

$holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'WindowsSandbox|vmwp' })
if ($holders.Count -gt 0) {
    'still held:'
    $holders | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String -Width 80
    'these are held by the Host Compute Service; only elevation can terminate vmwp'
    exit 1
}
"drained after ${waited}s"

if ($VerifyWithProbe) {
    $probeDir = Join-Path $env:TEMP 'gamebuddy-lock-verify'
    if (Test-Path -LiteralPath $probeDir) { Remove-Item -LiteralPath $probeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
    $wsb = Join-Path $probeDir 'p.wsb'
    [System.IO.File]::WriteAllText($wsb, @'
<Configuration>
  <Networking>Disable</Networking>
</Configuration>
'@, (New-Object System.Text.UTF8Encoding($false)))

    Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null
    Start-Sleep -Seconds 8
    $live = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' })
    if ($live.Count -eq 0) {
        'probe launch was refused (no sandbox process appeared)'
        exit 1
    }
    "probe launch accepted ($($live.Count) processes)"
    foreach ($process in $live) { try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Seconds 2
    'probe closed'
}

'ready to launch'
exit 0
