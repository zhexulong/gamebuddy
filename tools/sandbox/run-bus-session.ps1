param(
    [string]$Root = 'C:\gb-bus-v2',
    [int]$GuestTimeoutSeconds = 900
)

$ErrorActionPreference = 'Continue'

# The file-bus control channel, with the mount race fixed.
#
# Root cause this is built on (measured, see FINDINGS.md): `LogonCommand` fires at logon, the mapped
# folder is attached asynchronously by a separate driver, and the gap can be ~158s. A logon command that
# names the share immediately fails silently, which is what made every earlier attempt look like "the
# guest never ran anything". So:
#   * the logon command waits for `C:\bus\guest-worker.ps1` to exist before starting it;
#   * the worker waits for the bus folder before writing anything;
#   * the host waits for the guest's ready file with a budget long enough for a slow mount.
# The old `vmwp==0` precondition is gone: it was measured NOT to be sufficient, and it made the
# harness refuse runs that could have worked.
$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    $script:failures += if ($ok) { 0 } else { 1 }
    "{0,-46} {1,-6} {2}" -f $name, $(if ($ok) { 'ok' } else { 'FAIL' }), $detail
}

if (Test-Path -LiteralPath $Root) { Remove-Item -Recurse -Force -LiteralPath $Root }
foreach ($dir in @('', 'tasks', 'results', 'running')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null
}
Copy-Item -Path (Join-Path $PSScriptRoot 'guest-worker.ps1') -Destination (Join-Path $Root 'guest-worker.ps1') -Force

$wsb = Join-Path $Root 'bus.wsb'
$xml = @'
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>__ROOT__</HostFolder>
      <SandboxFolder>C:\bus</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Disable</Networking>
  <LogonCommand>
    <Command>cmd.exe /c "for /L %i in (1,1,900) do @(if exist C:\bus\guest-worker.ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\bus\guest-worker.ps1) else ping -n 2 127.0.0.1 >nul)"</Command>
  </LogonCommand>
</Configuration>
'@
$xml = $xml.Replace('__ROOT__', $Root)
[System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

$started = Get-Date
Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null

$ready = Join-Path $Root 'guest-ready.txt'
$deadline = (Get-Date).AddSeconds($GuestTimeoutSeconds)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $ready)) { Start-Sleep -Seconds 2 }
$readyElapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
Check 'guest worker announced readiness' (Test-Path -LiteralPath $ready) "after ${readyElapsed}s"
if (-not (Test-Path -LiteralPath $ready)) {
    "failures: $failures"
    exit $failures
}
Get-Content -LiteralPath $ready | ForEach-Object { "    $_" }

$id = 'probe1'
[System.IO.File]::WriteAllText(
    (Join-Path $Root "tasks\$id.json"),
    (@{ id = $id; command = 'Get-Date -Format o; (Get-CimInstance Win32_OperatingSystem).Caption' } | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false)))
$resultPath = Join-Path $Root "results\$id.json"
$resultDeadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $resultDeadline -and -not (Test-Path -LiteralPath $resultPath)) { Start-Sleep -Milliseconds 500 }
Check 'guest executed a host-issued task' (Test-Path -LiteralPath $resultPath) ''
if (Test-Path -LiteralPath $resultPath) {
    $raw = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    "    exitCode: $($raw.exitCode)"
    "    output:   $($raw.output.Trim())"
}

$premiseId = 'probe2'
[System.IO.File]::WriteAllText(
    (Join-Path $Root "tasks\$premiseId.json"),
    (@{ id = $premiseId; command = '"dotnet=" + (if (Get-Command dotnet -ErrorAction SilentlyContinue) { "present" } else { "absent" }) + " node=" + (if (Get-Command node -ErrorAction SilentlyContinue) { "present" } else { "absent" })' } | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false)))
$premisePath = Join-Path $Root "results\$premiseId.json"
$premiseDeadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $premiseDeadline -and -not (Test-Path -LiteralPath $premisePath)) { Start-Sleep -Milliseconds 500 }
if (Test-Path -LiteralPath $premisePath) {
    $premise = Get-Content -LiteralPath $premisePath -Raw | ConvertFrom-Json
    Check 'guest states its own tooling premise' $true $premise.output.Trim()
} else {
    Check 'guest states its own tooling premise' $false 'no result'
}

"failures: $failures"
exit $failures
