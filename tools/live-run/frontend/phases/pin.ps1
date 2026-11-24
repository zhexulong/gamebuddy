# Phase pin: create a detached worktree at the pinned commit and materialize the worktree
# prerequisites a bare worktree lacks, from the MAIN checkout (and, for the submodules, from their own
# clones at the commits the pin records). NO OVERLAY: if anything here needs a patch, the phase stops and
# reports instead of patching.
#
# Materialized from `$Repo` (the main checkout):
#   - root node_modules                  junction
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
#
# Checked out IN the worktree, at the commits the pin records (never junctioned from a checkout):
#   - vendor/{pi-koe,magic-context}      submodule gitlinks (§2), supplied by `git submodule update
#                                        --init` when the fresh worktree holds the empty stub
#   - vendor/pi-koe/node_modules         junction from a checkout whose pi-koe is at the recorded
#                                        commit; the tsc + esbuild install the compiles resolve from
#   - vendor/pi-koe/dist, packages/voice-protocol/dist   compiled here from the pinned source (§2b)
#   - vendor/magic-context/packages/pi-plugin/dist       copied from a checkout at the recorded commit
#                                        with a clean source tree, and the proof is printed (§2b)
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

# A submodule checkout the pin is about to read: how many files it holds, and the commit it is on.
# An unpopulated gitlink has no `.git` of its own, so BOTH readings are 0/empty rather than an error.
function SubmoduleFiles($dir) {
  if (-not (Test-Path (Join-Path $dir ".git"))) { return 0 }
  $listed = @(git -C $dir ls-files 2>$null)
  if ($LASTEXITCODE -ne 0) { return 0 }
  return $listed.Count
}
function SubmoduleHead($dir) {
  if (-not (Test-Path (Join-Path $dir ".git"))) { return "" }
  # No `Select-Object -First 1` here: stopping a native command's pipeline early leaves $LASTEXITCODE
  # unset, and `$null -ne 0` is true - which turned a successful read into "not-a-checkout".
  $head = @(git -C $dir rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0) { return "" }
  if ($head.Count -eq 0) { return "" }
  return "$($head[0])"
}
# ONE spelling for the invariant, at every population it is asked of (this worktree, and each checkout
# whose dependency install or build output §2b is about to consume).
function LogSubmoduleMismatch($where, $expected, $found) {
  $checkout = if ($found) { $found } else { "not-a-checkout" }
  Log ("  submodule_mismatch: " + $where + " pin=" + $expected + " checkout=" + $checkout)
}

