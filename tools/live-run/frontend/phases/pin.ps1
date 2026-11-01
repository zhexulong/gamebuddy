# Phase pin: create a detached worktree at the pinned commit and materialize the worktree
# prerequisites a bare worktree lacks, all from the MAIN checkout. NO OVERLAY: if anything here
# needs a patch, the phase stops and reports instead of patching.
#
# Materialized from `$Repo` (the main checkout):
#   - root node_modules                  junction
#   - vendor/{pi-koe,magic-context}      junction (keeps `git diff --ignore-submodules` sane)
#   - host/node_modules                  real dir; junction every child EXCEPT typescript,
#                                        which is ROBACOPIED (a junction makes host's tsc entry
#                                        resolve out of the repo root: typescript_entry_escapes_repository_root)
#   - dialogue-web/node_modules          real dir; junction every child EXCEPT vite,
#                                        which is ROBACOPIED (vite must be physically present)
#   - dialogue-web/node_modules/{rolldown,postcss,esbuild,picomatch,tinyglobby,jiti,lightningcss,yaml}
#                                        junctioned from the main checkout's pnpm virtual store
#   - windows-stale-lock-reclaimer/.dist ROBACOPIED (the build phase rebuilds it fresh)
#   - integrations/stardew/bin/Release/net6.0   built fresh in the build phase (never copied)
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Worktree,
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$Commit,
  [Parameter(Mandatory = $true)][string]$Log
)
$ErrorActionPreference = 'Continue'
Remove-Item $Log -Force -ErrorAction SilentlyContinue
function Log($t) { Write-Output $t; Add-Content -Path $Log -Value $t -Encoding utf8 }

Log "=== PIN: detached worktree at $Commit (NO OVERLAY EVER) ==="
$resolved = (git -C $Repo rev-parse --verify "$Commit^{commit}" 2>&1)
if ($LASTEXITCODE -ne 0) { Log "  CANNOT RESOLVE COMMIT: $Commit"; Log "DONE-PIN-FAIL"; exit 1 }
Log ("  resolved commit=" + $resolved)

