# Phase cleanup: ask the launch driver to tear down, sweep for this run's own leftover stage processes, kill only
# this lane's own browser/driver processes, verify the ports are closed, verify NO tracked file in the main
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

# `CreationDate` arrives as a CIM datetime; it is rendered into the one ISO-8601 spelling the kit's ledger
# records (`probes/process-table.ps1` `StartTime`), so the recorded string and this one are comparable.
function Start-TimeOf($row) {
  if ($null -eq $row.CreationDate) { return $null }
  try { return ([datetime]$row.CreationDate).ToString('o') } catch { return ([string]$row.CreationDate) }
}

# End ONE pid, and only while it is still the process this run started.
#
# A pid is not an identity: Windows hands a dead process's number to the next one. Measured 2026-11-24
# (`.tmp/lane-gen2prove.md` §12): the launch driver's pid 19420 had been reused by an unrelated `conhost`
# minutes after it exited, so the force-kill below would have ended a stranger on a busier machine - the
# incident #3715 exists to prevent. Two facts can claim a pid here, in this order: the OS start time this
# run's ledger recorded for it (`state/run-processes.jsonl`, `lib/run-owner.mjs`), or a command line that
# names this run's own stage. Anything else ends nothing and says `pid_reused`.
function Stop-VerifiedPid([int]$processId, [string]$what, [string]$recordedStart, [string]$commandLineMarker) {
  $row = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $row) {
    Log ("  already_gone: " + $what + " pid=" + $processId + " is not in the process table - nothing to end")
    return
  }
  $actualStart = Start-TimeOf $row
  if (-not [string]::IsNullOrWhiteSpace($recordedStart)) {
    if ($actualStart -ne $recordedStart) {
      Log ("  pid_reused: " + $what + " pid=" + $processId + " now names " + $row.Name + " (started " + $actualStart + "), not the process this run recorded (started " + $recordedStart + ") - left alive")
      return
    }
  } elseif (-not [string]::IsNullOrWhiteSpace($commandLineMarker)) {
    $commandLine = [string]$row.CommandLine
    if ($commandLine.IndexOf($commandLineMarker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      Log ("  pid_reused: " + $what + " pid=" + $processId + " has no recorded start time and its command line does not name this run (" + $commandLineMarker + ") - now names " + $row.Name + " (started " + $actualStart + ") - left alive")
      return
    }
  } else {
    Log ("  pid_reused: " + $what + " pid=" + $processId + " has neither a recorded start time nor a stage marker to claim it - now names " + $row.Name + " (started " + $actualStart + ") - left alive")
    return
  }
  Log ("  killing " + $what + " pid=" + $processId + " name=" + $row.Name + " started " + $actualStart + " (identity matched)")
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
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
  Log "  launch driver did NOT report DONE-LAUNCH within 120s - ending this run's own processes, each only while its identity still matches"
  # The pid file names whichever process holds that number NOW, so it is read as a CLAIM to be checked against
  # the ledger and never as an identity. The LAST matching row wins: the ledger is append-only and a reused
  # stage carries earlier invocations' rows, so the newest statement about a pid is the one this run wrote.
  $ledger = @()
  $ledgerFile = Join-Path $stateDir "run-processes.jsonl"
  if (Test-Path $ledgerFile) {
    foreach ($line in (Get-Content $ledgerFile -ErrorAction SilentlyContinue)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $ledger += ($line | ConvertFrom-Json) } catch { }
    }
  }
  $launchPid = 0
  $launchPidText = [string]((Get-Content (Join-Path $stateDir "launch-driver.pid") -ErrorAction SilentlyContinue | Select-Object -First 1))
  if ([int]::TryParse($launchPidText.Trim(), [ref]$launchPid) -and $launchPid -gt 0) {
    # The launch driver's command line carries this run's own `state/run.json` path, so the stage root claims it.
    $driverRecord = $ledger | Where-Object { [int]$_.pid -eq $launchPid -and $_.role -eq 'launch-driver' -and $_.retired -ne $true } | Select-Object -Last 1
    Stop-VerifiedPid $launchPid "launch driver" ([string]$driverRecord.startTime) $StageRoot
  } else {
    Log ("  no launch driver pid to end (launch-driver.pid holds " + $launchPidText + ")")
  }
  $state = Get-Content $launchStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  if ($state) {
    # The Host child is claimed by the start time launch.json wrote beside its pid; its command line names no
    # part of this run (`phases/launch.mjs`), so a child with no recorded start time is reported, not killed.
    if ($state.childPid) {
      Stop-VerifiedPid ([int]$state.childPid) "child (the mounted Host)" ([string]$state.childStartTime) $null
    }
    # The browser is the one process here whose command line does name this run: its own user-data-dir.
    if ($state.browserPid) {
      Stop-VerifiedPid ([int]$state.browserPid) "browser" ([string]$state.browserStartTime) (Join-Path $StageRoot "browser-profile")
    }
  }
  Start-Sleep -Seconds 5
}

Log "=== 3. orphan sweep: this run's own guardian/host processes ==="
# The population is THIS run's stage root inside the executable path - not a path FORM and not an image name.
# Both of those named processes this run never started: measured 2026-11-20 on `frontend--r12`, the predicate
# `ExecutablePath -like '*\\?\*GameBuddy*'` killed pid 20304, another lane's GameBuddy.Desktop.Tests Host
# (`\\?\C:\Users\long\AppData\Local\Temp\GameBuddy.Desktop.Tests\b5bf2f14…\Programs\GameBuddy\…\runtime\node.exe`,
# started 04:06:35), and `Name -like '*Guardian*'` would equally claim an operator's installed GameBuddy.
# A process this run launched runs out of this run's stage root; that is the fact, so that is the query.
function Test-RunOwnedPath([string]$exePath) {
  if ([string]::IsNullOrWhiteSpace($exePath)) { return $false }
  $normalized = $exePath.Replace('\\?\', '')
  return $normalized.StartsWith($StageRoot, [System.StringComparison]::OrdinalIgnoreCase)
}
for ($i = 0; $i -lt 4; $i++) {
  $all = Get-CimInstance Win32_Process
  $orphans = $all | Where-Object { Test-RunOwnedPath $_.ExecutablePath }
  if (@($orphans).Count -eq 0) { break }
  foreach ($p in $orphans) { Log ("  killing orphan pid=" + $p.ProcessId + " name=" + $p.Name + " path=" + $p.ExecutablePath); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
$all = Get-CimInstance Win32_Process
$guardians = $all | Where-Object { Test-RunOwnedPath $_.ExecutablePath }
Log ("  stage-root processes remaining: " + @($guardians).Count)

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