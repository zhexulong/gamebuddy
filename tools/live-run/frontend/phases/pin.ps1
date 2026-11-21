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
#   - windows-{stale-lock-reclaimer,stardew-folder-picker}/.dist   ROBACOPIED, and the pair the
#                                        build phase will CONSUME is verified by that helper's own
#                                        `readVerifiedPair` (probes/verified-helper-pair.mjs). The
#                                        folder picker's pair is REQUIRED: without it its builder
#                                        publishes, which is a restore against the package source.
#   - .tmp/*/nuget-packages              ROBACOPIED (every helper cache on disk; a sixth joins itself)
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
  # Windows can refuse `worktree remove` with `Invalid argument` while the administrative record survives, and
  # then `worktree add` only says `fatal: already exists` - two sentences that name neither the cause nor the
  # remedy. Prune the record, and if the directory really is still there, say so instead of adding.
  git -C $Repo worktree prune 2>&1 | ForEach-Object { Log ("  | prune: " + $_) }
  if (Test-Path $Worktree) {
    # Named as a REFUSAL, with the remedy on the same line: the measured run that died here read
    # `DONE-PIN-FAIL (previous worktree could not be cleared)` in the log and `phase pin failed (exit 1)`
    # in the operator's terminal, so the two facts an operator needs - which path, and what to do - were
    # in neither place. A locked file inside the old worktree (a survivor of the previous run) is the
    # usual cause, which is why the run's own teardown now terminates that run's processes.
    Log ("  previous_worktree_not_cleared:" + $Worktree)
    Log "  remedy: pass a FRESH --out (this --out's stage root still holds its previous worktree); pin has no --reuse, it always re-creates the worktree"
    Log "DONE-PIN-FAIL (previous worktree could not be cleared)"
    exit 1
  }
  Log "  cleared previous worktree at $Worktree"
}

git -C $Repo worktree add --detach $Worktree $Commit 2>&1 | ForEach-Object { Log ("  | " + $_) }
if ($LASTEXITCODE -ne 0) {
  Log ("  previous_worktree_not_cleared:" + $Worktree + " (git kept a record or a directory this run could not replace)")
  Log "  remedy: pass a FRESH --out; pin has no --reuse, it always re-creates the worktree"
  Log "  DONE-PIN-FAIL (worktree add failed)"
  exit 1
}
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