Log "=== 2. submodules: the pin's gitlinks, supplied before anything junctions or builds ==="
# `git worktree add` does not populate git submodules: a fresh worktree holds an EMPTY `vendor/<name>`
# directory. Until 2026-11-25 this step junctioned that empty directory from the materialization source,
# which is empty whenever the kit is run FROM a bare worktree (the reusable recipe in
# `.tmp/lane-round31.md` §5, which round32 followed). The first sign was then
#   ERR_MODULE_NOT_FOUND .../vendor/pi-koe/scripts/build-release-artifact.mjs
# at generation-build step 4 - four steps and ~200 s below the empty directory - and two live rounds
# were spent on it. A pin step that cannot tell "empty checkout" from "broken module" costs a round,
# so every gitlink in the pinned tree is asserted HERE, before §3 or §4 builds anything.
# A linked worktree keeps its own module clone (`git worktree list` + `git submodule status` in the
# main checkout stay untouched), so the supply clones once per pin: measured 32 s for both submodules
# from cold, at the recorded commits c212554f / d4bc32df.
$submodules = @()
foreach ($line in @(git -C $Worktree ls-tree -r $resolved)) {
  if ($line -match '^160000 commit ([0-9a-f]{40})\t(.+)$') {
    $submodules += [pscustomobject]@{ path = $Matches[2]; sha = $Matches[1] }
  }
}
Log ("  gitlinks in the pinned tree = [" + (($submodules | ForEach-Object { $_.path + '@' + $_.sha.Substring(0, 8) }) -join ', ') + "]")
foreach ($sub in $submodules) {
  $dir = Join-Path $Worktree $sub.path
  New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
  $files = SubmoduleFiles $dir
  $supplied = $false
  if ($files -eq 0) {
    Log ("  submodule_empty: " + $sub.path + " (the pin records " + $sub.sha + " here; a bare worktree never populates a submodule)")
    $sw = [Diagnostics.Stopwatch]::StartNew()
    git -C $Worktree submodule update --init $sub.path 2>&1 | ForEach-Object { Log ("  | " + $_) }
    $supplyExit = $LASTEXITCODE
    $sw.Stop()
    $files = SubmoduleFiles $dir
    if ($files -eq 0) {
      Log ("  submodule_supply_failed: " + $sub.path + " (git submodule update --init exited " + $supplyExit + " and the directory still holds no tracked file; the captured lines above are its own)")
      Log ("  remedy: that command needs the recorded commit fetchable from `"git -C $Worktree config -f .gitmodules submodule.$($sub.path).url`" - a linked worktree clones the submodule for itself, so this is once per pin")
      Log "DONE-PIN-FAIL (a submodule the pin needs is not in the worktree)"
      exit 1
    }
    $supplied = $true
  }
  $head = SubmoduleHead $dir
  if ($head -ne $sub.sha) {
    LogSubmoduleMismatch $sub.path $sub.sha $head
    Log ("  remedy: the pin never re-points a populated submodule (that would be an overlay); delete " + $dir + " and re-run so it is supplied at the recorded commit")
    Log "DONE-PIN-FAIL (a submodule is not at the commit the pin records)"
    exit 1
  }
  if ($supplied) { Log ("  submodule_supplied: " + $sub.path + " " + $head + " (" + $files + " files) elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s") }
  else { Log ("  submodule_present: " + $sub.path + " " + $head + " (" + $files + " files)") }
}

Log "=== 2b. submodule dependency installs and build outputs: proven, then supplied ==="
# A submodule checkout carries source only. Its `node_modules` and its `dist` are gitignored, so neither
# arrives with `git submodule update --init`, and all four of these are inputs of the generation build:
#   vendor/pi-koe/node_modules                          tsc + esbuild (the compiles below, and the release
#                                                       bundle host/scripts/build-production-artifact.mjs
#                                                       imports from vendor/pi-koe/scripts)
#   vendor/pi-koe/dist, packages/voice-protocol/dist     the bundle's entry sources
#   vendor/magic-context/packages/pi-plugin/dist         manifest-compared by the generation build against
#                                                       the shipped node_modules/@cortexkit/pi-magic-context
# Measured 2026-11-25 (round32): supplying them was three hand steps; the pin must supply them, and each
# is only worth anything when it is PROVEN to come from the source the pin records - a dist built from a
# different commit is an overlay nobody can see. So the candidates are the two checkouts an operator holds
# (`-Repo` and this repository's main worktree), a candidate is accepted only at the recorded sha (and, for
# the copied build output, only with a clean source tree), and a rejected candidate is named with the
# reading that rejected it.
$checkouts = @([System.IO.Path]::GetFullPath($Repo))
# The main worktree is the OTHER checkout an operator deliberately holds, and `git worktree list` prints it
# first. Sibling lane worktrees are deliberately NOT in this population: their submodule state is another
# lane's, and a dist copied out of a lane that is mid-write is exactly the unprovable artifact this step
# refuses. -Repo first, because that is the checkout this run was started from.
foreach ($line in @(git -C $Worktree worktree list --porcelain)) {
  if ($line -match '^worktree (.+)$') {
    $mainCheckout = [System.IO.Path]::GetFullPath($Matches[1].Trim())
    if ($checkouts -notcontains $mainCheckout) { $checkouts += $mainCheckout }
    break
  }
}
Log ("  checkouts examined = [" + ($checkouts -join ', ') + "]")
function GitlinkSha($path) {
  $found = @($submodules | Where-Object { $_.path -eq $path })
  if ($found.Count -eq 1) { return $found[0].sha }
  return ""
}

$piKoeSha = GitlinkSha 'vendor/pi-koe'
if ($piKoeSha) {
  $install = Join-Path $Worktree "vendor\pi-koe\node_modules"
  if (Test-Path $install) {
    Log ("  pi_koe_node_modules_already_present: " + $install)
  } else {
    $source = ""
    foreach ($checkout in $checkouts) {
      $candidate = Join-Path $checkout "vendor\pi-koe\node_modules"
      if (-not (Test-Path (Join-Path $candidate "typescript\lib\tsc.js")) -or -not (Test-Path (Join-Path $candidate "esbuild\package.json"))) {
        Log ("  pi_koe_node_modules_absent: " + $checkout)
        continue
      }
      $candidateSha = SubmoduleHead (Join-Path $checkout "vendor\pi-koe")
      if ($candidateSha -ne $piKoeSha) {
        LogSubmoduleMismatch (Join-Path $checkout "vendor\pi-koe") $piKoeSha $candidateSha
        continue
      }
      $source = $candidate
      break
    }
    if (-not $source) {
      Log ("  pi_koe_node_modules_unavailable: no checkout of this repository holds vendor\pi-koe\node_modules with typescript + esbuild while its vendor/pi-koe is at the commit this pin records (" + $piKoeSha + "); examined " + $checkouts.Count + " checkout(s)")
      Log ("  remedy: once, in a checkout whose `"git -C <checkout>/vendor/pi-koe rev-parse HEAD`" is " + $piKoeSha + ", run `"pnpm --dir vendor/pi-koe install`"")
      Log "DONE-PIN-FAIL (a submodule dependency install the pin needs is not on this machine)"
      exit 1
    }
    LinkDir $source $install
    Log ("  pi_koe_node_modules_junctioned: " + $source + " -> " + $install + " (that checkout's pi-koe is at " + $piKoeSha + ", the commit this pin records)")
  }
  $tsc = Join-Path $install "typescript\lib\tsc.js"
  if (-not (Test-Path $tsc)) {
    Log ("  pi_koe_typescript_missing: " + $tsc + " (the pi-koe dependency install must carry its own typescript devDependency)")
    Log "DONE-PIN-FAIL (the pin cannot compile the pi-koe submodule)"
    exit 1
  }
  # WHY NOT `pnpm --dir vendor/pi-koe run build:all`: pnpm's pre-run install check inspects the junctioned
  # `vendor/pi-koe/node_modules` and tries to purge it, aborting with
  # ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY (measured 2026-11-25, round32). It refused rather than
  # deleted - the safe direction - but it cannot run here. `build:all` is exactly two `tsc --project`
  # invocations (vendor/pi-koe/package.json: build:protocol, then build), so the pin runs those two
  # directly, in `build:all`'s order: the gateway's tsconfig imports `@gamebuddy/voice-protocol`, whose
  # `dist` the first run produces.
  # EXPIRY: the day `pnpm --dir vendor/pi-koe run build:all` can run against a junctioned node_modules
  # (pnpm's check learns to skip one), delete this workaround and call that instead - it keeps the build
  # recipe in the submodule's own package.json instead of in this file.
  $compiles = @(
    @{ label = 'voice-protocol'; project = 'vendor\pi-koe\packages\voice-protocol\tsconfig.json'; entry = 'vendor\pi-koe\packages\voice-protocol\dist\index.js' },
    @{ label = 'voice-gateway'; project = 'vendor\pi-koe\tsconfig.json'; entry = 'vendor\pi-koe\dist\main.js' }
  )
  foreach ($compile in $compiles) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $compileOutput = node $tsc --project (Join-Path $Worktree $compile.project) 2>&1
    $compileExit = $LASTEXITCODE
    $sw.Stop()
    $entry = Join-Path $Worktree $compile.entry
    if ($compileExit -ne 0 -or -not (Test-Path $entry)) {
      ($compileOutput | Select-Object -First 12) | ForEach-Object { Log ("  | " + $_) }
      Log ("  pi_koe_dist_build_failed: " + $compile.label + " (tsc exited " + $compileExit + ", entry " + $compile.entry + " present=" + (Test-Path $entry) + ")")
      Log "DONE-PIN-FAIL (the pi-koe submodule did not compile from the pinned source)"
      exit 1
    }
    Log ("  pi_koe_dist_compiled: " + $compile.label + " exit=0 entry=" + $compile.entry + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
  }
}

