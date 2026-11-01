# Phase cleanup: ask the launch driver to tear down, sweep for \\?\ guardian orphans, kill only this
# lane's own browser/driver processes, verify the ports are closed, verify NO tracked file in the main
# checkout changed, and report the KEPT run root. Nothing here touches the main checkout's files.
param(
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$OutRoot,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$RunConfigPath,
  [Parameter(Mandatory = $true)][string]$Log
)
$ErrorActionPreference = 'Continue'
Remove-Item $Log -Force -ErrorAction SilentlyContinue
function Log($t) { Write-Output $t; Add-Content -Path $Log -Value $t -Encoding utf8 }

Log "=== CLEANUP ==="
$run = Get-Content $RunConfigPath -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
if (-not $run) { Log "  run config unreadable"; Log "DONE-CLEANUP-FAIL"; exit 1 }
$stateDir = Join-Path $StageRoot "state"
$launchLog = Join-Path $StageRoot "logs\launch.log"
$launchStateFile = Join-Path $stateDir "launch.json"
$cdpPort = [int]$run.cdpPort
$tag = $run.tag

function Fingerprint($root) {
  $files = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue)
  $tavern = Join-Path $root "data\tavern"
  $newest = $null
  if (Test-Path $tavern) {
    $newest = Get-ChildItem $tavern -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
  return [pscustomobject]@{
    exists = (Test-Path $root)
    fileCount = $files.Count
    newestTavernFile = if ($newest) { $newest.FullName } else { $null }
    newestTavernMtime = if ($newest) { $newest.LastWriteTimeUtc.ToString("o") } else { $null }
  }
}

$prod = Join-Path ($run.homeLocalAppData) "GameBuddy"
Log "=== 1. production fingerprint (before teardown) ==="
$prodBefore = Fingerprint $prod
Log ("  " + ($prodBefore | ConvertTo-Json -Compress))

Log "=== 2. ask the launch driver to tear down ==="
Set-Content -Path (Join-Path $stateDir "stop.flag") -Value "stop" -Encoding ascii
$waited = 0
$done = $false
while ($waited -lt 120) {
  $tail = Get-Content $launchLog -Tail 8 -ErrorAction SilentlyContinue
  if (($tail -join " ") -match 'DONE-LAUNCH') { Log ("  launch driver reported DONE-LAUNCH after ${waited}s"); $done = $true; break }
  Start-Sleep -Seconds 3
  $waited += 3
}
if (-not $done) {
  Log "  launch driver did NOT report DONE-LAUNCH within 120s — force-killing its processes"
  $launchPid = Get-Content (Join-Path $stateDir "launch-driver.pid") -ErrorAction SilentlyContinue
  if ($launchPid) { Log ("  killing launch driver pid=" + $launchPid); Stop-Process -Id ([int]$launchPid) -Force -ErrorAction SilentlyContinue }
  $state = Get-Content $launchStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  if ($state) {
    if ($state.childPid)   { Log ("  killing child pid=" + $state.childPid);   Stop-Process -Id ([int]$state.childPid) -Force -ErrorAction SilentlyContinue }
    if ($state.browserPid) { Log ("  killing browser pid=" + $state.browserPid); Stop-Process -Id ([int]$state.browserPid) -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 5
}

Log "=== 3. orphan sweep: guardian / `\\?\`-prefixed children ==="
for ($i = 0; $i -lt 4; $i++) {
  $all = Get-CimInstance Win32_Process
  $orphans = $all | Where-Object { $_.ExecutablePath -like '*\\?\*GameBuddy*' -or $_.Name -like '*Guardian*' }
  if (@($orphans).Count -eq 0) { break }
  foreach ($p in $orphans) { Log ("  killing orphan pid=" + $p.ProcessId + " name=" + $p.Name + " path=" + $p.ExecutablePath); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
$all = Get-CimInstance Win32_Process
$guardians = $all | Where-Object { $_.ExecutablePath -like '*\\?\*GameBuddy*' -or $_.Name -like '*Guardian*' }
Log ("  guardian / \\?\ processes remaining: " + @($guardians).Count)

Log "=== 4. this lane's own browser (only its own user-data-dir) and stage processes ==="
$profile = Join-Path $StageRoot "browser-profile"
foreach ($p in ($all | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*$profile*" })) {
  Log ("  killing lane Edge pid=" + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

Log "=== 5. any process still owned by this lane (stage paths) ==="
$all = Get-CimInstance Win32_Process
$mine = $all | Where-Object {
  $_.CommandLine -like "*$StageRoot*" -or $_.CommandLine -like "*tools\shots\phases\launch.mjs*"
}
foreach ($p in $mine) { Log ("  STILL: pid=" + $p.ProcessId + " name=" + $p.Name + " path=" + $p.ExecutablePath) }
if (@($mine).Count -eq 0) { Log "  NONE" }

Log "=== 6. ports ==="
$lt = Get-NetTCPConnection -LocalPort $cdpPort -State Listen -ErrorAction SilentlyContinue
Log ("  cdp port " + $cdpPort + " listening = " + (@($lt).Count -gt 0))
$state2 = Get-Content $launchStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
if ($state2 -and $state2.port) {
  $pt = Get-NetTCPConnection -LocalPort ([int]$state2.port) -State Listen -ErrorAction SilentlyContinue
  Log ("  product port " + $state2.port + " listening = " + (@($pt).Count -gt 0))
}

Log "=== 7. production fingerprint after teardown ==="
$prodAfter = Fingerprint $prod
Log ("  " + ($prodAfter | ConvertTo-Json -Compress))
Log ("  stray roots in LOCALAPPDATA: " + (@(Get-ChildItem ([System.IO.Path]::GetDirectoryName($prod)) -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('tavern','contexts','settings','stardew-installation-registration','.gamebuddy-semantic-continuity-v1') } | Select-Object -ExpandProperty Name) -join ','))

Log "=== 8. run root KEPT ==="
$root = Join-Path $StageRoot "root"
Log ("  " + $root + " exists = " + (Test-Path $root))
$total = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue).Count
Log ("  run root total files = " + $total)
Log ("  top-level entries: [" + ((Get-ChildItem $root -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') + "]")
Get-ChildItem $root -Recurse -File -Filter *.jsonl -Force -ErrorAction SilentlyContinue | ForEach-Object { Log ("    jsonl: " + $_.FullName) }

Log "=== 9. tracked files in the MAIN checkout ==="
$st = git -C $Repo status --porcelain
$st | ForEach-Object { Log ("  " + $_) }
$changed = @($st | Where-Object { $_ -match '^ ?[MADRCU]' })
Log ("  entry count = " + @($st).Count + "; tracked-changed count = " + $changed.Count)

Log "=== 10. pinned worktree still clean ==="
$wt = Join-Path $StageRoot "worktree"
if (Test-Path $wt) {
  Log ("  " + $wt + " HEAD=" + (git -C $wt rev-parse HEAD))
  Log ("  changed files = [" + (((git -C $wt diff --name-only HEAD --ignore-submodules=all) -join ',')) + "]")
} else {
  Log ("  worktree absent at " + $wt)
}

Log "DONE-CLEANUP"