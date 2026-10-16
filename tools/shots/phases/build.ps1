# Phase build: typecheck, build the Stardew Mod, build windows-stale-lock-reclaimer, then the
# Host generation via the project's own builder. NEVER build-test-artifact-locked.mjs; NEVER run two
# builds at once. The generation builder ('host\scripts\build-desktop-launcher-test-generation.mjs
# <out> <dir-that-directly-contains-node.exe> --full-runtime-tree') is the ONLY production-shaped
# generation build and the second argument MUST be a directory with node.exe directly inside — a
# runtime ROOT fails with desktop_launcher_test_fixture_node_missing.
param(
  [Parameter(Mandatory = $true)][string]$Worktree,
  [Parameter(Mandatory = $true)][string]$OutRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeDir,
  [Parameter(Mandatory = $true)][string]$GameDir,
  [Parameter(Mandatory = $true)][string]$Log
)
$ErrorActionPreference = 'Continue'
Remove-Item $Log -Force -ErrorAction SilentlyContinue
function Log($t) { Write-Output $t; Add-Content -Path $Log -Value $t -Encoding utf8 }

Log "=== BUILD (pinned worktree, no overlays) ==="
Log ("  worktree HEAD=" + (git -C $Worktree rev-parse HEAD))
Log ("  worktree changed files before build=[" + (((git -C $Worktree diff --name-only HEAD --ignore-submodules=all) -join ',')) + "]")
Log ("  runtime source node.exe exists=" + (Test-Path (Join-Path $RuntimeDir 'node.exe')))
if (-not (Test-Path (Join-Path $RuntimeDir 'node.exe'))) { Log "  RUNTIME DIR DOES NOT DIRECTLY CONTAIN node.exe"; Log "DONE-BUILD-FAIL"; exit 1 }

Log "=== 1. host typecheck ==="
Push-Location $Worktree
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $tc = node host/node_modules/typescript/lib/tsc.js --project host/tsconfig.json --noEmit 2>&1
  $sw.Stop()
  Log ("  exit=" + $LASTEXITCODE + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s errors=" + (@($tc | Where-Object { $_ -match 'error TS' }).Count))
  if ($LASTEXITCODE -ne 0) {
    ($tc | Select-Object -First 20) | ForEach-Object { Log ("  | " + $_) }
    Log "DONE-BUILD-FAIL"; exit 1
  }
} finally {
  Pop-Location
}

Log "=== 2. Mod build ==="
if (-not (Test-Path (Join-Path $GameDir 'Stardew Valley.exe'))) { Log "  GAMEDIR MISSING: $GameDir"; Log "DONE-BUILD-FAIL"; exit 1 }
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = dotnet build (Join-Path $Worktree "integrations\stardew\GameBuddy.Stardew.csproj") -c Release --nologo -v minimal "-p:GamePath=$GameDir" 2>&1
$sw.Stop()
Log ("  Mod build exit=" + $LASTEXITCODE + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
$r | Select-Object -Last 6 | ForEach-Object { Log ("  | " + $_) }
$modDll = Join-Path $Worktree "integrations\stardew\bin\Release\net6.0\GameBuddy.Stardew.dll"
Log ("  Mod dll present=" + (Test-Path $modDll))
if (-not (Test-Path $modDll)) { Log "DONE-BUILD-FAIL"; exit 1 }
Log ("  Mod dll sha256=" + (Get-FileHash $modDll -Algorithm SHA256).Hash)

Log "=== 3. windows-stale-lock-reclaimer .dist ==="
$rec = Join-Path $Worktree "host\native\windows-stale-lock-reclaimer\.dist\win-x64\GameBuddy.WindowsStaleLockReclaimer.exe"
if (Test-Path $rec) {
  Log ("  present, sha256=" + (Get-FileHash $rec -Algorithm SHA256).Hash)
} else {
  Push-Location $Worktree
  try {
    $s = node host/scripts/build-windows-stale-lock-reclaimer.mjs 2>&1
    Log ("  reclaimer build exit=" + $LASTEXITCODE + " present=" + (Test-Path $rec))
    $s | Select-Object -Last 6 | ForEach-Object { Log ("  | " + $_) }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $rec)) { Log "DONE-BUILD-FAIL"; exit 1 }
  Log ("  reclaimer sha256=" + (Get-FileHash $rec -Algorithm SHA256).Hash)
}

Log "=== 4. generation build (project's own builder, --full-runtime-tree) ==="
if (Test-Path $OutRoot) { Log "  clearing artifact root"; Remove-Item $OutRoot -Recurse -Force -ErrorAction SilentlyContinue }
$sw = [Diagnostics.Stopwatch]::StartNew()
$g = node (Join-Path $Worktree "host\scripts\build-desktop-launcher-test-generation.mjs") $OutRoot $RuntimeDir --full-runtime-tree 2>&1
$sw.Stop()
Log ("  generation build exit=" + $LASTEXITCODE + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
$g | Select-Object -Last 15 | ForEach-Object { Log ("  | " + $_) }
if ($LASTEXITCODE -ne 0) { Log "DONE-BUILD-FAIL"; exit 1 }

Log "=== 5. artifact verification ==="
$cur = Join-Path $OutRoot 'current.json'
Log ("  current.json: " + (Get-Content $cur -Raw -ErrorAction SilentlyContinue))
$genDirs = @(Get-ChildItem (Join-Path $OutRoot 'generations') -Name -ErrorAction SilentlyContinue)
Log ("  generation dirs: " + ($genDirs -join ','))
$ok = $true
foreach ($gdir in $genDirs) {
  $entryPresent = Test-Path (Join-Path $OutRoot "generations\$gdir\bootstrap\entry\desktop-host-entry.internal.js")
  $runtimePresent = Test-Path (Join-Path $OutRoot "generations\$gdir\runtime\node.exe")
  Log ("    " + $gdir + ": entry=" + $entryPresent + " runtime node.exe=" + $runtimePresent)
  if (-not ($entryPresent -and $runtimePresent)) { $ok = $false }
  $gm = Join-Path $OutRoot "generations\$gdir\native\stardew-mod\GameBuddy\GameBuddy.Stardew.dll"
  if (Test-Path $gm) {
    $gh = (Get-FileHash $gm -Algorithm SHA256).Hash
    Log ("    staged Mod dll sha256=" + $gh)
    if ($gh -ne (Get-FileHash $modDll -Algorithm SHA256).Hash) { Log "    STAGED MOD DLL MISMATCH vs worktree build"; $ok = $false }
  } else {
    Log "    stage does not contain the Mod dll"; $ok = $false
  }
}
$dirty = (git -C $Worktree diff --name-only HEAD --ignore-submodules=all)
Log ("  worktree changed files after build=[" + ($dirty -join ',') + "]")
if (@($dirty).Count -gt 0) { Log "  WORKTREE DIRTY AFTER BUILD"; $ok = $false }
if (-not (Test-Path $cur)) { $ok = $false }
Log ("  ok=" + $ok)
if (-not $ok) { Log "DONE-BUILD-FAIL"; exit 1 }
Log "DONE-BUILD"