$magicContextSha = GitlinkSha 'vendor/magic-context'
if ($magicContextSha) {
  $target = Join-Path $Worktree "vendor\magic-context\packages\pi-plugin\dist"
  if (Test-Path (Join-Path $target "index.js")) {
    Log ("  magic_context_dist_already_present: " + $target)
  } else {
    $source = ""
    $sourceSha = ""
    foreach ($checkout in $checkouts) {
      $candidate = Join-Path $checkout "vendor\magic-context\packages\pi-plugin\dist"
      if (-not (Test-Path (Join-Path $candidate "index.js"))) {
        Log ("  magic_context_dist_absent: " + $checkout)
        continue
      }
      $candidateSub = Join-Path $checkout "vendor\magic-context"
      $candidateSha = SubmoduleHead $candidateSub
      if ($candidateSha -ne $magicContextSha) {
        LogSubmoduleMismatch $candidateSub $magicContextSha $candidateSha
        continue
      }
      $dirty = @(git -C $candidateSub status --porcelain -- packages/pi-plugin/src packages/pi-plugin/package.json 2>$null)
      if ($dirty.Count -gt 0) {
        Log ("  magic_context_dist_source_dirty: " + $candidateSub + " [" + ($dirty -join ',') + "]")
        continue
      }
      $source = $candidate
      $sourceSha = $candidateSha
      break
    }
    if (-not $source) {
      Log ("  magic_context_dist_unavailable: no checkout of this repository holds vendor\magic-context\packages\pi-plugin\dist with its vendor/magic-context at the commit this pin records (" + $magicContextSha + ") and a clean packages/pi-plugin source; examined " + $checkouts.Count + " checkout(s)")
      Log ("  remedy: once, in a checkout whose `"git -C <checkout>/vendor/magic-context rev-parse HEAD` is " + $magicContextSha + ", run `"bun install --cwd vendor/magic-context --frozen-lockfile`" then `"bun run --cwd vendor/magic-context/packages/pi-plugin build`" (host/scripts/run-test-suite.mjs does both); this pipeline needs bun, so the pin never builds it")
      Log "DONE-PIN-FAIL (a submodule build output the pin needs is not on this machine)"
      exit 1
    }
    New-Item -ItemType Directory -Force $target | Out-Null
    robocopy $source $target /E /NFL /NDL /NJH /NJS /NP | Out-Null
    $copied = @(Get-ChildItem $target -Recurse -File -Force).Count
    if (-not (Test-Path (Join-Path $target "index.js"))) {
      Log ("  magic_context_dist_copy_failed: " + $source + " -> " + $target + " (" + $copied + " file(s) arrived, the entry did not)")
      Log "DONE-PIN-FAIL (the magic-context build output did not survive the copy)"
      exit 1
    }
    Log ("  magic_context_dist_supplied: " + $source + " -> " + $target + " source_sha=" + $sourceSha + " pin=" + $magicContextSha + " source_clean=yes (" + $copied + " files)")
  }
}

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