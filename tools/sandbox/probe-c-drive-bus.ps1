param(
    [string]$Root = 'C:\gamebuddy-cbus',
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Continue'

# Decisive variable: the host drive that backs the mapped folder.
#
# Every earlier probe mapped E:\... and no guest ever wrote into it. Windows Sandbox's mapped folders
# are known to be brittle for paths that are not on the system drive (reparse points, redirected
# folders, non-system volumes). This run changes ONLY that: same worker, same logon command, host
# folder on C:.
$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    $script:failures += if ($ok) { 0 } else { 1 }
    "{0,-46} {1,-6} {2}" -f $name, $(if ($ok) { 'ok' } else { 'FAIL' }), $detail
}

if (Test-Path -LiteralPath $Root) { Remove-Item -Recurse -Force -LiteralPath $Root }
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'tasks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'results') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'running') | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'guest-worker.ps1') -Destination (Join-Path $Root 'guest-worker.ps1') -Force
Check 'worker staged on C:' (Test-Path (Join-Path $Root 'guest-worker.ps1')) $Root

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
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\bus\guest-worker.ps1</Command>
  </LogonCommand>
</Configuration>
'@
$xml = $xml.Replace('__ROOT__', $Root)
[System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))
Check 'wsb written' (Test-Path $wsb) $wsb

# Free the single-instance/session pool before launching.
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Name 'vmwp' -ErrorAction SilentlyContinue)) { break }
}
Check 'session pool released' (-not (Get-Process -Name 'vmwp' -ErrorAction SilentlyContinue)) 'vmwp'

$started = Get-Date
Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null
"launched at $($started.ToString('HH:mm:ss')), waiting up to ${TimeoutSeconds}s for the guest"

$ready = Join-Path $Root 'guest-ready.txt'
$deadline = $started.AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $ready)) {
    Start-Sleep -Seconds 2
}
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)

if (Test-Path -LiteralPath $ready) {
    Check 'guest worker announced readiness' $true "after ${elapsed}s"
    Get-Content -LiteralPath $ready | ForEach-Object { "    $_" }

    # Round trip through the bus: this is the thing the whole design exists for.
    $id = 'c_probe'
    $task = @{ id = $id; command = 'Get-Date -Format o; $env:COMPUTERNAME' } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $Root "tasks\$id.json"), $task, (New-Object System.Text.UTF8Encoding($false)))
    $resultPath = Join-Path $Root "results\$id.json"
    $resultDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $resultDeadline -and -not (Test-Path -LiteralPath $resultPath)) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $resultPath) {
        Check 'guest executed a task' $true ''
        Get-Content -LiteralPath $resultPath -Raw | ForEach-Object { "    $_" }
    } else {
        Check 'guest executed a task' $false 'no result'
    }
} else {
    Check 'guest worker announced readiness' $false "no ready file after ${elapsed}s"
    'bus contents:'
    Get-ChildItem -LiteralPath $Root | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 100
    'sandbox processes:'
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'Sandbox' } |
        Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String -Width 80
}

"failures: $failures"
exit $failures