Log "=== 4c. native helper pairs copied from the main checkout ==="
# A pinned worktree starts with none of the helpers' `.dist` roots, and a helper with no pair
# publishes one with `dotnet publish --self-contained win-x64`. Even with a warm
# `.tmp/<helper>/nuget-packages` (section 4c2) that publish still asks the package source for
# vulnerability data, and a machine with no route to api.nuget.org fails it - measured 2026-11-20:
# frontend live runs r9, r10 and r11 all died in the build phase this way.
#
#   windows-stale-lock-reclaimer   not required: build.ps1 builds it when the pair is absent
#   windows-stardew-folder-picker  REQUIRED: whose absence fails the pin
#
# `required` decides ONE thing: whether an ABSENT pair fails the pin. Whether a PRESENT pair is checked is
# never a per-helper decision - every copy below is handed to `probes/verified-helper-pair.mjs`, which asks
# the builder that will CONSUME the pair, so the acceptance rule stays in one place. Measured 2026-11-22
# (`D:\gb-lanes\deathproof-y`, commit 776f169f): the main checkout's reclaimer `.dist\win-x64` held a
# manifest naming sha256 b10eddbf… beside an exe hashing 5d2cb694… (six files, two publishes into one shared
# root). `required = $false` skipped the check, build.ps1 step 3 saw an exe and skipped its rebuild, and the
# generation builder refused the copy `windows_stale_lock_reclaimer_pair_invalid` 137 s into the build phase
# - after the typecheck and the Mod build, with nothing naming the copy as the cause.
$helperPairs = @(
  @{ name = 'windows-stale-lock-reclaimer'; required = $false; builder = 'host\scripts\build-windows-stale-lock-reclaimer.mjs' },
  @{ name = 'windows-stardew-folder-picker'; required = $true; builder = 'host\scripts\build-windows-stardew-folder-picker.mjs' }
)
foreach ($helper in $helperPairs) {
  $src = Join-Path $Repo ("host\native\" + $helper.name + "\.dist")
  $dst = Join-Path $Worktree ("host\native\" + $helper.name + "\.dist")
  if (-not (Test-Path $src)) {
    if (-not $helper.required) {
      Log ("  NO main-checkout .dist to copy for " + $helper.name + "; the build phase must build it")
      continue
    }
    Log ("  windows_stardew_folder_picker_pair_missing: the shared cache has no pair at " + $src)
    Log "  remedy: once, in the main checkout with the package source reachable, run `node host/scripts/build-windows-stardew-folder-picker.mjs`; the pinned build consumes that pair and never restores it"
    Log "DONE-PIN-FAIL (a required helper pair is absent from the shared cache)"
    exit 1
  }
  New-Item -ItemType Directory -Force $dst | Out-Null
  robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
  $entries = @(Get-ChildItem (Join-Path $dst 'win-x64') -Name -ErrorAction SilentlyContinue)
  Log ("  " + $helper.name + " .dist copied; win-x64 entries=[" + ($entries -join ',') + "]")
  $builder = Join-Path $Worktree $helper.builder
  $verdict = (node (Join-Path (Join-Path $PSScriptRoot '..') 'probes\verified-helper-pair.mjs') $builder 2>&1)
  $verdict | ForEach-Object { Log ("  | " + $_) }
  if ($LASTEXITCODE -ne 0) {
    Log ("  " + ($helper.name -replace '-', '_') + "_pair_invalid: the copy at " + $dst + " is not the pair its builder accepts, so the build phase would be handed a helper it refuses or republishes")
    Log "DONE-PIN-FAIL (a native helper pair did not survive the copy)"
    exit 1
  }
}

Log "=== 4c2. native helper NuGet caches (copied; the builds restore into them) ==="
# Five helper builds publish `--self-contained win-x64` with `NUGET_PACKAGES` pointed at
# `<repo>/.tmp/<helper>/nuget-packages` (host/scripts/build-windows-{bootstrap-guardian,reparse-inspector,
# stale-lock-reclaimer,stardew-folder-picker,...}.mjs) and bound each `dotnet` call at 5 minutes. Those directories are
# gitignored, so a pinned worktree starts with empty ones and every run restores the whole runtime pack per helper.
# Measured 2026-11-08: with a warm cache the same build ran in 10s in the main checkout; in the worktree the first run
# died as `windows_bootstrap_guardian_process_timeout` (300s) and, once that cache was copied, the very next helper died
# as `windows_reparse_dotnet_timeout`. That is the shape of a class, so the population is every `.tmp/*/nuget-packages`
# on disk rather than a hand-written list - a sixth helper joins on its own.
$copied = 0
foreach ($cacheDir in @(Get-ChildItem (Join-Path $Repo ".tmp") -Directory -ErrorAction SilentlyContinue)) {
  $src = Join-Path $cacheDir.FullName "nuget-packages"
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path (Join-Path $Worktree ".tmp") (Join-Path $cacheDir.Name "nuget-packages")
  New-Item -ItemType Directory -Force $dst | Out-Null
  robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Log ("  " + $cacheDir.Name + " -> package dirs=" + @(Get-ChildItem $dst -ErrorAction SilentlyContinue).Count)
  $copied += 1
}
if ($copied -eq 0) {
  Log "  no warm helper caches in the main checkout; each build restores cold (slow path, may exceed its 5-minute bound)"
} else {
  Log ("  copied " + $copied + " helper cache(s)")
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