# Only ever remove a worktree at OUR OWN stage path; never anyone else's checkout/workspace.
$wtFull = [System.IO.Path]::GetFullPath($Worktree)
$stageFull = [System.IO.Path]::GetFullPath($StageRoot)
if (-not $wtFull.StartsWith($stageFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  Log "  REFUSING: worktree path is outside this run's stage root"; Log "DONE-PIN-FAIL"; exit 1
}
if (Test-Path $Worktree) {
  git -C $Repo worktree remove --force $Worktree 2>&1 | ForEach-Object { Log ("  | remove: " + $_) }
  Remove-Item $Worktree -Recurse -Force -ErrorAction SilentlyContinue
  Log "  cleared previous worktree at $Worktree"
}

git -C $Repo worktree add --detach $Worktree $Commit 2>&1 | ForEach-Object { Log ("  | " + $_) }
if ($LASTEXITCODE -ne 0) { Log "  DONE-PIN-FAIL (worktree add failed)"; exit 1 }
Log ("  worktree HEAD=" + (git -C $Worktree rev-parse HEAD))
if ((git -C $Worktree rev-parse HEAD) -ne $resolved) { Log "  HEAD MISMATCH"; Log "DONE-PIN-FAIL"; exit 1 }

function LinkDir($target, $link) {
  if (Test-Path $link) { return }
  try {
    New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null
  } catch {
    # Never shell out to cmd.exe: the inherited environment block can exceed cmd's limit and the
    # junction then fails with "The input line is too long". Physical copy is the honest fallback.
    Log ("  junction FAILED (" + $_.Exception.Message + ") - copying " + $link)
    New-Item -ItemType Directory -Force $link | Out-Null
    robocopy $target $link /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}

Log "=== 1. root node_modules junction ==="
LinkDir (Join-Path $Repo "node_modules") (Join-Path $Worktree "node_modules")

Log "=== 2. vendor submodules: junction when the worktree copy is an empty stub ==="
New-Item -ItemType Directory -Force (Join-Path $Worktree "vendor") | Out-Null
foreach ($name in @('pi-koe','magic-context')) {
  $link = Join-Path $Worktree "vendor\$name"
  if (-not (Test-Path $link)) { LinkDir (Join-Path $Repo "vendor\$name") $link; continue }
  $entry = Get-Item $link -Force -ErrorAction SilentlyContinue
  $linkType = if ($entry) { $entry.LinkType } else { $null }
  $count = if ($entry -and -not $linkType) { @(Get-ChildItem $link -Force -ErrorAction SilentlyContinue).Count } else { -1 }
  if ($entry -and -not $linkType -and $count -le 1) {
    Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue
    try {
      New-Item -ItemType Junction -Path $link -Target (Join-Path $Repo "vendor\$name") -ErrorAction Stop | Out-Null
      Log ("  junctioned " + $name)
    } catch {
      Log ("  junction FAILED for " + $name + ": " + $_.Exception.Message)
    }
  }
}
Log ("  vendor/magic-context packages=" + ((Get-ChildItem (Join-Path $Worktree 'vendor\magic-context\packages') -Force -Name -ErrorAction SilentlyContinue | Select-Object -First 2) -join ','))
Log ("  vendor/pi-koe LinkType=" + (Get-Item (Join-Path $Worktree 'vendor\pi-koe') -Force).LinkType)

Log "=== 3. host/node_modules: real dir, REAL typescript (robocopy), junctions for the rest ==="
$hostNm = Join-Path $Worktree "host\node_modules"
New-Item -ItemType Directory -Force $hostNm | Out-Null
foreach ($child in @(Get-ChildItem (Join-Path $Repo "host\node_modules") -Force)) {
  if ($child.Name -eq 'typescript') { continue }
  LinkDir $child.FullName (Join-Path $hostNm $child.Name)
}
$tsSource = (Resolve-Path (Join-Path $Repo "host\node_modules\typescript")).Path
$sw = [Diagnostics.Stopwatch]::StartNew()
robocopy $tsSource (Join-Path $hostNm "typescript") /E /NFL /NDL /NJH /NJS /NP | Out-Null
$sw.Stop()
Log ("  typescript copied in " + [int]$sw.Elapsed.TotalSeconds + "s; tsc.js present=" + (Test-Path (Join-Path $hostNm "typescript\lib\tsc.js")))

Log "=== 4. dialogue-web/node_modules: real dir, REAL vite (robocopy), junctions for the rest ==="
$dwNm = Join-Path $Worktree "dialogue-web\node_modules"
New-Item -ItemType Directory -Force $dwNm | Out-Null
foreach ($child in @(Get-ChildItem (Join-Path $Repo "dialogue-web\node_modules") -Force)) {
  if ($child.Name -eq 'vite') { continue }
  LinkDir $child.FullName (Join-Path $dwNm $child.Name)
}
$viteSource = (Resolve-Path (Join-Path $Repo "dialogue-web\node_modules\vite")).Path
$sw2 = [Diagnostics.Stopwatch]::StartNew()
robocopy $viteSource (Join-Path $dwNm "vite") /E /NFL /NDL /NJH /NJS /NP | Out-Null
$sw2.Stop()
Log ("  vite copied in " + [int]$sw2.Elapsed.TotalSeconds + "s; vite.js present=" + (Test-Path (Join-Path $dwNm "vite\bin\vite.js")))

Log "=== 4b. vite pnpm siblings ← main checkout node_modules/.pnpm/node_modules ==="
foreach ($p in @("rolldown","postcss","esbuild","picomatch","tinyglobby","jiti","lightningcss","yaml")) {
  $source = Join-Path $Repo "node_modules\.pnpm\node_modules\$p"
  $target = Join-Path $dwNm $p
  if (-not (Test-Path $source)) { Log ("  MISSING IN MAIN CHECKOUT: " + $p); continue }
  if (Test-Path $target) { Log ("  already present: " + $p); continue }
  try {
    New-Item -ItemType Junction -Path $target -Target $source -ErrorAction Stop | Out-Null
    Log ("  added " + $p + " -> " + $source)
  } catch {
    Log ("  FAILED " + $p + " -> " + $source + " :: " + $_.Exception.Message)
  }
}

Log "=== 4c. windows-stale-lock-reclaimer/.dist (copied; the build phase rebuilds it fresh) ==="
$recDir = Join-Path $Worktree "host\native\windows-stale-lock-reclaimer\.dist"
$recSrc = Join-Path $Repo "host\native\windows-stale-lock-reclaimer\.dist"
if (Test-Path $recSrc) {
  New-Item -ItemType Directory -Force $recDir | Out-Null
  robocopy $recSrc $recDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Log ("  .dist copied; exe present=" + (Test-Path (Join-Path $recDir 'win-x64\GameBuddy.WindowsStaleLockReclaimer.exe')))
} else {
  Log ("  NO main-checkout .dist to copy; the build phase must build it")
}

Log "=== 4d. launcher authority exports (the tracked seam the kit consumes) ==="
$launcherFile = Join-Path $Worktree "tools\desktop-composition-launch.mjs"
if (-not (Test-Path $launcherFile)) { Log "  LAUNCHER MISSING IN WORKTREE"; Log "DONE-PIN-FAIL"; exit 1 }
$missingExports = @()
foreach ($fn in @("launchDesktopCompositionGateChild","desktopCompositionMutableRootPaths","measureDesktopCompositionRunRoots","assertDesktopCompositionRunRoots","readDesktopCompositionRuntimeRoot","readProductionPointer")) {
  if (-not (Select-String -Path $launcherFile -Pattern ("export (async\s+)?function " + $fn) -Quiet)) { $missingExports += $fn }
}
Log ("  missing exports = [" + ($missingExports -join ',') + "]")
if (@($missingExports).Count -gt 0) { Log "  PINNED COMMIT'S LAUNCHER LACKS A REQUIRED EXPORT"; Log "DONE-PIN-FAIL"; exit 1 }

Log "=== 5. CONTAINMENT CHECK ==="
$ok = $true
foreach ($p in @("host\node_modules\typescript\lib\tsc.js", "dialogue-web\node_modules\vite\bin\vite.js")) {
  $real = (Resolve-Path (Join-Path $Worktree $p)).Path
  $inside = $real.StartsWith($wtFull, [System.StringComparison]::OrdinalIgnoreCase)
  Log ("  $p inside worktree=" + $inside + " real=" + $real)
  if (-not $inside) { $ok = $false }
}
$siblingCount = 0
foreach ($p in @("rolldown","postcss","esbuild","picomatch","tinyglobby","jiti","lightningcss","yaml")) {
  if (Test-Path (Join-Path $dwNm $p)) { $siblingCount++ } else { Log ("  MISSING sibling: " + $p); $ok = $false }
}
Log ("  vite siblings present=" + $siblingCount + "/8")
$dirty = (git -C $Worktree diff --name-only HEAD --ignore-submodules=all)
Log ("  worktree diff vs HEAD = [" + ($dirty -join ',') + "]")
if (@($dirty).Count -gt 0) { $ok = $false; Log "  WORKTREE DIRTY AFTER MATERIALIZATION (an overlay is present) — stopping" }
Log ("  ok=" + $ok)
if (-not $ok) { Log "DONE-PIN-FAIL"; exit 1 }
Log "DONE-PIN"